import type { DatabaseSync } from "node:sqlite";

import {
  literatureFragmentSchema,
  literaturePageSchema,
  literatureParseRunSchema,
  type LiteratureFragment,
  type LiteraturePage,
  type LiteratureParseRun,
} from "@/domain/literature-parsing";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import {
  databaseWriteError,
  isSqliteConstraintError,
  optionalRowString,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

function rowToParseRun(row: SqliteRow): LiteratureParseRun {
  const completedAt = optionalRowString(row, "completed_at");
  const failureCode = optionalRowString(row, "failure_code");
  return literatureParseRunSchema.parse({
    schemaVersion: requiredRowString(row, "schema_version"),
    parseRunId: requiredRowString(row, "parse_run_id"),
    parseRequestId: requiredRowString(row, "parse_request_id"),
    requestFingerprint: requiredRowString(row, "request_fingerprint"),
    documentId: requiredRowString(row, "document_id"),
    versionId: requiredRowString(row, "version_id"),
    parserVersion: requiredRowString(row, "parser_version"),
    status: requiredRowString(row, "status"),
    pageCount: requiredRowInteger(row, "page_count"),
    codePointCount: requiredRowInteger(row, "code_point_count"),
    fragmentCount: requiredRowInteger(row, "fragment_count"),
    startedAt: requiredRowString(row, "started_at"),
    updatedAt: requiredRowString(row, "updated_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(failureCode === undefined ? {} : { failureCode }),
  });
}

function optionalRowInteger(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored literature parse record has an invalid integer field.",
      { fieldPath: column },
    );
  }
  return value;
}

function nullableInteger(row: SqliteRow, column: string): number | undefined {
  return optionalRowInteger(row, column);
}

function rowToFragment(row: SqliteRow): LiteratureFragment {
  const title = optionalRowString(row, "title");
  const pageNumber = nullableInteger(row, "page_number");
  const startCodePoint = nullableInteger(row, "start_code_point");
  const endCodePoint = nullableInteger(row, "end_code_point");
  const startLine = nullableInteger(row, "start_line");
  const endLine = nullableInteger(row, "end_line");
  const sourceKind = requiredRowString(row, "source_kind");
  const location = sourceKind === "PDF_PAGE"
    ? {
      kind: "PDF_PAGE" as const,
      pageNumber: pageNumber!,
      startCodePoint: startCodePoint!,
      endCodePoint: endCodePoint!,
    }
    : {
      kind: "TXT_LINES" as const,
      startLine: startLine!,
      endLine: endLine!,
      ...(title === undefined ? {} : { title }),
    };
  return literatureFragmentSchema.parse({
    schemaVersion: requiredRowString(row, "schema_version"),
    fragmentId: requiredRowString(row, "fragment_id"),
    parseRunId: requiredRowString(row, "parse_run_id"),
    pageId: requiredRowString(row, "page_id"),
    documentId: requiredRowString(row, "document_id"),
    versionId: requiredRowString(row, "version_id"),
    ordinal: requiredRowInteger(row, "ordinal"),
    sourceKind,
    location,
    text: requiredRowString(row, "text"),
    normalizedText: requiredRowString(row, "normalized_text"),
    textSha256: requiredRowString(row, "text_sha256"),
  });
}

export type LiteratureSearchCandidate = {
  fragment: LiteratureFragment;
  bm25: number;
};

export type LiteratureParsingRepository = {
  getParseRunByRequestId(parseRequestId: string): LiteratureParseRun | undefined;
  getParseRunById(parseRunId: string): LiteratureParseRun | undefined;
  getLatestParseRunByVersion(versionId: string): LiteratureParseRun | undefined;
  getReadyParseRunByVersion(versionId: string): LiteratureParseRun | undefined;
  insertParseRun(run: LiteratureParseRun): void;
  updateParseRun(runId: string, status: LiteratureParseRun["status"], updatedAt: string, counts?: { pageCount: number; codePointCount: number; fragmentCount: number }, failureCode?: LiteratureParseRun["failureCode"]): void;
  insertPage(page: LiteraturePage): void;
  insertFragment(fragment: LiteratureFragment): void;
  deleteRunContents(parseRunId: string): void;
  getFragmentById(fragmentId: string): LiteratureFragment | undefined;
  searchFts(matchExpression: string, documentIds: readonly string[], parseRunIds: readonly string[], limit: number): LiteratureSearchCandidate[];
  searchShort(normalizedQuery: string, documentIds: readonly string[], parseRunIds: readonly string[], limit: number): LiteratureSearchCandidate[];
  expireParsingRuns(cutoff: string, updatedAt: string): LiteratureParseRun[];
};

function conflictError(message: string): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.CONFLICT, message);
}

function parseRunUpdateError(): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Literature parse run state could not be updated.");
}

function documentPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function createLiteratureParsingRepository(database: DatabaseSync): LiteratureParsingRepository {
  const selectByRequest = database.prepare("SELECT * FROM literature_parse_runs WHERE parse_request_id = ?");
  const selectById = database.prepare("SELECT * FROM literature_parse_runs WHERE parse_run_id = ?");
  const selectLatestByVersion = database.prepare(`
    SELECT * FROM literature_parse_runs
    WHERE version_id = ?
    ORDER BY CASE status WHEN 'READY' THEN 0 WHEN 'PARSING' THEN 1 WHEN 'PENDING' THEN 2 ELSE 3 END,
      updated_at DESC, parse_run_id DESC
    LIMIT 1
  `);
  const selectReadyByVersion = database.prepare(
    "SELECT * FROM literature_parse_runs WHERE version_id = ? AND status = 'READY' LIMIT 1",
  );
  const insertRun = database.prepare(`
    INSERT INTO literature_parse_runs (
      parse_run_id, schema_version, parse_request_id, request_fingerprint, document_id, version_id,
      parser_version, status, page_count, code_point_count, fragment_count, started_at, updated_at,
      completed_at, failure_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPage = database.prepare(`
    INSERT INTO literature_pages (
      page_id, schema_version, parse_run_id, document_id, version_id, page_number, source_kind, text,
      code_point_count, text_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFragment = database.prepare(`
    INSERT INTO literature_fragments (
      fragment_id, schema_version, parse_run_id, page_id, document_id, version_id, ordinal, source_kind,
      page_number, start_code_point, end_code_point, start_line, end_line, title, text,
      normalized_text, text_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectFragment = database.prepare("SELECT * FROM literature_fragments WHERE fragment_id = ?");

  return {
    getParseRunByRequestId(parseRequestId) {
      const row = selectByRequest.get(parseRequestId) as SqliteRow | undefined;
      return row ? rowToParseRun(row) : undefined;
    },

    getParseRunById(parseRunId) {
      const row = selectById.get(parseRunId) as SqliteRow | undefined;
      return row ? rowToParseRun(row) : undefined;
    },

    getLatestParseRunByVersion(versionId) {
      const row = selectLatestByVersion.get(versionId) as SqliteRow | undefined;
      return row ? rowToParseRun(row) : undefined;
    },

    getReadyParseRunByVersion(versionId) {
      const row = selectReadyByVersion.get(versionId) as SqliteRow | undefined;
      return row ? rowToParseRun(row) : undefined;
    },

    insertParseRun(run) {
      const validated = literatureParseRunSchema.parse(run);
      try {
        insertRun.run(
          validated.parseRunId,
          validated.schemaVersion,
          validated.parseRequestId,
          validated.requestFingerprint,
          validated.documentId,
          validated.versionId,
          validated.parserVersion,
          validated.status,
          validated.pageCount,
          validated.codePointCount,
          validated.fragmentCount,
          validated.startedAt,
          validated.updatedAt,
          validated.completedAt ?? null,
          validated.failureCode ?? null,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) throw conflictError("Literature parse request or version is already being processed.");
        throw databaseWriteError();
      }
    },

    updateParseRun(runId, status, updatedAt, counts = { pageCount: 0, codePointCount: 0, fragmentCount: 0 }, failureCode) {
      const completedAt = status === "READY" ? updatedAt : null;
      const result = database.prepare(`
        UPDATE literature_parse_runs
        SET status = ?, page_count = ?, code_point_count = ?, fragment_count = ?, updated_at = ?,
            completed_at = ?, failure_code = ?
        WHERE parse_run_id = ?
      `).run(
        status,
        counts.pageCount,
        counts.codePointCount,
        counts.fragmentCount,
        updatedAt,
        completedAt,
        failureCode ?? null,
        runId,
      );
      if (Number(result.changes) !== 1) throw parseRunUpdateError();
    },

    insertPage(page) {
      const validated = literaturePageSchema.parse(page);
      try {
        insertPage.run(
          validated.pageId,
          validated.schemaVersion,
          validated.parseRunId,
          validated.documentId,
          validated.versionId,
          validated.pageNumber,
          validated.sourceKind,
          validated.text,
          validated.codePointCount,
          validated.textSha256,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) throw conflictError("Literature parse page already exists or is not bound to its run.");
        throw databaseWriteError();
      }
    },

    insertFragment(fragment) {
      const validated = literatureFragmentSchema.parse(fragment);
      const location = validated.location;
      try {
        insertFragment.run(
          validated.fragmentId,
          validated.schemaVersion,
          validated.parseRunId,
          validated.pageId,
          validated.documentId,
          validated.versionId,
          validated.ordinal,
          validated.sourceKind,
          location.kind === "PDF_PAGE" ? location.pageNumber : null,
          location.kind === "PDF_PAGE" ? location.startCodePoint : null,
          location.kind === "PDF_PAGE" ? location.endCodePoint : null,
          location.kind === "TXT_LINES" ? location.startLine : null,
          location.kind === "TXT_LINES" ? location.endLine : null,
          location.kind === "TXT_LINES" ? location.title ?? null : null,
          validated.text,
          validated.normalizedText,
          validated.textSha256,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) throw conflictError("Literature fragment already exists or is not bound to its page.");
        throw databaseWriteError();
      }
    },

    deleteRunContents(parseRunId) {
      try {
        database.prepare("DELETE FROM literature_pages WHERE parse_run_id = ?").run(parseRunId);
      } catch {
        throw databaseWriteError();
      }
    },

    getFragmentById(fragmentId) {
      const row = selectFragment.get(fragmentId) as SqliteRow | undefined;
      return row ? rowToFragment(row) : undefined;
    },

    searchFts(matchExpression, documentIds, parseRunIds, limit) {
      if (documentIds.length === 0 || parseRunIds.length === 0) return [];
      const documentIdPlaceholders = documentPlaceholders(documentIds.length);
      const parseRunPlaceholders = documentPlaceholders(parseRunIds.length);
      const rows = database.prepare(`
        SELECT f.*, bm25(literature_fragments_fts) AS bm25_score
        FROM literature_fragments_fts
        INNER JOIN literature_fragments f ON f.fragment_id = literature_fragments_fts.fragment_id
        WHERE literature_fragments_fts MATCH ?
          AND f.document_id IN (${documentIdPlaceholders})
          AND f.parse_run_id IN (${parseRunPlaceholders})
        ORDER BY bm25_score ASC, f.fragment_id ASC
        LIMIT ?
      `).all(matchExpression, ...documentIds, ...parseRunIds, limit) as Array<SqliteRow>;
      return rows.map((row) => ({ fragment: rowToFragment(row), bm25: typeof row.bm25_score === "number" ? row.bm25_score : 0 }));
    },

    searchShort(normalizedQuery, documentIds, parseRunIds, limit) {
      if (documentIds.length === 0 || parseRunIds.length === 0) return [];
      const documentIdPlaceholders = documentPlaceholders(documentIds.length);
      const parseRunPlaceholders = documentPlaceholders(parseRunIds.length);
      const rows = database.prepare(`
        SELECT f.*, 0.0 AS bm25_score
        FROM literature_fragments f
        WHERE instr(f.normalized_text, ?) > 0
          AND f.document_id IN (${documentIdPlaceholders})
          AND f.parse_run_id IN (${parseRunPlaceholders})
        ORDER BY f.fragment_id ASC
        LIMIT ?
      `).all(normalizedQuery, ...documentIds, ...parseRunIds, limit) as Array<SqliteRow>;
      return rows.map((row) => ({ fragment: rowToFragment(row), bm25: 0 }));
    },

    expireParsingRuns(cutoff, updatedAt) {
      const rows = database.prepare(
        "SELECT * FROM literature_parse_runs WHERE status = 'PARSING' AND updated_at < ? ORDER BY parse_run_id",
      ).all(cutoff) as SqliteRow[];
      for (const row of rows) {
        const run = rowToParseRun(row);
        this.deleteRunContents(run.parseRunId);
        this.updateParseRun(run.parseRunId, "FAILED", updatedAt, { pageCount: 0, codePointCount: 0, fragmentCount: 0 }, "PARSE_TIMEOUT");
      }
      return rows.map(rowToParseRun);
    },
  };
}
