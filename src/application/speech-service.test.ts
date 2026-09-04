import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { syntheticMedicalRecords } from "@/data/seed-loader";
import {
  speechErrorCodes,
  speechSessionSchema,
  type SpeechSession,
  type SpeechRecognitionPort,
} from "@/domain/speech";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { readSpeechRuntimeConfig } from "@/server/speech-runtime-config";
import { createSqliteSpeechAuditSink } from "./speech-audit-service";
import {
  createInMemorySpeechAuditSink,
  SpeechApplicationService,
  speechAuditMetadataSchema,
} from "./speech-service";
import { createFakeSpeechRecognitionProvider } from "@/infrastructure/speech/fake-speech-provider";

const times = [
  "2026-08-22T00:00:00.000Z",
  "2026-08-22T00:00:01.000Z",
  "2026-08-22T00:00:02.000Z",
  "2026-08-22T00:00:03.000Z",
  "2026-08-22T00:00:04.000Z",
  "2026-08-22T00:00:05.000Z",
];

function clock() {
  let index = 0;
  return () => times[index++] ?? times[times.length - 1];
}

function idFactory(prefix: string) {
  let counter = 0;
  return (kind: "SESSION" | "SUGGESTION" | "AUDIT") => `${kind.toLowerCase()}-${prefix}-${String(++counter).padStart(3, "0")}`;
}

function withCapability(base: SpeechRecognitionPort, capability: SpeechRecognitionPort["capability"]): SpeechRecognitionPort {
  return {
    capability,
    provider: base.provider,
    startRecording: base.startRecording.bind(base),
    stopAndTranscribe: base.stopAndTranscribe.bind(base),
    cancel: base.cancel.bind(base),
  };
}

function service(port: SpeechRecognitionPort, prefix = "test", auditSink = createInMemorySpeechAuditSink().sink) {
  return new SpeechApplicationService({
    port,
    runtimeMode: "local-research",
    clock: clock(),
    idFactory: idFactory(prefix),
    auditSink,
  });
}

describe("PWR-05 SpeechApplicationService", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => times[0] });
  });

  afterEach(() => {
    database.close();
  });

  it("fails closed when the provider is unconfigured or unsupported", () => {
    const base = createFakeSpeechRecognitionProvider();
    const unconfigured = withCapability(base, { status: "UNCONFIGURED", reason: "PROVIDER_NOT_CONFIGURED" });
    const unsupported = withCapability(base, { status: "UNSUPPORTED", reason: "BROWSER_AUDIO_UNSUPPORTED" });
    expect(() => service(unconfigured).createSession({ encounterId: "encounter-speech-001" })).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.UNCONFIGURED }),
    );
    expect(() => service(unsupported).createSession({ encounterId: "encounter-speech-001" })).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.UNSUPPORTED }),
    );
  });

  it("keeps permission required and denied as visible controlled states", async () => {
    const required = service(createFakeSpeechRecognitionProvider({ permission: "REQUIRED" }), "required");
    const requiredSession = required.createSession({ encounterId: "encounter-speech-001" });
    expect((await required.startRecording(requiredSession)).status).toBe("PERMISSION_REQUIRED");

    const denied = service(createFakeSpeechRecognitionProvider({ permission: "DENIED" }), "denied");
    const deniedSession = denied.createSession({ encounterId: "encounter-speech-001" });
    expect((await denied.startRecording(deniedSession)).status).toBe("PERMISSION_DENIED");
  });

  it("preserves a controlled microphone start failure for the interface", async () => {
    const base = createFakeSpeechRecognitionProvider();
    const port: SpeechRecognitionPort = {
      capability: base.capability,
      provider: base.provider,
      startRecording: async () => ({
        status: "FAILED",
        errorCode: speechErrorCodes.PROVIDER_FAILED,
        failureReason: "SPEECH_MICROPHONE_NOT_FOUND",
      }),
      stopAndTranscribe: base.stopAndTranscribe.bind(base),
      cancel: base.cancel.bind(base),
    };
    const speech = service(port, "missing-microphone");
    const created = speech.createSession({ encounterId: "encounter-speech-001" });
    const failed = await speech.startRecording(created);

    expect(failed).toMatchObject({
      status: "FAILED",
      errorCode: speechErrorCodes.PROVIDER_FAILED,
      failureReason: "SPEECH_MICROPHONE_NOT_FOUND",
    });
  });

  it("runs recording, transcription and review with auto history assignment", async () => {
    const audit = createInMemorySpeechAuditSink();
    const speech = service(createFakeSpeechRecognitionProvider(), "success", audit.sink);
    const created = speech.createSession({ encounterId: "encounter-speech-001" });
    const recording = await speech.startRecording(created);
    expect(recording.status).toBe("RECORDING");
    const reviewed = await speech.stopAndTranscribe(recording);
    expect(reviewed.status).toBe("NEEDS_REVIEW");
    expect(reviewed.suggestions[0].target).toBe("presentIllness");
    expect(reviewed.suggestions[0].decision).toBe("PENDING");
    expect(audit.events.map((event) => event.afterStatus)).toEqual([
      "PERMISSION_REQUIRED",
      "RECORDING",
      "TRANSCRIBING",
      "NEEDS_REVIEW",
    ]);
  });

  it("keeps the target genuinely undefined when automatic history assignment is disabled", () => {
    const speech = service(createFakeSpeechRecognitionProvider());
    const created = speech.createSession({
      encounterId: "encounter-speech-001",
      autoAssignHistory: false,
    });
    expect(created.selectedTarget).toBeUndefined();
    expect(speech.updateAssignment(created, false).selectedTarget).toBeUndefined();
  });

  it.each(["SUCCESS", "FAILURE"] as const)("ignores a late %s result after transcription cancellation", async (lateResult) => {
    const audit = createInMemorySpeechAuditSink();
    const provider = createFakeSpeechRecognitionProvider({
      delayMs: 20,
      lateResultAfterCancel: lateResult,
    });
    const speech = service(provider, `late-${lateResult.toLowerCase()}`, audit.sink);
    const created = speech.createSession({ encounterId: "encounter-speech-001" });
    const recording = await speech.startRecording(created);
    let transcribing: SpeechSession | undefined;
    const stopPromise = speech.stopAndTranscribe(recording, (value) => {
      transcribing = value;
    });

    expect(transcribing?.status).toBe("TRANSCRIBING");
    const cancelled = await speech.cancel(transcribing!);
    const late = await stopPromise;

    expect(cancelled.status).toBe("CANCELLED");
    expect(late.status).toBe("TRANSCRIBING");
    expect(late.suggestions).toHaveLength(0);
    expect(provider.hasTemporaryAudio).toBe(false);
    expect(audit.events.map((event) => event.afterStatus)).toEqual([
      "PERMISSION_REQUIRED",
      "RECORDING",
      "TRANSCRIBING",
      "CANCELLED",
    ]);
  });

  it("supports low-confidence and not-provided confidence without inventing a value", async () => {
    const low = service(createFakeSpeechRecognitionProvider({ scenario: "LOW_CONFIDENCE" }), "low");
    const lowReview = await low.stopAndTranscribe(await low.startRecording(low.createSession({ encounterId: "encounter-speech-001" })));
    expect(lowReview.suggestions[0].confidence).toBe(0.42);

    const none = service(createFakeSpeechRecognitionProvider({ scenario: "NO_CONFIDENCE" }), "none");
    const noneReview = await none.stopAndTranscribe(await none.startRecording(none.createSession({ encounterId: "encounter-speech-001" })));
    expect(noneReview.suggestions[0].confidenceStatus).toBe("NOT_PROVIDED");
    expect(noneReview.suggestions[0].confidence).toBeUndefined();
  });

  it("maps provider failure and cancellation without changing a record", async () => {
    const record = syntheticMedicalRecords[0];
    const failed = service(createFakeSpeechRecognitionProvider({ scenario: "FAILURE" }), "failure");
    const failedSession = await failed.stopAndTranscribe(await failed.startRecording(failed.createSession({ encounterId: "encounter-speech-001" })));
    expect(failedSession.status).toBe("FAILED");
    expect(failedSession.errorCode).toBe(speechErrorCodes.PROVIDER_FAILED);

    const cancelledProvider = createFakeSpeechRecognitionProvider();
    const cancelled = service(cancelledProvider, "cancel");
    const cancelledSession = await cancelled.cancel(await cancelled.startRecording(cancelled.createSession({ encounterId: "encounter-speech-001" })));
    expect(cancelledSession.status).toBe("CANCELLED");
    expect(record.history.presentIllness.value).toBe(syntheticMedicalRecords[0].history.presentIllness.value);
    expect(cancelledProvider.hasTemporaryAudio).toBe(false);
  });

  it("propagates a controlled port failure reason into the failed session", async () => {
    const base = createFakeSpeechRecognitionProvider();
    const port: SpeechRecognitionPort = {
      capability: base.capability,
      provider: base.provider,
      startRecording: base.startRecording.bind(base),
      stopAndTranscribe: async (sessionId) => ({
        ok: false as const,
        sessionId,
        provider: base.provider,
        errorCode: speechErrorCodes.PROVIDER_FAILED,
        failureReason: "SPEECH_RECORDING_TOO_SHORT" as const,
        durationMs: 0,
      }),
      cancel: base.cancel.bind(base),
    };
    const speech = service(port, "failure-reason");
    const created = speech.createSession({ encounterId: "encounter-speech-001" });
    const recording = await speech.startRecording(created);
    const failed = await speech.stopAndTranscribe(recording);

    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe(speechErrorCodes.PROVIDER_FAILED);
    expect(failed.failureReason).toBe("SPEECH_RECORDING_TOO_SHORT");
  });

  it("allows one edited write, one ignore, and prevents repeat processing", async () => {
    const audit = createInMemorySpeechAuditSink();
    const speech = service(createFakeSpeechRecognitionProvider(), "decisions", audit.sink);
    const created = speech.createSession({ encounterId: "encounter-speech-001" });
    const recording = await speech.startRecording(created);
    const reviewed = await speech.stopAndTranscribe(recording);
    const edited = speech.editSuggestion(reviewed, reviewed.suggestions[0].id, "医生编辑后的合成口述", "presentIllness");
    const written = speech.decideSuggestion(edited, edited.suggestions[0].id, "ACCEPTED", syntheticMedicalRecords[0]);
    expect(written.session.status).toBe("ACCEPTED");
    expect(written.record.history.presentIllness.value).toContain("医生编辑后的合成口述");
    expect(() => speech.decideSuggestion(written.session, written.session.suggestions[0].id, "IGNORED", written.record)).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.SUGGESTION_ALREADY_PROCESSED }),
    );
    expect(audit.events.at(-1)?.metadata).not.toHaveProperty("transcript");
  });

  it("keeps partial suggestions pending until every suggestion is processed", async () => {
    const provider = createFakeSpeechRecognitionProvider();
    const speech = service(provider, "partial");
    const created = speech.createSession({ encounterId: "encounter-speech-001" });
    const recording = await speech.startRecording(created);
    const reviewed = await speech.stopAndTranscribe(recording);
    const second = {
      ...reviewed.suggestions[0],
      id: "suggestion-second",
      sourceSegmentId: "segment-second",
    };
    const withTwo = speechSessionSchema.parse({ ...reviewed, suggestions: [reviewed.suggestions[0], second] });
    const partial = speech.decideSuggestion(withTwo, reviewed.suggestions[0].id, "ACCEPTED", syntheticMedicalRecords[0]);
    expect(partial.session.status).toBe("PARTIALLY_ACCEPTED");
    const complete = speech.decideSuggestion(partial.session, second.id, "IGNORED", partial.record);
    expect(complete.session.status).toBe("ACCEPTED");
  });

  it("uses a strict audit metadata shape without record or transcript content", () => {
    const safe = speechAuditMetadataSchema.parse({
      encounterId: "encounter-speech-001",
      sessionId: "speech-session-001",
      synthetic: true,
      runtimeMode: "local-research",
      status: "NEEDS_REVIEW",
      durationMs: 1200,
      providerType: "FAKE_TEST",
      providerVersion: "fake-speech-1.0.0",
      networkUsed: false,
      retainedAudio: false,
      suggestionCount: 1,
      processedSuggestionCount: 0,
      acceptedSuggestionCount: 0,
    });
    expect(safe).not.toHaveProperty("transcript");
    expect(speechAuditMetadataSchema.safeParse({ ...safe, demographicSnapshot: { displayLabel: "合成患者-01" } }).success).toBe(false);
    expect(speechAuditMetadataSchema.safeParse({ ...safe, recordPayload: { value: "正文" } }).success).toBe(false);
  });

  it("writes only safe audit metadata to the existing append-only table", async () => {
    const sink = createSqliteSpeechAuditSink(database, idFactory("sqlite-audit"));
    const speech = service(createFakeSpeechRecognitionProvider(), "sqlite", sink);
    const created = speech.createSession({ encounterId: "encounter-speech-001" });
    const reviewed = await speech.stopAndTranscribe(await speech.startRecording(created));
    const events = createAuditEventRepository(database).listByEntity("SPEECH_SESSION", reviewed.id);
    expect(events.length).toBeGreaterThan(0);
    const json = JSON.stringify(events);
    expect(json).not.toContain("合成口述");
    expect(json).not.toContain("recordPayload");
    expect(json).toContain("retainedAudio");
  });

  it("rejects public-demo before port, transaction, or audit work", () => {
    let startCalls = 0;
    const provider = createFakeSpeechRecognitionProvider();
    const guarded: SpeechRecognitionPort = {
      capability: provider.capability,
      provider: provider.provider,
      startRecording: async (id) => {
        startCalls += 1;
        return provider.startRecording(id);
      },
      stopAndTranscribe: provider.stopAndTranscribe.bind(provider),
      cancel: provider.cancel.bind(provider),
    };
    const sink = createSqliteSpeechAuditSink(database, idFactory("public"));
    const speech = new SpeechApplicationService({ port: guarded, runtimeMode: "public-demo", auditSink: sink });
    expect(() => speech.createSession({ encounterId: "encounter-speech-001" })).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.PUBLIC_DEMO_READ_ONLY }),
    );
    expect(startCalls).toBe(0);
    expect(database.isTransaction).toBe(false);
    expect(createAuditEventRepository(database).listByEntity("SPEECH_SESSION", "speech-session-public-001")).toEqual([]);
  });

  it("does not enable the test provider through normal runtime configuration", () => {
    expect(readSpeechRuntimeConfig({ NODE_ENV: "test", APP_RUNTIME_MODE: "local-research", SPEECH_PROVIDER: "fake-test" }).capability.status).toBe("UNCONFIGURED");
    expect(readSpeechRuntimeConfig({ NODE_ENV: "test", APP_RUNTIME_MODE: "local-research" }).capability.status).toBe("UNCONFIGURED");
  });
});
