import type { DatabaseSync } from "node:sqlite";

import {
  feedbackActionSchema,
  feedbackCandidatePatchSchema,
  feedbackEventRecordSchema,
  feedbackEvidenceSchema,
  type FeedbackEventRecord,
} from "@/domain/runtime-records";
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
import { z } from "zod";

export interface FeedbackEventRepository {
  append(record: FeedbackEventRecord): void;
  getById(id: string): FeedbackEventRecord | undefined;
  listByGenerationRun(generationRunId: string): FeedbackEventRecord[];
  listByDraftRevision(draftRevisionId: string): FeedbackEventRecord[];
  listByStatusRisk(status?: FeedbackEventRecord["status"], riskLevel?: FeedbackEventRecord["riskLevel"]): FeedbackEventRecord[];
}

function optionalRowInteger(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored feedback record has an invalid integer field.",
      { fieldPath: column },
    );
  }
  return value;
}

function rowToRecord(row: SqliteRow): FeedbackEventRecord {
  const draftRevisionId = optionalRowString(row, "draft_revision_id");
  const revisionNumber = optionalRowInteger(row, "revision_number");
  const candidatePatchRaw = optionalRowString(row, "candidate_patch_json");
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    eventType: "FEEDBACK_CLASSIFIED" as const,
    generationRunId: requiredRowString(row, "generation_run_id"),
    ...(draftRevisionId ? { draftRevisionId } : {}),
    ...(revisionNumber === undefined ? {} : { revisionNumber }),
    proposalId: requiredRowString(row, "proposal_id"),
    profileId: requiredRowString(row, "profile_id"),
    profileVersion: requiredRowInteger(row, "profile_version"),
    rulesVersion: requiredRowString(row, "rules_version"),
    changeType: requiredRowString(row, "change_type"),
    status: requiredRowString(row, "status"),
    riskLevel: requiredRowString(row, "risk_level"),
    decision: requiredRowString(row, "decision"),
    affectedField: requiredRowString(row, "affected_field"),
    ruleHits: parseStoredJson(requiredRowString(row, "rule_hits_json"), z.array(z.string()), "ruleHits"),
    safetyReason: requiredRowString(row, "safety_reason"),
    nextAllowedActions: parseStoredJson(
      requiredRowString(row, "next_allowed_actions_json"),
      z.array(feedbackActionSchema),
      "nextAllowedActions",
    ),
    evidence: parseStoredJson(requiredRowString(row, "evidence_json"), feedbackEvidenceSchema, "evidence"),
    ...(candidatePatchRaw
      ? { candidatePatch: parseStoredJson(candidatePatchRaw, feedbackCandidatePatchSchema, "candidatePatch") }
      : {}),
    createdAt: requiredRowString(row, "created_at"),
  };

  return validateRuntimeRecord(feedbackEventRecordSchema, record);
}

export function createFeedbackEventRepository(database: DatabaseSync): FeedbackEventRepository {
  const insertStatement = database.prepare(`
    INSERT INTO feedback_events (
      id, schema_version, generation_run_id, event_type, status, risk_level,
      before_json, after_json, rule_hits_json, decision_json, created_at,
      draft_revision_id, revision_number, proposal_id, profile_id, profile_version,
      rules_version, change_type, affected_field, safety_reason,
      next_allowed_actions_json, evidence_json, candidate_patch_json, decision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM feedback_events WHERE id = ?");
  const listByGenerationRunStatement = database.prepare(`
    SELECT * FROM feedback_events
    WHERE generation_run_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const listByDraftRevisionStatement = database.prepare(`
    SELECT * FROM feedback_events
    WHERE draft_revision_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const listByStatusRiskStatement = database.prepare(`
    SELECT * FROM feedback_events
    WHERE (? IS NULL OR status = ?)
      AND (? IS NULL OR risk_level = ?)
    ORDER BY created_at ASC, id ASC
  `);

  return {
    append(record) {
      const validated = validateRuntimeRecord(feedbackEventRecordSchema, record);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.generationRunId,
          validated.eventType,
          validated.status,
          validated.riskLevel,
          "{}",
          "{}",
          stableJsonStringify(validated.ruleHits),
          stableJsonStringify({ decision: validated.decision }),
          validated.createdAt,
          validated.draftRevisionId ?? null,
          validated.revisionNumber ?? null,
          validated.proposalId,
          validated.profileId,
          validated.profileVersion,
          validated.rulesVersion,
          validated.changeType,
          validated.affectedField,
          validated.safetyReason,
          stableJsonStringify(validated.nextAllowedActions),
          stableJsonStringify(validated.evidence),
          validated.candidatePatch ? stableJsonStringify(validated.candidatePatch) : null,
          validated.decision,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Feedback event ID or reference already exists.");
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByGenerationRun(generationRunId) {
      return (listByGenerationRunStatement.all(generationRunId) as SqliteRow[]).map(rowToRecord);
    },

    listByDraftRevision(draftRevisionId) {
      return (listByDraftRevisionStatement.all(draftRevisionId) as SqliteRow[]).map(rowToRecord);
    },

    listByStatusRisk(status, riskLevel) {
      const statusValue = status ?? null;
      const riskValue = riskLevel ?? null;
      return (listByStatusRiskStatement.all(statusValue, statusValue, riskValue, riskValue) as SqliteRow[]).map(rowToRecord);
    },
  };
}
