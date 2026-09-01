import { describe, expect, it } from "vitest";

import { syntheticMedicalRecords } from "@/data/seed-loader";

import {
  applyAcceptedTranscriptSuggestion,
  decideTranscriptSuggestion,
  editTranscriptSuggestion,
  speechCapabilitySchema,
  speechErrorCodes,
  speechFailureReasonSchema,
  speechPortSuccessSchema,
  speechSessionSchema,
  structureTranscript,
  transitionSpeechSession,
  type SpeechSession,
} from "./speech";

const timestamp = "2026-08-22T00:00:00.000Z";
const provider = {
  providerType: "FAKE_TEST" as const,
  providerVersion: "fake-speech-1.0.0",
  networkUsed: false,
  retainedAudio: false as const,
};

function suggestion(id = "suggestion-001", target: "presentIllness" | "laboratory" = "presentIllness") {
  return {
    id,
    sourceSegmentId: `segment-${id}`,
    target,
    text: "合成口述：晨起乏力，待医生复核。",
    confidenceStatus: "PROVIDED" as const,
    confidence: 0.8,
    decision: "PENDING" as const,
  };
}

function session(overrides: Partial<SpeechSession> = {}): SpeechSession {
  return speechSessionSchema.parse({
    schemaVersion: "1.0.0",
    id: "speech-session-001",
    encounterId: "encounter-speech-001",
    status: "PERMISSION_REQUIRED",
    autoAssignHistory: true,
    provider,
    retainedAudio: false,
    suggestions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

describe("PWR-05 speech domain", () => {
  it("accepts only fixed failure reasons on failed sessions", () => {
    const reasons = [
      "SPEECH_RECORDING_TOO_SHORT",
      "SPEECH_NO_AUDIO_DETECTED",
      "SPEECH_BROWSER_AUDIO_FAILED",
      "SPEECH_LOCAL_SERVICE_UNAVAILABLE",
      "SPEECH_LOCAL_TRANSCRIPTION_FAILED",
    ] as const;
    expect(reasons.map((reason) => speechFailureReasonSchema.parse(reason))).toEqual(reasons);
    expect(speechFailureReasonSchema.safeParse("SPEECH_RAW_PROVIDER_ERROR").success).toBe(false);

    const failed = transitionSpeechSession(
      session({ status: "TRANSCRIBING", startedAt: timestamp }),
      "FAILED",
      timestamp,
      { errorCode: speechErrorCodes.PROVIDER_FAILED, failureReason: "SPEECH_NO_AUDIO_DETECTED" },
    );
    expect(failed.failureReason).toBe("SPEECH_NO_AUDIO_DETECTED");
    expect(() => transitionSpeechSession(session(), "RECORDING", timestamp, {
      failureReason: "SPEECH_BROWSER_AUDIO_FAILED",
    })).toThrow();

    const legacyFailed = speechSessionSchema.parse(session({
      status: "FAILED",
      errorCode: speechErrorCodes.PROVIDER_FAILED,
    }));
    expect(legacyFailed.failureReason).toBeUndefined();
    expect(speechSessionSchema.safeParse({
      ...session({ status: "RECORDING", startedAt: timestamp }),
      failureReason: "SPEECH_BROWSER_AUDIO_FAILED",
    }).success).toBe(false);
  });

  it("uses a strict capability and port result schema", () => {
    expect(speechCapabilitySchema.safeParse({ status: "READY", extra: true }).success).toBe(false);
    expect(speechPortSuccessSchema.safeParse({
      ok: true,
      sessionId: "speech-session-001",
      provider,
      durationMs: 100,
      transcript: {
        text: "合成口述",
        durationMs: 100,
        segments: [{
          id: "segment-001",
          text: "合成口述",
          startMs: 0,
          endMs: 100,
          confidenceStatus: "NOT_PROVIDED",
        }],
      },
      extra: "not allowed",
    }).success).toBe(false);
  });

  it("rejects out-of-order or out-of-duration transcript segments", () => {
    const base = {
      text: "合成口述一。合成口述二。",
      durationMs: 200,
      segments: [
        { id: "segment-001", text: "合成口述一。", startMs: 0, endMs: 100, confidenceStatus: "NOT_PROVIDED" as const },
        { id: "segment-002", text: "合成口述二。", startMs: 90, endMs: 200, confidenceStatus: "NOT_PROVIDED" as const },
      ],
    };
    expect(() => speechPortSuccessSchema.parse({ ok: true, sessionId: "speech-session-001", provider, durationMs: 200, transcript: base })).toThrow();
    expect(() => speechPortSuccessSchema.parse({
      ok: true,
      sessionId: "speech-session-001",
      provider,
      durationMs: 200,
      transcript: { ...base, segments: [{ ...base.segments[0], endMs: 300 }] },
    })).toThrow();
  });

  it("supports only the explicit forward session path", () => {
    const withRecording = transitionSpeechSession(session(), "RECORDING", timestamp);
    const transcribing = transitionSpeechSession(withRecording, "TRANSCRIBING", "2026-08-22T00:00:01.000Z");
    const reviewed = transitionSpeechSession(
      session({
        status: "TRANSCRIBING",
        startedAt: timestamp,
        transcript: {
          text: "合成口述",
          durationMs: 100,
          segments: [{ id: "segment-001", text: "合成口述", startMs: 0, endMs: 100, confidenceStatus: "NOT_PROVIDED" }],
        },
        suggestions: [suggestion()],
      }),
      "NEEDS_REVIEW",
      "2026-08-22T00:00:02.000Z",
    );
    expect(withRecording.status).toBe("RECORDING");
    expect(transcribing.status).toBe("TRANSCRIBING");
    expect(reviewed.status).toBe("NEEDS_REVIEW");
    expect(() => transitionSpeechSession(session(), "NEEDS_REVIEW", timestamp)).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.INVALID_STATE }),
    );
    expect(() => transitionSpeechSession(reviewed, "RECORDING", timestamp)).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.INVALID_STATE }),
    );
  });

  it("allows a permission-denied session to recover when the provider grants access", () => {
    const denied = transitionSpeechSession(session(), "PERMISSION_DENIED", timestamp);
    const recording = transitionSpeechSession(denied, "RECORDING", "2026-08-22T00:00:01.000Z");

    expect(recording.status).toBe("RECORDING");
    expect(recording.startedAt).toBe("2026-08-22T00:00:01.000Z");
  });

  it("blocks repeated terminal transitions", () => {
    const accepted = session({
      status: "ACCEPTED",
      transcript: {
        text: "合成口述",
        durationMs: 100,
        segments: [{ id: "segment-001", text: "合成口述", startMs: 0, endMs: 100, confidenceStatus: "NOT_PROVIDED" }],
      },
      suggestions: [suggestion()],
    });
    expect(() => transitionSpeechSession(accepted, "ACCEPTED", timestamp)).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.INVALID_STATE }),
    );
    expect(() => transitionSpeechSession(accepted, "CANCELLED", timestamp)).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.INVALID_STATE }),
    );
  });

  it("maps transcript segments without inferring clinical meaning", () => {
    const suggestions = structureTranscript({
      sessionId: "speech-session-001",
      transcript: {
        text: "合成口述一。合成口述二。",
        durationMs: 200,
        segments: [
          { id: "segment-001", text: "合成口述一。", startMs: 0, endMs: 100, confidenceStatus: "PROVIDED", confidence: 0.9 },
          { id: "segment-002", text: "合成口述二。", startMs: 100, endMs: 200, confidenceStatus: "NOT_PROVIDED" },
        ],
      },
      autoAssignHistory: true,
      suggestionIdFactory: (index) => `suggestion-${String(index + 1).padStart(3, "0")}`,
    });
    expect(suggestions.map((item) => item.target)).toEqual(["presentIllness", "presentIllness"]);
    expect(suggestions[0].confidence).toBe(0.9);
    expect(suggestions[1].confidenceStatus).toBe("NOT_PROVIDED");
    expect(suggestions[1].confidence).toBeUndefined();
  });

  it("requires a physician-selected target when automatic history assignment is off", () => {
    expect(() => structureTranscript({
      sessionId: "speech-session-001",
      transcript: {
        text: "合成口述",
        durationMs: 100,
        segments: [{ id: "segment-001", text: "合成口述", startMs: 0, endMs: 100, confidenceStatus: "NOT_PROVIDED" }],
      },
      autoAssignHistory: false,
      suggestionIdFactory: () => "suggestion-001",
    })).toThrowError(expect.objectContaining({ code: speechErrorCodes.TARGET_REQUIRED }));
  });

  it("rejects suspected PII without echoing the matched text", () => {
    let caught: unknown;
    try {
      structureTranscript({
        sessionId: "speech-session-001",
        transcript: {
          text: "姓名：合成患者",
          durationMs: 100,
          segments: [{ id: "segment-001", text: "姓名：合成患者", startMs: 0, endMs: 100, confidenceStatus: "NOT_PROVIDED" }],
        },
        autoAssignHistory: true,
        suggestionIdFactory: () => "suggestion-001",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({ code: speechErrorCodes.SUSPECTED_PII }));
    expect(String(caught)).not.toContain("合成患者");
  });

  it("allows editing a pending suggestion but blocks a second decision", () => {
    const reviewed = session({
      status: "NEEDS_REVIEW",
      transcript: {
        text: "合成口述",
        durationMs: 100,
        segments: [{ id: "segment-001", text: "合成口述", startMs: 0, endMs: 100, confidenceStatus: "NOT_PROVIDED" }],
      },
      suggestions: [suggestion()],
    });
    const edited = editTranscriptSuggestion(reviewed, "suggestion-001", "医生编辑后的合成口述", "presentIllness");
    expect(edited.suggestions[0].text).toBe("医生编辑后的合成口述");
    const accepted = decideTranscriptSuggestion(edited, "suggestion-001", "ACCEPTED", timestamp);
    expect(accepted.status).toBe("ACCEPTED");
    expect(() => decideTranscriptSuggestion(accepted, "suggestion-001", "IGNORED", timestamp)).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.SUGGESTION_ALREADY_PROCESSED }),
    );
  });

  it("moves from review to partial and then accepted without losing pending counts", () => {
    const reviewed = session({
      status: "NEEDS_REVIEW",
      transcript: {
        text: "合成口述一。合成口述二。",
        durationMs: 200,
        segments: [
          { id: "segment-001", text: "合成口述一。", startMs: 0, endMs: 100, confidenceStatus: "NOT_PROVIDED" },
          { id: "segment-002", text: "合成口述二。", startMs: 100, endMs: 200, confidenceStatus: "NOT_PROVIDED" },
        ],
      },
      suggestions: [suggestion("suggestion-001"), suggestion("suggestion-002")],
    });
    const partial = decideTranscriptSuggestion(reviewed, "suggestion-001", "ACCEPTED", timestamp);
    expect(partial.status).toBe("PARTIALLY_ACCEPTED");
    expect(partial.suggestions.filter((item) => item.decision === "PENDING")).toHaveLength(1);
    const accepted = decideTranscriptSuggestion(partial, "suggestion-002", "IGNORED", "2026-08-22T00:00:01.000Z");
    expect(accepted.status).toBe("ACCEPTED");
  });

  it("only projects an accepted suggestion and leaves the original record unchanged", () => {
    const record = syntheticMedicalRecords[0];
    const pending = suggestion();
    expect(() => applyAcceptedTranscriptSuggestion(record, pending)).toThrowError(
      expect.objectContaining({ code: speechErrorCodes.SUGGESTION_INVALID }),
    );

    const accepted = { ...pending, decision: "ACCEPTED" as const };
    const projected = applyAcceptedTranscriptSuggestion(record, accepted);
    expect(projected).not.toBe(record);
    expect(projected.history.presentIllness.value).toContain(pending.text);
    expect(projected.history.presentIllness.status).toBe("PENDING_PHYSICIAN_CONFIRMATION");
    expect(record.history.presentIllness.value).not.toContain(pending.text);
  });

  it("writes an accepted auxiliary suggestion to the structured result field only", () => {
    const record = syntheticMedicalRecords[0];
    const accepted = {
      ...suggestion("suggestion-lab", "laboratory"),
      decision: "ACCEPTED" as const,
      text: "合成实验室结果待医生复核",
    };
    const projected = applyAcceptedTranscriptSuggestion(record, accepted);
    expect(projected.auxiliaryExams.laboratory.result).toContain(accepted.text);
    expect(projected.history.presentIllness.value).toBe(record.history.presentIllness.value);
  });
});
