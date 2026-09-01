import "server-only";

import type { DatabaseSync } from "node:sqlite";

import {
  LITERATURE_MIN_EVIDENCE_SCORE,
  LITERATURE_SEARCH_MAX_RESULTS,
  literatureCitationDtoSchema,
  literatureSearchRequestSchema,
  literatureSearchResponseSchema,
  normalizeLiteratureSearchText,
  truncateLiteratureExcerpt,
  type LiteratureCitationDto,
  type LiteratureSearchRequest,
  type LiteratureSearchResponse,
  type LiteratureSearchResult,
} from "@/domain/literature-parsing";
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";
import { getDatabase } from "@/server/database";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import { createLiteratureParsingRepository } from "@/infrastructure/sqlite/repositories/literature-parsing-repository";
import { createLiteratureRepository } from "@/infrastructure/sqlite/repositories/literature-repository";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { literatureError, literatureErrorCodes } from "@/infrastructure/literature/literature-errors";

export type LiteratureRetrievalDependencies = {
  databaseFactory?: () => DatabaseSync;
  runtimeMode?: AppRuntimeMode;
  env?: NodeJS.ProcessEnv;
};

function trustedLocalResearchMode(dependencies: LiteratureRetrievalDependencies): AppRuntimeMode {
  if (dependencies.runtimeMode !== undefined) {
    const parsed = appRuntimeModeSchema.safeParse(dependencies.runtimeMode);
    if (!parsed.success) throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
    if (parsed.data === "public-demo") {
      throw new PersistenceError(persistenceErrorCodes.RUNTIME_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE, { ruleId: PUBLIC_DEMO_READ_ONLY });
    }
    return parsed.data;
  }
  const gate = assertRuntimeWriteAllowed(dependencies.env);
  if (!gate.ok) {
    throw new PersistenceError(persistenceErrorCodes.RUNTIME_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE, { ruleId: PUBLIC_DEMO_READ_ONLY });
  }
  return gate.runtimeMode;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeRequest(value: unknown): LiteratureSearchRequest & { normalizedQuery: string } {
  const parsed = literatureSearchRequestSchema.safeParse(value);
  if (!parsed.success) throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
  const normalizedQuery = normalizeLiteratureSearchText(parsed.data.query);
  if (normalizedQuery.length === 0) throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
  return { ...parsed.data, normalizedQuery };
}

function safeFtsPhrase(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function queryUnits(query: string): string[] {
  const units = Array.from(query).filter((character) => !/\s/u.test(character));
  return [...new Set(units)];
}

function scoreCandidate(normalizedQuery: string, normalizedText: string, bm25: number): number {
  const units = queryUnits(normalizedQuery);
  const coverage = units.length === 0
    ? 0
    : units.filter((unit) => normalizedText.includes(unit)).length / units.length;
  const phrase = normalizedText.includes(normalizedQuery) ? 1 : 0;
  const bm25Boost = Math.max(0, Math.min(1, Number.isFinite(bm25) ? (-bm25 / 5) : 0));
  return Math.round((phrase * 0.6 + coverage * 0.3 + bm25Boost * 0.1) * 1_000_000) / 1_000_000;
}

function locationSortKey(citation: LiteratureCitationDto): string {
  return citation.location.kind === "PDF_PAGE"
    ? `0:${String(citation.location.pageNumber).padStart(8, "0")}:${String(citation.location.startCodePoint).padStart(10, "0")}`
    : `1:${String(citation.location.startLine).padStart(8, "0")}:${String(citation.location.endLine).padStart(8, "0")}`;
}

function sortResult(left: LiteratureSearchResult, right: LiteratureSearchResult): number {
  if (left.score !== right.score) return right.score - left.score;
  const display = compareText(left.citation.displayName, right.citation.displayName);
  if (display !== 0) return display;
  if (left.citation.version !== right.citation.version) return left.citation.version - right.citation.version;
  const location = compareText(locationSortKey(left.citation), locationSortKey(right.citation));
  if (location !== 0) return location;
  return compareText(left.citation.fragmentId, right.citation.fragmentId);
}

function citationFor(
  database: DatabaseSync,
  fragmentId: string,
  expectedDocumentId?: string,
  expectedVersionId?: string,
): LiteratureCitationDto | undefined {
  const parsingRepository = createLiteratureParsingRepository(database);
  const fragment = parsingRepository.getFragmentById(fragmentId);
  if (!fragment || (expectedDocumentId !== undefined && fragment.documentId !== expectedDocumentId)
    || (expectedVersionId !== undefined && fragment.versionId !== expectedVersionId)) return undefined;
  const literatureRepository = createLiteratureRepository(database);
  const document = literatureRepository.getDocumentById(fragment.documentId);
  const version = literatureRepository.getVersionById(fragment.versionId);
  const ready = parsingRepository.getReadyParseRunByVersion(fragment.versionId);
  if (!document || document.status !== "ACTIVE" || document.currentVersionId !== fragment.versionId
    || !version || version.documentId !== document.documentId || !ready || ready.parseRunId !== fragment.parseRunId) {
    return undefined;
  }
  return literatureCitationDtoSchema.parse({
    documentId: document.documentId,
    versionId: version.versionId,
    fragmentId: fragment.fragmentId,
    displayName: document.displayName,
    version: version.versionNumber,
    location: fragment.location,
    excerpt: truncateLiteratureExcerpt(fragment.text),
  });
}

export class LiteratureCitationResolver {
  constructor(private readonly database: DatabaseSync) {}

  resolve(input: { documentId: string; versionId: string; fragmentId: string }): LiteratureCitationDto {
    const citation = citationFor(this.database, input.fragmentId, input.documentId, input.versionId);
    if (!citation) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature citation was not found.");
    return citation;
  }
}

export function createLiteratureRetrievalService(dependencies: LiteratureRetrievalDependencies = {}) {
  const databaseFactory = dependencies.databaseFactory ?? getDatabase;

  function assertEncounterAllowed(database: DatabaseSync, encounterId: string): void {
    const row = database.prepare(
      "SELECT synthetic, runtime_mode FROM encounters WHERE id = ? LIMIT 1",
    ).get(encounterId) as { synthetic?: number; runtime_mode?: string } | undefined;
    if (!row || row.synthetic !== 1 || row.runtime_mode !== "local-research") {
      throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Current synthetic encounter was not found.");
    }
  }

  function selectedReadyDocuments(database: DatabaseSync, documentIds: readonly string[]) {
    const literatureRepository = createLiteratureRepository(database);
    const parsingRepository = createLiteratureParsingRepository(database);
    const selected: Array<{ documentId: string; parseRunId: string }> = [];
    for (const documentId of documentIds) {
      const document = literatureRepository.getDocumentById(documentId);
      if (!document || document.status !== "ACTIVE") throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Selected literature document was not found.");
      const version = literatureRepository.getAvailableVersion(documentId, document.currentVersion);
      if (!version || version.versionId !== document.currentVersionId) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Selected literature version was not found.");
      const ready = parsingRepository.getReadyParseRunByVersion(version.versionId);
      if (!ready) throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Selected literature document is not ready.");
      selected.push({ documentId, parseRunId: ready.parseRunId });
    }
    return selected;
  }

  function search(value: unknown): LiteratureSearchResponse {
    trustedLocalResearchMode(dependencies);
    const request = normalizeRequest(value);
    const database = databaseFactory();
    assertEncounterAllowed(database, request.encounterId);
    const selected = selectedReadyDocuments(database, request.documentIds);
    const selectedIds = selected.map((item) => item.documentId);
    const selectedRunIds = selected.map((item) => item.parseRunId);
    const parsingRepository = createLiteratureParsingRepository(database);
    const candidates = codePointLength(request.normalizedQuery) < 3
      ? parsingRepository.searchShort(request.normalizedQuery, selectedIds, selectedRunIds, 100)
      : parsingRepository.searchFts(safeFtsPhrase(request.normalizedQuery), selectedIds, selectedRunIds, 100);
    const results: LiteratureSearchResult[] = [];
    for (const candidate of candidates) {
      const citation = citationFor(database, candidate.fragment.fragmentId);
      if (!citation) continue;
      const score = scoreCandidate(request.normalizedQuery, candidate.fragment.normalizedText, candidate.bm25);
      if (score < LITERATURE_MIN_EVIDENCE_SCORE) continue;
      results.push({ citation, score });
    }
    results.sort(sortResult);
    const limited = results.slice(0, LITERATURE_SEARCH_MAX_RESULTS);
    if (limited.length === 0) return literatureSearchResponseSchema.parse({ status: "INSUFFICIENT_EVIDENCE", results: [] });
    return literatureSearchResponseSchema.parse({ status: "RESULTS", results: limited });
  }

  function resolveCitation(input: { documentId: string; versionId: string; fragmentId: string }): LiteratureCitationDto {
    trustedLocalResearchMode(dependencies);
    return new LiteratureCitationResolver(databaseFactory()).resolve(input);
  }

  return { search, resolveCitation };
}
