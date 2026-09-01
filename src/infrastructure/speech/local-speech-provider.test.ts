import { describe, expect, it, vi } from "vitest";

import {
  BrowserAudioCaptureError,
  type BrowserAudioCaptureAdapter,
} from "./browser-audio-capture";
import { createLocalSpeechRecognitionProvider } from "./local-speech-provider";

function fakeCapture(overrides: Partial<{
  status: "READY" | "UNSUPPORTED" | "PERMISSION_DENIED" | "RECORDING";
  start: () => Promise<"RECORDING" | "UNSUPPORTED" | "PERMISSION_DENIED">;
  stop: () => Promise<{
    audioBytes: Uint8Array;
    durationMs: number;
    mimeType: "audio/wav";
    sourceMimeType: string;
    retainedAudio: false;
  }>;
  cancel: () => void;
}> = {}) {
  return {
    status: overrides.status ?? "READY",
    start: overrides.start ?? vi.fn(async () => "RECORDING" as const),
    stop: overrides.stop ?? vi.fn(async () => ({
      audioBytes: new Uint8Array([82, 73, 70, 70]),
      durationMs: 1_000,
      mimeType: "audio/wav" as const,
      sourceMimeType: "audio/webm",
      retainedAudio: false as const,
    })),
    cancel: overrides.cancel ?? vi.fn(),
  } as unknown as BrowserAudioCaptureAdapter;
}

function successResponse(sessionId: string) {
  return new Response(JSON.stringify({
    ok: true,
    sessionId,
    provider: {
      providerType: "LOCAL_WHISPER",
      providerVersion: "whisper.cpp@v1.9.2",
      networkUsed: false,
      retainedAudio: false,
    },
    durationMs: 1_000,
    transcript: {
      text: "合成口述：晨起乏力，持续两周。",
      durationMs: 1_000,
      segments: [{
        id: "segment-001",
        text: "合成口述：晨起乏力，持续两周。",
        startMs: 0,
        endMs: 1_000,
        confidenceStatus: "NOT_PROVIDED",
      }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("LocalSpeechRecognitionProvider", () => {
  it("does not request capture until startRecording and posts a strict WAV DTO", async () => {
    const capture = fakeCapture();
    let postedForm: FormData | undefined;
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      postedForm = init?.body as FormData;
      return successResponse("speech-local-001");
    });
    const provider = createLocalSpeechRecognitionProvider(
      { status: "READY" },
      { capture, request },
    );

    expect(capture.start).not.toHaveBeenCalled();
    expect(await provider.startRecording("speech-local-001")).toEqual({ status: "RECORDING" });
    const result = await provider.stopAndTranscribe("speech-local-001");

    expect(capture.start).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(postedForm?.get("sessionId")).toBe("speech-local-001");
    expect((postedForm?.get("audio") as File).type).toBe("audio/wav");
    expect(result.ok).toBe(true);
    expect(result.provider.providerType).toBe("LOCAL_WHISPER");
    expect(result.provider.providerVersion).toBe("whisper.cpp@v1.9.2");
    expect(result.provider.networkUsed).toBe(false);
    expect(result.provider.retainedAudio).toBe(false);
  });

  it.each([
    "SPEECH_RECORDING_TOO_SHORT",
    "SPEECH_NO_AUDIO_DETECTED",
    "SPEECH_BROWSER_AUDIO_FAILED",
  ] as const)("maps controlled capture failure %s without a request", async (failureReason) => {
    const capture = fakeCapture({
      stop: vi.fn(async () => { throw new BrowserAudioCaptureError(failureReason); }),
    });
    const request = vi.fn();
    const provider = createLocalSpeechRecognitionProvider(
      { status: "READY" },
      { capture, request },
    );

    await provider.startRecording(`speech-capture-failure-${failureReason}`);
    const result = await provider.stopAndTranscribe(`speech-capture-failure-${failureReason}`);

    expect(result).toMatchObject({
      ok: false,
      errorCode: "SPEECH_PROVIDER_FAILED",
      failureReason,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [400, "SPEECH_PROVIDER_FAILED", "SPEECH_BROWSER_AUDIO_FAILED"],
    [413, "SPEECH_PROVIDER_FAILED", "SPEECH_BROWSER_AUDIO_FAILED"],
    [415, "SPEECH_PROVIDER_FAILED", "SPEECH_BROWSER_AUDIO_FAILED"],
    [503, "SPEECH_PROVIDER_FAILED", "SPEECH_LOCAL_SERVICE_UNAVAILABLE"],
    [500, "SPEECH_PROVIDER_FAILED", "SPEECH_LOCAL_TRANSCRIPTION_FAILED"],
    [499, "SPEECH_CANCELLED", undefined],
  ] as const)("maps HTTP %s without reading the response body", async (status, errorCode, failureReason) => {
    const capture = fakeCapture();
    const response = new Response("server-only response", { status });
    const responseJson = vi.spyOn(response, "json");
    const request = vi.fn(async () => response);
    const provider = createLocalSpeechRecognitionProvider(
      { status: "READY" },
      { capture, request },
    );
    await provider.startRecording(`speech-http-${status}`);
    const result = await provider.stopAndTranscribe(`speech-http-${status}`);

    expect(result).toMatchObject({ ok: false, errorCode });
    if (failureReason === undefined) expect(result).not.toHaveProperty("failureReason");
    else expect(result).toHaveProperty("failureReason", failureReason);
    expect(responseJson).not.toHaveBeenCalled();
  });

  it("maps fetch errors to local service unavailability without exposing the error", async () => {
    const capture = fakeCapture();
    const request = vi.fn(async () => { throw new Error("secret transport details"); });
    const provider = createLocalSpeechRecognitionProvider(
      { status: "READY" },
      { capture, request },
    );
    await provider.startRecording("speech-fetch-failure-001");
    const result = await provider.stopAndTranscribe("speech-fetch-failure-001");

    expect(result).toMatchObject({
      ok: false,
      errorCode: "SPEECH_PROVIDER_FAILED",
      failureReason: "SPEECH_LOCAL_SERVICE_UNAVAILABLE",
    });
    expect(JSON.stringify(result)).not.toContain("secret transport details");
  });

  it.each([
    ["invalid JSON", "{invalid-json"],
    ["invalid success shape", JSON.stringify({ ok: true })],
  ] as const)("maps %s to local transcription failure", async (_label, body) => {
    const capture = fakeCapture();
    const request = vi.fn(async () => new Response(body, { status: 200 }));
    const provider = createLocalSpeechRecognitionProvider(
      { status: "READY" },
      { capture, request },
    );
    await provider.startRecording("speech-response-failure-001");
    const result = await provider.stopAndTranscribe("speech-response-failure-001");

    expect(result).toMatchObject({
      ok: false,
      errorCode: "SPEECH_PROVIDER_FAILED",
      failureReason: "SPEECH_LOCAL_TRANSCRIPTION_FAILED",
    });
  });

  it("keeps permission, unsupported and failed capture paths controlled", async () => {
    const denied = createLocalSpeechRecognitionProvider(
      { status: "READY" },
      { capture: fakeCapture({ start: vi.fn(async () => "PERMISSION_DENIED" as const) }) },
    );
    const unsupported = createLocalSpeechRecognitionProvider(
      { status: "READY" },
      { capture: fakeCapture({ start: vi.fn(async () => "UNSUPPORTED" as const) }) },
    );
    expect(await denied.startRecording("speech-denied-001")).toEqual({ status: "PERMISSION_DENIED" });
    expect((await unsupported.startRecording("speech-unsupported-001")).status).toBe("FAILED");
  });

  it("aborts the request, releases capture and sends idempotent DELETE on cancel", async () => {
    const capture = fakeCapture();
    let transcribeSignal: AbortSignal | undefined;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") transcribeSignal = init?.signal as AbortSignal | undefined;
      if (init?.method === "DELETE") return new Response(JSON.stringify({
        ok: false,
        sessionId: "speech-cancel-001",
        provider: {
          providerType: "LOCAL_WHISPER",
          providerVersion: "whisper.cpp@v1.9.2",
          networkUsed: false,
          retainedAudio: false,
        },
        errorCode: "SPEECH_CANCELLED",
        durationMs: 0,
      }), { status: 200 });
      void input;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const provider = createLocalSpeechRecognitionProvider({ status: "READY" }, { capture, request });
    await provider.startRecording("speech-cancel-001");
    const transcribe = provider.stopAndTranscribe("speech-cancel-001");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = await provider.cancel("speech-cancel-001");

    expect(capture.cancel).toHaveBeenCalledOnce();
    expect(transcribeSignal?.aborted).toBe(true);
    expect(cancelled.errorCode).toBe("SPEECH_CANCELLED");
    await expect(transcribe).resolves.toMatchObject({ ok: false, errorCode: "SPEECH_CANCELLED" });
  });

  it("does not silently downgrade when capability is not ready", async () => {
    const capture = fakeCapture();
    const request = vi.fn();
    const provider = createLocalSpeechRecognitionProvider(
      { status: "UNCONFIGURED", reason: "PROVIDER_NOT_CONFIGURED" },
      { capture, request },
    );

    expect(await provider.startRecording("speech-unconfigured-001")).toMatchObject({ status: "FAILED" });
    expect(capture.start).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("releases a capture that resolves after unmount cancellation", async () => {
    let resolveStart!: (value: "RECORDING") => void;
    const capture = fakeCapture({
      start: () => new Promise((resolve) => { resolveStart = resolve; }),
    });
    const provider = createLocalSpeechRecognitionProvider({ status: "READY" }, { capture });
    const starting = provider.startRecording("speech-unmount-001");
    const cancelled = provider.cancel("speech-unmount-001");
    resolveStart("RECORDING");

    expect((await cancelled).errorCode).toBe("SPEECH_CANCELLED");
    expect((await starting).status).toBe("FAILED");
    expect(capture.cancel).toHaveBeenCalledOnce();
  });
});
