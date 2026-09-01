import type { DatabaseSync } from "node:sqlite";

import {
  encounterRecordSchema,
  encounterSourceOf,
  encounterStatusSchema,
  demographicSnapshotSchema,
  type EncounterRecord,
  type EncounterStatus,
} from "@/domain/encounter";
import { isoUtcTimestampSchema } from "@/domain/runtime-records";
import { parseEncounterSource } from "@/domain/encounter-source";
import { dataCorruptionError, PersistenceError, persistenceErrorCodes, validationError } from "../errors";
import { parseStoredJson, stableJsonStringify, validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  invalidQueryLimit,
  isSqliteConstraintError,
  optionalRowString,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export type EncounterConcurrencyExpectation = {
  status: EncounterStatus;
  updatedAt: string;
};

export interface EncounterRepository {
  insert(record: EncounterRecord): void;
  getById(id: string): EncounterRecord | undefined;
  listByCase(caseId: string, caseVersion?: string, limit?: number): EncounterRecord[];
  listByStatus(status: EncounterStatus, limit?: number): EncounterRecord[];
  getByManualIntakeId(intakeId: string): EncounterRecord | undefined;
  updateStatus(record: EncounterRecord, expected: EncounterConcurrencyExpectation): void;
}

function rowToRecord(row: SqliteRow): EncounterRecord {
  const currentRecordRevisionId = optionalRowString(row, "current_record_revision_id");
  const confirmedAt = optionalRowString(row, "confirmed_at");
  const caseId = requiredRowString(row, "case_id");
  const caseVersion = requiredRowString(row, "case_version");
  const sourceType = requiredRowString(row, "source_type");
  const manualIntakeId = optionalRowString(row, "manual_intake_id");
  let source: EncounterRecord["source"];
  try {
    if (sourceType === "SEEDED_SYNTHETIC") {
      if (manualIntakeId !== undefined) throw new Error("seeded source has manual intake binding");
      parseEncounterSource(undefined, { caseId, caseVersion });
    } else if (sourceType === "MANUAL_SYNTHETIC") {
      if (manualIntakeId === undefined) throw new Error("manual source has no intake binding");
      source = parseEncounterSource({
        type: "MANUAL_SYNTHETIC",
        intakeId: manualIntakeId,
        intakeSchemaVersion: "1.0.0",
      }, { caseId, caseVersion });
    } else {
      throw new Error("unknown encounter source type");
    }
  } catch {
    throw dataCorruptionError("source");
  }
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    synthetic: requiredRowInteger(row, "synthetic") === 1,
    caseId,
    caseVersion,
    status: requiredRowString(row, "status"),
    demographicSnapshot: parseStoredJson(
      requiredRowString(row, "demographic_snapshot_json"),
      demographicSnapshotSchema,
      "demographicSnapshot",
    ),
    ...(currentRecordRevisionId === undefined ? {} : { currentRecordRevisionId }),
    createdAt: requiredRowString(row, "created_at"),
    updatedAt: requiredRowString(row, "updated_at"),
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
    runtimeMode: requiredRowString(row, "runtime_mode"),
    ...(source === undefined ? {} : { source }),
  };

  return validateRuntimeRecord(encounterRecordSchema, record);
}

function assertConcurrencyExpectation(expected: EncounterConcurrencyExpectation): void {
  if (!encounterStatusSchema.safeParse(expected.status).success) {
    throw validationError("expectedStatus");
  }
  if (!isoUtcTimestampSchema.safeParse(expected.updatedAt).success) {
    throw validationError("expectedUpdatedAt");
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1_000) throw invalidQueryLimit();
}

export function createEncounterRepository(database: DatabaseSync): EncounterRepository {
  const insertStatement = database.prepare(`
    INSERT INTO encounters (
      id, schema_version, synthetic, case_id, case_version, status,
      demographic_snapshot_json, current_record_revision_id,
      created_at, updated_at, confirmed_at, runtime_mode, source_type, manual_intake_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM encounters WHERE id = ?");
  const listByCaseStatement = database.prepare(`
    SELECT * FROM encounters
    WHERE case_id = ? AND (? IS NULL OR case_version = ?)
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);
  const listByStatusStatement = database.prepare(`
    SELECT * FROM encounters
    WHERE status = ?
    ORDER BY updated_at ASC, id ASC
    LIMIT ?
  `);
  const selectByManualIntakeIdStatement = database.prepare(
    "SELECT * FROM encounters WHERE manual_intake_id = ?",
  );
  const updateStatusStatement = database.prepare(`
    UPDATE encounters
    SET status = ?, current_record_revision_id = ?, updated_at = ?, confirmed_at = ?
    WHERE id = ? AND status = ? AND updated_at = ?
  `);

  return {
    insert(record) {
      const validated = validateRuntimeRecord(encounterRecordSchema, record);
      const source = encounterSourceOf(validated);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.synthetic ? 1 : 0,
          validated.caseId,
          validated.caseVersion,
          validated.status,
          stableJsonStringify(validated.demographicSnapshot),
          validated.currentRecordRevisionId ?? null,
          validated.createdAt,
          validated.updatedAt,
          validated.confirmedAt ?? null,
          validated.runtimeMode,
          source.type,
          source.type === "MANUAL_SYNTHETIC" ? source.intakeId : null,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Encounter ID already exists or violates its constraints.");
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByCase(caseId, caseVersion, limit = 100) {
      assertLimit(limit);
      const version = caseVersion ?? null;
      const rows = listByCaseStatement.all(caseId, version, version, limit) as SqliteRow[];
      return rows.map(rowToRecord);
    },

    listByStatus(status, limit = 100) {
      if (!encounterStatusSchema.safeParse(status).success) throw validationError("status");
      assertLimit(limit);
      return (listByStatusStatement.all(status, limit) as SqliteRow[]).map(rowToRecord);
    },

    getByManualIntakeId(intakeId) {
      const row = selectByManualIntakeIdStatement.get(intakeId) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    updateStatus(record, expected) {
      const validated = validateRuntimeRecord(encounterRecordSchema, record);
      assertConcurrencyExpectation(expected);
      try {
        const result = updateStatusStatement.run(
          validated.status,
          validated.currentRecordRevisionId ?? null,
          validated.updatedAt,
          validated.confirmedAt ?? null,
          validated.id,
          expected.status,
          expected.updatedAt,
        );
        if (Number(result.changes) !== 1) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "Encounter status update was stale or already applied.",
          );
        }
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Encounter status update violates its constraints.");
        }
        throw databaseWriteError();
      }
    },
  };
}
