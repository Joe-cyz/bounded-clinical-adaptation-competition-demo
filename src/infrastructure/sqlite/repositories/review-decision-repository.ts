import type { DatabaseSync } from "node:sqlite";

import {
  reviewDecisionRecordSchema,
  type ReviewDecisionRecord,
} from "@/domain/runtime-records";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import { validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  isSqliteConstraintError,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export interface ReviewDecisionRepository {
  append(record: ReviewDecisionRecord): void;
  getById(id: string): ReviewDecisionRecord | undefined;
  getByFeedbackEvent(feedbackEventId: string): ReviewDecisionRecord | undefined;
}

function rowToRecord(row: SqliteRow): ReviewDecisionRecord {
  const expectedProfileVersion = optionalRowInteger(row, "expected_profile_version");
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    feedbackEventId: requiredRowString(row, "feedback_event_id"),
    actorId: requiredRowString(row, "actor_id"),
    simulatedRole: requiredRowString(row, "simulated_role"),
    decision: requiredRowString(row, "decision"),
    rationale: requiredRowString(row, "rationale"),
    ...(expectedProfileVersion === undefined ? {} : { expectedProfileVersion }),
    createdAt: requiredRowString(row, "created_at"),
  };
  return validateRuntimeRecord(reviewDecisionRecordSchema, record);
}

function optionalRowInteger(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored review decision has an invalid integer field.",
      { fieldPath: column },
    );
  }
  return value;
}

export function createReviewDecisionRepository(database: DatabaseSync): ReviewDecisionRepository {
  const insertStatement = database.prepare(`
    INSERT INTO review_decisions (
      id, schema_version, feedback_event_id, actor_id, simulated_role,
      decision, rationale, created_at, expected_profile_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM review_decisions WHERE id = ?");
  const selectByFeedbackStatement = database.prepare(`
    SELECT * FROM review_decisions WHERE feedback_event_id = ? LIMIT 1
  `);

  return {
    append(record) {
      const validated = validateRuntimeRecord(reviewDecisionRecordSchema, record);
      if (selectByFeedbackStatement.get(validated.feedbackEventId)) {
        throw new PersistenceError(persistenceErrorCodes.CONFLICT, "A feedback event already has a terminal decision.");
      }
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.feedbackEventId,
          validated.actorId,
          validated.simulatedRole,
          validated.decision,
          validated.rationale,
          validated.createdAt,
          validated.expectedProfileVersion ?? null,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Review decision ID or feedback decision already exists.");
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    getByFeedbackEvent(feedbackEventId) {
      const row = selectByFeedbackStatement.get(feedbackEventId) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },
  };
}
