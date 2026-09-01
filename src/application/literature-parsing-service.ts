import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  LITERATURE_MAX_DOCUMENT_CODE_POINTS,
  LITERATURE_MAX_FRAGMENTS,
  LITERATURE_MAX_PAGE_CODE_POINTS,
  LITERATURE_MAX_PDF_PAGES,
  LITERATURE_PARSE_TIMEOUT_MS,
  LITERATURE_PARSER_SCHEMA_VERSION,
  LITERATURE_PARSER_VERSION,
  literatureFragmentSchema,
  literaturePageSchema,
  literatureParseRequestSchema,
  literatureParseRunSchema,
  normalizeLiteratureNewlines,
  normalizeLiteratureSearchText,
  splitLiteraturePage,
  type LiteratureFragment,
  type LiteraturePage,
  type LiteratureParseFailureCode,
  type LiteratureParseRequest,
  type LiteratureParseRun,
} from "@/domain/literature-parsing";
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";
import { type AuditEventRecord } from "@/domain/runtime-records";
import { getDatabase } from "@/server/database";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createLiteratureParsingRepository, type LiteratureParsingRepository } from "@/infrastructure/sqlite/repositories/literature-parsing-repository";
import { createLiteratureRepository } from "@/infrastructure/sqlite/repositories/literature-repository";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { stableJsonStringify } from "@/infrastructure/sqlite/record-validation";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { literatureError, literatureErrorCodes } from "@/infrastructure/literature/literature-errors";
import {
  defaultLiteratureOperationCoordinator,
  type LiteratureOperationCoordinator,
} from "@/infrastructure/literature/literature-operation-coordinator";
import { createLocalLiteratureFileStorage, type LiteratureFileStorage } from "@/infrastructure/literature/literature-file-storage";
import {
  isLiteratureParsingFailure,
  LiteratureParsingFailure,
  type ExtractedLiteraturePage,
  type LiteratureTextExtractorPort,
} from "@/infrastructure/literature/literature-text-extractor";
import { UnpdfLiteratureTextExtractor } from "@/infrastructure/literature/unpdf-literature-text-extractor";
import { readLiteratureRuntimePaths } from "@/server/literature-runtime-config";
import { createRandomSystemId } from "./system-id";

export type LiteratureParsingIdKind = "PARSE_RUN" | "AUDIT" | "PAGE" | "FRAGMENT";
export type LiteratureParsingIdFactory = (kind: LiteratureParsingIdKind) => string;
export type LiteratureParsingClock = () => string;

export type LiteratureParsingDependencies = {
  databaseFactory?: () => DatabaseSync;
  storageFactory?: () => LiteratureFileStorage;
  extractorFactory?: () => LiteratureTextExtractorPort;
  runtimeMode?: AppRuntimeMode;
  env?: NodeJS.ProcessEnv;
  clock?: LiteratureParsingClock;
  idFactory?: LiteratureParsingIdFactory;
  coordinator?: LiteratureOperationCoordinator;
  timeoutMs?: number;
  actorId?: string;
};

export type LiteratureParseResult = {
  parseRun: LiteratureParseRun;
  idempotencyResult: "CREATED" | "REPLAYED" | "IN_PROGRESS";
};

type ParsedPage = {
  page: LiteraturePage;
  fragments: LiteratureFragment[];
};

const defaultClock: LiteratureParsingClock = () => new Date().toISOString();
const defaultIdFactory: LiteratureParsingIdFactory = (kind) => createRandomSystemId(`literature-${kind.toLowerCase()}`);

function trustedLocalResearchMode(dependencies: LiteratureParsingDependencies): AppRuntimeMode {
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

function nowIso(clock: LiteratureParsingClock): string {
  const value = clock();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) {
    throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
  }
  return value;
}

function parseRequest(value: unknown): LiteratureParseRequest {
  const parsed = literatureParseRequestSchema.safeParse(value);
  if (!parsed.success) throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
  return parsed.data;
}

function fingerprint(documentId: string, versionId: string): string {
  return createHash("sha256")
    .update(stableJsonStringify({ documentId, versionId }), "utf8")
    .digest("hex");
}

function idHash(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function textHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function auditEvent(
  dependencies: LiteratureParsingDependencies,
  idFactory: LiteratureParsingIdFactory,
  eventType: "LITERATURE_PARSE_SUCCEEDED" | "LITERATURE_PARSE_FAILED",
  run: LiteratureParseRun,
  createdAt: string,
): AuditEventRecord {
  return {
    schemaVersion: "1.0.0",
    id: idFactory("AUDIT"),
    eventType,
    actorId: dependencies.actorId ?? "literature-parsing-service",
    simulatedRole: "SYSTEM",
    entityType: "LITERATURE_PARSE_RUN",
    entityId: run.parseRunId,
    metadata: eventType === "LITERATURE_PARSE_SUCCEEDED"
      ? {
        parseRunId: run.parseRunId,
        documentId: run.documentId,
        versionId: run.versionId,
        status: run.status,
        parserVersion: run.parserVersion,
        pageCount: run.pageCount,
        codePointCount: run.codePointCount,
        fragmentCount: run.fragmentCount,
      }
      : {
        parseRunId: run.parseRunId,
        documentId: run.documentId,
        versionId: run.versionId,
        status: run.status,
        parserVersion: run.parserVersion,
        failureCode: run.failureCode ?? "PUBLISH_FAILED",
      },
    createdAt,
  };
}

async function closeHandle(handle: Awaited<ReturnType<NonNullable<LiteratureFileStorage["openObject"]>>>): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw new LiteratureParsingFailure("CLEANUP_FAILED");
  }
}

async function readHandle(
  handle: Awaited<ReturnType<NonNullable<LiteratureFileStorage["openObject"]>>>,
  collect: boolean,
): Promise<{ bytesRead: number; sha256: string; bytes?: Uint8Array }> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let bytesRead = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, position);
    if (result.bytesRead === 0) break;
    const chunk = buffer.subarray(0, result.bytesRead);
    hash.update(chunk);
    if (collect) chunks.push(Buffer.from(chunk));
    bytesRead += result.bytesRead;
    position += result.bytesRead;
    if (bytesRead > 104_857_600) throw new LiteratureParsingFailure("DOCUMENT_TEXT_EXCEEDED");
  }
  return {
    bytesRead,
    sha256: hash.digest("hex"),
    ...(collect ? { bytes: new Uint8Array(Buffer.concat(chunks)) } : {}),
  };
}

async function readAndVerifyObject(
  storage: LiteratureFileStorage,
  storageKey: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<Uint8Array> {
  if (!storage.openObject) throw new LiteratureParsingFailure("UNSAFE_OBJECT_PATH");
  let firstHandle: Awaited<ReturnType<NonNullable<LiteratureFileStorage["openObject"]>>>;
  try {
    firstHandle = await storage.openObject(storageKey);
  } catch {
    throw new LiteratureParsingFailure("STORAGE_MISSING");
  }
  try {
    const first = await readHandle(firstHandle, false);
    await closeHandle(firstHandle);
    if (first.bytesRead !== expectedSize || first.sha256 !== expectedSha256) {
      throw new LiteratureParsingFailure("SHA_MISMATCH");
    }
  } catch (error) {
    try { await firstHandle.close(); } catch { /* controlled below */ }
    if (isLiteratureParsingFailure(error)) throw error;
    throw new LiteratureParsingFailure("STORAGE_MISSING");
  }

  let secondHandle: Awaited<ReturnType<NonNullable<LiteratureFileStorage["openObject"]>>>;
  try {
    secondHandle = await storage.openObject(storageKey);
  } catch {
    throw new LiteratureParsingFailure("STORAGE_MISSING");
  }
  try {
    const second = await readHandle(secondHandle, true);
    await closeHandle(secondHandle);
    if (second.bytesRead !== expectedSize || second.sha256 !== expectedSha256 || !second.bytes) {
      throw new LiteratureParsingFailure("SHA_MISMATCH");
    }
    return second.bytes;
  } catch (error) {
    try { await secondHandle.close(); } catch { /* controlled below */ }
    if (isLiteratureParsingFailure(error)) throw error;
    throw new LiteratureParsingFailure("STORAGE_MISSING");
  }
}

function makePage(
  documentId: string,
  versionId: string,
  parseRunId: string,
  sourceKind: "PDF_PAGE" | "TXT_LINES",
  pageNumber: number,
  text: string,
): LiteraturePage {
  const normalizedText = normalizeLiteratureNewlines(text);
  return literaturePageSchema.parse({
    schemaVersion: LITERATURE_PARSER_SCHEMA_VERSION,
    pageId: idHash("literature-page", `${versionId}|${sourceKind}|${pageNumber}|${textHash(normalizedText)}`),
    parseRunId,
    documentId,
    versionId,
    pageNumber,
    sourceKind,
    text: normalizedText,
    codePointCount: codePointLength(normalizedText),
    textSha256: textHash(normalizedText),
  });
}

function makeFragments(page: LiteraturePage, title?: string): LiteratureFragment[] {
  return splitLiteraturePage({
    sourceKind: page.sourceKind,
    pageNumber: page.pageNumber,
    text: page.text,
    ...(title === undefined ? {} : { title }),
  }).map((chunk) => {
    const normalizedText = normalizeLiteratureSearchText(chunk.text);
    if (normalizedText.length === 0) return undefined;
    return literatureFragmentSchema.parse({
      schemaVersion: LITERATURE_PARSER_SCHEMA_VERSION,
      fragmentId: idHash(
        "literature-fragment",
        `${page.versionId}|${chunk.sourceKind}|${chunk.pageNumber}|${chunk.startCodePoint}|${chunk.endCodePoint}|${normalizedText}`,
      ),
      parseRunId: page.parseRunId,
      pageId: page.pageId,
      documentId: page.documentId,
      versionId: page.versionId,
      ordinal: 0,
      sourceKind: chunk.sourceKind,
      location: chunk.location,
      text: chunk.text,
      normalizedText,
      textSha256: textHash(chunk.text),
    });
  }).filter((fragment): fragment is LiteratureFragment => fragment !== undefined);
}

function parseText(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) throw new Error("control");
    if (value.trim().length === 0) throw new Error("empty");
    return normalizeLiteratureNewlines(value);
  } catch {
    throw new LiteratureParsingFailure("INVALID_TEXT");
  }
}

function buildPages(
  documentId: string,
  versionId: string,
  parseRunId: string,
  format: "PDF" | "UTF8_TEXT",
  extracted: readonly ExtractedLiteraturePage[],
): ParsedPage[] {
  if (extracted.length === 0 || extracted.length > LITERATURE_MAX_PDF_PAGES) {
    throw new LiteratureParsingFailure(extracted.length === 0 ? "NO_TEXT_LAYER" : "PAGES_EXCEEDED");
  }
  let totalCodePoints = 0;
  const parsed: ParsedPage[] = [];
  let fragmentCount = 0;
  for (const extractedPage of extracted) {
    const text = normalizeLiteratureNewlines(extractedPage.text);
    const count = codePointLength(text);
    if (count > LITERATURE_MAX_PAGE_CODE_POINTS) throw new LiteratureParsingFailure("PAGE_TEXT_EXCEEDED");
    totalCodePoints += count;
    if (totalCodePoints > LITERATURE_MAX_DOCUMENT_CODE_POINTS) throw new LiteratureParsingFailure("DOCUMENT_TEXT_EXCEEDED");
    const page = makePage(documentId, versionId, parseRunId, format === "PDF" ? "PDF_PAGE" : "TXT_LINES", extractedPage.pageNumber, text);
    const fragments = makeFragments(page);
    if (fragmentCount + fragments.length > LITERATURE_MAX_FRAGMENTS) throw new LiteratureParsingFailure("FRAGMENTS_EXCEEDED");
    parsed.push({
      page,
      fragments: fragments.map((fragment, ordinal) => ({ ...fragment, ordinal: fragmentCount + ordinal })),
    });
    fragmentCount += fragments.length;
  }
  if (totalCodePoints === 0) throw new LiteratureParsingFailure("NO_TEXT_LAYER");
  return parsed;
}

async function parseObject(
  version: { format: "PDF" | "UTF8_TEXT"; storageKey: string; sha256: string; sizeBytes: number },
  documentId: string,
  versionId: string,
  parseRunId: string,
  storage: LiteratureFileStorage,
  extractor: LiteratureTextExtractorPort,
  timeoutMs: number,
): Promise<ParsedPage[]> {
  const bytes = await readAndVerifyObject(storage, version.storageKey, version.sha256, version.sizeBytes);
  if (version.format === "UTF8_TEXT") {
    return buildPages(documentId, versionId, parseRunId, version.format, [{ pageNumber: 1, text: parseText(bytes) }]);
  }
  const extracted = await extractor.extractPdf(bytes, { timeoutMs });
  return buildPages(documentId, versionId, parseRunId, version.format, extracted);
}

function failureCodeOf(error: unknown): LiteratureParseFailureCode {
  if (isLiteratureParsingFailure(error)) return error.code;
  if (error instanceof PersistenceError && error.code === literatureErrorCodes.CLEANUP_FAILED) return "CLEANUP_FAILED";
  return "PUBLISH_FAILED";
}

export function createLiteratureParsingService(dependencies: LiteratureParsingDependencies = {}) {
  const databaseFactory = dependencies.databaseFactory ?? getDatabase;
  const storageFactory = dependencies.storageFactory ?? (() => {
    const configuredRoot = readLiteratureRuntimePaths(dependencies.env).storageRoot;
    return createLocalLiteratureFileStorage(configuredRoot);
  });
  const extractorFactory = dependencies.extractorFactory ?? (() => new UnpdfLiteratureTextExtractor());
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const coordinator = dependencies.coordinator ?? defaultLiteratureOperationCoordinator;
  const timeoutMs = dependencies.timeoutMs ?? LITERATURE_PARSE_TIMEOUT_MS;

  function markFailed(
    database: DatabaseSync,
    repository: LiteratureParsingRepository,
    runId: string,
    code: LiteratureParseFailureCode,
  ): void {
    const at = nowIso(clock);
    withTransaction(database, () => {
      repository.deleteRunContents(runId);
      repository.updateParseRun(runId, "FAILED", at, { pageCount: 0, codePointCount: 0, fragmentCount: 0 }, code);
      const run = repository.getParseRunById(runId);
      if (run) createAuditEventRepository(database).append(auditEvent(dependencies, idFactory, "LITERATURE_PARSE_FAILED", run, at));
    });
  }

  async function parseVersion(input: { documentId: string; versionId: string; request: unknown }): Promise<LiteratureParseResult> {
    trustedLocalResearchMode(dependencies);
    const request = parseRequest(input.request);
    const requestFingerprint = fingerprint(input.documentId, input.versionId);
    const lease = await coordinator.enterMutation();
    try {
      const database = databaseFactory();
      const repository = createLiteratureParsingRepository(database);
      const existingRequest = repository.getParseRunByRequestId(request.parseRequestId);
      if (existingRequest) {
        if (existingRequest.requestFingerprint !== requestFingerprint) throw literatureError(literatureErrorCodes.PARSE_REQUEST_CONFLICT);
        return {
          parseRun: existingRequest,
          idempotencyResult: existingRequest.status === "PARSING" ? "IN_PROGRESS" : "REPLAYED",
        };
      }

      const literatureRepository = createLiteratureRepository(database);
      const document = literatureRepository.getDocumentById(input.documentId);
      const version = literatureRepository.getVersionById(input.versionId);
      if (!document || !version || document.status !== "ACTIVE" || document.currentVersionId !== input.versionId
        || version.documentId !== input.documentId || version.versionNumber !== document.currentVersion) {
        throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature document version was not found.");
      }
      const available = literatureRepository.getAvailableVersion(input.documentId, document.currentVersion);
      if (!available || available.versionId !== version.versionId) throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Literature document version is not available.");

      const ready = repository.getReadyParseRunByVersion(version.versionId);
      if (ready) return { parseRun: ready, idempotencyResult: "REPLAYED" };
      const active = repository.getLatestParseRunByVersion(version.versionId);
      if (active?.status === "PARSING") return { parseRun: active, idempotencyResult: "IN_PROGRESS" };

      const startedAt = nowIso(clock);
      const run = literatureParseRunSchema.parse({
        schemaVersion: LITERATURE_PARSER_SCHEMA_VERSION,
        parseRunId: idFactory("PARSE_RUN"),
        parseRequestId: request.parseRequestId,
        requestFingerprint,
        documentId: input.documentId,
        versionId: input.versionId,
        parserVersion: LITERATURE_PARSER_VERSION,
        status: "PARSING",
        pageCount: 0,
        codePointCount: 0,
        fragmentCount: 0,
        startedAt,
        updatedAt: startedAt,
      });
      try {
        withTransaction(database, () => repository.insertParseRun(run));
      } catch (error) {
        if (error instanceof PersistenceError && error.code === persistenceErrorCodes.CONFLICT) {
          const winner = repository.getReadyParseRunByVersion(version.versionId) ?? repository.getLatestParseRunByVersion(version.versionId);
          if (winner?.status === "READY") return { parseRun: winner, idempotencyResult: "REPLAYED" };
          if (winner?.status === "PARSING") return { parseRun: winner, idempotencyResult: "IN_PROGRESS" };
        }
        throw error;
      }

      let parsedPages: ParsedPage[];
      try {
        parsedPages = await parseObject(version, input.documentId, input.versionId, run.parseRunId, storageFactory(), extractorFactory(), timeoutMs);
      } catch (error) {
        const code = failureCodeOf(error);
        try {
          markFailed(database, repository, run.parseRunId, code);
        } catch {
          throw new LiteratureParsingFailure("CLEANUP_FAILED");
        }
        throw error instanceof Error ? error : new LiteratureParsingFailure(code);
      }

      const pageCount = parsedPages.length;
      const codePointCount = parsedPages.reduce((total, entry) => total + entry.page.codePointCount, 0);
      const fragmentCount = parsedPages.reduce((total, entry) => total + entry.fragments.length, 0);
      try {
        withTransaction(database, () => {
          const currentRun = repository.getParseRunById(run.parseRunId);
          if (!currentRun || currentRun.status !== "PARSING") throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Literature parse run is no longer active.");
          for (const entry of parsedPages) {
            repository.insertPage(entry.page);
            for (const fragment of entry.fragments) repository.insertFragment(fragment);
          }
          const at = nowIso(clock);
          repository.updateParseRun(run.parseRunId, "READY", at, { pageCount, codePointCount, fragmentCount });
          const readyRun = repository.getParseRunById(run.parseRunId);
          if (!readyRun) throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Literature parse run disappeared.");
           createAuditEventRepository(database).append(auditEvent(dependencies, idFactory, "LITERATURE_PARSE_SUCCEEDED", readyRun, at));
         });
       } catch {
        try {
          markFailed(database, repository, run.parseRunId, "PUBLISH_FAILED");
        } catch {
          throw new LiteratureParsingFailure("CLEANUP_FAILED");
        }
        throw new LiteratureParsingFailure("PUBLISH_FAILED");
      }
      const readyRun = repository.getParseRunById(run.parseRunId);
      if (!readyRun) throw new LiteratureParsingFailure("PUBLISH_FAILED");
      return { parseRun: readyRun, idempotencyResult: "CREATED" };
    } finally {
      lease.release();
    }
  }

  async function parseCurrentDocument(input: { documentId: string; request: unknown }): Promise<LiteratureParseResult> {
    trustedLocalResearchMode(dependencies);
    const database = databaseFactory();
    const document = createLiteratureRepository(database).getDocumentById(input.documentId);
    if (!document || document.status !== "ACTIVE") {
      throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature document was not found.");
    }
    return parseVersion({ documentId: input.documentId, versionId: document.currentVersionId, request: input.request });
  }

  async function reconcile(staleAfterMs = LITERATURE_PARSE_TIMEOUT_MS): Promise<{ expiredRuns: number }> {
    trustedLocalResearchMode(dependencies);
    const lease = await coordinator.enterMaintenance();
    try {
      const database = databaseFactory();
      const repository = createLiteratureParsingRepository(database);
      const at = nowIso(clock);
      const cutoff = new Date(Date.parse(at) - staleAfterMs).toISOString();
      let expiredRuns = 0;
      withTransaction(database, () => {
        const expired = repository.expireParsingRuns(cutoff, at);
        expiredRuns = expired.length;
        for (const run of expired) {
          const failed = repository.getParseRunById(run.parseRunId);
          if (failed) createAuditEventRepository(database).append(auditEvent(dependencies, idFactory, "LITERATURE_PARSE_FAILED", failed, at));
        }
      });
      return { expiredRuns };
    } finally {
      lease.release();
    }
  }

  return { parseVersion, parseCurrentDocument, reconcile };
}
