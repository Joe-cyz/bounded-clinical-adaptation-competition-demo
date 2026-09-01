import type { DatabaseSync } from "node:sqlite";

import {
  evaluationBatchRecordSchema,
  type EvaluationBatchRecord,
  type EvaluationBatchStatus,
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

export interface EvaluationBatchRepository {
  insert(record: EvaluationBatchRecord): void;
  getById(id: string): EvaluationBatchRecord | undefined;
  listRecent(limit?: number): EvaluationBatchRecord[];
  transitionStatus(id: string, expectedStatus: "RUNNING", status: Exclude<EvaluationBatchStatus, "RUNNING">, completedAt: string): void;
}

function rowToRecord(row: SqliteRow): EvaluationBatchRecord {
  const completedAt = optionalRowString(row, "completed_at");
  return validateRuntimeRecord(evaluationBatchRecordSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    datasetVersion: requiredRowString(row, "dataset_version"),
    status: requiredRowString(row, "status"),
    executionType: requiredRowString(row, "execution_type"),
    provider: {
      id: requiredRowString(row, "provider_id"),
      modelId: requiredRowString(row, "model_id"),
      promptVersion: requiredRowString(row, "prompt_version"),
    },
    safetyCore: {
      id: requiredRowString(row, "safety_core_id"),
      version: requiredRowString(row, "safety_core_version"),
    },
    rulesVersion: requiredRowString(row, "feedback_rules_version"),
    configuration: parseStoredJson(
      requiredRowString(row, "configuration_json"),
      evaluationBatchRecordSchema.shape.configuration,
      "configuration",
    ),
    startedAt: requiredRowString(row, "started_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  });
}

function notFound(): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Evaluation batch was not found.");
}

function stateConflict(): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.CONFLICT, "Evaluation batch state transition is not allowed.");
}

export function createEvaluationBatchRepository(database: DatabaseSync): EvaluationBatchRepository {
  const insertStatement = database.prepare(`
    INSERT INTO evaluation_batches (
      id, schema_version, dataset_version, status,
      provider_id, model_id, prompt_version,
      execution_type,
      safety_core_id, safety_core_version, feedback_rules_version,
      configuration_json, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM evaluation_batches WHERE id = ?");
  const recentStatement = database.prepare(`
    SELECT * FROM evaluation_batches
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `);
  const updateStatusStatement = database.prepare(`
    UPDATE evaluation_batches
    SET status = ?, completed_at = ?
    WHERE id = ? AND status = ?
  `);

  return {
    insert(record) {
      const validated = validateRuntimeRecord(evaluationBatchRecordSchema, record);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.datasetVersion,
          validated.status,
          validated.provider.id,
          validated.provider.modelId,
          validated.provider.promptVersion,
          validated.executionType,
          validated.safetyCore.id,
          validated.safetyCore.version,
          validated.rulesVersion,
          stableJsonStringify(validated.configuration),
          validated.startedAt,
          validated.completedAt ?? null,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Evaluation batch ID already exists.");
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listRecent(limit = 20) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) throw invalidQueryLimit();
      return (recentStatement.all(limit) as SqliteRow[]).map(rowToRecord);
    },

    transitionStatus(id, expectedStatus, status, completedAt) {
      if (!isoUtcTimestampSchema.safeParse(completedAt).success) {
        throw new PersistenceError(
          persistenceErrorCodes.VALIDATION_FAILED,
          "Evaluation batch completion timestamp is invalid.",
          { fieldPath: "completedAt" },
        );
      }
      const current = selectByIdStatement.get(id) as SqliteRow | undefined;
      if (!current) throw notFound();
      const currentStatus = requiredRowString(current, "status");
      if (currentStatus !== expectedStatus) throw stateConflict();
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
