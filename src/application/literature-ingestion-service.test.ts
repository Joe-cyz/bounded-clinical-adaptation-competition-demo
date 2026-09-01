import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createLocalLiteratureFileStorage, type LiteratureFileStorage } from "@/infrastructure/literature/literature-file-storage";
import { literatureErrorCodes } from "@/infrastructure/literature/literature-errors";
import { LiteratureOperationCoordinator } from "@/infrastructure/literature/literature-operation-coordinator";
import { persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createLiteratureIngestionService } from "./literature-ingestion-service";

type LiteratureService = ReturnType<typeof createLiteratureIngestionService>;

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function validPdf(suffix = "one"): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${suffix}\n%%EOF\n`);
}

function invalidPdf(): Uint8Array {
  return new TextEncoder().encode("not a pdf");
}

function createRequest(requestId: string, bytes: Uint8Array, options: {
  filename?: string;
  intent?: "CREATE_DOCUMENT" | "ADD_VERSION";
  documentId?: string;
  expectedCurrentVersion?: number;
  clientFileId?: string;
} = {}) {
  return {
    requestId,
    files: [{
      clientFileId: options.clientFileId ?? `${requestId}-file`,
      originalFilename: options.filename ?? "synthetic.pdf",
      declaredExtension: ".pdf" as const,
      declaredMime: "application/pdf",
      expectedSizeBytes: bytes.byteLength,
      intent: options.intent ?? "CREATE_DOCUMENT" as const,
      ...(options.documentId === undefined ? {} : { documentId: options.documentId }),
      ...(options.expectedCurrentVersion === undefined ? {} : { expectedCurrentVersion: options.expectedCurrentVersion }),
    }],
  };
}

function createTwoFileRequest(requestId: string, first: Uint8Array, second: Uint8Array, options: {
  firstIntent?: "CREATE_DOCUMENT" | "ADD_VERSION";
  firstDocumentId?: string;
  firstExpectedCurrentVersion?: number;
} = {}) {
  return {
    requestId,
    files: [
      {
        clientFileId: `${requestId}-first`,
        originalFilename: "first.pdf",
        declaredExtension: ".pdf" as const,
        declaredMime: "application/pdf",
        expectedSizeBytes: first.byteLength,
        intent: options.firstIntent ?? "CREATE_DOCUMENT" as const,
        ...(options.firstDocumentId === undefined ? {} : { documentId: options.firstDocumentId }),
        ...(options.firstExpectedCurrentVersion === undefined ? {} : { expectedCurrentVersion: options.firstExpectedCurrentVersion }),
      },
      {
        clientFileId: `${requestId}-second`,
        originalFilename: "second.pdf",
        declaredExtension: ".pdf" as const,
        declaredMime: "application/pdf",
        expectedSizeBytes: second.byteLength,
        intent: "CREATE_DOCUMENT" as const,
      },
    ],
  };
}

function createIdFactory(prefix: string) {
  let counter = 0;
  return (kind: string) => `${prefix}-${kind.toLowerCase()}-${++counter}`;
}

class Barrier {
  private arrivals = 0;
  private readonly released: Promise<void>;
  private release!: () => void;

  constructor(private readonly parties: number) {
    this.released = new Promise<void>((resolve) => { this.release = resolve; });
  }

  async wait(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === this.parties) this.release();
    await this.released;
  }
}

function barrierStorage(root: string, barrier: Barrier): LiteratureFileStorage {
  const base = createLocalLiteratureFileStorage(root);
  return {
    ...base,
    async promote(stagingPath, storageKey) {
      await barrier.wait();
      return base.promote(stagingPath, storageKey);
    },
  };
}

describe("literature ingestion service", () => {
  let root: string;
  let storageRoot: string;
  let databasePath: string;
  let database: DatabaseSync;
  let storage: LiteratureFileStorage;
  let service: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "pwr-08a-literature-service-"));
    storageRoot = join(root, "storage");
    databasePath = join(root, "runtime.db");
    database = openRuntimeDatabase({ path: databasePath });
    storage = createLocalLiteratureFileStorage(storageRoot);
    service = createLiteratureIngestionService({
      runtimeMode: "local-research",
      databaseFactory: () => database,
      storageFactory: () => storage,
      idFactory: createIdFactory("svc"),
      clock: () => "2026-08-25T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    if (database.isOpen) database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function upload(serviceToUse: LiteratureService, batchId: string, itemId: string, bytes: Uint8Array): Promise<unknown> {
    return serviceToUse.uploadFile({
      batchId,
      itemId,
      body: streamFromBytes(bytes),
      contentLength: bytes.byteLength,
      contentType: "application/pdf",
    });
  }

  it("creates and replays a reserved batch without reading a file body", async () => {
    const bytes = validPdf();
    const request = createRequest("request-idempotent-001", bytes);
    const created = await service.createBatch(request);
    const replayed = await service.createBatch(request);
    expect(created.idempotencyResult).toBe("CREATED");
    expect(replayed.idempotencyResult).toBe("REPLAYED");
    expect(replayed.batch.batchId).toBe(created.batch.batchId);
    await expect(service.createBatch(createRequest("request-idempotent-001", validPdf("changed"))))
      .rejects.toMatchObject({ code: literatureErrorCodes.BATCH_CONFLICT });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_import_batches").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_import_items").get()).toEqual({ count: 1 });
  });

  it("rejects public-demo before a throwing database factory or storage factory is called", async () => {
    const databaseFactory = vi.fn(() => { throw new Error("database must not be obtained"); });
    const storageFactory = vi.fn(() => { throw new Error("storage must not be obtained"); });
    const publicService = createLiteratureIngestionService({ runtimeMode: "public-demo", databaseFactory, storageFactory });
    await expect(publicService.createBatch(createRequest("request-public-001", validPdf())))
      .rejects.toMatchObject({ code: persistenceErrorCodes.RUNTIME_READ_ONLY });
    await expect(publicService.uploadFile({ batchId: "batch-public-001", itemId: "item-public-001", body: streamFromBytes(validPdf()) }))
      .rejects.toMatchObject({ code: persistenceErrorCodes.RUNTIME_READ_ONLY });
    expect(databaseFactory).toHaveBeenCalledTimes(0);
    expect(storageFactory).toHaveBeenCalledTimes(0);
  });

  it("obtains the local database once for a batch reservation", async () => {
    const databaseFactory = vi.fn(() => database);
    const localService = createLiteratureIngestionService({ runtimeMode: "local-research", databaseFactory, storageFactory: () => storage });
    await localService.createBatch(createRequest("request-local-factory-001", validPdf()));
    expect(databaseFactory).toHaveBeenCalledTimes(1);
  });

  it("keeps every uploaded item VALIDATED and invisible until completeBatch publishes the whole batch", async () => {
    const first = validPdf("first");
    const second = validPdf("second");
    const created = await service.createBatch(createTwoFileRequest("request-atomic-001", first, second));
    const firstUpload = await upload(service, created.batch.batchId, created.items[0].itemId, first) as { item: { status: string; storageKey?: string } };
    const secondUpload = await upload(service, created.batch.batchId, created.items[1].itemId, second) as { item: { status: string; storageKey?: string } };
    expect(firstUpload.item.status).toBe("VALIDATED");
    expect(secondUpload.item.status).toBe("VALIDATED");
    expect(firstUpload.item.storageKey).toMatch(/^objects\//u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_documents").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_document_versions").get()).toEqual({ count: 0 });
    expect(await service.getAvailableVersion("svc-document-not-created")).toBeUndefined();

    const completed = await service.completeBatch(created.batch.batchId);
    expect(completed.batch.status).toBe("COMPLETED");
    expect(completed.items.every((item) => item.status === "AVAILABLE")).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_documents").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_document_versions").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = ?").get("LITERATURE_DOCUMENT_VERSION_AVAILABLE")).toEqual({ count: 2 });
    expect((await service.completeBatch(created.batch.batchId)).idempotencyResult).toBe("REPLAYED");
  });

  it("fails the complete batch when a later item upload fails and removes earlier validated objects", async () => {
    const first = validPdf("first-failure");
    const second = invalidPdf();
    const created = await service.createBatch(createTwoFileRequest("request-failure-atomic-001", first, second));
    await upload(service, created.batch.batchId, created.items[0].itemId, first);
    await expect(upload(service, created.batch.batchId, created.items[1].itemId, second))
      .rejects.toMatchObject({ code: literatureErrorCodes.INVALID_PDF });
    const stored = database.prepare("SELECT status FROM literature_import_batches WHERE batch_id = ?").get(created.batch.batchId);
    expect(stored).toEqual({ status: "FAILED" });
    expect(database.prepare("SELECT status FROM literature_import_items WHERE batch_id = ? ORDER BY item_id").all(created.batch.batchId)).toEqual([
      { status: "FAILED" },
      { status: "FAILED" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_documents").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_document_versions").get()).toEqual({ count: 0 });
    expect(await storage.listObjectPaths()).toHaveLength(0);
    expect(await storage.listStagingPartPaths()).toHaveLength(0);
    expect(database.prepare("SELECT 1").get()).toEqual({ 1: 1 });
  });

  it("cancels after one successful upload without publishing a document and remains idempotent", async () => {
    const bytes = validPdf("cancel");
    const created = await service.createBatch(createRequest("request-cancel-001", bytes));
    await upload(service, created.batch.batchId, created.items[0].itemId, bytes);
    const cancelled = await service.cancelBatch(created.batch.batchId);
    expect(cancelled.batch.status).toBe("CANCELLED");
    expect(cancelled.items[0].status).toBe("CANCELLED");
    expect((await service.cancelBatch(created.batch.batchId)).idempotencyResult).toBe("REPLAYED");
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_documents").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_document_versions").get()).toEqual({ count: 0 });
    expect(await storage.listObjectPaths()).toHaveLength(0);
    expect(await storage.listStagingPartPaths()).toHaveLength(0);
  });

  it("keeps the old ADD_VERSION current version when another item in the batch fails", async () => {
    const baseBytes = validPdf("base");
    const base = await service.createBatch(createRequest("request-add-base-001", baseBytes));
    await upload(service, base.batch.batchId, base.items[0].itemId, baseBytes);
    await service.completeBatch(base.batch.batchId);
    const document = database.prepare("SELECT document_id, current_version FROM literature_documents LIMIT 1").get() as { document_id: string; current_version: number };
    expect(document.current_version).toBe(1);

    const addBytes = validPdf("new-version");
    const failedBytes = invalidPdf();
    const addBatch = await service.createBatch(createTwoFileRequest("request-add-failure-001", addBytes, failedBytes, {
      firstIntent: "ADD_VERSION",
      firstDocumentId: document.document_id,
      firstExpectedCurrentVersion: 1,
    }));
    await upload(service, addBatch.batch.batchId, addBatch.items[0].itemId, addBytes);
    await expect(upload(service, addBatch.batch.batchId, addBatch.items[1].itemId, failedBytes))
      .rejects.toMatchObject({ code: literatureErrorCodes.INVALID_PDF });
    expect(database.prepare("SELECT current_version FROM literature_documents WHERE document_id = ?").get(document.document_id)).toEqual({ current_version: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_document_versions").get()).toEqual({ count: 1 });
    expect(await storage.listObjectPaths()).toHaveLength(1);
  });

  it("rolls back all documents, versions, current-version changes and audit rows when the second version insert fails", async () => {
    const baseBytes = validPdf("rollback-base");
    const base = await service.createBatch(createRequest("request-rollback-base-001", baseBytes));
    await upload(service, base.batch.batchId, base.items[0].itemId, baseBytes);
    await service.completeBatch(base.batch.batchId);
    const document = database.prepare("SELECT document_id FROM literature_documents LIMIT 1").get() as { document_id: string };
    const first = validPdf("rollback-first");
    const second = validPdf("rollback-second");
    const batch = await service.createBatch(createTwoFileRequest("request-rollback-001", first, second, {
      firstIntent: "ADD_VERSION",
      firstDocumentId: document.document_id,
      firstExpectedCurrentVersion: 1,
    }));
    await upload(service, batch.batch.batchId, batch.items[0].itemId, first);
    await upload(service, batch.batch.batchId, batch.items[1].itemId, second);
    database.exec(`
      CREATE TRIGGER test_literature_second_insert_failure
      BEFORE INSERT ON literature_document_versions
      WHEN NEW.original_filename = 'second.pdf'
      BEGIN SELECT RAISE(ABORT, 'synthetic second insert failure'); END;
    `);
    await expect(service.completeBatch(batch.batch.batchId)).rejects.toMatchObject({ code: literatureErrorCodes.STORAGE_FAILED });
    database.exec("DROP TRIGGER test_literature_second_insert_failure");
    expect(database.prepare("SELECT current_version FROM literature_documents WHERE document_id = ?").get(document.document_id)).toEqual({ current_version: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_document_versions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM literature_documents").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status FROM literature_import_batches WHERE batch_id = ?").get(batch.batch.batchId)).toEqual({ status: "FAILED" });
    expect(await storage.listObjectPaths()).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = ?").get("LITERATURE_DOCUMENT_VERSION_AVAILABLE")).toEqual({ count: 1 });
  });

  it("fails closed when an abnormal failed or cancelled batch still has an AVAILABLE item", async () => {
    const bytes = validPdf("abnormal");
    const created = await service.createBatch(createRequest("request-abnormal-001", bytes));
    await upload(service, created.batch.batchId, created.items[0].itemId, bytes);
    await service.completeBatch(created.batch.batchId);
    const document = database.prepare("SELECT document_id FROM literature_documents LIMIT 1").get() as { document_id: string };
    database.prepare("UPDATE literature_import_batches SET status = 'FAILED', completed_at = NULL WHERE batch_id = ?").run(created.batch.batchId);
    expect(await service.getAvailableVersion(document.document_id, 1)).toBeUndefined();
  });

  it("enforces duplicate SHA at the database boundary across two independent connections", async () => {
    const barrier = new Barrier(2);
    const databaseA = openRuntimeDatabase({ path: databasePath });
    const databaseB = new DatabaseSync(databasePath);
    const serviceA = createLiteratureIngestionService({ runtimeMode: "local-research", databaseFactory: () => databaseA, storageFactory: () => barrierStorage(storageRoot, barrier), coordinator: new LiteratureOperationCoordinator(), idFactory: createIdFactory("concurrent-a") });
    const serviceB = createLiteratureIngestionService({ runtimeMode: "local-research", databaseFactory: () => databaseB, storageFactory: () => barrierStorage(storageRoot, barrier), coordinator: new LiteratureOperationCoordinator(), idFactory: createIdFactory("concurrent-b") });
    const bytes = validPdf("same-sha");
    const batchA = await serviceA.createBatch(createRequest("request-concurrent-a", bytes));
    const batchB = await serviceB.createBatch(createRequest("request-concurrent-b", bytes));
    try {
      const results = await Promise.allSettled([
        upload(serviceA, batchA.batch.batchId, batchA.items[0].itemId, bytes),
        upload(serviceB, batchB.batch.batchId, batchB.items[0].itemId, bytes),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected?.reason).toMatchObject({ code: literatureErrorCodes.DUPLICATE_CONTENT });
      const successfulBatch = results.find((result): result is PromiseFulfilledResult<{ batch: { batchId: string }; item: { itemId: string } }> => result.status === "fulfilled")!.value.batch.batchId;
      await (successfulBatch === batchA.batch.batchId ? serviceA : serviceB).completeBatch(successfulBatch);
      expect(database.prepare("SELECT COUNT(*) AS count FROM literature_document_versions").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM literature_documents").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM literature_import_items WHERE status = 'AVAILABLE'").get()).toEqual({ count: 1 });
    } finally {
      if (databaseA.isOpen) databaseA.close();
      if (databaseB.isOpen) databaseB.close();
    }
  });

  it("holds reconciliation behind an upload promotion barrier and preserves the object before completion", async () => {
    let signalPromotion!: () => void;
    let releasePromotion!: () => void;
    const entered = new Promise<void>((resolve) => { signalPromotion = resolve; });
    const hold = new Promise<void>((resolve) => { releasePromotion = resolve; });
    const base = createLocalLiteratureFileStorage(storageRoot);
    const gatedStorage: LiteratureFileStorage = {
      ...base,
      async promote(stagingPath, storageKey) {
        const promoted = await base.promote(stagingPath, storageKey);
        signalPromotion();
        await hold;
        return promoted;
      },
    };
    service = createLiteratureIngestionService({ runtimeMode: "local-research", databaseFactory: () => database, storageFactory: () => gatedStorage, coordinator: new LiteratureOperationCoordinator(), idFactory: createIdFactory("barrier") });
    const bytes = validPdf("reconcile-safe");
    const batch = await service.createBatch(createRequest("request-reconcile-barrier", bytes));
    const uploadPromise = upload(service, batch.batch.batchId, batch.items[0].itemId, bytes);
    await entered;
    const reconciliationPromise = service.reconcile();
    releasePromotion();
    const uploaded = await uploadPromise as { item: { storageKey: string } };
    const reconciliation = await reconciliationPromise;
    expect(reconciliation.removedOrphanObjects).toBe(0);
    expect(await storage.hasObject(uploaded.item.storageKey)).toBe(true);
    await service.completeBatch(batch.batch.batchId);
    expect(await service.getAvailableVersion((database.prepare("SELECT document_id FROM literature_documents LIMIT 1").get() as { document_id: string }).document_id, 1)).toBeDefined();
  });
});
