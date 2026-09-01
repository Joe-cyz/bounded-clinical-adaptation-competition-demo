import type { DatabaseSync } from "node:sqlite";

import {
  physicianProfileVersionRecordSchema,
  type PhysicianProfileVersionRecord,
} from "@/domain/runtime-records";
import { physicianPreferenceSchema } from "@/domain/schemas";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import { parseStoredJson, stableJsonStringify, validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  isSqliteConstraintError,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export interface PhysicianProfileVersionRepository {
  append(record: PhysicianProfileVersionRecord, expectedPreviousVersion?: number): void;
  get(profileId: string, version: number): PhysicianProfileVersionRecord | undefined;
  getLatest(profileId: string): PhysicianProfileVersionRecord | undefined;
  listHistory(profileId: string): PhysicianProfileVersionRecord[];
}

function rowToRecord(row: SqliteRow): PhysicianProfileVersionRecord {
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    profileId: requiredRowString(row, "profile_id"),
    version: requiredRowInteger(row, "version"),
    status: requiredRowString(row, "status"),
    synthetic: requiredRowInteger(row, "synthetic") === 1,
    preferences: parseStoredJson(
      requiredRowString(row, "preferences_json"),
      physicianPreferenceSchema,
      "preferences",
    ),
    ...(row.previous_version === null || row.previous_version === undefined
      ? {}
      : { previousVersion: requiredRowInteger(row, "previous_version") }),
    sourceType: requiredRowString(row, "source_type"),
    createdAt: requiredRowString(row, "created_at"),
  };

  return validateRuntimeRecord(physicianProfileVersionRecordSchema, record);
}

function profileVersionConflict(message: string): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.PROFILE_VERSION_CONFLICT, message);
}

export function createPhysicianProfileVersionRepository(
  database: DatabaseSync,
): PhysicianProfileVersionRepository {
  const latestStatement = database.prepare(`
    SELECT * FROM physician_profile_versions
    WHERE profile_id = ?
    ORDER BY version DESC
    LIMIT 1
  `);
  const insertStatement = database.prepare(`
    INSERT INTO physician_profile_versions (
      profile_id, version, schema_version, status, synthetic,
      preferences_json, previous_version, source_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectVersionStatement = database.prepare(`
    SELECT * FROM physician_profile_versions WHERE profile_id = ? AND version = ?
  `);
  const historyStatement = database.prepare(`
    SELECT * FROM physician_profile_versions
    WHERE profile_id = ?
    ORDER BY version ASC
  `);

  return {
    append(record, expectedPreviousVersion) {
      const validated = validateRuntimeRecord(physicianProfileVersionRecordSchema, record);
      const latestRow = latestStatement.get(validated.profileId) as SqliteRow | undefined;
      const latestVersion = latestRow ? requiredRowInteger(latestRow, "version") : undefined;

      if (latestVersion === undefined) {
        if (expectedPreviousVersion !== undefined || validated.version !== 1 || validated.previousVersion !== undefined) {
          throw profileVersionConflict("Initial physician profile version is not valid.");
        }
      } else {
        if (expectedPreviousVersion !== latestVersion) {
          throw profileVersionConflict("Expected previous physician profile version does not match.");
        }
        if (validated.version !== latestVersion + 1 || validated.previousVersion !== latestVersion) {
          throw profileVersionConflict("Physician profile versions must be continuous.");
        }
      }

      try {
        insertStatement.run(
          validated.profileId,
          validated.version,
          validated.schemaVersion,
          validated.status,
          validated.synthetic ? 1 : 0,
          stableJsonStringify(validated.preferences),
          validated.previousVersion ?? null,
          validated.sourceType,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw profileVersionConflict("Physician profile version already exists or violates continuity.");
        }
        throw databaseWriteError();
      }
    },

    get(profileId, version) {
      const row = selectVersionStatement.get(profileId, version) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    getLatest(profileId) {
      const row = latestStatement.get(profileId) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listHistory(profileId) {
      const rows = historyStatement.all(profileId) as SqliteRow[];
      return rows.map(rowToRecord);
    },
  };
}
