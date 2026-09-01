import type { DatabaseSync } from "node:sqlite";

import {
  auditEventRecordSchema,
  isoUtcTimestampSchema,
  jsonObjectSchema,
  type AuditEventRecord,
} from "@/domain/runtime-records";
import { z } from "zod";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import { parseStoredJson, stableJsonStringify, validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  invalidQueryLimit,
  isSqliteConstraintError,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export const AUDIT_EVENT_TYPES = [
  "GENERATION_RUN_SUCCEEDED",
  "GENERATION_RUN_FAILED",
  "GENERATION_REQUEST_BLOCKED",
  "GENERATION_RUN_RECORDED",
  "REVISION_SAVED",
  "DRAFT_VALIDATION_BLOCKED",
  "FEEDBACK_CLASSIFIED",
  "CANDIDATE_CONFIRMED",
  "CANDIDATE_DISMISSED",
  "REVIEW_APPROVED",
  "REVIEW_REJECTED",
  "PROFILE_VERSION_CREATED",
  "PROFILE_VERSION_APPENDED",
  "PROFILE_FROZEN",
  "PROFILE_ROLLED_BACK",
  "EVALUATION_STARTED",
  "EVALUATION_COMPLETED",
  "EVALUATION_PARTIAL_FAILURE",
  "EVALUATION_FAILED",
  "EVALUATION_EXPORTED",
  "EVALUATION_BATCH_RECORDED",
  "EVALUATION_RUN_RECORDED",
  "EVALUATION_RESULT_RECORDED",
  "DATASET_FEEDBACK_STARTED",
  "DATASET_FEEDBACK_RESULT_RECORDED",
  "DATASET_FEEDBACK_COMPLETED",
  "DATASET_FEEDBACK_INCOMPLETE",
  "ENCOUNTER_CREATED",
  "ENCOUNTER_STATUS_CHANGED",
  "MEDICAL_RECORD_REVISION_SAVED",
  "SPEECH_SESSION_STATUS_CHANGED",
  "SPEECH_SUGGESTIONS_PROCESSED",
  "PRE_SIGN_REVIEW_CREATED",
  "REVIEW_ITEM_DECISION_RECORDED",
  "PHYSICIAN_CONFIRMATION_RECORDED",
  "LITERATURE_IMPORT_BATCH_RESERVED",
  "LITERATURE_IMPORT_ITEM_VALIDATED",
  "LITERATURE_DOCUMENT_VERSION_AVAILABLE",
  "LITERATURE_IMPORT_BATCH_COMPLETED",
  "LITERATURE_IMPORT_FAILED",
  "LITERATURE_IMPORT_CANCELLED",
  "LITERATURE_PARSE_SUCCEEDED",
  "LITERATURE_PARSE_FAILED",
] as const;

export const AUDIT_SIMULATED_ROLES = ["SYSTEM", "PHYSICIAN", "REVIEWER", "RESEARCHER"] as const;
export const AUDIT_ENTITY_TYPES = [
  "GENERATION_REQUEST",
  "GENERATION_RUN",
  "DRAFT_REVISION",
  "FEEDBACK_EVENT",
  "PHYSICIAN_PROFILE",
  "PHYSICIAN_PROFILE_VERSION",
  "EVALUATION_BATCH",
  "EVALUATION_RUN",
  "EVALUATION_RESULT",
  "FEEDBACK_EVALUATION_RESULT",
  "ENCOUNTER",
  "SPEECH_SESSION",
  "LITERATURE_IMPORT_BATCH",
  "LITERATURE_IMPORT_ITEM",
  "LITERATURE_DOCUMENT",
  "LITERATURE_DOCUMENT_VERSION",
  "LITERATURE_PARSE_RUN",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditSimulatedRole = (typeof AUDIT_SIMULATED_ROLES)[number];
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export type AuditEventQuery = {
  eventType?: AuditEventType;
  simulatedRole?: AuditSimulatedRole;
  entityType?: AuditEntityType;
  entityId?: string;
  generationRunId?: string;
  limit?: number;
  cursor?: string;
};

export type AuditCursor = { createdAt: string; id: string };
export type AuditEventPage = { items: AuditEventRecord[]; nextCursor?: string };

const auditCursorSchema = z.object({
  createdAt: isoUtcTimestampSchema,
  id: z.string().min(1).max(200),
}).strict();
const MAX_AUDIT_QUERY_LIMIT = 100;

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(auditCursorSchema.parse(cursor)), "utf8").toString("base64url");
}

export function decodeAuditCursor(value: string): AuditCursor {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = auditCursorSchema.safeParse(JSON.parse(decoded));
    if (!parsed.success) throw new Error("invalid cursor");
    return parsed.data;
  } catch {
    throw new PersistenceError(
      persistenceErrorCodes.VALIDATION_FAILED,
      "Audit cursor is invalid.",
      { fieldPath: "cursor" },
    );
  }
}

function assertAllowedFilter<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  fieldPath: string,
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new PersistenceError(
      persistenceErrorCodes.VALIDATION_FAILED,
      "Audit filter is not allowed.",
      { fieldPath },
    );
  }
}

function assertQueryText(value: string | undefined, fieldPath: string, maxLength = 200): void {
  if (value !== undefined && (typeof value !== "string" || value.length > maxLength)) {
    throw new PersistenceError(
      persistenceErrorCodes.VALIDATION_FAILED,
      "Audit query text is invalid.",
      { fieldPath },
    );
  }
}

export interface AuditEventRepository {
  append(event: AuditEventRecord): void;
  getById(id: string): AuditEventRecord | undefined;
  listByEntity(entityType: string, entityId: string): AuditEventRecord[];
  listPage(filter?: AuditEventQuery): AuditEventPage;
  listByGenerationRun(generationRunId: string): AuditEventRecord[];
}

function rowToRecord(row: SqliteRow): AuditEventRecord {
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    eventType: requiredRowString(row, "event_type"),
    actorId: requiredRowString(row, "actor_id"),
    simulatedRole: requiredRowString(row, "simulated_role"),
    entityType: requiredRowString(row, "entity_type"),
    entityId: requiredRowString(row, "entity_id"),
    ...(row.before_version === null || row.before_version === undefined
      ? {}
      : { beforeVersion: requiredRowString(row, "before_version") }),
    ...(row.after_version === null || row.after_version === undefined
      ? {}
      : { afterVersion: requiredRowString(row, "after_version") }),
    metadata: parseStoredJson(
      requiredRowString(row, "metadata_json"),
      jsonObjectSchema,
      "metadata",
    ),
    createdAt: requiredRowString(row, "created_at"),
  };

  return validateRuntimeRecord(auditEventRecordSchema, record);
}

export function createAuditEventRepository(database: DatabaseSync): AuditEventRepository {
  const insertStatement = database.prepare(`
    INSERT INTO audit_events (
      id, schema_version, event_type, actor_id, simulated_role,
      entity_type, entity_id, before_version, after_version, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM audit_events WHERE id = ?");
  const listByEntityStatement = database.prepare(`
    SELECT * FROM audit_events
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  return {
    append(event) {
      const validated = validateRuntimeRecord(auditEventRecordSchema, event);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.eventType,
          validated.actorId,
          validated.simulatedRole,
          validated.entityType,
          validated.entityId,
          validated.beforeVersion ?? null,
          validated.afterVersion ?? null,
          stableJsonStringify(validated.metadata),
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "Audit event ID already exists.",
          );
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByEntity(entityType, entityId) {
      const rows = listByEntityStatement.all(entityType, entityId) as SqliteRow[];
      return rows.map(rowToRecord);
    },

    listPage(filter: AuditEventQuery = {}) {
      const limit = filter.limit ?? 50;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_AUDIT_QUERY_LIMIT) throw invalidQueryLimit();
      assertAllowedFilter(filter.eventType, AUDIT_EVENT_TYPES, "eventType");
      assertAllowedFilter(filter.simulatedRole, AUDIT_SIMULATED_ROLES, "simulatedRole");
      assertAllowedFilter(filter.entityType, AUDIT_ENTITY_TYPES, "entityType");
      assertQueryText(filter.entityId, "entityId");
      assertQueryText(filter.generationRunId, "generationRunId");
      assertQueryText(filter.cursor, "cursor", 1_000);

      const conditions: string[] = [];
      const parameters: Array<string | number> = [];
      if (filter.eventType) {
        conditions.push("event_type = ?");
        parameters.push(filter.eventType);
      }
      if (filter.simulatedRole) {
        conditions.push("simulated_role = ?");
        parameters.push(filter.simulatedRole);
      }
      if (filter.entityType) {
        conditions.push("entity_type = ?");
        parameters.push(filter.entityType);
      }
      if (filter.entityId) {
        conditions.push("entity_id = ?");
        parameters.push(filter.entityId);
      }
      if (filter.generationRunId) {
        conditions.push("((entity_type = 'GENERATION_RUN' AND entity_id = ?) OR json_extract(metadata_json, '$.generationRunId') = ? OR json_extract(metadata_json, '$.runId') = ?)");
        parameters.push(filter.generationRunId, filter.generationRunId, filter.generationRunId);
      }
      if (filter.cursor) {
        const cursor = decodeAuditCursor(filter.cursor);
        conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
        parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = database.prepare(`
        SELECT * FROM audit_events
        ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(...parameters, limit + 1) as SqliteRow[];
      const records = rows.map(rowToRecord);
      const hasNext = records.length > limit;
      if (hasNext) records.pop();
      return {
        items: records,
        ...(hasNext && records.length > 0
          ? { nextCursor: encodeAuditCursor({ createdAt: records[records.length - 1].createdAt, id: records[records.length - 1].id }) }
          : {}),
      };
    },

    listByGenerationRun(generationRunId) {
      const records: AuditEventRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = this.listPage({ generationRunId, limit: MAX_AUDIT_QUERY_LIMIT, ...(cursor ? { cursor } : {}) });
        records.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return records;
    },
  };
}
