import { z } from "zod";

import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";

import {
  parseEncounterRecordPayload,
  type EncounterRecordPayload,
} from "./manual-synthetic-record";
import {
  type MedicalListField,
  type MedicalTextField,
} from "./medical-record";

export const SPEECH_SCHEMA_VERSION = "1.0.0" as const;

const safeSpeechIdPattern = /^[A-Za-z][A-Za-z0-9._:-]*$/u;
export const speechIdSchema = z.string().min(1).max(200).regex(safeSpeechIdPattern);

export const speechCapabilityStatusSchema = z.enum(["UNCONFIGURED", "READY", "UNSUPPORTED"]);
export type SpeechCapabilityStatus = z.infer<typeof speechCapabilityStatusSchema>;

export const speechCapabilityReasonSchema = z.enum([
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_NOT_IMPLEMENTED",
  "BROWSER_AUDIO_UNSUPPORTED",
  "PUBLIC_DEMO_READ_ONLY",
]);
export type SpeechCapabilityReason = z.infer<typeof speechCapabilityReasonSchema>;

export const speechCapabilitySchema = z.object({
  status: speechCapabilityStatusSchema,
  reason: speechCapabilityReasonSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "READY" && value.reason !== undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Ready speech capability cannot have a reason." });
  }
});
export type SpeechCapability = z.infer<typeof speechCapabilitySchema>;

export const speechProviderTypeSchema = z.enum([
  "FAKE_TEST",
  "BROWSER_EXPERIMENTAL",
  "LOCAL_WHISPER",
]);
export type SpeechProviderType = z.infer<typeof speechProviderTypeSchema>;

export const speechProviderDescriptorSchema = z.object({
  providerType: speechProviderTypeSchema,
  providerVersion: z.string().min(1).max(100),
  networkUsed: z.boolean(),
  retainedAudio: z.literal(false),
}).strict();
export type SpeechProviderDescriptor = z.infer<typeof speechProviderDescriptorSchema>;

export const speechSessionStatusSchema = z.enum([
  "PERMISSION_REQUIRED",
  "PERMISSION_DENIED",
  "RECORDING",
  "TRANSCRIBING",
  "NEEDS_REVIEW",
  "PARTIALLY_ACCEPTED",
  "ACCEPTED",
  "FAILED",
  "CANCELLED",
]);
export type SpeechSessionStatus = z.infer<typeof speechSessionStatusSchema>;

export const speechFailureReasonSchema = z.enum([
  "SPEECH_BROWSER_UNSUPPORTED",
  "SPEECH_MICROPHONE_NOT_FOUND",
  "SPEECH_MICROPHONE_BUSY",
  "SPEECH_RECORDING_TOO_SHORT",
  "SPEECH_NO_AUDIO_DETECTED",
  "SPEECH_BROWSER_AUDIO_FAILED",
  "SPEECH_LOCAL_SERVICE_UNAVAILABLE",
  "SPEECH_LOCAL_TRANSCRIPTION_FAILED",
]);
export type SpeechFailureReason = z.infer<typeof speechFailureReasonSchema>;

export const speechTargetSchema = z.enum([
  "chiefComplaint",
  "presentIllness",
  "pastHistory",
  "personalHistory",
  "familyHistory",
  "allergyHistory",
  "currentMedications",
  "problemFacts",
  "recentChanges",
  "redFlags",
  "generalCondition",
  "specialtyExam",
  "notExaminedOrUnknown",
  "laboratory",
  "electrocardiogram",
  "imaging",
  "other",
  "missingInformation",
]);
export type SpeechTarget = z.infer<typeof speechTargetSchema>;

export const speechSuggestionDecisionSchema = z.enum(["PENDING", "ACCEPTED", "IGNORED"]);
export type SpeechSuggestionDecision = z.infer<typeof speechSuggestionDecisionSchema>;

export const speechErrorCodes = {
  UNCONFIGURED: "SPEECH_UNCONFIGURED",
  UNSUPPORTED: "SPEECH_UNSUPPORTED",
  PUBLIC_DEMO_READ_ONLY: "SPEECH_PUBLIC_DEMO_READ_ONLY",
  PERMISSION_REQUIRED: "SPEECH_PERMISSION_REQUIRED",
  PERMISSION_DENIED: "SPEECH_PERMISSION_DENIED",
  INVALID_STATE: "SPEECH_INVALID_STATE",
  SESSION_NOT_FOUND: "SPEECH_SESSION_NOT_FOUND",
  PROVIDER_FAILED: "SPEECH_PROVIDER_FAILED",
  CANCELLED: "SPEECH_CANCELLED",
  TARGET_REQUIRED: "SPEECH_TARGET_REQUIRED",
  TRANSCRIPT_EMPTY: "SPEECH_TRANSCRIPT_EMPTY",
  SUGGESTION_NOT_FOUND: "SPEECH_SUGGESTION_NOT_FOUND",
  SUGGESTION_ALREADY_PROCESSED: "SPEECH_SUGGESTION_ALREADY_PROCESSED",
  SUGGESTION_INVALID: "SPEECH_SUGGESTION_INVALID",
  SUSPECTED_PII: "SPEECH_SUSPECTED_PII",
  AUDIT_FAILED: "SPEECH_AUDIT_FAILED",
} as const;
export type SpeechErrorCode = (typeof speechErrorCodes)[keyof typeof speechErrorCodes];

export class SpeechDomainError extends Error {
  readonly code: SpeechErrorCode;

  constructor(code: SpeechErrorCode, message: string) {
    super(message);
    this.name = "SpeechDomainError";
    this.code = code;
  }
}

const speechConfidenceSchema = z.number().finite().min(0).max(1);
const speechDurationSchema = z.number().int().nonnegative().max(3_600_000);

export const speechTranscriptSegmentSchema = z.object({
  id: speechIdSchema,
  text: z.string().min(1).max(2_000).refine(
    (value) => value.trim().length > 0,
    "Speech transcript segments must contain text.",
  ),
  startMs: speechDurationSchema,
  endMs: speechDurationSchema,
  confidenceStatus: z.enum(["PROVIDED", "NOT_PROVIDED"]),
  confidence: speechConfidenceSchema.optional(),
}).strict().superRefine((segment, context) => {
  if (segment.endMs < segment.startMs) {
    context.addIssue({ code: "custom", path: ["endMs"], message: "Speech segment end must not precede its start." });
  }
  if (segment.confidenceStatus === "PROVIDED" && segment.confidence === undefined) {
    context.addIssue({ code: "custom", path: ["confidence"], message: "Provided confidence must contain a value." });
  }
  if (segment.confidenceStatus === "NOT_PROVIDED" && segment.confidence !== undefined) {
    context.addIssue({ code: "custom", path: ["confidence"], message: "A missing confidence cannot contain a value." });
  }
});
export type SpeechTranscriptSegment = z.infer<typeof speechTranscriptSegmentSchema>;

export const speechTranscriptSchema = z.object({
  text: z.string().min(1).max(20_000).refine(
    (value) => value.trim().length > 0,
    "Speech transcripts must contain text.",
  ),
  segments: z.array(speechTranscriptSegmentSchema).min(1).max(40),
  durationMs: speechDurationSchema,
}).strict().superRefine((transcript, context) => {
  let previousEndMs = 0;
  transcript.segments.forEach((segment, index) => {
    if (segment.startMs < previousEndMs) {
      context.addIssue({ code: "custom", path: ["segments", index, "startMs"], message: "Speech segments must be ordered." });
    }
    if (segment.endMs > transcript.durationMs) {
      context.addIssue({ code: "custom", path: ["segments", index, "endMs"], message: "Speech segments must fit within the transcript duration." });
    }
    previousEndMs = Math.max(previousEndMs, segment.endMs);
  });
});
export type SpeechTranscript = z.infer<typeof speechTranscriptSchema>;

export const speechSuggestionSchema = z.object({
  id: speechIdSchema,
  sourceSegmentId: speechIdSchema,
  target: speechTargetSchema.optional(),
  text: z.string().min(1).max(2_000).refine(
    (value) => value.trim().length > 0,
    "Speech suggestions must contain text.",
  ),
  confidenceStatus: z.enum(["PROVIDED", "NOT_PROVIDED"]),
  confidence: speechConfidenceSchema.optional(),
  decision: speechSuggestionDecisionSchema,
}).strict().superRefine((suggestion, context) => {
  if (suggestion.confidenceStatus === "PROVIDED" && suggestion.confidence === undefined) {
    context.addIssue({ code: "custom", path: ["confidence"], message: "Provided confidence must contain a value." });
  }
  if (suggestion.confidenceStatus === "NOT_PROVIDED" && suggestion.confidence !== undefined) {
    context.addIssue({ code: "custom", path: ["confidence"], message: "A missing confidence cannot contain a value." });
  }
});
export type TranscriptSuggestion = z.infer<typeof speechSuggestionSchema>;

export const speechSessionSchema = z.object({
  schemaVersion: z.literal(SPEECH_SCHEMA_VERSION),
  id: speechIdSchema,
  encounterId: speechIdSchema,
  status: speechSessionStatusSchema,
  autoAssignHistory: z.boolean(),
  selectedTarget: speechTargetSchema.optional(),
  provider: speechProviderDescriptorSchema,
  retainedAudio: z.literal(false),
  transcript: speechTranscriptSchema.optional(),
  suggestions: z.array(speechSuggestionSchema).max(40),
  durationMs: speechDurationSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).optional(),
  errorCode: z.string().regex(/^SPEECH_[A-Z0-9_]+$/u).optional(),
  failureReason: speechFailureReasonSchema.optional(),
}).strict().superRefine((session, context) => {
  const reviewStates: SpeechSessionStatus[] = ["NEEDS_REVIEW", "PARTIALLY_ACCEPTED", "ACCEPTED"];
  if (reviewStates.includes(session.status) && (!session.transcript || session.suggestions.length === 0)) {
    context.addIssue({ code: "custom", path: ["suggestions"], message: "Reviewable speech sessions need transcript suggestions." });
  }
  if (session.status === "RECORDING" && session.startedAt === undefined) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "Recording sessions need a start time." });
  }
  if (session.status === "FAILED" && session.errorCode === undefined) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "Failed speech sessions need a controlled error code." });
  }
  if (session.status !== "FAILED" && session.failureReason !== undefined) {
    context.addIssue({ code: "custom", path: ["failureReason"], message: "Speech failure reasons only belong to failed sessions." });
  }
});
export type SpeechSession = z.infer<typeof speechSessionSchema>;

const speechPortFailureCodeSchema = z.enum([
  speechErrorCodes.PERMISSION_REQUIRED,
  speechErrorCodes.PERMISSION_DENIED,
  speechErrorCodes.PROVIDER_FAILED,
  speechErrorCodes.CANCELLED,
  speechErrorCodes.UNSUPPORTED,
]);

export const speechPortStartResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("RECORDING") }).strict(),
  z.object({ status: z.literal("PERMISSION_REQUIRED") }).strict(),
  z.object({ status: z.literal("PERMISSION_DENIED") }).strict(),
  z.object({
    status: z.literal("FAILED"),
    errorCode: speechPortFailureCodeSchema,
    failureReason: speechFailureReasonSchema.optional(),
  }).strict(),
]);
export type SpeechPortStartResult = z.infer<typeof speechPortStartResultSchema>;

export const speechPortSuccessSchema = z.object({
  ok: z.literal(true),
  sessionId: speechIdSchema,
  provider: speechProviderDescriptorSchema,
  transcript: speechTranscriptSchema,
  durationMs: speechDurationSchema,
}).strict();
export type SpeechPortSuccess = z.infer<typeof speechPortSuccessSchema>;

export const speechPortFailureSchema = z.object({
  ok: z.literal(false),
  sessionId: speechIdSchema,
  provider: speechProviderDescriptorSchema,
  errorCode: speechPortFailureCodeSchema,
  durationMs: speechDurationSchema,
  failureReason: speechFailureReasonSchema.optional(),
}).strict();
export type SpeechPortFailure = z.infer<typeof speechPortFailureSchema>;

export type SpeechRecognitionPort = {
  readonly capability: SpeechCapability;
  readonly provider: SpeechProviderDescriptor;
  readonly hasTemporaryAudio?: boolean;
  startRecording(sessionId: string): Promise<SpeechPortStartResult>;
  stopAndTranscribe(sessionId: string): Promise<SpeechPortSuccess | SpeechPortFailure>;
  cancel(sessionId: string): Promise<SpeechPortFailure>;
};

const terminalSpeechStatuses: readonly SpeechSessionStatus[] = ["ACCEPTED", "FAILED", "CANCELLED"];
const allowedSpeechTransitions: Record<SpeechSessionStatus, readonly SpeechSessionStatus[]> = {
  PERMISSION_REQUIRED: ["RECORDING", "PERMISSION_DENIED", "FAILED", "CANCELLED"],
  PERMISSION_DENIED: ["PERMISSION_REQUIRED", "RECORDING", "FAILED", "CANCELLED"],
  RECORDING: ["TRANSCRIBING", "FAILED", "CANCELLED"],
  TRANSCRIBING: ["NEEDS_REVIEW", "FAILED", "CANCELLED"],
  NEEDS_REVIEW: ["PARTIALLY_ACCEPTED", "ACCEPTED", "CANCELLED"],
  PARTIALLY_ACCEPTED: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: [],
  FAILED: [],
  CANCELLED: [],
};

export function transitionSpeechSession(
  session: SpeechSession,
  targetStatus: SpeechSessionStatus,
  updatedAt: string,
  options: { errorCode?: SpeechErrorCode; durationMs?: number; failureReason?: SpeechFailureReason } = {},
): SpeechSession {
  const current = speechSessionSchema.parse(session);
  if (!allowedSpeechTransitions[current.status].includes(targetStatus)) {
    throw new SpeechDomainError(
      speechErrorCodes.INVALID_STATE,
      terminalSpeechStatuses.includes(current.status)
        ? "已结束的语音会话不能再次操作。"
        : "语音会话状态转换不被允许。",
    );
  }

  const next = {
    ...current,
    status: targetStatus,
    updatedAt,
    ...(targetStatus === "RECORDING" ? { startedAt: updatedAt } : {}),
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    ...(options.failureReason === undefined ? {} : { failureReason: options.failureReason }),
  };
  return speechSessionSchema.parse(next);
}

export type TranscriptStructuringInput = {
  sessionId: string;
  transcript: SpeechTranscript;
  autoAssignHistory: boolean;
  selectedTarget?: SpeechTarget;
  suggestionIdFactory: (index: number) => string;
};

/**
 * Deterministic structure-only mapping. It never infers a diagnosis, medicine,
 * examination result or other clinical meaning from transcript text.
 */
export function structureTranscript(input: TranscriptStructuringInput): TranscriptSuggestion[] {
  const transcript = speechTranscriptSchema.parse(input.transcript);
  const matches = scanSuspectedPii(transcript);
  if (matches.length > 0) {
    throw new SpeechDomainError(speechErrorCodes.SUSPECTED_PII, "语音转写包含疑似身份信息，已安全拒绝。 ");
  }

  const target = input.autoAssignHistory ? "presentIllness" : input.selectedTarget;
  if (!target) {
    throw new SpeechDomainError(speechErrorCodes.TARGET_REQUIRED, "请先选择语音内容要归入的病历栏目。 ");
  }

  return transcript.segments.map((segment, index) => speechSuggestionSchema.parse({
    id: input.suggestionIdFactory(index),
    sourceSegmentId: segment.id,
    target,
    text: segment.text.trim(),
    confidenceStatus: segment.confidenceStatus,
    ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
    decision: "PENDING",
  }));
}

function editableSpeechSession(session: SpeechSession): SpeechSession {
  if (session.status !== "NEEDS_REVIEW" && session.status !== "PARTIALLY_ACCEPTED") {
    throw new SpeechDomainError(speechErrorCodes.INVALID_STATE, "当前语音结果还不能编辑。 ");
  }
  return speechSessionSchema.parse(session);
}

function suggestionIndex(session: SpeechSession, suggestionId: string): number {
  const index = session.suggestions.findIndex((suggestion) => suggestion.id === suggestionId);
  if (index < 0) throw new SpeechDomainError(speechErrorCodes.SUGGESTION_NOT_FOUND, "语音建议不存在。 ");
  if (session.suggestions[index].decision !== "PENDING") {
    throw new SpeechDomainError(speechErrorCodes.SUGGESTION_ALREADY_PROCESSED, "这条语音建议已经处理过。 ");
  }
  return index;
}

export function editTranscriptSuggestion(
  session: SpeechSession,
  suggestionId: string,
  text: string,
  target?: SpeechTarget,
): SpeechSession {
  const current = editableSpeechSession(session);
  const index = suggestionIndex(current, suggestionId);
  if (text.trim().length === 0) {
    throw new SpeechDomainError(speechErrorCodes.SUGGESTION_INVALID, "语音建议不能为空。 ");
  }
  if (scanSuspectedPii(text).length > 0) {
    throw new SpeechDomainError(speechErrorCodes.SUSPECTED_PII, "语音建议包含疑似身份信息，已安全拒绝。 ");
  }
  const suggestion = current.suggestions[index];
  const nextSuggestion = speechSuggestionSchema.parse({
    ...suggestion,
    text,
    ...(target === undefined ? {} : { target }),
  });
  const suggestions = [...current.suggestions];
  suggestions[index] = nextSuggestion;
  return speechSessionSchema.parse({ ...current, suggestions });
}

function processedSuggestionStatus(suggestions: readonly TranscriptSuggestion[]): "NEEDS_REVIEW" | "PARTIALLY_ACCEPTED" | "ACCEPTED" {
  const processed = suggestions.filter((suggestion) => suggestion.decision !== "PENDING").length;
  if (processed === 0) return "NEEDS_REVIEW";
  if (processed < suggestions.length) return "PARTIALLY_ACCEPTED";
  return "ACCEPTED";
}

export function decideTranscriptSuggestion(
  session: SpeechSession,
  suggestionId: string,
  decision: Exclude<SpeechSuggestionDecision, "PENDING">,
  updatedAt: string,
  target?: SpeechTarget,
): SpeechSession {
  const current = speechSessionSchema.parse(session);
  const index = suggestionIndex(current, suggestionId);
  if (current.status !== "NEEDS_REVIEW" && current.status !== "PARTIALLY_ACCEPTED") {
    throw new SpeechDomainError(speechErrorCodes.INVALID_STATE, "当前语音结果还不能处理。 ");
  }
  const suggestion = current.suggestions[index];
  const nextSuggestion = speechSuggestionSchema.parse({
    ...suggestion,
    ...(target === undefined ? {} : { target }),
    decision,
  });
  if (decision === "ACCEPTED" && nextSuggestion.target === undefined) {
    throw new SpeechDomainError(speechErrorCodes.TARGET_REQUIRED, "请先选择归入栏目。 ");
  }
  const suggestions = [...current.suggestions];
  suggestions[index] = nextSuggestion;
  const nextStatus = processedSuggestionStatus(suggestions);
  return transitionSpeechSession(
    speechSessionSchema.parse({ ...current, suggestions }),
    nextStatus,
    updatedAt,
  );
}

function appendText(field: MedicalTextField, text: string): MedicalTextField {
  const existing = field.value?.trim();
  const value = existing ? `${existing}；${text.trim()}` : text.trim();
  return { status: "PENDING_PHYSICIAN_CONFIRMATION", value };
}

function appendList(field: MedicalListField, text: string): MedicalListField {
  return {
    status: "PENDING_PHYSICIAN_CONFIRMATION",
    items: [...(field.items ?? []), text.trim()],
  };
}

/**
 * Applies only an explicitly ACCEPTED suggestion. The returned record is a
 * new validated in-memory value; persistence remains the existing PWR-04 save
 * action. Pending transcript text therefore cannot enter the save payload.
 */
export function applyAcceptedTranscriptSuggestion(
  record: EncounterRecordPayload,
  suggestion: TranscriptSuggestion,
): EncounterRecordPayload {
  const current = speechSuggestionSchema.parse(suggestion);
  if (current.decision !== "ACCEPTED" || current.target === undefined) {
    throw new SpeechDomainError(speechErrorCodes.SUGGESTION_INVALID, "只有已明确写入且已选定栏目的语音建议可以进入病历。 ");
  }
  if (scanSuspectedPii(current.text).length > 0) {
    throw new SpeechDomainError(speechErrorCodes.SUSPECTED_PII, "语音建议包含疑似身份信息，已安全拒绝。 ");
  }

  const parsedRecord = parseEncounterRecordPayload(record);
  const target = current.target;
  const next = {
    ...parsedRecord,
    history: { ...parsedRecord.history },
    physicalExam: { ...parsedRecord.physicalExam },
    auxiliaryExams: { ...parsedRecord.auxiliaryExams },
  };

  switch (target) {
    case "chiefComplaint":
    case "presentIllness":
    case "pastHistory":
    case "personalHistory":
    case "familyHistory":
    case "allergyHistory":
    case "currentMedications":
      next.history[target] = appendText(parsedRecord.history[target], current.text);
      break;
    case "problemFacts":
    case "recentChanges":
    case "redFlags":
      next.history[target] = appendList(parsedRecord.history[target], current.text);
      break;
    case "generalCondition":
    case "specialtyExam":
      next.physicalExam[target] = appendText(parsedRecord.physicalExam[target], current.text);
      break;
    case "notExaminedOrUnknown":
      next.physicalExam.notExaminedOrUnknown = appendList(parsedRecord.physicalExam.notExaminedOrUnknown, current.text);
      break;
    case "laboratory":
    case "electrocardiogram":
    case "imaging":
    case "other": {
      if (current.text.trim().length > 500) {
        throw new SpeechDomainError(speechErrorCodes.SUGGESTION_INVALID, "语音建议过长，无法安全写入检查结果。 ");
      }
      const field = parsedRecord.auxiliaryExams[target];
      next.auxiliaryExams[target] = {
        status: "PENDING_PHYSICIAN_CONFIRMATION",
        result: field.result ? `${field.result.trim()}\n${current.text.trim()}` : current.text.trim(),
        ...(field.examinationDate === undefined ? {} : { examinationDate: field.examinationDate }),
      };
      break;
    }
    case "missingInformation":
      next.missingInformation = appendList(parsedRecord.missingInformation, current.text);
      break;
    default: {
      const exhaustive: never = target;
      throw new SpeechDomainError(speechErrorCodes.SUGGESTION_INVALID, `不支持的语音目标：${String(exhaustive)}`);
    }
  }

  try {
    return parseEncounterRecordPayload(next);
  } catch {
    throw new SpeechDomainError(speechErrorCodes.SUGGESTION_INVALID, "语音建议未通过病历结构校验。 ");
  }
}

export function speechSuggestionCounts(suggestions: readonly TranscriptSuggestion[]): {
  suggestionCount: number;
  processedSuggestionCount: number;
  acceptedSuggestionCount: number;
} {
  return {
    suggestionCount: suggestions.length,
    processedSuggestionCount: suggestions.filter((suggestion) => suggestion.decision !== "PENDING").length,
    acceptedSuggestionCount: suggestions.filter((suggestion) => suggestion.decision === "ACCEPTED").length,
  };
}
