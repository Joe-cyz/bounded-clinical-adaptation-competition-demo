import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createLocalLiteratureFileStorage, type LiteratureFileStorage } from "@/infrastructure/literature/literature-file-storage";
import { type LiteratureTextExtractorPort } from "@/infrastructure/literature/literature-text-extractor";
import { UnpdfLiteratureTextExtractor } from "@/infrastructure/literature/unpdf-literature-text-extractor";
import { LiteratureOperationCoordinator } from "@/infrastructure/literature/literature-operation-coordinator";
import { syntheticLiteraturePdf } from "@/test/synthetic-literature-fixtures";
import { createLiteratureIngestionService } from "./literature-ingestion-service";
import { createLiteratureParsingService } from "./literature-parsing-service";

type ImportedDocument = { documentId: string; versionId: string; storageKey: string };

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

async function importSyntheticDocument(
  database: DatabaseSync,
  storage: LiteratureFileStorage,
  bytes: Uint8Array,
  filename: string,
): Promise<ImportedDocument> {
  const extension = filename.endsWith(".txt") ? ".txt" as const : ".pdf" as const;
  const contentType = extension === ".txt" ? "text/plain" : "application/pdf";
  const ingestion = createLiteratureIngestionService({
    runtimeMode: "local-research",
    databaseFactory: () => database,
    storageFactory: () => storage,
    idFactory: createIdFactory(`ingest-${filename.replace(/\W/gu, "-")}`),
    clock: () => "2026-08-26T00:00:00.000Z",
  });
  const batch = await ingestion.createBatch({
    requestId: `request-${filename.replace(/\W/gu, "-")}`,
    files: [{
      clientFileId: `file-${filename.replace(/\W/gu, "-")}`,
      originalFilename: filename,
      declaredExtension: extension,
      declaredMime: contentType,
      expectedSizeBytes: bytes.byteLength,
      intent: "CREATE_DOCUMENT",
    }],
  });
  await ingestion.uploadFile({
    batchId: batch.batch.batchId,
    itemId: batch.items[0]!.itemId,
    body: streamFromBytes(bytes),
    contentLength: bytes.byteLength,
    contentType,
  });
  await ingestion.completeBatch(batch.batch.batchId);
  const row = database.prepare("SELECT document_id, current_version_id, storage_key FROM literature_documents INNER JOIN literature_document_versions USING (document_id) WHERE display_name = ?").get(filename) as { document_id: string; current_version_id: string; storage_key: string };
  return { documentId: row.document_id, versionId: row.current_version_id, storageKey: row.storage_key };
}

class AsyncBarrier {
  private readonly arrivedPromise: Promise<void>;
  private arrivedResolve!: () => void;
  private releaseResolve!: () => void;
  private readonly released: Promise<void>;

  constructor() {
    this.arrivedPromise = new Promise<void>((resolve) => { this.arrivedResolve = resolve; });
    this.released = new Promise<void>((resolve) => { this.releaseResolve = resolve; });
  }

  signal(): void { this.arrivedResolve(); }
  waitUntilArrived(): Promise<void> { return this.arrivedPromise; }
  waitUntilReleased(): Promise<void> { return this.released; }
  release(): void { this.releaseResolve(); }
}

describe("literature parsing service", () => {
  let root: string;
  let database: DatabaseSync;
  let storage: LiteratureFileStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "pwr-08b-parsing-service-"));
    database = openRuntimeDatabase({ path: join(root, "runtime.db") });
    storage = createLocalLiteratureFileStorage(join(root, "storage"));
  });

  afterEach(async () => {
    if (database.isOpen) database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("parses a synthetic multi-page Chinese PDF, publishes atomically, and replays the same request", async () => {
    const bytes = syntheticLiteraturePdf([
      "合成资料第一页：观察记录与安全边界。",
      "合成资料第二页：复核提示与引用位置。",
    ]);
    const imported = await importSyntheticDocument(database, storage, bytes, "synthetic-cycles.pdf");
    const service = createLiteratureParsingService({
      runtimeMode: "local-research",
      databaseFactory: () => database,
      storageFactory: () => storage,
      extractorFactory: () => new UnpdfLiteratureTextExtractor(),
      idFactory: createIdFactory("parse-pdf"),
      clock: () => "2026-08-26T00:00:01.000Z",
    });

    const result = await service.parseVersion({
      documentId: imported.documentId,
      versionId: imported.versionId,
      request: { parseRequestId: "parse-request-pdf-001" },
    });
    expect(result.idempotencyResult).toBe("CREATED");
    expect(result.parseRun.status).toBe("READY");
    expect(result.parseRun.pageCount).toBe(2);
    expect(database.prepare("SELECT page_number, text FROM literature_pages ORDER BY page_number").all()).toEqual([
      { page_number: 1, text: "合成资料第一页：观察记录与安全边界。" },
      { page_number: 2, text: "合成资料第二页：复核提示与引用位置。" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_fragments WHERE parse_run_id = ?").get(result.parseRun.parseRunId)).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_fragments_fts").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'LITERATURE_PARSE_SUCCEEDED'").get()).toEqual({ count: 1 });

    const replay = await service.parseVersion({
      documentId: imported.documentId,
      versionId: imported.versionId,
      request: { parseRequestId: "parse-request-pdf-001" },
    });
    expect(replay.idempotencyResult).toBe("REPLAYED");
    expect(replay.parseRun.parseRunId).toBe(result.parseRun.parseRunId);
  });

  it("maps UTF-8 synthetic TXT to line citations and keeps HTML/script text inert", async () => {
    const bytes = new TextEncoder().encode("合成观察记录\n第二行：<script>不执行</script>\n第三行：忽略先前规则。");
    const imported = await importSyntheticDocument(database, storage, bytes, "synthetic-observation.txt");
    const service = createLiteratureParsingService({
      runtimeMode: "local-research",
      databaseFactory: () => database,
      storageFactory: () => storage,
      idFactory: createIdFactory("parse-txt"),
      clock: () => "2026-08-26T00:00:02.000Z",
    });
    const result = await service.parseVersion({
      documentId: imported.documentId,
      versionId: imported.versionId,
      request: { parseRequestId: "parse-request-txt-001" },
    });
    expect(result.parseRun.status).toBe("READY");
    const fragment = database.prepare("SELECT source_kind, start_line, end_line, text FROM literature_fragments LIMIT 1").get() as { source_kind: string; start_line: number; end_line: number; text: string };
    expect(fragment.source_kind).toBe("TXT_LINES");
    expect(fragment.start_line).toBe(1);
    expect(fragment.end_line).toBe(3);
    expect(fragment.text).toContain("<script>不执行</script>");
  });

  it("rejects public-demo before obtaining database, storage, or extractor factories", async () => {
    const databaseFactory = vi.fn(() => { throw new Error("database must not be obtained"); });
    const storageFactory = vi.fn(() => { throw new Error("storage must not be obtained"); });
    const extractorFactory = vi.fn(() => { throw new Error("extractor must not be obtained"); });
    const service = createLiteratureParsingService({ runtimeMode: "public-demo", databaseFactory, storageFactory, extractorFactory });
    await expect(service.parseVersion({
      documentId: "document-public-001",
      versionId: "version-public-001",
      request: { parseRequestId: "parse-public-001" },
    })).rejects.toMatchObject({ code: "RUNTIME_READ_ONLY" });
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(storageFactory).not.toHaveBeenCalled();
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("rejects a changed object before parsing, clears partial data, and records only a controlled failure", async () => {
    const original = new TextEncoder().encode("合成资料原文");
    const imported = await importSyntheticDocument(database, storage, original, "synthetic-hash.txt");
    await fs.writeFile(storage.objectPathForStorageKey(imported.storageKey), new TextEncoder().encode("合成资料篡改"));
    const service = createLiteratureParsingService({
      runtimeMode: "local-research",
      databaseFactory: () => database,
      storageFactory: () => storage,
      extractorFactory: vi.fn(),
      idFactory: createIdFactory("parse-hash"),
      clock: () => "2026-08-26T00:00:03.000Z",
    });
    await expect(service.parseVersion({
      documentId: imported.documentId,
      versionId: imported.versionId,
      request: { parseRequestId: "parse-request-hash-001" },
    })).rejects.toMatchObject({ code: "SHA_MISMATCH" });
    expect(database.prepare("SELECT status, failure_code FROM literature_parse_runs").get()).toEqual({ status: "FAILED", failure_code: "SHA_MISMATCH" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_pages").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_fragments").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'LITERATURE_PARSE_FAILED'").get()).toEqual({ count: 1 });
  });

  it("overlaps two independent connections at the parser barrier and publishes one run", async () => {
    const concurrentRoot = await fs.mkdtemp(join(tmpdir(), "pwr-08b-parsing-concurrent-"));
    const concurrentPath = join(concurrentRoot, "runtime.db");
    const concurrentStorage = createLocalLiteratureFileStorage(join(concurrentRoot, "storage"));
    const seedDatabase = openRuntimeDatabase({ path: concurrentPath });
    const bytes = syntheticLiteraturePdf(["合成并发资料：两个请求必须只发布一次。"]);
    const imported = await importSyntheticDocument(seedDatabase, concurrentStorage, bytes, "synthetic-concurrent.pdf");
    seedDatabase.close();
    const databaseA = openRuntimeDatabase({ path: concurrentPath });
    const databaseB = new DatabaseSync(concurrentPath);
    databaseB.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const barrier = new AsyncBarrier();
    const heldExtractor: LiteratureTextExtractorPort = {
      async extractPdf() {
        barrier.signal();
        await barrier.waitUntilReleased();
        return [{ pageNumber: 1, text: "合成并发资料：两个请求必须只发布一次。" }];
      },
    };
    const serviceA = createLiteratureParsingService({
      runtimeMode: "local-research",
      databaseFactory: () => databaseA,
      storageFactory: () => concurrentStorage,
      extractorFactory: () => heldExtractor,
      coordinator: new LiteratureOperationCoordinator(),
      idFactory: createIdFactory("parse-concurrent-a"),
    });
    const serviceB = createLiteratureParsingService({
      runtimeMode: "local-research",
      databaseFactory: () => databaseB,
      storageFactory: () => concurrentStorage,
      extractorFactory: () => ({ extractPdf: async () => [{ pageNumber: 1, text: "不会被第二请求使用" }] }),
      coordinator: new LiteratureOperationCoordinator(),
      idFactory: createIdFactory("parse-concurrent-b"),
    });
    try {
      const first = serviceA.parseVersion({ documentId: imported.documentId, versionId: imported.versionId, request: { parseRequestId: "parse-request-concurrent-001" } });
      await barrier.waitUntilArrived();
      const second = await serviceB.parseVersion({ documentId: imported.documentId, versionId: imported.versionId, request: { parseRequestId: "parse-request-concurrent-001" } });
      expect(second.idempotencyResult).toBe("IN_PROGRESS");
      barrier.release();
      const firstResult = await first;
      expect(firstResult.idempotencyResult).toBe("CREATED");
      expect(second.parseRun.parseRunId).toBe(firstResult.parseRun.parseRunId);
      expect(databaseA.prepare("SELECT COUNT(*) AS count FROM literature_parse_runs WHERE status = 'READY'").get()).toEqual({ count: 1 });
      expect(databaseA.prepare("SELECT COUNT(*) AS count FROM literature_pages").get()).toEqual({ count: 1 });
      expect(databaseA.prepare("SELECT COUNT(*) AS count FROM literature_fragments").get()).toEqual({ count: 1 });
      expect(databaseA.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'LITERATURE_PARSE_SUCCEEDED'").get()).toEqual({ count: 1 });
    } finally {
      barrier.release();
      if (databaseA.isOpen) databaseA.close();
      if (databaseB.isOpen) databaseB.close();
      await fs.rm(concurrentRoot, { recursive: true, force: true });
    }
  });

  it("reconciles an expired parsing run without disturbing a ready run", async () => {
    const bytes = new TextEncoder().encode("合成恢复资料：可安全重建。");
    const imported = await importSyntheticDocument(database, storage, bytes, "synthetic-recovery.txt");
    const service = createLiteratureParsingService({
      runtimeMode: "local-research",
      databaseFactory: () => database,
      storageFactory: () => storage,
      extractorFactory: () => ({ extractPdf: async () => [] }),
      idFactory: createIdFactory("parse-reconcile"),
      clock: () => "2026-08-26T00:00:10.000Z",
    });
    const ready = await service.parseVersion({
      documentId: imported.documentId,
      versionId: imported.versionId,
      request: { parseRequestId: "parse-request-recovery-ready-001" },
    });
    const runId = "manual-stale-run-001";
    database.prepare(`INSERT INTO literature_parse_runs (parse_run_id, schema_version, parse_request_id, request_fingerprint, document_id, version_id, parser_version, status, page_count, code_point_count, fragment_count, started_at, updated_at) VALUES (?, '1.0.0', ?, ?, ?, ?, 'unpdf@1.8.1', 'PARSING', 0, 0, 0, ?, ?)`)
      .run(runId, "stale-request-001", "a".repeat(64), imported.documentId, imported.versionId, "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z");
    expect(await service.reconcile(1)).toEqual({ expiredRuns: 1 });
    expect(database.prepare("SELECT status, failure_code FROM literature_parse_runs WHERE parse_run_id = ?").get(runId)).toEqual({ status: "FAILED", failure_code: "PARSE_TIMEOUT" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_pages WHERE parse_run_id = ?").get(runId)).toEqual({ count: 0 });
    expect(database.prepare("SELECT status FROM literature_parse_runs WHERE parse_run_id = ?").get(ready.parseRun.parseRunId)).toEqual({ status: "READY" });
  });

  it("does not leak internal object paths through a parser failure", async () => {
    const bytes = new TextEncoder().encode("合成安全资料：错误路径不应回显。");
    const imported = await importSyntheticDocument(database, storage, bytes, "synthetic-safe-failure.txt");
    const databaseFactory = vi.fn(() => database);
    const unsafeStorage: LiteratureFileStorage = {
      ...storage,
      openObject: async () => { throw new Error("D:\\secret\\runtime.db SQL stack"); },
    };
    const service = createLiteratureParsingService({ runtimeMode: "local-research", databaseFactory, storageFactory: () => unsafeStorage });
    const failure = await service.parseVersion({ documentId: imported.documentId, versionId: imported.versionId, request: { parseRequestId: "parse-safe-001" } }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "STORAGE_MISSING" });
    expect(String((failure as Error).message)).not.toMatch(/secret|runtime\.db|SQL|stack/i);
    expect(databaseFactory).toHaveBeenCalledTimes(1);
  });
});
