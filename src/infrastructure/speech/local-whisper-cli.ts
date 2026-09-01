import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  speechProviderDescriptorSchema,
  speechTranscriptSchema,
  type SpeechProviderDescriptor,
  type SpeechTranscript,
} from "@/domain/speech";

export const LOCAL_WHISPER_VERSION = "v1.9.2" as const;
export const LOCAL_WHISPER_TIMEOUT_MS = 180_000 as const;
export const LOCAL_WHISPER_EXECUTABLE_NAME = "whisper-cli.exe" as const;
export const LOCAL_WHISPER_EXECUTABLE_SHA256 = "95e3c0b0e778ad9499eb0125f97c1dcf437dd9eb4ea77050b043574f93c2631d" as const;
export const LOCAL_WHISPER_MODEL_NAME = "ggml-small.bin" as const;
export const LOCAL_WHISPER_MODEL_SHA256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" as const;
export const LOCAL_WHISPER_PROVIDER: SpeechProviderDescriptor = speechProviderDescriptorSchema.parse({
  providerType: "LOCAL_WHISPER",
  providerVersion: `whisper.cpp@${LOCAL_WHISPER_VERSION}`,
  networkUsed: false,
  retainedAudio: false,
});

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 30_000;
const OUTPUT_CLEANUP_EXTENSIONS = [".json", ".txt", ".vtt", ".srt", ".lrc", ".csv", ".wts"] as const;
const MAX_CAPTURED_PROCESS_OUTPUT_BYTES = 1_000_000;

export const localWhisperErrorCodes = {
  INVALID_CONFIG: "LOCAL_WHISPER_INVALID_CONFIG",
  INVALID_INPUT: "LOCAL_WHISPER_INVALID_INPUT",
  PROCESS_FAILED: "LOCAL_WHISPER_PROCESS_FAILED",
  TIMEOUT: "LOCAL_WHISPER_TIMEOUT",
  CANCELLED: "LOCAL_WHISPER_CANCELLED",
  OUTPUT_MISSING: "LOCAL_WHISPER_OUTPUT_MISSING",
  OUTPUT_INVALID: "LOCAL_WHISPER_OUTPUT_INVALID",
  CLEANUP_FAILED: "LOCAL_WHISPER_CLEANUP_FAILED",
} as const;
export type LocalWhisperErrorCode = (typeof localWhisperErrorCodes)[keyof typeof localWhisperErrorCodes];

export class LocalWhisperError extends Error {
  readonly code: LocalWhisperErrorCode;

  constructor(code: LocalWhisperErrorCode, message: string) {
    super(message);
    this.name = "LocalWhisperError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  }
}

export type LocalWhisperCliConfig = Readonly<{
  executablePath: string;
  modelPath: string;
  tempRoot: string;
}>;

export type LocalWhisperSpawnOptions = Readonly<{
  shell: false;
  windowsHide: true;
  cwd: string;
  stdio: ["ignore", "pipe", "pipe"];
}>;

export type LocalWhisperExecutionResult = Readonly<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  processError: boolean;
}>;

export type LocalWhisperExecution = Readonly<{
  completion: Promise<LocalWhisperExecutionResult>;
  terminate: () => void;
}>;

export type LocalWhisperSpawn = (
  executablePath: string,
  args: readonly string[],
  options: LocalWhisperSpawnOptions,
) => LocalWhisperExecution;

type TimerHandle = ReturnType<typeof setTimeout>;

export type LocalWhisperCliDependencies = Readonly<{
  spawnProcess?: LocalWhisperSpawn;
  sha256File?: (filePath: string) => Promise<string>;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelTimeout?: (timer: TimerHandle) => void;
  createOutputId?: () => string;
}>;

export type LocalWhisperTimings = Readonly<{
  modelLoadMs?: number;
  melMs?: number;
  encodeMs?: number;
  decodeMs?: number;
  totalMs?: number;
}>;

export type LocalWhisperTranscriptionResult = Readonly<{
  provider: SpeechProviderDescriptor;
  transcript: SpeechTranscript;
  elapsedMs: number;
  timings: LocalWhisperTimings;
  input: Readonly<{
    sizeBytes: number;
    durationMs: number;
    sha256: string;
  }>;
}>;

const whisperOutputSegmentSchema = z.object({
  text: z.string(),
  offsets: z.object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }).strict().optional(),
  timestamps: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
  }).strict().optional(),
}).passthrough();

const whisperOutputSchema = z.object({
  transcription: z.array(whisperOutputSegmentSchema).min(1).max(200),
}).passthrough();

type ParsedWav = Readonly<{
  sizeBytes: number;
  durationMs: number;
}>;

type ParsedWhisperSegment = Readonly<{
  text: string;
  startMs: number;
  endMs: number;
}>;

function invalidConfig(): never {
  throw new LocalWhisperError(
    localWhisperErrorCodes.INVALID_CONFIG,
    "Local Whisper configuration is invalid.",
  );
}

function invalidInput(): never {
  throw new LocalWhisperError(
    localWhisperErrorCodes.INVALID_INPUT,
    "Local Whisper input audio is invalid.",
  );
}

function invalidOutput(): never {
  throw new LocalWhisperError(
    localWhisperErrorCodes.OUTPUT_INVALID,
    "Local Whisper output is invalid.",
  );
}

function asAbsolutePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    invalidConfig();
  }
  return path.normalize(value);
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertNoSymlinkPath(rootPath: string, candidatePath: string): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalidInput();
  }

  let currentPath = resolvedRoot;
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    currentPath = path.join(currentPath, part);
    let entry;
    try {
      entry = await fs.lstat(currentPath);
    } catch {
      return;
    }
    if (entry.isSymbolicLink() || (entry.isFile() && entry.nlink > 1)) {
      invalidInput();
    }
  }
}

async function assertRegularFile(filePath: string, errorCode: LocalWhisperErrorCode): Promise<void> {
  let entry;
  try {
    entry = await fs.lstat(filePath);
  } catch {
    throw new LocalWhisperError(errorCode, "Local Whisper fixed file is unavailable.");
  }
  if (entry.isSymbolicLink() || entry.nlink > 1 || !entry.isFile()) {
    throw new LocalWhisperError(errorCode, "Local Whisper fixed file is unavailable.");
  }
}

function readUInt32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    invalidInput();
  }
  return buffer.readUInt32LE(offset);
}

function readUInt16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) {
    invalidInput();
  }
  return buffer.readUInt16LE(offset);
}

function parseWav(buffer: Buffer): ParsedWav {
  if (
    buffer.length < 44
    || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    invalidInput();
  }

  let offset = 12;
  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let bitsPerSample: number | undefined;
  let dataSize: number | undefined;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = readUInt32(buffer, offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      invalidInput();
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        invalidInput();
      }
      audioFormat = readUInt16(buffer, chunkStart);
      channels = readUInt16(buffer, chunkStart + 2);
      sampleRate = readUInt32(buffer, chunkStart + 4);
      byteRate = readUInt32(buffer, chunkStart + 8);
      blockAlign = readUInt16(buffer, chunkStart + 12);
      bitsPerSample = readUInt16(buffer, chunkStart + 14);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (
    audioFormat !== 1
    || channels !== 1
    || sampleRate === undefined
    || sampleRate !== 16_000
    || byteRate !== 32_000
    || blockAlign !== 2
    || bitsPerSample !== 16
    || dataSize === undefined
    || dataSize <= 0
    || dataSize % 2 !== 0
  ) {
    invalidInput();
  }

  const bytesPerSample = bitsPerSample / 8;
  const durationMs = Math.round((dataSize / (sampleRate * channels * bytesPerSample)) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_DURATION_MS) {
    invalidInput();
  }

  return { sizeBytes: buffer.length, durationMs };
}

function parseTimestamp(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/u.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  const totalMs = (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
  return Number.isSafeInteger(totalMs) ? totalMs : undefined;
}

function parseWhisperSegment(segment: z.infer<typeof whisperOutputSegmentSchema>): ParsedWhisperSegment {
  const text = segment.text.trim();
  if (text.length === 0) {
    invalidOutput();
  }

  let startMs: number | undefined;
  let endMs: number | undefined;
  if (segment.offsets !== undefined) {
    startMs = segment.offsets.from;
    endMs = segment.offsets.to;
  } else if (segment.timestamps !== undefined) {
    startMs = parseTimestamp(segment.timestamps.from);
    endMs = parseTimestamp(segment.timestamps.to);
  }
  if (startMs === undefined || endMs === undefined || endMs < startMs) {
    invalidOutput();
  }

  return { text, startMs, endMs };
}

export function parseWhisperJson(jsonText: string, inputDurationMs: number): SpeechTranscript {
  let json: unknown;
  try {
    json = JSON.parse(jsonText) as unknown;
  } catch {
    invalidOutput();
  }

  const parsed = whisperOutputSchema.safeParse(json);
  if (!parsed.success) {
    invalidOutput();
  }

  const segments = parsed.data.transcription.map(parseWhisperSegment);
  if (segments.length === 0 || segments.length > 40) {
    invalidOutput();
  }

  const maxAllowedEndMs = inputDurationMs + 250;
  let previousEndMs = 0;
  for (const segment of segments) {
    if (segment.startMs < previousEndMs || segment.endMs > maxAllowedEndMs) {
      invalidOutput();
    }
    previousEndMs = Math.max(previousEndMs, segment.endMs);
  }

  const transcriptDurationMs = Math.max(inputDurationMs, ...segments.map((segment) => segment.endMs));
  const transcript = {
    text: segments.map((segment) => segment.text).join(""),
    segments: segments.map((segment, index) => ({
      id: `local-whisper-segment-${index + 1}`,
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      confidenceStatus: "NOT_PROVIDED" as const,
    })),
    durationMs: transcriptDurationMs,
  };
  const validated = speechTranscriptSchema.safeParse(transcript);
  if (!validated.success) {
    invalidOutput();
  }
  return validated.data;
}

export function buildLocalWhisperArgs(input: Readonly<{
  modelPath: string;
  audioPath: string;
  outputBasePath: string;
  cwd?: string;
}>): string[] {
  const processPath = (value: string): string => {
    if (input.cwd === undefined) {
      return value;
    }
    const relative = path.relative(input.cwd, value);
    return relative.length === 0 ? path.basename(value) : relative;
  };

  return [
    "-m", processPath(input.modelPath),
    "-f", processPath(input.audioPath),
    "-l", "zh",
    "-oj",
    "-of", processPath(input.outputBasePath),
    "-ng",
  ];
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function assertFrozenFile(
  filePath: string,
  expectedName: string,
  expectedSha256: string,
  digestFile: (filePath: string) => Promise<string>,
): Promise<void> {
  if (path.basename(filePath) !== expectedName) {
    invalidConfig();
  }
  let actualSha256: string;
  try {
    actualSha256 = await digestFile(filePath);
  } catch {
    invalidConfig();
  }
  if (actualSha256.toLowerCase() !== expectedSha256) {
    invalidConfig();
  }
}

function parseTiming(text: string, label: RegExp): number | undefined {
  const match = label.exec(text);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseWhisperTimings(output: string): LocalWhisperTimings {
  return {
    modelLoadMs: parseTiming(output, /load time\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/iu),
    melMs: parseTiming(output, /mel time\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/iu),
    encodeMs: parseTiming(output, /encode time\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/iu),
    decodeMs: parseTiming(output, /decode time\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/iu),
    totalMs: parseTiming(output, /total time\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/iu),
  };
}

function createDefaultSpawn(): LocalWhisperSpawn {
  return (executablePath, args, options) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const appendOutput = (current: string, chunk: Buffer | string, byteCount: number): Readonly<{ value: string; bytes: number }> => {
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (byteCount >= MAX_CAPTURED_PROCESS_OUTPUT_BYTES) {
        return { value: current, bytes: byteCount };
      }
      const remaining = MAX_CAPTURED_PROCESS_OUTPUT_BYTES - byteCount;
      const limited = Buffer.byteLength(value, "utf8") > remaining
        ? Buffer.from(value, "utf8").subarray(0, remaining).toString("utf8")
        : value;
      return { value: current + limited, bytes: byteCount + Buffer.byteLength(limited, "utf8") };
    };

    let child;
    try {
      child = spawn(executablePath, [...args], options);
    } catch {
      return {
        completion: Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", processError: true }),
        terminate: () => undefined,
      };
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = appendOutput(stdout, chunk, stdoutBytes);
      stdout = next.value;
      stdoutBytes = next.bytes;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const next = appendOutput(stderr, chunk, stderrBytes);
      stderr = next.value;
      stderrBytes = next.bytes;
    });

    const completion = new Promise<LocalWhisperExecutionResult>((resolve) => {
      let settled = false;
      const finish = (result: LocalWhisperExecutionResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      child.once("error", () => finish({ exitCode: null, signal: null, stdout, stderr, processError: true }));
      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => finish({
        exitCode,
        signal,
        stdout,
        stderr,
        processError: false,
      }));
    });

    return {
      completion,
      terminate: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may already have exited.
        }
      },
    };
  };
}

async function terminateAndDrain(
  execution: LocalWhisperExecution,
  scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle,
  cancelTimeout: (timer: TimerHandle) => void,
): Promise<void> {
  execution.terminate();
  let drainTimer: TimerHandle | undefined;
  const drainPromise = new Promise<void>((resolve) => {
    drainTimer = scheduleTimeout(resolve, 2_000);
  });
  await Promise.race([execution.completion.then(() => undefined).catch(() => undefined), drainPromise]);
  if (drainTimer !== undefined) {
    cancelTimeout(drainTimer);
  }
}

async function executeWithDeadline(
  execution: LocalWhisperExecution,
  signal: AbortSignal | undefined,
  scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle,
  cancelTimeout: (timer: TimerHandle) => void,
): Promise<LocalWhisperExecutionResult> {
  if (signal?.aborted) {
    await terminateAndDrain(execution, scheduleTimeout, cancelTimeout);
    throw new LocalWhisperError(localWhisperErrorCodes.CANCELLED, "Local Whisper transcription was cancelled.");
  }

  let timeoutTimer: TimerHandle | undefined;
  let abortHandler: (() => void) | undefined;
  let resolveAbort: (() => void) | undefined;
  const abortPromise = new Promise<"cancelled">((resolve) => {
    resolveAbort = () => resolve("cancelled");
    if (signal) {
      abortHandler = () => resolveAbort?.();
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutTimer = scheduleTimeout(() => resolve("timeout"), LOCAL_WHISPER_TIMEOUT_MS);
  });

  let outcome: LocalWhisperExecutionResult | "cancelled" | "timeout";
  try {
    outcome = await Promise.race([execution.completion, abortPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer !== undefined) {
      cancelTimeout(timeoutTimer);
    }
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }

  if (outcome === "cancelled") {
    await terminateAndDrain(execution, scheduleTimeout, cancelTimeout);
    throw new LocalWhisperError(localWhisperErrorCodes.CANCELLED, "Local Whisper transcription was cancelled.");
  }
  if (outcome === "timeout") {
    await terminateAndDrain(execution, scheduleTimeout, cancelTimeout);
    throw new LocalWhisperError(localWhisperErrorCodes.TIMEOUT, "Local Whisper transcription timed out.");
  }
  return outcome;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    const entry = await fs.lstat(filePath);
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error("not a file");
    }
    await fs.unlink(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function cleanupFiles(audioPath: string | undefined, outputBasePath: string | undefined): Promise<void> {
  const paths = [
    ...(audioPath === undefined ? [] : [audioPath]),
    ...(outputBasePath === undefined ? [] : OUTPUT_CLEANUP_EXTENSIONS.map((extension) => `${outputBasePath}${extension}`)),
  ];
  for (const filePath of paths) {
    await unlinkIfPresent(filePath);
  }
}

function defaultCreateOutputId(): string {
  return randomBytes(16).toString("hex");
}

export class LocalWhisperCliAdapter {
  readonly provider = LOCAL_WHISPER_PROVIDER;

  private readonly executablePath: string;
  private readonly modelPath: string;
  private readonly tempRoot: string;
  private readonly spawnProcess: LocalWhisperSpawn;
  private readonly sha256File: (filePath: string) => Promise<string>;
  private readonly now: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimeout: (timer: TimerHandle) => void;
  private readonly createOutputId: () => string;

  constructor(config: LocalWhisperCliConfig, dependencies: LocalWhisperCliDependencies = {}) {
    this.executablePath = asAbsolutePath(config.executablePath);
    this.modelPath = asAbsolutePath(config.modelPath);
    this.tempRoot = asAbsolutePath(config.tempRoot);
    if (
      path.basename(this.executablePath).toLowerCase() !== LOCAL_WHISPER_EXECUTABLE_NAME
      || path.basename(this.modelPath) !== LOCAL_WHISPER_MODEL_NAME
    ) {
      invalidConfig();
    }
    this.spawnProcess = dependencies.spawnProcess ?? createDefaultSpawn();
    this.sha256File = dependencies.sha256File ?? sha256File;
    this.now = dependencies.now ?? Date.now;
    this.scheduleTimeout = dependencies.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = dependencies.cancelTimeout ?? ((timer) => clearTimeout(timer));
    this.createOutputId = dependencies.createOutputId ?? defaultCreateOutputId;
  }

  async transcribeFile(audioPath: string, signal?: AbortSignal): Promise<LocalWhisperTranscriptionResult> {
    if (!path.isAbsolute(audioPath) || !isWithin(this.tempRoot, audioPath)) {
      invalidInput();
    }
    await assertNoSymlinkPath(this.tempRoot, audioPath);
    await assertRegularFile(audioPath, localWhisperErrorCodes.INVALID_INPUT);

    const inputPathForCleanup = path.normalize(audioPath);
    const processCwd = path.dirname(this.executablePath);

    let outputBasePath: string | undefined;
    let operationError: LocalWhisperError | undefined;
    let result: LocalWhisperTranscriptionResult | undefined;
    const startedAt = this.now();
    try {
      try {
        await assertRegularFile(this.executablePath, localWhisperErrorCodes.INVALID_CONFIG);
        await assertRegularFile(this.modelPath, localWhisperErrorCodes.INVALID_CONFIG);
        await assertFrozenFile(
          this.executablePath,
          LOCAL_WHISPER_EXECUTABLE_NAME,
          LOCAL_WHISPER_EXECUTABLE_SHA256,
          this.sha256File,
        );
        await assertFrozenFile(
          this.modelPath,
          LOCAL_WHISPER_MODEL_NAME,
          LOCAL_WHISPER_MODEL_SHA256,
          this.sha256File,
        );

        const audioBuffer = await fs.readFile(inputPathForCleanup);
        if (audioBuffer.length === 0 || audioBuffer.length > MAX_AUDIO_BYTES) {
          invalidInput();
        }
        const wav = parseWav(audioBuffer);
        const inputSha256 = createHash("sha256").update(audioBuffer).digest("hex");

        const outputRoot = path.join(this.tempRoot, "output");
        await fs.mkdir(outputRoot, { recursive: true });
        await assertNoSymlinkPath(this.tempRoot, outputRoot);
        const candidateOutputBasePath = path.join(outputRoot, `local-whisper-${this.createOutputId()}`);
        if (!isWithin(this.tempRoot, candidateOutputBasePath)) {
          throw new LocalWhisperError(localWhisperErrorCodes.CLEANUP_FAILED, "Local Whisper output path is invalid.");
        }
        outputBasePath = candidateOutputBasePath;
        const args = buildLocalWhisperArgs({
          modelPath: this.modelPath,
          audioPath: inputPathForCleanup,
          outputBasePath: candidateOutputBasePath,
          cwd: processCwd,
        });
        const execution = this.spawnProcess(this.executablePath, args, {
          shell: false,
          windowsHide: true,
          cwd: processCwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const executionResult = await executeWithDeadline(
          execution,
          signal,
          this.scheduleTimeout,
          this.cancelTimeout,
        );
        if (executionResult.processError || executionResult.exitCode !== 0) {
          throw new LocalWhisperError(localWhisperErrorCodes.PROCESS_FAILED, "Local Whisper process failed.");
        }

        const outputJsonPath = `${candidateOutputBasePath}.json`;
        let jsonText: string;
        try {
          jsonText = await fs.readFile(outputJsonPath, "utf8");
        } catch {
          throw new LocalWhisperError(localWhisperErrorCodes.OUTPUT_MISSING, "Local Whisper output is missing.");
        }
        const transcript = parseWhisperJson(jsonText, wav.durationMs);
        result = {
          provider: this.provider,
          transcript,
          elapsedMs: Math.max(0, Math.round(this.now() - startedAt)),
          timings: parseWhisperTimings(`${executionResult.stdout}\n${executionResult.stderr}`),
          input: {
            sizeBytes: wav.sizeBytes,
            durationMs: wav.durationMs,
            sha256: inputSha256,
          },
        };
      } catch (error) {
        operationError = error instanceof LocalWhisperError
          ? error
          : new LocalWhisperError(localWhisperErrorCodes.PROCESS_FAILED, "Local Whisper processing failed.");
      }
    } finally {
      try {
        await cleanupFiles(inputPathForCleanup, outputBasePath);
      } catch {
        throw new LocalWhisperError(localWhisperErrorCodes.CLEANUP_FAILED, "Local Whisper temporary files could not be removed.");
      }
    }
    if (operationError !== undefined) {
      throw operationError;
    }
    if (result === undefined) {
      throw new LocalWhisperError(localWhisperErrorCodes.PROCESS_FAILED, "Local Whisper processing failed.");
    }
    return result;
  }
}

export function createLocalWhisperCliAdapter(
  config: LocalWhisperCliConfig,
  dependencies: LocalWhisperCliDependencies = {},
): LocalWhisperCliAdapter {
  return new LocalWhisperCliAdapter(config, dependencies);
}
