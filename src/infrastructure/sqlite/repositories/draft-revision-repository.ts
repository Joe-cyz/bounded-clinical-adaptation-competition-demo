import type { DatabaseSync } from "node:sqlite";

import {
  draftRevisionDiffSummarySchema,
  draftRevisionRecordSchema,
  type DraftRevisionRecord,
} from "@/domain/draft-revisions";
import { generatedDraftSchema } from "@/domain/schemas";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import { parseStoredJson, stableJsonStringify, validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  isSqliteConstraintError,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export interface DraftRevisionRepository {
  append(record: DraftRevisionRecord, expectedPreviousRevision?: number): void;
  getById(id: string): DraftRevisionRecord | undefined;
  getLatestByGenerationRun(generationRunId: string): DraftRevisionRecord | undefined;
  listByGenerationRun(generationRunId: string): DraftRevisionRecord[];
}

function rowToRecord(row: SqliteRow): DraftRevisionRecord {
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    generationRunId: requiredRowString(row, "generation_run_id"),
    revisionNumber: requiredRowInteger(row, "revision_number"),
    beforeSnapshot: parseStoredJson(
      requiredRowString(row, "before_json"),
      generatedDraftSchema,
      "beforeSnapshot",
    ),
    afterSnapshot: parseStoredJson(
      requiredRowString(row, "after_json"),
      generatedDraftSchema,
      "afterSnapshot",
    ),
    diffSummary: parseStoredJson(
      requiredRowString(row, "diff_summary_json"),
      draftRevisionDiffSummarySchema,
      "diffSummary",
    ),
    editorId: requiredRowString(row, "editor_id"),
    createdAt: requiredRowString(row, "created_at"),
  };

  return validateRuntimeRecord(draftRevisionRecordSchema, record);
}

export function createDraftRevisionRepository(database: DatabaseSync): DraftRevisionRepository {
  const insertStatement = database.prepare(`
    INSERT INTO draft_revisions (
      id, schema_version, generation_run_id, revision_number,
      before_json, after_json, diff_summary_json, editor_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM draft_revisions WHERE id = ?");
  const selectLatestStatement = database.prepare(`
    SELECT * FROM draft_revisions
    WHERE generation_run_id = ?
    ORDER BY revision_number DESC
    LIMIT 1
  `);
  const listByGenerationRunStatement = database.prepare(`
    SELECT * FROM draft_revisions
    WHERE generation_run_id = ?
    ORDER BY revision_number ASC, created_at ASC, id ASC
  `);

  return {
    append(record, expectedPreviousRevision) {
      const validated = validateRuntimeRecord(draftRevisionRecordSchema, record);
      const latestRow = selectLatestStatement.get(validated.generationRunId) as SqliteRow | undefined;
      const latest = latestRow ? rowToRecord(latestRow) : undefined;
      const currentRevision = latest?.revisionNumber ?? 0;
      const expectedRevision = expectedPreviousRevision ?? 0;

      if (currentRevision !== expectedRevision) {
        throw new PersistenceError(
          persistenceErrorCodes.CONFLICT,
          "Draft revision optimistic concurrency check failed.",
        );
      }
      if (validated.revisionNumber !== currentRevision + 1) {
        throw new PersistenceError(
          persistenceErrorCodes.CONFLICT,
          "Draft revision number must be continuous.",
        );
      }
      if (latest && stableJsonStringify(validated.beforeSnapshot) !== stableJsonStringify(latest.afterSnapshot)) {
        throw new PersistenceError(
          persistenceErrorCodes.CONFLICT,
          "Draft revision before snapshot does not match the latest revision.",
        );
      }

      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.generationRunId,
          validated.revisionNumber,
          stableJsonStringify(validated.beforeSnapshot),
          stableJsonStringify(validated.afterSnapshot),
          stableJsonStringify(validated.diffSummary),
          validated.editorId,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "Draft revision ID or revision number already exists.",
          );
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    getLatestByGenerationRun(generationRunId) {
      const row = selectLatestStatement.get(generationRunId) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByGenerationRun(generationRunId) {
      const rows = listByGenerationRunStatement.all(generationRunId) as SqliteRow[];
      return rows.map(rowToRecord);
    },
  };
}
