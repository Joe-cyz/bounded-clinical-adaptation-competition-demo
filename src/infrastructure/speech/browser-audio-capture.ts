import {
  speechErrorCodes,
  speechFailureReasonSchema,
  type SpeechErrorCode,
  type SpeechFailureReason,
} from "@/domain/speech";

export const BROWSER_AUDIO_SAMPLE_RATE = 16_000 as const;
export const BROWSER_AUDIO_CHANNELS = 1 as const;
export const BROWSER_AUDIO_BITS_PER_SAMPLE = 16 as const;
export const BROWSER_AUDIO_MIN_DURATION_MS = 500 as const;
export const BROWSER_AUDIO_MAX_DURATION_MS = 15_000 as const;
export const BROWSER_AUDIO_MAX_BYTES = 500 * 1024;

export type BrowserAudioCaptureStatus =
  | "READY"
  | "UNSUPPORTED"
  | "PERMISSION_REQUIRED"
  | "PERMISSION_DENIED"
  | "RECORDING";

export type BrowserAudioCaptureResult = {
  audioBytes: Uint8Array;
  durationMs: number;
  mimeType: "audio/wav";
  sourceMimeType: string;
  retainedAudio: false;
};

export type BrowserAudioCaptureFailure = {
  code: SpeechErrorCode;
  failureReason?: SpeechFailureReason;
};

export class BrowserAudioCaptureError extends Error {
  readonly failureReason: SpeechFailureReason;

  constructor(failureReason: SpeechFailureReason) {
    super("Browser audio capture failed.");
    this.name = "BrowserAudioCaptureError";
    this.failureReason = speechFailureReasonSchema.parse(failureReason);
  }
}

class BrowserAudioCaptureCancelledError extends Error {
  constructor() {
    super("Browser audio capture was cancelled.");
    this.name = "BrowserAudioCaptureCancelledError";
  }
}

type DecodedAudioBuffer = {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly duration?: number;
  getChannelData(channel: number): Float32Array;
};

type DecodeAudioContext = {
  decodeAudioData(data: ArrayBuffer): Promise<DecodedAudioBuffer>;
  close?: () => Promise<void> | void;
};

type OfflineAudioContextLike = {
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): {
    getChannelData(channel: number): Float32Array;
  };
  createBufferSource(): {
    buffer: unknown;
    connect(destination: unknown): void;
    start(when?: number): void;
  };
  readonly destination: unknown;
  startRendering(): Promise<DecodedAudioBuffer>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type BrowserAudioCaptureDependencies = Readonly<{
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createMediaRecorder?: (stream: MediaStream) => MediaRecorder;
  createAudioContext?: () => DecodeAudioContext;
  createOfflineAudioContext?: (
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ) => OfflineAudioContextLike;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  cancelTimeout?: (timer: TimerHandle) => void;
  onFailure?: (failure: BrowserAudioCaptureFailure) => void;
}>;

function browserGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

function browserCreateMediaRecorder(stream: MediaStream): MediaRecorder {
  return new MediaRecorder(stream);
}

function browserCreateAudioContext(): DecodeAudioContext {
  const AudioContextConstructor = globalThis.AudioContext;
  if (typeof AudioContextConstructor !== "function") {
    throw new Error("Audio decoding is unavailable.");
  }
  return new AudioContextConstructor();
}

function browserCreateOfflineAudioContext(
  numberOfChannels: number,
  length: number,
  sampleRate: number,
): OfflineAudioContextLike {
  const OfflineAudioContextConstructor = globalThis.OfflineAudioContext;
  if (typeof OfflineAudioContextConstructor !== "function") {
    throw new Error("Offline audio rendering is unavailable.");
  }
  return new OfflineAudioContextConstructor(numberOfChannels, length, sampleRate);
}

function hasBrowserAudioApis(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined"
    && typeof globalThis.AudioContext !== "undefined"
    && typeof globalThis.OfflineAudioContext !== "undefined";
}

function clampPcm16(value: number): number {
  const clipped = Math.max(-1, Math.min(1, value));
  return clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff);
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = BROWSER_AUDIO_SAMPLE_RATE): Uint8Array {
  if (sampleRate !== BROWSER_AUDIO_SAMPLE_RATE || samples.length === 0) {
    throw new Error("PCM audio does not satisfy the fixed speech contract.");
  }
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, BROWSER_AUDIO_CHANNELS, true);
  view.setUint32(24, BROWSER_AUDIO_SAMPLE_RATE, true);
  view.setUint32(28, BROWSER_AUDIO_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, BROWSER_AUDIO_BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * 2, clampPcm16(samples[index]), true);
  }
  return new Uint8Array(buffer);
}

export function parsePcm16WavHeader(bytes: Uint8Array): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  dataBytes: number;
} {
  if (bytes.length < 44) throw new Error("WAV is too short.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number): string => {
    let value = "";
    for (let index = 0; index < length; index += 1) value += String.fromCharCode(view.getUint8(offset + index));
    return value;
  };
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || ascii(12, 4) !== "fmt ") {
    throw new Error("WAV header is invalid.");
  }
  const fmtSize = view.getUint32(16, true);
  if (fmtSize !== 16 || ascii(36, 4) !== "data") throw new Error("WAV chunks are invalid.");
  const dataBytes = view.getUint32(40, true);
  if (44 + dataBytes > bytes.length) throw new Error("WAV data is truncated.");
  return {
    sampleRate: view.getUint32(24, true),
    channels: view.getUint16(22, true),
    bitsPerSample: view.getUint16(34, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    dataBytes,
  };
}

function releaseStream(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function isSilent(samples: Float32Array): boolean {
  if (samples.length === 0) return true;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) < 0.0005;
}

/**
 * Browser-only capture boundary. Permission is requested only from start().
 * The recorder Blob is decoded and resampled in memory; no audio is written
 * to disk, storage, cookies or logs, and every terminal path releases tracks.
 */
export class BrowserAudioCaptureAdapter {
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private sourceMimeType = "";
  private startedAt?: number;
  private stopPromise?: Promise<BrowserAudioCaptureResult>;
  private autoStopTimer?: TimerHandle;
  private cancelled = false;

  private readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  private readonly createMediaRecorder: (stream: MediaStream) => MediaRecorder;
  private readonly createAudioContext: () => DecodeAudioContext;
  private readonly createOfflineAudioContext: (
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ) => OfflineAudioContextLike;
  private readonly now: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimeout: (timer: TimerHandle) => void;
  private readonly onFailure?: (failure: BrowserAudioCaptureFailure) => void;

  constructor(dependencies: BrowserAudioCaptureDependencies = {}) {
    this.getUserMedia = dependencies.getUserMedia ?? browserGetUserMedia;
    this.createMediaRecorder = dependencies.createMediaRecorder ?? browserCreateMediaRecorder;
    this.createAudioContext = dependencies.createAudioContext ?? browserCreateAudioContext;
    this.createOfflineAudioContext = dependencies.createOfflineAudioContext ?? browserCreateOfflineAudioContext;
    this.now = dependencies.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.scheduleTimeout = dependencies.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimeout = dependencies.cancelTimeout ?? ((timer) => clearTimeout(timer));
    this.onFailure = dependencies.onFailure;
  }

  get status(): BrowserAudioCaptureStatus {
    if (!hasBrowserAudioApis() && this.getUserMedia === browserGetUserMedia) return "UNSUPPORTED";
    if (this.recorder?.state === "recording") return "RECORDING";
    return "READY";
  }

  async start(): Promise<BrowserAudioCaptureStatus> {
    if (this.status === "UNSUPPORTED") return "UNSUPPORTED";
    if (this.recorder?.state === "recording") return "RECORDING";
    this.cancelled = false;
    let stream: MediaStream;
    try {
      stream = await this.getUserMedia({ audio: true });
    } catch {
      this.onFailure?.({ code: speechErrorCodes.PERMISSION_DENIED });
      return "PERMISSION_DENIED";
    }

    if (this.cancelled) {
      releaseStream(stream);
      this.release();
      return "PERMISSION_DENIED";
    }

    try {
      const recorder = this.createMediaRecorder(stream);
      this.stream = stream;
      this.recorder = recorder;
      this.chunks = [];
      this.sourceMimeType = recorder.mimeType || "audio/webm";
      this.startedAt = this.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.start();
      this.autoStopTimer = this.scheduleTimeout(() => {
        if (this.recorder?.state === "recording") {
          void this.stop().catch((error: unknown) => {
            this.reportFailure(error);
          });
        }
      }, BROWSER_AUDIO_MAX_DURATION_MS);
      return "RECORDING";
    } catch {
      releaseStream(stream);
      this.release();
      this.onFailure?.({ code: speechErrorCodes.UNSUPPORTED });
      return "UNSUPPORTED";
    }
  }

  stop(): Promise<BrowserAudioCaptureResult> {
    if (this.stopPromise) return this.stopPromise;
    const recorder = this.recorder;
    if (!recorder || recorder.state !== "recording") {
      return Promise.reject(new Error("Speech recording is not active."));
    }

    this.stopPromise = new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const chunks = [...this.chunks];
        const sourceMimeType = this.sourceMimeType;
        const durationMs = Math.max(0, Math.round(this.now() - (this.startedAt ?? this.now())));
        void this.convertRecordedBlob(chunks, sourceMimeType, durationMs)
          .then((result) => {
            this.release();
            resolve(result);
          })
          .catch((error: unknown) => {
            this.release();
            this.reportFailure(error);
            reject(error);
          });
      };
      try {
        recorder.stop();
      } catch (error) {
        this.release();
        this.reportFailure(error);
        reject(new Error("Speech recording could not be stopped."));
      }
    });
    return this.stopPromise;
  }

  cancel(): void {
    this.cancelled = true;
    try {
      if (this.recorder?.state === "recording") this.recorder.stop();
    } catch {
      // The explicit release below is the authoritative cleanup path.
    } finally {
      this.release();
    }
  }

  private async convertRecordedBlob(
    chunks: readonly Blob[],
    sourceMimeType: string,
    recorderDurationMs: number,
  ): Promise<BrowserAudioCaptureResult> {
    if (this.cancelled) throw new BrowserAudioCaptureCancelledError();
    const sourceBlob = new Blob([...chunks], { type: sourceMimeType });
    if (sourceBlob.size === 0) throw new BrowserAudioCaptureError("SPEECH_NO_AUDIO_DETECTED");
    let context: DecodeAudioContext | undefined;
    try {
      context = this.createAudioContext();
      const decoded = await context.decodeAudioData(await sourceBlob.arrayBuffer());
      if (this.cancelled) throw new BrowserAudioCaptureCancelledError();
      if (decoded.length <= 0 || decoded.numberOfChannels <= 0) {
        throw new BrowserAudioCaptureError("SPEECH_NO_AUDIO_DETECTED");
      }
      if (!Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0) {
        throw new BrowserAudioCaptureError("SPEECH_BROWSER_AUDIO_FAILED");
      }
      const durationMs = Math.round((decoded.duration ?? (decoded.length / decoded.sampleRate)) * 1000);
      if (!Number.isFinite(durationMs)) throw new BrowserAudioCaptureError("SPEECH_BROWSER_AUDIO_FAILED");
      if (durationMs < BROWSER_AUDIO_MIN_DURATION_MS) {
        throw new BrowserAudioCaptureError("SPEECH_RECORDING_TOO_SHORT");
      }
      if (durationMs > BROWSER_AUDIO_MAX_DURATION_MS || recorderDurationMs > BROWSER_AUDIO_MAX_DURATION_MS + 250) {
        throw new BrowserAudioCaptureError("SPEECH_BROWSER_AUDIO_FAILED");
      }
      const outputLength = Math.max(1, Math.round(decoded.length * BROWSER_AUDIO_SAMPLE_RATE / decoded.sampleRate));
      const offline = this.createOfflineAudioContext(BROWSER_AUDIO_CHANNELS, outputLength, BROWSER_AUDIO_SAMPLE_RATE);
      const mono = offline.createBuffer(BROWSER_AUDIO_CHANNELS, decoded.length, decoded.sampleRate);
      const monoSamples = mono.getChannelData(0);
      const decodedChannels = Array.from(
        { length: decoded.numberOfChannels },
        (_, channel) => decoded.getChannelData(channel),
      );
      for (let index = 0; index < decoded.length; index += 1) {
        let sum = 0;
        for (const channelData of decodedChannels) {
          sum += channelData[index] ?? 0;
        }
        monoSamples[index] = sum / Math.max(1, decoded.numberOfChannels);
      }
      const source = offline.createBufferSource();
      source.buffer = mono;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      if (this.cancelled) throw new BrowserAudioCaptureCancelledError();
      const samples = rendered.getChannelData(0);
      if (isSilent(samples)) throw new BrowserAudioCaptureError("SPEECH_NO_AUDIO_DETECTED");
      const audioBytes = encodePcm16Wav(samples);
      if (audioBytes.length > BROWSER_AUDIO_MAX_BYTES) {
        throw new BrowserAudioCaptureError("SPEECH_BROWSER_AUDIO_FAILED");
      }
      const header = parsePcm16WavHeader(audioBytes);
      if (
        header.sampleRate !== BROWSER_AUDIO_SAMPLE_RATE
        || header.channels !== BROWSER_AUDIO_CHANNELS
        || header.bitsPerSample !== BROWSER_AUDIO_BITS_PER_SAMPLE
        || header.byteRate !== BROWSER_AUDIO_SAMPLE_RATE * 2
        || header.blockAlign !== 2
      ) throw new BrowserAudioCaptureError("SPEECH_BROWSER_AUDIO_FAILED");
      return {
        audioBytes,
        durationMs: Math.round(samples.length / BROWSER_AUDIO_SAMPLE_RATE * 1000),
        mimeType: "audio/wav",
        sourceMimeType,
        retainedAudio: false,
      };
    } catch (error) {
      if (error instanceof BrowserAudioCaptureError || error instanceof BrowserAudioCaptureCancelledError) {
        throw error;
      }
      throw new BrowserAudioCaptureError("SPEECH_BROWSER_AUDIO_FAILED");
    } finally {
      await context?.close?.();
    }
  }

  private reportFailure(error: unknown): void {
    if (error instanceof BrowserAudioCaptureCancelledError) {
      this.onFailure?.({ code: speechErrorCodes.CANCELLED });
      return;
    }
    this.onFailure?.({
      code: speechErrorCodes.PROVIDER_FAILED,
      failureReason: error instanceof BrowserAudioCaptureError
        ? error.failureReason
        : "SPEECH_BROWSER_AUDIO_FAILED",
    });
  }

  private release(): void {
    if (this.autoStopTimer !== undefined) {
      this.cancelTimeout(this.autoStopTimer);
      this.autoStopTimer = undefined;
    }
    releaseStream(this.stream);
    this.stream = undefined;
    this.recorder = undefined;
    this.chunks = [];
    this.sourceMimeType = "";
    this.startedAt = undefined;
    this.stopPromise = undefined;
  }
}

export function createBrowserAudioCaptureAdapter(
  dependencies: BrowserAudioCaptureDependencies = {},
): BrowserAudioCaptureAdapter {
  return new BrowserAudioCaptureAdapter(dependencies);
}
