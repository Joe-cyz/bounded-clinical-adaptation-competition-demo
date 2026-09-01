import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  evaluationAttemptMetricsSchema,
  evaluationFailureTypeSchema,
  evaluationModeSchema,
  evaluationResultRecordSchema,
  type EvaluationResultRecord,
  type EvaluationResultStatus,
} from "@/domain/evaluation";
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

const storedMetricsSchema = z.object({
  mode: evaluationModeSchema,
  pairKey: z.string().min(1).max(2_000),
  profileId: z.string().min(1).max(200).optional(),
  profileVersion: z.number().int().positive().max(100_000).optional(),
  failureType: evaluationFailureTypeSchema.optional(),
  failureRuleId: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_.-]*$/u).optional(),
  metrics: evaluationAttemptMetricsSchema,
}).strict();

export interface EvaluationResultRepository {
  append(record: EvaluationResultRecord): void;
  getById(id: string): EvaluationResultRecord | undefined;
  listByEvaluationRun(evaluationRunId: string): EvaluationResultRecord[];
  listByBatch(evaluationBatchId: string, limit?: number): EvaluationResultRecord[];
  listByStatus(status?: EvaluationResultStatus, limit?: number): EvaluationResultRecord[];
}

function rowToRecord(row: SqliteRow): EvaluationResultRecord {
  const generationRunId = optionalRowString(row, "generation_run_id");
  const storedMetrics = parseStoredJson(
    requiredRowString(row, "metrics_json"),
    storedMetricsSchema,
    "metrics",
  );
  return validateRuntimeRecord(evaluationResultRecordSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    evaluationRunId: requiredRowString(row, "evaluation_run_id"),
    ...(generationRunId === undefined ? {} : { generationRunId }),
    caseId: requiredRowString(row, "case_id"),
    caseVersion: requiredRowString(row, "case_version"),
    mode: storedMetrics.mode,
    pairKey: storedMetrics.pairKey,
    status: requiredRowString(row, "status"),
    ...(storedMetrics.profileId === undefined ? {} : { profileId: storedMetrics.profileId }),
    ...(storedMetrics.profileVersion === undefined ? {} : { profileVersion: storedMetrics.profileVersion }),
    ...(storedMetrics.failureType === undefined ? {} : { failureType: storedMetrics.failureType }),
    ...(storedMetrics.failureRuleId === undefined ? {} : { failureRuleId: storedMetrics.failureRuleId }),
    metrics: storedMetrics.metrics,
    createdAt: requiredRowString(row, "created_at"),
  });
}

export function createEvaluationResultRepository(database: DatabaseSync): EvaluationResultRepository {
  const insertStatement = database.prepare(`
    INSERT INTO evaluation_results (
      id, evaluation_run_id, generation_run_id, schema_version,
      case_id, case_version, status, metrics_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM evaluation_results WHERE id = ?");
  const listByRunStatement = database.prepare(`
    SELECT * FROM evaluation_results
    WHERE evaluation_run_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const listByBatchStatement = database.prepare(`
    SELECT evaluation_results.* FROM evaluation_results
    INNER JOIN evaluation_runs ON evaluation_runs.id = evaluation_results.evaluation_run_id
    WHERE evaluation_runs.evaluation_batch_id = ?
    ORDER BY evaluation_results.created_at ASC, evaluation_results.id ASC
    LIMIT ?
  `);
  const listByStatusStatement = database.prepare(`
    SELECT * FROM evaluation_results
    WHERE (? IS NULL OR status = ?)
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);

  return {
    append(record) {
      const validated = validateRuntimeRecord(evaluationResultRecordSchema, record);
      try {
        insertStatement.run(
          validated.id,
          validated.evaluationRunId,
          validated.generationRunId ?? null,
          validated.schemaVersion,
          validated.caseId,
          validated.caseVersion,
          validated.status,
          stableJsonStringify({
            mode: validated.mode,
            pairKey: validated.pairKey,
            ...(validated.profileId === undefined ? {} : { profileId: validated.profileId }),
            ...(validated.profileVersion === undefined ? {} : { profileVersion: validated.profileVersion }),
            ...(validated.failureType === undefined ? {} : { failureType: validated.failureType }),
            ...(validated.failureRuleId === undefined ? {} : { failureRuleId: validated.failureRuleId }),
            metrics: validated.metrics,
          }),
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Evaluation result ID or run result already exists.");
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByEvaluationRun(evaluationRunId) {
      return (listByRunStatement.all(evaluationRunId) as SqliteRow[]).map(rowToRecord);
    },

    listByBatch(evaluationBatchId, limit = 100) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw invalidQueryLimit();
      return (listByBatchStatement.all(evaluationBatchId, limit) as SqliteRow[]).map(rowToRecord);
    },

    listByStatus(status, limit = 100) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw invalidQueryLimit();
      const value = status ?? null;
      return (listByStatusStatement.all(value, value, limit) as SqliteRow[]).map(rowToRecord);
    },
  };
}
