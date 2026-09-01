import type { DatabaseSync } from "node:sqlite";

import {
  evaluationPairConfigurationSchema,
  evaluationRunRecordSchema,
  type EvaluationRunRecord,
  type EvaluationRunStatus,
} from "@/domain/evaluation";
import { isoUtcTimestampSchema } from "@/domain/runtime-records";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import { parseStoredJson, stableJsonStringify, validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  invalidQueryLimit,
  isSqliteConstraintError,
  optionalRowString,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

function optionalRowInteger(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored evaluation run has an invalid integer field.",
      { fieldPath: column },
    );
  }
  return value;
}

export interface EvaluationRunRepository {
  insert(record: EvaluationRunRecord): void;
  getById(id: string): EvaluationRunRecord | undefined;
  listByBatch(evaluationBatchId: string, limit?: number): EvaluationRunRecord[];
  transitionStatus(id: string, expectedStatus: "RUNNING", status: Exclude<EvaluationRunStatus, "RUNNING">, completedAt: string): void;
}

function rowToRecord(row: SqliteRow): EvaluationRunRecord {
  const profileId = optionalRowString(row, "profile_id");
  const profileVersion = optionalRowInteger(row, "profile_version");
  const completedAt = optionalRowString(row, "completed_at");
  const configuration = parseStoredJson(
    requiredRowString(row, "configuration_json"),
    evaluationPairConfigurationSchema,
    "configuration",
  );
  return validateRuntimeRecord(evaluationRunRecordSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    evaluationBatchId: requiredRowString(row, "evaluation_batch_id"),
    pairKey: requiredRowString(row, "pair_key"),
    datasetVersion: requiredRowString(row, "dataset_version"),
    mode: requiredRowString(row, "mode"),
    status: requiredRowString(row, "status"),
    executionType: requiredRowString(row, "execution_type"),
    caseId: configuration.caseRef.id,
    caseVersion: configuration.caseRef.version,
    ...(profileId === undefined ? {} : { profileId }),
    ...(profileVersion === undefined ? {} : { profileVersion }),
    provider: configuration.provider,
    safetyCore: configuration.safetyCore,
    policy: configuration.policy,
    feedbackRulesVersion: configuration.feedbackRulesVersion,
    configurationKey: requiredRowString(row, "mode") === "GENERIC"
      ? configuration.genericConfigurationKey
      : configuration.boundedConfigurationKey,
    configuration,
    startedAt: requiredRowString(row, "started_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  });
}

function notFound(): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Evaluation run was not found.");
}

function stateConflict(): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.CONFLICT, "Evaluation run state transition is not allowed.");
}

export function createEvaluationRunRepository(database: DatabaseSync): EvaluationRunRepository {
  const insertStatement = database.prepare(`
    INSERT INTO evaluation_runs (
      id, schema_version, dataset_version, mode, status, configuration_json,
      started_at, completed_at, evaluation_batch_id, pair_key,
      profile_id, profile_version, execution_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM evaluation_runs WHERE id = ?");
  const listByBatchStatement = database.prepare(`
    SELECT * FROM evaluation_runs
    WHERE evaluation_batch_id = ?
    ORDER BY started_at ASC, pair_key ASC, mode ASC, id ASC
    LIMIT ?
  `);
  const updateStatusStatement = database.prepare(`
    UPDATE evaluation_runs
    SET status = ?, completed_at = ?
    WHERE id = ? AND status = ?
  `);

  return {
    insert(record) {
      const validated = validateRuntimeRecord(evaluationRunRecordSchema, record);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.datasetVersion,
          validated.mode,
          validated.status,
          stableJsonStringify(validated.configuration),
          validated.startedAt,
          validated.completedAt ?? null,
          validated.evaluationBatchId,
          validated.pairKey,
          validated.profileId ?? null,
          validated.profileVersion ?? null,
          validated.executionType,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Evaluation run ID or pair already exists.");
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByBatch(evaluationBatchId, limit = 100) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw invalidQueryLimit();
      return (listByBatchStatement.all(evaluationBatchId, limit) as SqliteRow[]).map(rowToRecord);
    },

    transitionStatus(id, expectedStatus, status, completedAt) {
      if (!isoUtcTimestampSchema.safeParse(completedAt).success) {
        throw new PersistenceError(
          persistenceErrorCodes.VALIDATION_FAILED,
          "Evaluation run completion timestamp is invalid.",
          { fieldPath: "completedAt" },
        );
      }
      const current = selectByIdStatement.get(id) as SqliteRow | undefined;
      if (!current) throw notFound();
      if (requiredRowString(current, "status") !== expectedStatus) throw stateConflict();
      try {
        const result = updateStatusStatement.run(status, completedAt, id, expectedStatus);
        if (Number(result.changes ?? 0) !== 1) throw stateConflict();
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        if (isSqliteConstraintError(error)) throw stateConflict();
        throw databaseWriteError();
      }
    },
  };
}
