import type { DatabaseSync } from "node:sqlite";

import {
  encounterRecordRevisionSchema,
  type EncounterRecordRevision,
} from "@/domain/encounter";
import { jsonObjectSchema } from "@/domain/runtime-records";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import { parseStoredJson, stableJsonStringify, validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  isSqliteConstraintError,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export interface EncounterRecordRevisionRepository {
  append(record: EncounterRecordRevision, expectedPreviousRevision?: number): void;
  getById(id: string): EncounterRecordRevision | undefined;
  getLatestByEncounter(encounterId: string): EncounterRecordRevision | undefined;
  listByEncounter(encounterId: string): EncounterRecordRevision[];
}

function rowToRecord(row: SqliteRow): EncounterRecordRevision {
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    encounterId: requiredRowString(row, "encounter_id"),
    revisionNumber: requiredRowInteger(row, "revision_number"),
    recordPayload: parseStoredJson(
      requiredRowString(row, "record_payload_json"),
      jsonObjectSchema,
      "recordPayload",
    ),
    createdAt: requiredRowString(row, "created_at"),
  };

  return validateRuntimeRecord(encounterRecordRevisionSchema, record);
}

export function createEncounterRecordRevisionRepository(
  database: DatabaseSync,
): EncounterRecordRevisionRepository {
  const insertStatement = database.prepare(`
    INSERT INTO encounter_record_revisions (
      id, encounter_id, schema_version, revision_number, record_payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare(
    "SELECT * FROM encounter_record_revisions WHERE id = ?",
  );
  const selectLatestStatement = database.prepare(`
    SELECT * FROM encounter_record_revisions
    WHERE encounter_id = ?
    ORDER BY revision_number DESC
    LIMIT 1
  `);
  const listByEncounterStatement = database.prepare(`
    SELECT * FROM encounter_record_revisions
    WHERE encounter_id = ?
    ORDER BY revision_number ASC, created_at ASC, id ASC
  `);

  return {
    append(record, expectedPreviousRevision) {
      const validated = validateRuntimeRecord(encounterRecordRevisionSchema, record);
      const latestRow = selectLatestStatement.get(validated.encounterId) as SqliteRow | undefined;
      const currentRevision = latestRow ? requiredRowInteger(latestRow, "revision_number") : 0;
      const expectedRevision = expectedPreviousRevision ?? 0;

      if (currentRevision !== expectedRevision || validated.revisionNumber !== currentRevision + 1) {
        throw new PersistenceError(
          persistenceErrorCodes.CONFLICT,
          "Encounter record revisions must be continuous and use the expected previous revision.",
        );
      }

      try {
        insertStatement.run(
          validated.id,
          validated.encounterId,
          validated.schemaVersion,
          validated.revisionNumber,
          stableJsonStringify(validated.recordPayload),
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "Encounter record revision ID or revision number already exists.",
          );
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    getLatestByEncounter(encounterId) {
      const row = selectLatestStatement.get(encounterId) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByEncounter(encounterId) {
      return (listByEncounterStatement.all(encounterId) as SqliteRow[]).map(rowToRecord);
    },
  };
}
