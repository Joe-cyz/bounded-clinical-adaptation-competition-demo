import { describe, expect, it } from "vitest";

import { createFakeSpeechRecognitionProvider } from "./fake-speech-provider";

describe("FakeSpeechRecognitionProvider", () => {
  it("keeps synthetic audio in memory and releases it after success", async () => {
    const provider = createFakeSpeechRecognitionProvider();

    expect((await provider.startRecording("speech-session-success")).status).toBe("RECORDING");
    expect(provider.hasTemporaryAudio).toBe(true);

    const result = await provider.stopAndTranscribe("speech-session-success");

    expect(result.ok).toBe(true);
    expect(result.provider.retainedAudio).toBe(false);
    expect(provider.hasTemporaryAudio).toBe(false);
  });

  it("releases temporary audio on provider failure and cancellation", async () => {
    const failed = createFakeSpeechRecognitionProvider({ scenario: "FAILURE" });
    await failed.startRecording("speech-session-failure");
    expect(failed.hasTemporaryAudio).toBe(true);
    expect((await failed.stopAndTranscribe("speech-session-failure")).ok).toBe(false);
    expect(failed.hasTemporaryAudio).toBe(false);

    const cancelled = createFakeSpeechRecognitionProvider();
    await cancelled.startRecording("speech-session-cancel");
    expect(cancelled.hasTemporaryAudio).toBe(true);
    expect((await cancelled.cancel("speech-session-cancel")).errorCode).toBe("SPEECH_CANCELLED");
    expect(cancelled.hasTemporaryAudio).toBe(false);
  });

  it.each(["SUCCESS", "FAILURE"] as const)("releases audio when a %s result arrives after cancellation", async (lateResult) => {
    const provider = createFakeSpeechRecognitionProvider({
      delayMs: 20,
      lateResultAfterCancel: lateResult,
    });
    await provider.startRecording(`speech-session-late-${lateResult.toLowerCase()}`);
    const stopPromise = provider.stopAndTranscribe(`speech-session-late-${lateResult.toLowerCase()}`);
    const cancelResult = await provider.cancel(`speech-session-late-${lateResult.toLowerCase()}`);
    const late = await stopPromise;

    expect(cancelResult.errorCode).toBe("SPEECH_CANCELLED");
    expect(lateResult === "SUCCESS" ? late.ok : !late.ok).toBe(true);
    expect(provider.hasTemporaryAudio).toBe(false);
  });

  it("supports no-confidence output without inventing a confidence value", async () => {
    const provider = createFakeSpeechRecognitionProvider({ scenario: "NO_CONFIDENCE" });
    await provider.startRecording("speech-session-confidence");

    const result = await provider.stopAndTranscribe("speech-session-confidence");

    if (!result.ok) throw new Error("Expected deterministic fake success.");
    expect(result.transcript.segments[0].confidenceStatus).toBe("NOT_PROVIDED");
    expect(result.transcript.segments[0].confidence).toBeUndefined();
    expect(provider.hasTemporaryAudio).toBe(false);
  });

  it("does not allocate audio when permission is required or denied", async () => {
    const required = createFakeSpeechRecognitionProvider({ permission: "REQUIRED" });
    expect((await required.startRecording("speech-session-required")).status).toBe("PERMISSION_REQUIRED");
    expect(required.hasTemporaryAudio).toBe(false);

    const denied = createFakeSpeechRecognitionProvider({ permission: "DENIED" });
    expect((await denied.startRecording("speech-session-denied")).status).toBe("PERMISSION_DENIED");
    expect(denied.hasTemporaryAudio).toBe(false);
  });
});
