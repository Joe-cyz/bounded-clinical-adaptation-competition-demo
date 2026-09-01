import {
  speechPortFailureSchema,
  speechPortSuccessSchema,
  type SpeechPortFailure,
  type SpeechPortStartResult,
  type SpeechPortSuccess,
  type SpeechRecognitionPort,
} from "@/domain/speech";

export type FakeSpeechScenario = "SUCCESS" | "LOW_CONFIDENCE" | "NO_CONFIDENCE" | "FAILURE" | "CANCELLED";
export type FakePermissionScenario = "GRANTED" | "REQUIRED" | "DENIED" | "DENIED_ONCE";

export type FakeSpeechProviderOptions = {
  scenario?: FakeSpeechScenario;
  permission?: FakePermissionScenario;
  delayMs?: number;
  durationMs?: number;
  segmentCount?: number;
  lateResultAfterCancel?: "NONE" | "SUCCESS" | "FAILURE";
};

const descriptor = {
  providerType: "FAKE_TEST" as const,
  providerVersion: "fake-speech-1.0.0",
  networkUsed: false,
  retainedAudio: false as const,
};

const syntheticSpeechSegments = [
  "合成口述：晨起乏力，持续两周，待医生结合完整病历复核。",
  "合成口述：近期睡眠变化，需结合病史判断。",
] as const;

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Test-only provider. It uses a tiny in-memory synthetic byte buffer and
 * releases it on every terminal path. It is never selected by runtime config.
 */
export class FakeSpeechRecognitionProvider implements SpeechRecognitionPort {
  readonly capability = { status: "READY" as const };
  readonly provider = descriptor;

  private readonly options: Required<FakeSpeechProviderOptions>;
  private activeSessionId?: string;
  private temporaryAudio?: Uint8Array;
  private permissionRequests = 0;

  constructor(options: FakeSpeechProviderOptions = {}) {
    this.options = {
      scenario: options.scenario ?? "SUCCESS",
      permission: options.permission ?? "GRANTED",
      delayMs: options.delayMs ?? 0,
      durationMs: options.durationMs ?? 1_200,
      segmentCount: options.segmentCount ?? 1,
      lateResultAfterCancel: options.lateResultAfterCancel ?? "NONE",
    };
  }

  get hasTemporaryAudio(): boolean {
    return this.temporaryAudio !== undefined;
  }

  async startRecording(sessionId: string): Promise<SpeechPortStartResult> {
    await wait(this.options.delayMs);
    if (this.options.permission === "REQUIRED") return { status: "PERMISSION_REQUIRED" };
    if (this.options.permission === "DENIED") return { status: "PERMISSION_DENIED" };
    if (this.options.permission === "DENIED_ONCE" && this.permissionRequests++ === 0) {
      return { status: "PERMISSION_DENIED" };
    }
    if (this.activeSessionId !== undefined) {
      return { status: "FAILED", errorCode: "SPEECH_PROVIDER_FAILED" };
    }

    this.activeSessionId = sessionId;
    this.temporaryAudio = new Uint8Array([0x53, 0x59, 0x4e, 0x54, 0x48]);
    return { status: "RECORDING" };
  }

  async stopAndTranscribe(sessionId: string): Promise<SpeechPortSuccess | SpeechPortFailure> {
    const wasActiveAtStart = this.activeSessionId === sessionId;
    await wait(this.options.delayMs);
    const cancelledDuringTranscription = wasActiveAtStart && this.activeSessionId !== sessionId;
    if (!wasActiveAtStart || (cancelledDuringTranscription && this.options.lateResultAfterCancel !== "SUCCESS")) {
      return this.failure(sessionId, "SPEECH_PROVIDER_FAILED");
    }

    try {
      if (cancelledDuringTranscription && this.options.lateResultAfterCancel === "FAILURE") {
        return this.failure(sessionId, "SPEECH_PROVIDER_FAILED");
      }
      if (this.options.scenario === "CANCELLED") return this.failure(sessionId, "SPEECH_CANCELLED");
      if (this.options.scenario === "FAILURE") return this.failure(sessionId, "SPEECH_PROVIDER_FAILED");

      const lowConfidence = this.options.scenario === "LOW_CONFIDENCE";
      const noConfidence = this.options.scenario === "NO_CONFIDENCE";
      const segments = syntheticSpeechSegments.slice(0, this.options.segmentCount);
      const segmentDuration = Math.floor(this.options.durationMs / segments.length);
      const result = speechPortSuccessSchema.parse({
        ok: true,
        sessionId,
        provider: this.provider,
        durationMs: this.options.durationMs,
        transcript: {
          text: segments.join("\n"),
          durationMs: this.options.durationMs,
          segments: segments.map((text, index) => ({
            id: `fake-segment-${sessionId.slice(0, 12)}-${index + 1}`,
            text,
            startMs: index * segmentDuration,
            endMs: index === segments.length - 1 ? this.options.durationMs : (index + 1) * segmentDuration,
            confidenceStatus: noConfidence ? "NOT_PROVIDED" as const : "PROVIDED" as const,
            ...(noConfidence ? {} : { confidence: lowConfidence && index === 0 ? 0.42 : 0.96 }),
          })),
        },
      });
      return result;
    } finally {
      this.releaseTemporaryAudio();
    }
  }

  async cancel(sessionId: string): Promise<SpeechPortFailure> {
    // Release the in-memory capture immediately. The provider may still take
    // time to acknowledge cancellation, but an in-flight transcription must
    // observe that this session is no longer active.
    if (this.activeSessionId === sessionId) this.releaseTemporaryAudio();
    await wait(this.options.delayMs);
    this.releaseTemporaryAudio();
    return this.failure(sessionId, "SPEECH_CANCELLED");
  }

  private failure(sessionId: string, errorCode: "SPEECH_PROVIDER_FAILED" | "SPEECH_CANCELLED"): SpeechPortFailure {
    const result = speechPortFailureSchema.parse({
      ok: false,
      sessionId,
      provider: this.provider,
      errorCode,
      durationMs: this.options.durationMs,
    });
    this.activeSessionId = undefined;
    return result;
  }

  private releaseTemporaryAudio(): void {
    this.temporaryAudio = undefined;
    this.activeSessionId = undefined;
  }
}

export function createFakeSpeechRecognitionProvider(
  options: FakeSpeechProviderOptions = {},
): FakeSpeechRecognitionProvider {
  return new FakeSpeechRecognitionProvider(options);
}
