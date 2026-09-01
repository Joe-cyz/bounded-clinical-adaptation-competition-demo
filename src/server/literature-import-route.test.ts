import { describe, expect, it, vi } from "vitest";

import { createLiteratureIngestionService } from "@/application/literature-ingestion-service";
import { literatureErrorCodes } from "@/infrastructure/literature/literature-errors";
import { createLiteratureImportRouteHandlers } from "./literature-import-route";

type Service = ReturnType<typeof createLiteratureIngestionService>;

function headers(contentType: string, contentLength?: number): Headers {
  const value = new Headers({
    Origin: "http://localhost:3000",
    Host: "localhost:3000",
    "Content-Type": contentType,
  });
  if (contentLength !== undefined) value.set("Content-Length", String(contentLength));
  return value;
}

function serviceStub(overrides: Partial<Record<keyof Service, unknown>> = {}): Service {
  return {
    createBatch: vi.fn(async () => ({ batch: { batchId: "batch-001" }, items: [], idempotencyResult: "CREATED" as const })),
    uploadFile: vi.fn(async () => ({ batch: { batchId: "batch-001" }, item: { itemId: "item-001" } })),
    completeBatch: vi.fn(async () => ({ batch: { batchId: "batch-001" }, items: [], idempotencyResult: "CREATED" as const })),
    cancelBatch: vi.fn(async () => ({ batch: { batchId: "batch-001" }, items: [], idempotencyResult: "CANCELLED" as const })),
    reconcile: vi.fn(async () => ({ removedStagingFiles: 0, removedOrphanObjects: 0, checkedAvailableObjects: 0 })),
    getAvailableVersion: vi.fn(() => undefined),
    ...overrides,
  } as unknown as Service;
}

function createPayload() {
  return {
    requestId: "route-request-001",
    files: [{
      clientFileId: "route-file-001",
      originalFilename: "route.pdf",
      declaredExtension: ".pdf",
      declaredMime: "application/pdf",
      expectedSizeBytes: 12,
      intent: "CREATE_DOCUMENT",
    }],
  };
}

describe("literature import routes", () => {
  it("rejects public-demo before reading JSON, constructing the service, obtaining a database or touching storage", async () => {
    const bodyRead = vi.fn();
    const databaseFactory = vi.fn();
    const storageFactory = vi.fn();
    const serviceFactory = vi.fn(() => serviceStub());
    const handlers = createLiteratureImportRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "public-demo" },
      databaseFactory,
      storageFactory,
      serviceFactory,
    });
    const request = {
      headers: headers("application/json"),
      get body(): ReadableStream<Uint8Array> {
        bodyRead();
        throw new Error("body must not be read");
      },
    } as unknown as Request;

    const response = await handlers.create(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, errorCode: "PUBLIC_DEMO_READ_ONLY" });
    expect(bodyRead).not.toHaveBeenCalled();
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(storageFactory).not.toHaveBeenCalled();
    expect(serviceFactory).not.toHaveBeenCalled();
  });

  it("bounds strict JSON input before invoking the service", async () => {
    const service = serviceStub();
    const oversized = new Uint8Array(16 * 1024 + 1);
    const response = await createLiteratureImportRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "local-research" },
      serviceFactory: () => service,
    }).create(new Request("http://localhost:3000/api/literature/import-batches", {
      method: "POST",
      headers: headers("application/json"),
      body: oversized,
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, errorCode: literatureErrorCodes.REQUEST_TOO_LARGE });
    expect(service.createBatch).not.toHaveBeenCalled();
  });

  it("passes JSON and the raw PUT stream to the service and exposes only DTOs", async () => {
    const service = serviceStub();
    const handlers = createLiteratureImportRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "local-research" },
      serviceFactory: () => service,
    });
    const payload = JSON.stringify(createPayload());
    const createResponse = await handlers.create(new Request("http://localhost:3000/api/literature/import-batches", {
      method: "POST",
      headers: headers("application/json", new TextEncoder().encode(payload).byteLength),
      body: payload,
    }));
    expect(createResponse.status).toBe(201);
    expect(await createResponse.json()).toEqual({
      ok: true,
      batchId: "batch-001",
      items: [],
      idempotencyResult: "CREATED",
    });
    expect(service.createBatch).toHaveBeenCalledWith(createPayload());

    const bytes = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
    const uploadResponse = await handlers.upload(new Request("http://localhost:3000/api/literature/import-batches/batch-001/files/item-001", {
      method: "PUT",
      headers: headers("application/pdf", bytes.byteLength),
      body: bytes,
    }), "batch-001", "item-001");
    expect(uploadResponse.status).toBe(201);
    expect(await uploadResponse.json()).toEqual({ ok: true });
    const uploadCall = vi.mocked(service.uploadFile).mock.calls[0][0];
    expect(uploadCall.contentType).toBe("application/pdf");
    expect(uploadCall.contentLength).toBe(bytes.byteLength);
    expect(uploadCall.body).toBeInstanceOf(ReadableStream);
    if (!uploadCall.body) throw new Error("Expected raw upload body.");
    expect(await new Response(uploadCall.body).arrayBuffer()).toEqual(bytes.buffer);
  });

  it("does not expose storage keys, raw body metadata, or internal batch records to the browser", async () => {
    const service = serviceStub({
      createBatch: vi.fn(async () => ({
        batch: { batchId: "batch-safe-001", requestId: "request-safe-001", storageRoot: "D:\\not-for-client" },
        items: [{ itemId: "item-safe-001", clientFileId: "route-file-001", storageKey: "objects/aa/hidden.pdf", actualSha256: "a".repeat(64) }],
        idempotencyResult: "CREATED" as const,
      })),
    });
    const response = await createLiteratureImportRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "local-research" },
      serviceFactory: () => service,
    }).create(new Request("http://localhost:3000/api/literature/import-batches", {
      method: "POST",
      headers: headers("application/json"),
      body: JSON.stringify(createPayload()),
    }));
    const text = await response.text();
    expect(text).toBe(JSON.stringify({
      ok: true,
      batchId: "batch-safe-001",
      items: [{ itemId: "item-safe-001", clientFileId: "route-file-001" }],
      idempotencyResult: "CREATED",
    }));
    expect(text).not.toMatch(/storageRoot|storageKey|objects\/|not-for-client|actualSha256/i);
  });

  it("normalizes service failures without returning messages, paths or stack details", async () => {
    const service = serviceStub({
      createBatch: vi.fn(async () => { throw new Error("D:\\secret\\prototype.db SQL stack"); }),
    });
    const response = await createLiteratureImportRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "local-research" },
      serviceFactory: () => service,
    }).create(new Request("http://localhost:3000/api/literature/import-batches", {
      method: "POST",
      headers: headers("application/json"),
      body: JSON.stringify(createPayload()),
    }));
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toBe(JSON.stringify({ ok: false, errorCode: literatureErrorCodes.STORAGE_FAILED }));
    expect(body).not.toMatch(/secret|prototype|SQL|stack/i);
  });

  it("rejects origins and media types before any file stream is read", async () => {
    const service = serviceStub();
    const handlers = createLiteratureImportRouteHandlers({
      env: { ...process.env, APP_RUNTIME_MODE: "local-research" },
      serviceFactory: () => service,
    });
    const invalidOrigin = new Request("http://localhost:3000/api/literature/import-batches", {
      method: "POST",
      headers: new Headers({ Origin: "http://evil.example", Host: "localhost:3000", "Content-Type": "application/json" }),
      body: JSON.stringify(createPayload()),
    });
    expect((await handlers.create(invalidOrigin)).status).toBe(403);
    expect((await handlers.upload(new Request("http://localhost:3000/api/literature/import-batches/b/files/i", {
      method: "PUT",
      headers: headers("audio/wav"),
      body: new TextEncoder().encode("should-not-be-read"),
    }), "batch", "item")).status).toBe(415);
    expect(service.uploadFile).not.toHaveBeenCalled();
  });
});
