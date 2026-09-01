import "server-only";

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  speechIdSchema,
  speechPortFailureSchema,
  speechPortSuccessSchema,
  type SpeechPortFailure,
} from "@/domain/speech";
import {
  LOCAL_WHISPER_PROVIDER,
  LocalWhisperError,
  createLocalWhisperCliAdapter,
  type LocalWhisperCliAdapter,
  type LocalWhisperCliConfig,
} from "@/infrastructure/speech/local-whisper-cli";
import { readSpeechRuntimeConfig, type SpeechRuntimeConfig } from "./speech-runtime-config";

export const SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES = 500 * 1024;
export const SPEECH_TRANSCRIPTION_MIN_DURATION_MS = 500 as const;
export const SPEECH_TRANSCRIPTION_MAX_DURATION_MS = 15_000 as const;
const MAX_MULTIPART_BYTES = SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES + 32 * 1024;
const MAX_SESSION_ID_LENGTH = 200;

export const speechRouteErrorCodes = {
  PUBLIC_DEMO_READ_ONLY: "SPEECH_PUBLIC_DEMO_READ_ONLY",
  UNCONFIGURED: "SPEECH_UNCONFIGURED",
  INVALID_REQUEST: "SPEECH_REQUEST_REJECTED",
  ORIGIN_REJECTED: "SPEECH_ORIGIN_REJECTED",
  MEDIA_TYPE_REJECTED: "SPEECH_MEDIA_TYPE_REJECTED",
  AUDIO_INVALID: "SPEECH_AUDIO_INVALID",
  AUDIO_TOO_LARGE: "SPEECH_AUDIO_TOO_LARGE",
  AUDIO_TOO_SHORT: "SPEECH_AUDIO_TOO_SHORT",
  AUDIO_TOO_LONG: "SPEECH_AUDIO_TOO_LONG",
  SESSION_CONFLICT: "SPEECH_SESSION_CONFLICT",
  BUSY: "SPEECH_BUSY",
  PROVIDER_FAILED: "SPEECH_PROVIDER_FAILED",
  CANCELLED: "SPEECH_CANCELLED",
  CLEANUP_FAILED: "SPEECH_CLEANUP_FAILED",
} as const;

type RouteErrorCode = (typeof speechRouteErrorCodes)[keyof typeof speechRouteErrorCodes];

type SpeechFileAdapter = Pick<LocalWhisperCliAdapter, "transcribeFile">;
type SpeechAdapterFactory = (config: LocalWhisperCliConfig) => SpeechFileAdapter;

type ActiveSpeechTask = {
  sessionId: string;
  controller: AbortController;
  cancelled: boolean;
};

export class SpeechTranscriptionRegistry {
  private active?: ActiveSpeechTask;

  claim(sessionId: string): { ok: true; task: ActiveSpeechTask } | { ok: false; code: RouteErrorCode } {
    if (this.active) {
      return {
        ok: false,
        code: this.active.sessionId === sessionId
          ? speechRouteErrorCodes.SESSION_CONFLICT
          : speechRouteErrorCodes.BUSY,
      };
    }
    const task: ActiveSpeechTask = {
      sessionId,
      controller: new AbortController(),
      cancelled: false,
    };
    this.active = task;
    return { ok: true, task };
  }

  cancel(sessionId: string): boolean {
    if (!this.active || this.active.sessionId !== sessionId) return false;
    this.active.cancelled = true;
    this.active.controller.abort();
    return true;
  }

  release(task: ActiveSpeechTask): void {
    if (this.active === task) this.active = undefined;
  }

  get activeSessionId(): string | undefined {
    return this.active?.sessionId;
  }
}

export type SpeechTranscriptionRouteDependencies = Readonly<{
  readRuntimeConfig?: (env?: NodeJS.ProcessEnv) => SpeechRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  registry?: SpeechTranscriptionRegistry;
  adapterFactory?: SpeechAdapterFactory;
  randomId?: () => string;
}>;

type RouteResponse = {
  readonly status: number;
  readonly body: unknown;
};

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function routeErrorBody(sessionId: string | undefined, errorCode: RouteErrorCode): SpeechPortFailure | { ok: false; errorCode: RouteErrorCode } {
  if (!sessionId || !speechIdSchema.safeParse(sessionId).success) return { ok: false, errorCode };
  return speechPortFailureSchema.parse({
    ok: false,
    sessionId,
    provider: LOCAL_WHISPER_PROVIDER,
    errorCode: errorCode === speechRouteErrorCodes.CANCELLED
      ? "SPEECH_CANCELLED"
      : "SPEECH_PROVIDER_FAILED",
    durationMs: 0,
  });
}

function controlledResponse(
  sessionId: string | undefined,
  errorCode: RouteErrorCode,
  status: number,
): Response {
  return jsonResponse(routeErrorBody(sessionId, errorCode), status);
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

function requestHasMultipartContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.startsWith("multipart/form-data;") && contentType.includes("boundary=");
}

function headerContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : Number.POSITIVE_INFINITY;
}

function isSafeFileName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && path.basename(name) === name && name.toLowerCase().endsWith(".wav");
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index));
  return value;
}

function validateWav(bytes: Uint8Array): RouteErrorCode | undefined {
  if (bytes.length === 0 || bytes.length > SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    return bytes.length > SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES
      ? speechRouteErrorCodes.AUDIO_TOO_LARGE
      : speechRouteErrorCodes.AUDIO_INVALID;
  }
  if (bytes.length < 44) return speechRouteErrorCodes.AUDIO_INVALID;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") return speechRouteErrorCodes.AUDIO_INVALID;
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | undefined;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + chunkSize;
    if (end > bytes.length) return speechRouteErrorCodes.AUDIO_INVALID;
    if (chunkId === "fmt ") {
      if (chunkSize < 16) return speechRouteErrorCodes.AUDIO_INVALID;
      format = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        byteRate: view.getUint32(start + 8, true),
        blockAlign: view.getUint16(start + 12, true),
        bitsPerSample: view.getUint16(start + 14, true),
      };
    }
    if (chunkId === "data") dataBytes = chunkSize;
    offset = end + (chunkSize % 2);
  }
  if (!format || dataBytes <= 0) return speechRouteErrorCodes.AUDIO_INVALID;
  if (
    format.audioFormat !== 1
    || format.channels !== 1
    || format.sampleRate !== 16_000
    || format.bitsPerSample !== 16
    || format.blockAlign !== 2
    || format.byteRate !== 32_000
    || dataBytes % 2 !== 0
  ) return speechRouteErrorCodes.AUDIO_INVALID;
  const durationMs = dataBytes / format.byteRate * 1000;
  if (durationMs < SPEECH_TRANSCRIPTION_MIN_DURATION_MS) return speechRouteErrorCodes.AUDIO_TOO_SHORT;
  if (durationMs > SPEECH_TRANSCRIPTION_MAX_DURATION_MS) return speechRouteErrorCodes.AUDIO_TOO_LONG;
  return undefined;
}

async function assertNoSymlinkPath(root: string, candidate: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("unsafe temp path");
  }
  let current = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink > 1)) throw new Error("unsafe temp path");
    } catch (error) {
      if (error instanceof Error && error.message === "unsafe temp path") throw error;
      return;
    }
  }
}

async function createOwnedAudioFile(tempRoot: string, bytes: Uint8Array, randomId: () => string): Promise<string> {
  const inputRoot = path.join(tempRoot, "input");
  await fs.mkdir(inputRoot, { recursive: true });
  await assertNoSymlinkPath(tempRoot, inputRoot);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = path.join(inputRoot, `speech-${randomId()}.wav`);
    if (path.relative(path.resolve(tempRoot), candidate).startsWith(`..${path.sep}`)) throw new Error("unsafe temp path");
    try {
      const handle = await fs.open(candidate, "wx");
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not allocate temp file");
}

async function unlinkIfPresent(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function mapProviderError(error: unknown, task: ActiveSpeechTask): RouteErrorCode {
  if (task.cancelled || (error instanceof LocalWhisperError && error.code === "LOCAL_WHISPER_CANCELLED")) {
    return speechRouteErrorCodes.CANCELLED;
  }
  return speechRouteErrorCodes.PROVIDER_FAILED;
}

function responseForRoute(response: RouteResponse): Response {
  return jsonResponse(response.body, response.status);
}

export function createSpeechTranscriptionRouteHandlers(dependencies: SpeechTranscriptionRouteDependencies = {}) {
  const registry = dependencies.registry ?? new SpeechTranscriptionRegistry();
  const readConfig = dependencies.readRuntimeConfig ?? readSpeechRuntimeConfig;
  const adapterFactory = dependencies.adapterFactory ?? ((config: LocalWhisperCliConfig) => createLocalWhisperCliAdapter(config));
  const randomId = dependencies.randomId ?? (() => randomBytes(18).toString("hex"));

  function readConfigForRequest(): SpeechRuntimeConfig {
    return readConfig(dependencies.env);
  }

  async function post(request: Request): Promise<Response> {
    if (!requestHasStrictSameOrigin(request)) return controlledResponse(undefined, speechRouteErrorCodes.ORIGIN_REJECTED, 403);
    const config = readConfigForRequest();
    if (config.capability.reason === "PUBLIC_DEMO_READ_ONLY") {
      return controlledResponse(undefined, speechRouteErrorCodes.PUBLIC_DEMO_READ_ONLY, 403);
    }
    if (config.capability.status !== "READY" || !config.localWhisper) {
      return controlledResponse(undefined, speechRouteErrorCodes.UNCONFIGURED, 503);
    }
    if (!requestHasMultipartContentType(request)) return controlledResponse(undefined, speechRouteErrorCodes.MEDIA_TYPE_REJECTED, 415);
    const contentLength = headerContentLength(request);
    if (contentLength !== undefined && contentLength > MAX_MULTIPART_BYTES) {
      return controlledResponse(undefined, speechRouteErrorCodes.AUDIO_TOO_LARGE, 413);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return controlledResponse(undefined, speechRouteErrorCodes.INVALID_REQUEST, 400);
    }
    const entries = [...form.entries()];
    const sessionEntries = entries.filter(([key]) => key === "sessionId");
    const audioEntries = entries.filter(([key]) => key === "audio");
    if (
      entries.length !== 2
      || sessionEntries.length !== 1
      || audioEntries.length !== 1
      || typeof sessionEntries[0][1] !== "string"
      || !(audioEntries[0][1] instanceof File)
    ) return controlledResponse(undefined, speechRouteErrorCodes.INVALID_REQUEST, 400);
    const sessionId = sessionEntries[0][1];
    const audio = audioEntries[0][1];
    if (!speechIdSchema.safeParse(sessionId).success || sessionId.length > MAX_SESSION_ID_LENGTH) {
      return controlledResponse(undefined, speechRouteErrorCodes.INVALID_REQUEST, 400);
    }
    if (audio.type !== "audio/wav" || !isSafeFileName(audio.name)) {
      return controlledResponse(sessionId, speechRouteErrorCodes.AUDIO_INVALID, 400);
    }
    if (audio.size > SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      return controlledResponse(sessionId, speechRouteErrorCodes.AUDIO_TOO_LARGE, 413);
    }

    const claim = registry.claim(sessionId);
    if (!claim.ok) return controlledResponse(sessionId, claim.code, claim.code === speechRouteErrorCodes.BUSY ? 429 : 409);
    const task = claim.task;
    let audioPath: string | undefined;
    let adapterStarted = false;
    let routeResult: Response | undefined;
    try {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const audioError = validateWav(bytes);
      if (audioError) {
        routeResult = controlledResponse(sessionId, audioError, audioError === speechRouteErrorCodes.AUDIO_TOO_LARGE ? 413 : 400);
      } else {
        audioPath = await createOwnedAudioFile(config.localWhisper.tempRoot, bytes, randomId);
        const adapter = adapterFactory(config.localWhisper);
        adapterStarted = true;
        const result = await adapter.transcribeFile(audioPath, task.controller.signal);
        if (task.cancelled || task.controller.signal.aborted) {
          routeResult = controlledResponse(sessionId, speechRouteErrorCodes.CANCELLED, 499);
        } else {
          const success = speechPortSuccessSchema.parse({
            ok: true,
            sessionId,
            provider: result.provider,
            transcript: result.transcript,
            durationMs: result.input.durationMs,
          });
          routeResult = responseForRoute({ status: 200, body: success });
        }
      }
    } catch (error) {
      const errorCode = mapProviderError(error, task);
      routeResult = controlledResponse(sessionId, errorCode, errorCode === speechRouteErrorCodes.CANCELLED ? 499 : 502);
    } finally {
      try {
        await unlinkIfPresent(audioPath);
      } catch {
        routeResult = controlledResponse(sessionId, speechRouteErrorCodes.CLEANUP_FAILED, 500);
      }
      registry.release(task);
    }
    if (!routeResult) return controlledResponse(sessionId, adapterStarted ? speechRouteErrorCodes.PROVIDER_FAILED : speechRouteErrorCodes.INVALID_REQUEST, 500);
    return routeResult;
  }

  async function cancel(request: Request, sessionId: string): Promise<Response> {
    if (!requestHasStrictSameOrigin(request)) return controlledResponse(undefined, speechRouteErrorCodes.ORIGIN_REJECTED, 403);
    const config = readConfigForRequest();
    if (config.capability.reason === "PUBLIC_DEMO_READ_ONLY") {
      return controlledResponse(sessionId, speechRouteErrorCodes.PUBLIC_DEMO_READ_ONLY, 403);
    }
    if (config.capability.status !== "READY") return controlledResponse(sessionId, speechRouteErrorCodes.UNCONFIGURED, 503);
    if (!speechIdSchema.safeParse(sessionId).success) return controlledResponse(undefined, speechRouteErrorCodes.INVALID_REQUEST, 400);
    registry.cancel(sessionId);
    const cancelled = speechPortFailureSchema.parse({
      ok: false,
      sessionId,
      provider: LOCAL_WHISPER_PROVIDER,
      errorCode: "SPEECH_CANCELLED",
      durationMs: 0,
    });
    return jsonResponse(cancelled, 200);
  }

  return { post, cancel, registry };
}

const defaultHandlers = createSpeechTranscriptionRouteHandlers();

export async function POST(request: Request): Promise<Response> {
  return defaultHandlers.post(request);
}

export async function DELETE(request: Request, sessionId: string): Promise<Response> {
  return defaultHandlers.cancel(request, sessionId);
}
