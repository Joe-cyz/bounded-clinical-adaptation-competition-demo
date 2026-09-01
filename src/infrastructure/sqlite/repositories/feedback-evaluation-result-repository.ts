import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  feedbackFixtureEvaluationResultSchema,
  feedbackFixtureObservedSchema,
  type FeedbackFixtureEvaluationResult,
} from "@/domain/dataset";
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

const storedExpectedSchema = z.object({
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "UNCERTAIN"]),
  status: z.enum(["CANDIDATE", "HELD_FOR_REVIEW", "REJECTED"]),
  decision: z.enum(["PENDING", "REJECTED"]),
  ruleIds: z.array(z.string().min(1).max(120)).max(20),
}).strict();

function optionalInteger(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Stored feedback evaluation result has an invalid integer field.", { fieldPath: column });
  }
  return value;
}

function rowToRecord(row: SqliteRow): FeedbackFixtureEvaluationResult {
  const generationRunId = optionalRowString(row, "generation_run_id");
  const expected = parseStoredJson(requiredRowString(row, "expected_json"), storedExpectedSchema, "expected");
  const observedStored = parseStoredJson(
    requiredRowString(row, "observed_json"),
    z.record(z.string(), z.unknown()),
    "observed",
  );
  const observed = feedbackFixtureObservedSchema.parse({
    executionPath: "WORKBENCH_REVISION",
    dangerousBodyStored: false,
    ...observedStored,
  });
  return validateRuntimeRecord(feedbackFixtureEvaluationResultSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    evaluationBatchId: requiredRowString(row, "evaluation_batch_id"),
    ...(generationRunId ? { generationRunId } : {}),
    datasetVersion: requiredRowString(row, "dataset_version"),
    fixtureId: requiredRowString(row, "fixture_id"),
    fixtureVersion: requiredRowString(row, "fixture_version"),
    caseId: requiredRowString(row, "case_id"),
    caseVersion: requiredRowString(row, "case_version"),
    profileId: requiredRowString(row, "profile_id"),
    profileVersion: optionalInteger(row, "profile_version"),
    mutationType: requiredRowString(row, "mutation_type"),
    expectedRiskLevel: expected.riskLevel,
    expectedStatus: expected.status,
    expectedDecision: expected.decision,
    expectedRuleIds: expected.ruleIds,
    observed,
    resultStatus: requiredRowString(row, "result_status"),
    rulesVersion: requiredRowString(row, "rules_version"),
    createdAt: requiredRowString(row, "created_at"),
  });
}

export interface FeedbackEvaluationResultRepository {
  append(record: FeedbackFixtureEvaluationResult): void;
  getById(id: string): FeedbackFixtureEvaluationResult | undefined;
  listByBatch(evaluationBatchId: string, limit?: number): FeedbackFixtureEvaluationResult[];
  listByStatus(status?: "PASS" | "FAIL", limit?: number): FeedbackFixtureEvaluationResult[];
}

export function createFeedbackEvaluationResultRepository(database: DatabaseSync): FeedbackEvaluationResultRepository {
  const insertStatement = database.prepare(`
    INSERT INTO feedback_evaluation_results (
      id, schema_version, evaluation_batch_id, generation_run_id,
      dataset_version, fixture_id, fixture_version, case_id, case_version,
      profile_id, profile_version, mutation_type, expected_json, observed_json,
      result_status, rules_version, revision_saved, profile_updated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM feedback_evaluation_results WHERE id = ?");
  const listByBatchStatement = database.prepare(`
    SELECT * FROM feedback_evaluation_results
    WHERE evaluation_batch_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);
  const listByStatusStatement = database.prepare(`
    SELECT * FROM feedback_evaluation_results
    WHERE (? IS NULL OR result_status = ?)
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);

  return {
    append(record) {
      const validated = validateRuntimeRecord(feedbackFixtureEvaluationResultSchema, record);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.evaluationBatchId,
          validated.generationRunId ?? null,
          validated.datasetVersion,
          validated.fixtureId,
          validated.fixtureVersion,
          validated.caseId,
          validated.caseVersion,
          validated.profileId,
          validated.profileVersion,
          validated.mutationType,
          stableJsonStringify({
            riskLevel: validated.expectedRiskLevel,
            status: validated.expectedStatus,
            decision: validated.expectedDecision,
            ruleIds: validated.expectedRuleIds,
          }),
          stableJsonStringify(validated.observed),
          validated.resultStatus,
          validated.rulesVersion,
          validated.observed.revisionSaved ? 1 : 0,
          validated.observed.profileUpdated ? 1 : 0,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Feedback evaluation fixture result already exists.");
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByBatch(evaluationBatchId, limit = 100) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) throw invalidQueryLimit();
      return (listByBatchStatement.all(evaluationBatchId, limit) as SqliteRow[]).map(rowToRecord);
    },

    listByStatus(status, limit = 100) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) throw invalidQueryLimit();
      const value = status ?? null;
      return (listByStatusStatement.all(value, value, limit) as SqliteRow[]).map(rowToRecord);
    },
  };
}
