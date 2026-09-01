import {
  speechPortFailureSchema,
  speechPortSuccessSchema,
  speechProviderDescriptorSchema,
  type SpeechCapability,
  type SpeechFailureReason,
  type SpeechPortFailure,
  type SpeechPortStartResult,
  type SpeechPortSuccess,
  type SpeechRecognitionPort,
} from "@/domain/speech";
import {
  BrowserAudioCaptureError,
  createBrowserAudioCaptureAdapter,
  type BrowserAudioCaptureAdapter,
} from "./browser-audio-capture";

const LOCAL_WHISPER_PROVIDER = speechProviderDescriptorSchema.parse({
  providerType: "LOCAL_WHISPER",
  providerVersion: "whisper.cpp@v1.9.2",
  networkUsed: false,
  retainedAudio: false,
});

const responseShape = {
  ok: true as const,
};

type LocalSpeechProviderDependencies = Readonly<{
  capture?: BrowserAudioCaptureAdapter;
  createCapture?: () => BrowserAudioCaptureAdapter;
  request?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  endpoint?: string;
}>;

function controlledFailure(
  sessionId: string,
  errorCode: SpeechPortFailure["errorCode"],
  failureReason?: SpeechFailureReason,
): SpeechPortFailure {
  return speechPortFailureSchema.parse({
    ok: false,
    sessionId,
    provider: LOCAL_WHISPER_PROVIDER,
    errorCode,
    durationMs: 0,
    ...(failureReason === undefined ? {} : { failureReason }),
  });
}

function asRequestError(sessionId: string, failureReason?: SpeechFailureReason): SpeechPortFailure {
  return controlledFailure(sessionId, "SPEECH_PROVIDER_FAILED", failureReason);
}

function responseFailure(sessionId: string, status: number): SpeechPortFailure {
  if (status === 499) return controlledFailure(sessionId, "SPEECH_CANCELLED");
  if (status === 400 || status === 413 || status === 415) {
    return asRequestError(sessionId, "SPEECH_BROWSER_AUDIO_FAILED");
  }
  if (status === 503) return asRequestError(sessionId, "SPEECH_LOCAL_SERVICE_UNAVAILABLE");
  return asRequestError(sessionId, "SPEECH_LOCAL_TRANSCRIPTION_FAILED");
}

/**
 * Browser-facing local provider. The server endpoint is the only component
 * allowed to construct LocalWhisperCliAdapter; this client port only owns the
 * in-memory WAV and sends a strict DTO to the same-origin route.
 */
export class LocalSpeechRecognitionProvider implements SpeechRecognitionPort {
  readonly capability: SpeechCapability;
  readonly provider = LOCAL_WHISPER_PROVIDER;

  private readonly capture: BrowserAudioCaptureAdapter;
  private readonly request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly endpoint: string;
  private activeSessionId?: string;
  private startingSessionId?: string;
  private readonly cancelledSessionIds = new Set<string>();
  private requestController?: AbortController;

  constructor(capability: SpeechCapability, dependencies: LocalSpeechProviderDependencies = {}) {
    this.capability = capability;
    this.capture = dependencies.capture ?? dependencies.createCapture?.() ?? createBrowserAudioCaptureAdapter();
    this.request = dependencies.request ?? fetch;
    this.endpoint = dependencies.endpoint ?? "/api/speech/transcriptions";
  }

  get hasTemporaryAudio(): boolean {
    return this.capture.status === "RECORDING";
  }

  async startRecording(sessionId: string): Promise<SpeechPortStartResult> {
    if (this.capability.status !== "READY") {
      return { status: "FAILED", errorCode: "SPEECH_PROVIDER_FAILED" };
    }
    if (this.activeSessionId !== undefined) {
      return { status: "FAILED", errorCode: "SPEECH_PROVIDER_FAILED" };
    }
    this.startingSessionId = sessionId;
    try {
      const result = await this.capture.start();
      if (this.cancelledSessionIds.delete(sessionId)) {
        return { status: "FAILED", errorCode: "SPEECH_PROVIDER_FAILED" };
      }
      if (result === "RECORDING") {
        this.activeSessionId = sessionId;
        return { status: "RECORDING" };
      }
      if (result === "PERMISSION_REQUIRED") return { status: "PERMISSION_REQUIRED" };
      if (result === "PERMISSION_DENIED") return { status: "PERMISSION_DENIED" };
      return { status: "FAILED", errorCode: result === "UNSUPPORTED" ? "SPEECH_UNSUPPORTED" : "SPEECH_PROVIDER_FAILED" };
    } finally {
      if (this.startingSessionId === sessionId) this.startingSessionId = undefined;
    }
  }

  async stopAndTranscribe(sessionId: string): Promise<SpeechPortSuccess | SpeechPortFailure> {
    if (this.activeSessionId !== sessionId) return asRequestError(sessionId);
    let captureResult;
    try {
      captureResult = await this.capture.stop();
    } catch (error) {
      this.activeSessionId = undefined;
      return asRequestError(
        sessionId,
        error instanceof BrowserAudioCaptureError
          ? error.failureReason
          : "SPEECH_BROWSER_AUDIO_FAILED",
      );
    }

    const controller = new AbortController();
    this.requestController = controller;
    try {
      const form = new FormData();
      form.set("sessionId", sessionId);
      const audioCopy = new Uint8Array(captureResult.audioBytes.byteLength);
      audioCopy.set(captureResult.audioBytes);
      form.set(
        "audio",
        new Blob([audioCopy.buffer], { type: captureResult.mimeType }),
        "recording.wav",
      );
      const response = await this.request(this.endpoint, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) return responseFailure(sessionId, response.status);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return asRequestError(sessionId, "SPEECH_LOCAL_TRANSCRIPTION_FAILED");
      }
      const parsed = speechPortSuccessSchema.safeParse(payload);
      if (!parsed.success || parsed.data.ok !== responseShape.ok) {
        return asRequestError(sessionId, "SPEECH_LOCAL_TRANSCRIPTION_FAILED");
      }
      return parsed.data;
    } catch {
      return controller.signal.aborted
        ? controlledFailure(sessionId, "SPEECH_CANCELLED")
        : asRequestError(sessionId, "SPEECH_LOCAL_SERVICE_UNAVAILABLE");
    } finally {
      if (this.requestController === controller) this.requestController = undefined;
      this.activeSessionId = undefined;
    }
  }

  async cancel(sessionId: string): Promise<SpeechPortFailure> {
    if (this.activeSessionId !== sessionId && this.startingSessionId !== sessionId) {
      return controlledFailure(sessionId, "SPEECH_CANCELLED");
    }
    this.cancelledSessionIds.add(sessionId);
    this.capture.cancel();
    this.requestController?.abort();
    this.activeSessionId = undefined;
    try {
      const response = await this.request(`${this.endpoint}/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        const parsed = speechPortFailureSchema.safeParse(payload);
        if (parsed.success) return parsed.data;
      }
    } catch {
      // Local cancellation remains controlled even when the request was
      // already aborted or the route has already released its file.
    }
    return controlledFailure(sessionId, "SPEECH_CANCELLED");
  }
}

export function createLocalSpeechRecognitionProvider(
  capability: SpeechCapability,
  dependencies: LocalSpeechProviderDependencies = {},
): LocalSpeechRecognitionProvider {
  return new LocalSpeechRecognitionProvider(capability, dependencies);
}
