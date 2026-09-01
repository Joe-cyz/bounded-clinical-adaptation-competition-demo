import type { DatabaseSync } from "node:sqlite";

import {
  physicianConfirmationSchema,
  preSignReviewSchema,
  reviewItemDecisionSchema,
  type PhysicianConfirmation,
  type PreSignReview,
  type ReviewItemDecision,
} from "@/domain/pre-sign-review";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import { parseStoredJson, stableJsonStringify, validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  isSqliteConstraintError,
  optionalRowString,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

function reviewRowToRecord(row: SqliteRow): PreSignReview {
  return validateRuntimeRecord(preSignReviewSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    encounterId: requiredRowString(row, "encounter_id"),
    recordRevisionId: requiredRowString(row, "record_revision_id"),
    revisionNumber: requiredRowInteger(row, "revision_number"),
    rulesetVersion: requiredRowString(row, "ruleset_version"),
    items: parseStoredJson(requiredRowString(row, "items_json"), preSignReviewSchema.shape.items, "items"),
    blockingCount: requiredRowInteger(row, "blocking_count"),
    pendingCount: requiredRowInteger(row, "pending_count"),
    createdAt: requiredRowString(row, "created_at"),
  });
}

function decisionRowToRecord(row: SqliteRow): ReviewItemDecision {
  return validateRuntimeRecord(reviewItemDecisionSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    reviewId: requiredRowString(row, "review_id"),
    itemId: requiredRowString(row, "item_id"),
    decision: requiredRowString(row, "decision"),
    ...(optionalRowString(row, "reason") === undefined ? {} : { reason: optionalRowString(row, "reason") }),
    actorId: requiredRowString(row, "actor_id"),
    simulatedRole: requiredRowString(row, "simulated_role"),
    createdAt: requiredRowString(row, "created_at"),
  });
}

function confirmationRowToRecord(row: SqliteRow): PhysicianConfirmation {
  return validateRuntimeRecord(physicianConfirmationSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    encounterId: requiredRowString(row, "encounter_id"),
    reviewId: requiredRowString(row, "review_id"),
    recordRevisionId: requiredRowString(row, "record_revision_id"),
    revisionNumber: requiredRowInteger(row, "revision_number"),
    decisionSummary: parseStoredJson(
      requiredRowString(row, "decision_summary_json"),
      physicianConfirmationSchema.shape.decisionSummary,
      "decisionSummary",
    ),
    disclaimerVersion: requiredRowString(row, "disclaimer_version"),
    actorId: requiredRowString(row, "actor_id"),
    simulatedRole: requiredRowString(row, "simulated_role"),
    confirmedAt: requiredRowString(row, "confirmed_at"),
  });
}

export interface PreSignReviewRepository {
  insert(review: PreSignReview): void;
  getById(id: string): PreSignReview | undefined;
  getByEncounterRevision(encounterId: string, recordRevisionId: string): PreSignReview | undefined;
  listByEncounter(encounterId: string): PreSignReview[];
}

export interface ReviewItemDecisionRepository {
  insert(decision: ReviewItemDecision): void;
  getByReviewItem(reviewId: string, itemId: string): ReviewItemDecision | undefined;
  listByReview(reviewId: string): ReviewItemDecision[];
}

export interface PhysicianConfirmationRepository {
  insert(confirmation: PhysicianConfirmation): void;
  getByEncounter(encounterId: string): PhysicianConfirmation | undefined;
}

export function createPreSignReviewRepository(database: DatabaseSync): PreSignReviewRepository {
  const insertStatement = database.prepare(`
    INSERT INTO pre_sign_reviews (
      id, schema_version, encounter_id, record_revision_id, revision_number,
      ruleset_version, items_json, blocking_count, pending_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM pre_sign_reviews WHERE id = ?");
  const selectByEncounterRevisionStatement = database.prepare(
    "SELECT * FROM pre_sign_reviews WHERE encounter_id = ? AND record_revision_id = ?",
  );
  const listByEncounterStatement = database.prepare(`
    SELECT * FROM pre_sign_reviews
    WHERE encounter_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  return {
    insert(review) {
      const validated = validateRuntimeRecord(preSignReviewSchema, review);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.encounterId,
          validated.recordRevisionId,
          validated.revisionNumber,
          validated.rulesetVersion,
          stableJsonStringify(validated.items),
          validated.blockingCount,
          validated.pendingCount,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "Pre-sign review already exists for this Encounter revision or violates its binding.",
          );
        }
        throw databaseWriteError();
      }
    },
    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? reviewRowToRecord(row) : undefined;
    },
    getByEncounterRevision(encounterId, recordRevisionId) {
      const row = selectByEncounterRevisionStatement.get(encounterId, recordRevisionId) as SqliteRow | undefined;
      return row ? reviewRowToRecord(row) : undefined;
    },
    listByEncounter(encounterId) {
      return (listByEncounterStatement.all(encounterId) as SqliteRow[]).map(reviewRowToRecord);
    },
  };
}

export function createReviewItemDecisionRepository(database: DatabaseSync): ReviewItemDecisionRepository {
  const insertStatement = database.prepare(`
    INSERT INTO review_item_decisions (
      id, schema_version, review_id, item_id, decision, reason,
      actor_id, simulated_role, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByReviewItemStatement = database.prepare(
    "SELECT * FROM review_item_decisions WHERE review_id = ? AND item_id = ?",
  );
  const listByReviewStatement = database.prepare(`
    SELECT * FROM review_item_decisions
    WHERE review_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  return {
    insert(decision) {
      const validated = validateRuntimeRecord(reviewItemDecisionSchema, decision);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.reviewId,
          validated.itemId,
          validated.decision,
          validated.reason ?? null,
          validated.actorId,
          validated.simulatedRole,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "This review item has already received a decision.",
          );
        }
        throw databaseWriteError();
      }
    },
    getByReviewItem(reviewId, itemId) {
      const row = selectByReviewItemStatement.get(reviewId, itemId) as SqliteRow | undefined;
      return row ? decisionRowToRecord(row) : undefined;
    },
    listByReview(reviewId) {
      return (listByReviewStatement.all(reviewId) as SqliteRow[]).map(decisionRowToRecord);
    },
  };
}

export function createPhysicianConfirmationRepository(database: DatabaseSync): PhysicianConfirmationRepository {
  const insertStatement = database.prepare(`
    INSERT INTO physician_confirmations (
      id, schema_version, encounter_id, review_id, record_revision_id,
      revision_number, decision_summary_json, disclaimer_version,
      actor_id, simulated_role, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByEncounterStatement = database.prepare(
    "SELECT * FROM physician_confirmations WHERE encounter_id = ?",
  );

  return {
    insert(confirmation) {
      const validated = validateRuntimeRecord(physicianConfirmationSchema, confirmation);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.encounterId,
          validated.reviewId,
          validated.recordRevisionId,
          validated.revisionNumber,
          stableJsonStringify(validated.decisionSummary),
          validated.disclaimerVersion,
          validated.actorId,
          validated.simulatedRole,
          validated.confirmedAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "This Encounter already has a physician confirmation or violates its binding.",
          );
        }
        throw databaseWriteError();
      }
    },
    getByEncounter(encounterId) {
      const row = selectByEncounterStatement.get(encounterId) as SqliteRow | undefined;
      return row ? confirmationRowToRecord(row) : undefined;
    },
  };
}
