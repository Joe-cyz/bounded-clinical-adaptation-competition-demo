import "server-only";

import {
  createLiteratureIngestionService,
  type LiteratureIngestionDependencies,
} from "@/application/literature-ingestion-service";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { literatureError, literatureErrorCodes } from "@/infrastructure/literature/literature-errors";
import { LITERATURE_IMPORT_REQUEST_MAX_BYTES } from "@/domain/literature";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY } from "./runtime-config";

type LiteratureImportService = ReturnType<typeof createLiteratureIngestionService>;

export type LiteratureImportRouteDependencies = Readonly<{
  env?: NodeJS.ProcessEnv;
  databaseFactory?: LiteratureIngestionDependencies["databaseFactory"];
  storageFactory?: LiteratureIngestionDependencies["storageFactory"];
  serviceFactory?: () => LiteratureImportService;
}>;

type RouteError = {
  ok: false;
  errorCode: string;
};

type BatchCreationResponse = {
  ok: true;
  batchId: string;
  items: Array<{ itemId: string; clientFileId: string }>;
  idempotencyResult: "CREATED" | "REPLAYED";
};

type MutationAcknowledgement = {
  ok: true;
  idempotencyResult?: "CREATED" | "REPLAYED" | "CANCELLED";
};

function batchCreationResponse(result: Awaited<ReturnType<LiteratureImportService["createBatch"]>>): BatchCreationResponse {
  return {
    ok: true,
    batchId: result.batch.batchId,
    items: result.items.map((item) => ({ itemId: item.itemId, clientFileId: item.clientFileId })),
    idempotencyResult: result.idempotencyResult,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requestHasStrictSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

function normalizeContentType(value: string): string {
  return value.trim().toLowerCase().replace(/\s*;\s*/gu, ";").replace(/\s*=\s*/gu, "=");
}

function isJsonContentType(request: Request): boolean {
  const value = request.headers.get("content-type");
  return value !== null && normalizeContentType(value).split(";", 1)[0] === "application/json";
}

function isSupportedUploadContentType(value: string): boolean {
  const normalized = normalizeContentType(value);
  return normalized === "application/pdf"
    || normalized === "text/plain"
    || normalized === "text/plain;charset=utf-8";
}

function contentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw literatureError(literatureErrorCodes.LENGTH_MISMATCH);
  }
  return parsed;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let value = "";
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw literatureError(literatureErrorCodes.STREAM_ABORTED);
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
      byteLength += result.value.byteLength;
      if (byteLength > LITERATURE_IMPORT_REQUEST_MAX_BYTES) {
        throw literatureError(literatureErrorCodes.REQUEST_TOO_LARGE);
      }
      try {
        value += decoder.decode(result.value, { stream: true });
      } catch {
        throw literatureError(literatureErrorCodes.INVALID_REQUEST);
      }
    }
    try {
      value += decoder.decode();
    } catch {
      throw literatureError(literatureErrorCodes.INVALID_REQUEST);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw literatureError(literatureErrorCodes.INVALID_REQUEST);
  }
}

function errorCode(error: unknown): string {
  if (!(error instanceof PersistenceError)) return literatureErrorCodes.STORAGE_FAILED;
  if (error.code === persistenceErrorCodes.RUNTIME_READ_ONLY) return PUBLIC_DEMO_READ_ONLY;
  if (error.code === persistenceErrorCodes.NOT_FOUND || error.code === persistenceErrorCodes.CONFLICT) return error.code;
  if (error.code.startsWith("LITERATURE_")) return error.code;
  if (error.code === persistenceErrorCodes.VALIDATION_FAILED) return literatureErrorCodes.INVALID_REQUEST;
  return literatureErrorCodes.CONSISTENCY_FAILED;
}

function errorStatus(code: string): number {
  if (code === PUBLIC_DEMO_READ_ONLY || code === literatureErrorCodes.ORIGIN_REJECTED) return 403;
  if (code === persistenceErrorCodes.NOT_FOUND) return 404;
  if (code === persistenceErrorCodes.CONFLICT
    || code === literatureErrorCodes.BATCH_CONFLICT
    || code === literatureErrorCodes.VERSION_CONFLICT
    || code === literatureErrorCodes.DUPLICATE_CONTENT
    || code === literatureErrorCodes.REPLAYED) return 409;
  if (code === literatureErrorCodes.FILE_TOO_LARGE
    || code === literatureErrorCodes.BATCH_TOO_LARGE
    || code === literatureErrorCodes.REQUEST_TOO_LARGE) return 413;
  if (code === literatureErrorCodes.CONTENT_TYPE_INVALID
    || code === literatureErrorCodes.UNSUPPORTED_FORMAT) return 415;
  if (code === literatureErrorCodes.CLEANUP_FAILED
    || code === literatureErrorCodes.STORAGE_FAILED
    || code === literatureErrorCodes.CONSISTENCY_FAILED) return 500;
  if (code.startsWith("LITERATURE_") || code === persistenceErrorCodes.VALIDATION_FAILED) return 400;
  return 500;
}

function controlledError(error: unknown): Response {
  const code = errorCode(error);
  return jsonResponse({ ok: false, errorCode: code } satisfies RouteError, errorStatus(code));
}

function readOnlyResponse(env: NodeJS.ProcessEnv | undefined): Response | undefined {
  const gate = assertRuntimeWriteAllowed(env);
  if (gate.ok) return undefined;
  return jsonResponse({ ok: false, errorCode: PUBLIC_DEMO_READ_ONLY } satisfies RouteError, 403);
}

export function createLiteratureImportRouteHandlers(dependencies: LiteratureImportRouteDependencies = {}) {
  function service(): LiteratureImportService {
    if (dependencies.serviceFactory) return dependencies.serviceFactory();
    return createLiteratureIngestionService({
      env: dependencies.env,
      databaseFactory: dependencies.databaseFactory,
      storageFactory: dependencies.storageFactory,
    });
  }

  async function create(request: Request): Promise<Response> {
    if (!requestHasStrictSameOrigin(request)) {
      return controlledError(literatureError(literatureErrorCodes.ORIGIN_REJECTED));
    }
    const readOnly = readOnlyResponse(dependencies.env);
    if (readOnly) return readOnly;
    if (!isJsonContentType(request)) {
      return controlledError(literatureError(literatureErrorCodes.CONTENT_TYPE_INVALID));
    }
    try {
      const length = contentLength(request);
      if (length !== undefined && length > LITERATURE_IMPORT_REQUEST_MAX_BYTES) {
        throw literatureError(literatureErrorCodes.REQUEST_TOO_LARGE);
      }
      const payload = await readBoundedJson(request);
      const result = await service().createBatch(payload);
      return jsonResponse(batchCreationResponse(result), result.idempotencyResult === "CREATED" ? 201 : 200);
    } catch (error) {
      return controlledError(error);
    }
  }

  async function upload(request: Request, batchId: string, itemId: string): Promise<Response> {
    if (!requestHasStrictSameOrigin(request)) {
      return controlledError(literatureError(literatureErrorCodes.ORIGIN_REJECTED));
    }
    const readOnly = readOnlyResponse(dependencies.env);
    if (readOnly) return readOnly;
    const rawContentType = request.headers.get("content-type");
    if (!rawContentType || !isSupportedUploadContentType(rawContentType)) {
      return controlledError(literatureError(literatureErrorCodes.CONTENT_TYPE_INVALID));
    }
    try {
      const length = contentLength(request);
      await service().uploadFile({
        batchId,
        itemId,
        body: request.body,
        ...(length === undefined ? {} : { contentLength: length }),
        contentType: normalizeContentType(rawContentType),
      });
      const response: MutationAcknowledgement = { ok: true };
      return jsonResponse(response, 201);
    } catch (error) {
      return controlledError(error);
    }
  }

  async function complete(request: Request, batchId: string): Promise<Response> {
    if (!requestHasStrictSameOrigin(request)) {
      return controlledError(literatureError(literatureErrorCodes.ORIGIN_REJECTED));
    }
    const readOnly = readOnlyResponse(dependencies.env);
    if (readOnly) return readOnly;
    try {
      const result = await service().completeBatch(batchId);
      const response: MutationAcknowledgement = { ok: true, idempotencyResult: result.idempotencyResult };
      return jsonResponse(response, 200);
    } catch (error) {
      return controlledError(error);
    }
  }

  async function cancel(request: Request, batchId: string): Promise<Response> {
    if (!requestHasStrictSameOrigin(request)) {
      return controlledError(literatureError(literatureErrorCodes.ORIGIN_REJECTED));
    }
    const readOnly = readOnlyResponse(dependencies.env);
    if (readOnly) return readOnly;
    try {
      const result = await service().cancelBatch(batchId);
      const response: MutationAcknowledgement = { ok: true, idempotencyResult: result.idempotencyResult };
      return jsonResponse(response, 200);
    } catch (error) {
      return controlledError(error);
    }
  }

  return { create, upload, complete, cancel };
}

const defaultHandlers = createLiteratureImportRouteHandlers();

export async function POST(request: Request): Promise<Response> {
  return defaultHandlers.create(request);
}

export async function PUT(request: Request, batchId: string, itemId: string): Promise<Response> {
  return defaultHandlers.upload(request, batchId, itemId);
}

export async function COMPLETE(request: Request, batchId: string): Promise<Response> {
  return defaultHandlers.complete(request, batchId);
}

export async function DELETE(request: Request, batchId: string): Promise<Response> {
  return defaultHandlers.cancel(request, batchId);
}
