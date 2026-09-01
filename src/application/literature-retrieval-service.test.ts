import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEncounter } from "./encounter-service";
import { createLiteratureIngestionService } from "./literature-ingestion-service";
import { createLiteratureParsingService } from "./literature-parsing-service";
import { createLiteratureRetrievalService } from "./literature-retrieval-service";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createLocalLiteratureFileStorage } from "@/infrastructure/literature/literature-file-storage";

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createIdFactory(prefix: string) {
  let counter = 0;
  return (kind: string) => `${prefix}-${kind.toLowerCase()}-${++counter}`;
}

async function importReadyText(database: DatabaseSync, storageRoot: string): Promise<{ documentId: string; versionId: string; encounterId: string }> {
  const storage = createLocalLiteratureFileStorage(storageRoot);
  const bytes = new TextEncoder().encode("合成资料检索内容。这里包含稳定中文关键词和安全引用位置。\n第二行继续说明合成资料的范围。\n第三行保留原始提示，不执行脚本。");
  const ingestion = createLiteratureIngestionService({
    runtimeMode: "local-research",
    databaseFactory: () => database,
    storageFactory: () => storage,
    idFactory: createIdFactory("retrieval-ingest"),
    clock: () => "2026-08-26T00:00:00.000Z",
  });
  const batch = await ingestion.createBatch({
    requestId: "retrieval-import-request-001",
    files: [{
      clientFileId: "retrieval-file-001",
      originalFilename: "synthetic-retrieval.txt",
      declaredExtension: ".txt",
      declaredMime: "text/plain",
      expectedSizeBytes: bytes.byteLength,
      intent: "CREATE_DOCUMENT",
    }],
  });
  await ingestion.uploadFile({
    batchId: batch.batch.batchId,
    itemId: batch.items[0]!.itemId,
    body: streamFromBytes(bytes),
    contentLength: bytes.byteLength,
    contentType: "text/plain",
  });
  await ingestion.completeBatch(batch.batch.batchId);
  const documentRow = database.prepare("SELECT document_id, current_version_id FROM literature_documents WHERE display_name = ?").get("synthetic-retrieval.txt") as { document_id: string; current_version_id: string };
  const parser = createLiteratureParsingService({
    runtimeMode: "local-research",
    databaseFactory: () => database,
    storageFactory: () => storage,
    idFactory: createIdFactory("retrieval-parse"),
    clock: () => "2026-08-26T00:00:01.000Z",
  });
  await parser.parseVersion({
    documentId: documentRow.document_id,
    versionId: documentRow.current_version_id,
    request: { parseRequestId: "retrieval-parse-request-001" },
  });
  const encounterId = "encounter-literature-search-001";
  createEncounter({
    id: encounterId,
    caseId: "general-first-001",
    caseVersion: "0.4.1-001",
    demographicSnapshot: { displayLabel: "合成患者-001" as const, sex: "UNKNOWN" as const, ageBand: "ADULT" as const },
  }, {
    database,
    runtimeMode: "local-research",
    idFactory: (kind) => kind === "ENCOUNTER" ? encounterId : `retrieval-encounter-audit-${kind.toLowerCase()}`,
    clock: () => "2026-08-26T00:00:02.000Z",
  });
  return { documentId: documentRow.document_id, versionId: documentRow.current_version_id, encounterId };
}

describe("literature retrieval service", () => {
  let root: string;
  let database: DatabaseSync;
  let document: { documentId: string; versionId: string; encounterId: string };

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "pwr-08b-retrieval-service-"));
    database = openRuntimeDatabase({ path: join(root, "runtime.db") });
    document = await importReadyText(database, join(root, "storage"));
  });

  afterEach(async () => {
    if (database.isOpen) database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("searches Chinese trigrams, supports bounded two-character fallback, and returns a safe citation", () => {
    const service = createLiteratureRetrievalService({ runtimeMode: "local-research", databaseFactory: () => database });
    const trigram = service.search({ encounterId: document.encounterId, query: "稳定中文", documentIds: [document.documentId] });
    expect(trigram.status).toBe("RESULTS");
    expect(trigram.results).toHaveLength(1);
    expect(trigram.results[0]?.citation).toMatchObject({
      documentId: document.documentId,
      versionId: document.versionId,
      displayName: "synthetic-retrieval.txt",
      location: { kind: "TXT_LINES", startLine: 1, endLine: 3 },
    });
    expect(trigram.results[0]?.citation.excerpt).toContain("合成资料");
    const resolved = service.resolveCitation({ documentId: document.documentId, versionId: document.versionId, fragmentId: trigram.results[0]!.citation.fragmentId });
    expect(resolved).toEqual(trigram.results[0]!.citation);

    const short = service.search({ encounterId: document.encounterId, query: "中文", documentIds: [document.documentId] });
    expect(short.status).toBe("RESULTS");
    expect(short.results[0]?.citation.fragmentId).toBe(trigram.results[0]?.citation.fragmentId);
  });

  it("sanitizes FTS punctuation and returns insufficient evidence without lowering the threshold", () => {
    const service = createLiteratureRetrievalService({ runtimeMode: "local-research", databaseFactory: () => database });
    const safe = service.search({ encounterId: document.encounterId, query: `中文*`, documentIds: [document.documentId] });
    expect(safe.status).toBe("RESULTS");
    const empty = service.search({ encounterId: document.encounterId, query: "完全不存在", documentIds: [document.documentId] });
    expect(empty).toEqual({ status: "INSUFFICIENT_EVIDENCE", results: [] });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type LIKE 'LITERATURE_PARSE_%'").get()).toEqual({ count: 1 });
  });

  it("rechecks active current ready scope and rejects disabled documents or foreign citations", () => {
    const service = createLiteratureRetrievalService({ runtimeMode: "local-research", databaseFactory: () => database });
    database.prepare("UPDATE literature_documents SET status = 'DISABLED', disabled_at = ? WHERE document_id = ?").run("2026-08-26T00:00:03.000Z", document.documentId);
    const searchFailure = (() => {
      try {
        service.search({ encounterId: document.encounterId, query: "中文", documentIds: [document.documentId] });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(searchFailure).toMatchObject({ code: "NOT_FOUND" });
    const citationFailure = (() => {
      try {
        service.resolveCitation({ documentId: document.documentId, versionId: document.versionId, fragmentId: "fragment-does-not-exist" });
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(citationFailure).toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects public-demo before a database factory is invoked", () => {
    const databaseFactory = vi.fn(() => { throw new Error("database must not be obtained"); });
    const service = createLiteratureRetrievalService({ runtimeMode: "public-demo", databaseFactory });
    expect(() => service.search({ encounterId: "encounter-public-001", query: "中文", documentIds: ["document-public-001"] })).toThrowError(/read-only|只读/i);
    expect(() => service.resolveCitation({ documentId: "document-public-001", versionId: "version-public-001", fragmentId: "fragment-public-001" })).toThrowError(/read-only|只读/i);
    expect(databaseFactory).not.toHaveBeenCalled();
  });
});
