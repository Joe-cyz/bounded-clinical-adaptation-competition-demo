import "server-only";

import {
  createLiteratureRetrievalService,
  type LiteratureRetrievalDependencies,
} from "@/application/literature-retrieval-service";
import { LITERATURE_IMPORT_REQUEST_MAX_BYTES } from "@/domain/literature";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { literatureError, literatureErrorCodes } from "@/infrastructure/literature/literature-errors";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY } from "./runtime-config";

type RetrievalService = ReturnType<typeof createLiteratureRetrievalService>;

export type LiteratureSearchRouteDependencies = Readonly<{
  env?: NodeJS.ProcessEnv;
  databaseFactory?: LiteratureRetrievalDependencies["databaseFactory"];
  serviceFactory?: () => RetrievalService;
}>;

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function sameOrigin(request: Request): boolean {
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

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
      size += result.value.byteLength;
      if (size > LITERATURE_IMPORT_REQUEST_MAX_BYTES) throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw literatureError(literatureErrorCodes.PARSE_INVALID_REQUEST);
  }
}

function errorCode(error: unknown): string {
  if (!(error instanceof PersistenceError)) return literatureErrorCodes.PARSE_PUBLISH_FAILED;
  if (error.code === persistenceErrorCodes.RUNTIME_READ_ONLY) return PUBLIC_DEMO_READ_ONLY;
  if (error.code === persistenceErrorCodes.NOT_FOUND || error.code === persistenceErrorCodes.CONFLICT) return error.code;
  if (error.code.startsWith("LITERATURE_")) return error.code;
  return literatureErrorCodes.PARSE_PUBLISH_FAILED;
}

function errorStatus(code: string): number {
  if (code === PUBLIC_DEMO_READ_ONLY) return 403;
  if (code === persistenceErrorCodes.NOT_FOUND) return 404;
  if (code === persistenceErrorCodes.CONFLICT) return 409;
  return 400;
}

export function createLiteratureSearchRouteHandlers(dependencies: LiteratureSearchRouteDependencies = {}) {
  function service(): RetrievalService {
    if (dependencies.serviceFactory) return dependencies.serviceFactory();
    return createLiteratureRetrievalService({ env: dependencies.env, databaseFactory: dependencies.databaseFactory });
  }

  async function post(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return jsonResponse({ ok: false, errorCode: literatureErrorCodes.ORIGIN_REJECTED }, 403);
    const gate = assertRuntimeWriteAllowed(dependencies.env);
    if (!gate.ok) return jsonResponse({ ok: false, errorCode: PUBLIC_DEMO_READ_ONLY }, 403);
    if (request.headers.get("content-type")?.toLowerCase().split(";", 1)[0] !== "application/json") {
      return jsonResponse({ ok: false, errorCode: literatureErrorCodes.PARSE_INVALID_REQUEST }, 400);
    }
    try {
      return jsonResponse(await service().search(await readBoundedJson(request)), 200);
    } catch (error) {
      const code = errorCode(error);
      return jsonResponse({ ok: false, errorCode: code }, errorStatus(code));
    }
  }

  return { post };
}

const defaultHandlers = createLiteratureSearchRouteHandlers();

export async function POST(request: Request): Promise<Response> {
  return defaultHandlers.post(request);
}
