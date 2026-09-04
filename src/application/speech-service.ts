import { z } from "zod";

import {
  applyAcceptedTranscriptSuggestion,
  decideTranscriptSuggestion,
  editTranscriptSuggestion,
  speechCapabilitySchema,
  speechErrorCodes,
  speechIdSchema,
  speechPortFailureSchema,
  speechPortStartResultSchema,
  speechPortSuccessSchema,
  speechSessionSchema,
  speechSessionStatusSchema,
  speechSuggestionSchema,
  speechSuggestionCounts,
  structureTranscript,
  transitionSpeechSession,
  type SpeechCapability,
  type SpeechErrorCode,
  type SpeechRecognitionPort,
  type SpeechSession,
  type SpeechSuggestionDecision,
  type SpeechTarget,
} from "@/domain/speech";
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";
import { auditEventRecordSchema, isoUtcTimestampSchema, type AuditEventRecord } from "@/domain/runtime-records";
import type { EncounterRecordPayload } from "@/domain/manual-synthetic-record";

const speechAuditEventTypeSchema = z.enum([
  "SPEECH_SESSION_STATUS_CHANGED",
  "SPEECH_SUGGESTIONS_PROCESSED",
]);
export type SpeechAuditEventType = z.infer<typeof speechAuditEventTypeSchema>;

const speechAuditStatusSchema = z.union([speechSessionStatusSchema, z.literal("NEW")]);
type SpeechAuditStatus = z.infer<typeof speechAuditStatusSchema>;

export const speechAuditMetadataSchema = z.object({
  encounterId: speechIdSchema,
  sessionId: speechIdSchema,
  synthetic: z.literal(true),
  runtimeMode: appRuntimeModeSchema,
  status: speechAuditStatusSchema,
  durationMs: z.number().int().nonnegative().max(3_600_000),
  providerType: z.string().min(1).max(100),
  providerVersion: z.string().min(1).max(100),
  networkUsed: z.boolean(),
  retainedAudio: z.literal(false),
  suggestionCount: z.number().int().nonnegative().max(40),
  processedSuggestionCount: z.number().int().nonnegative().max(40),
  acceptedSuggestionCount: z.number().int().nonnegative().max(40),
}).strict();
export type SpeechAuditMetadata = z.infer<typeof speechAuditMetadataSchema>;

export type SpeechAuditEvent = {
  eventType: SpeechAuditEventType;
  encounterId: string;
  sessionId: string;
  beforeStatus?: SpeechAuditStatus;
  afterStatus: z.infer<typeof speechSessionStatusSchema>;
  metadata: SpeechAuditMetadata;
  createdAt: string;
};

export type SpeechAuditSink = {
  append(event: SpeechAuditEvent): void;
};

export type SpeechIdKind = "SESSION" | "SUGGESTION" | "AUDIT";
export type SpeechIdFactory = (kind: SpeechIdKind) => string;
export type SpeechClock = () => string;

export type SpeechServiceDependencies = {
  port: SpeechRecognitionPort;
  runtimeMode: AppRuntimeMode;
  clock?: SpeechClock;
  idFactory?: SpeechIdFactory;
  auditSink?: SpeechAuditSink;
};

export type CreateSpeechSessionInput = {
  encounterId: string;
  autoAssignHistory?: boolean;
  selectedTarget?: SpeechTarget;
};

export type SpeechSuggestionDecisionResult = {
  session: SpeechSession;
  record: EncounterRecordPayload;
};

const defaultClock: SpeechClock = () => new Date().toISOString();
const defaultIdFactory: SpeechIdFactory = (kind) => {
  const entropy = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `speech-${kind.toLowerCase()}-${entropy}`;
};

function nowIso(clock: SpeechClock): string {
  const value = clock();
  if (!isoUtcTimestampSchema.safeParse(value).success) {
    throw new SpeechError(speechErrorCodes.PROVIDER_FAILED, "语音服务时间不可用。 ");
  }
  return value;
}

function isPublicDemo(runtimeMode: AppRuntimeMode): boolean {
  return runtimeMode === "public-demo";
}

function capabilityError(capability: SpeechCapability): SpeechError {
  return new SpeechError(
    capability.status === "UNSUPPORTED" ? speechErrorCodes.UNSUPPORTED : speechErrorCodes.UNCONFIGURED,
    capability.status === "UNSUPPORTED" ? "当前环境不支持语音录入。" : "语音转写服务尚未配置。",
  );
}

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;

  constructor(code: SpeechErrorCode, message: string) {
    super(message);
    this.name = "SpeechError";
    this.code = code;
  }
}

function safeErrorCode(value: unknown): SpeechErrorCode {
  const known = new Set<SpeechErrorCode>(Object.values(speechErrorCodes));
  return typeof value === "string" && known.has(value as SpeechErrorCode)
    ? value as SpeechErrorCode
    : speechErrorCodes.PROVIDER_FAILED;
}

function assertSessionBelongsToPort(session: SpeechSession, port: SpeechRecognitionPort): void {
  if (session.provider.providerType !== port.provider.providerType
    || session.provider.providerVersion !== port.provider.providerVersion) {
    throw new SpeechError(speechErrorCodes.PROVIDER_FAILED, "语音会话服务配置已变化，请重新开始。 ");
  }
}

export function createSpeechAuditEventRecord(
  event: SpeechAuditEvent,
  idFactory: SpeechIdFactory = defaultIdFactory,
): AuditEventRecord {
  const metadata = speechAuditMetadataSchema.parse(event.metadata);
  const eventType = speechAuditEventTypeSchema.parse(event.eventType);
  return auditEventRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: idFactory("AUDIT"),
    eventType,
    actorId: "speech-service",
    simulatedRole: "PHYSICIAN",
    entityType: "SPEECH_SESSION",
    entityId: event.sessionId,
    ...(event.beforeStatus === undefined ? {} : { beforeVersion: event.beforeStatus }),
    afterVersion: event.afterStatus,
    metadata,
    createdAt: event.createdAt,
  });
}

export class SpeechApplicationService {
  private readonly dependencies: Required<Pick<SpeechServiceDependencies, "clock" | "idFactory">>
    & Omit<SpeechServiceDependencies, "clock" | "idFactory">;
  private readonly cancelledTranscriptionSessionIds = new Set<string>();

  constructor(dependencies: SpeechServiceDependencies) {
    this.dependencies = {
      ...dependencies,
      clock: dependencies.clock ?? defaultClock,
      idFactory: dependencies.idFactory ?? defaultIdFactory,
    };
    speechCapabilitySchema.parse(dependencies.port.capability);
  }

  private assertWritable(): void {
    if (isPublicDemo(this.dependencies.runtimeMode)) {
      throw new SpeechError(
        speechErrorCodes.PUBLIC_DEMO_READ_ONLY,
        "公开只读演示不允许录音、转写或处理语音建议。",
      );
    }
  }

  private appendAudit(
    session: SpeechSession,
    beforeStatus: SpeechAuditStatus | undefined,
    eventType: SpeechAuditEventType = "SPEECH_SESSION_STATUS_CHANGED",
  ): void {
    if (!this.dependencies.auditSink) return;
    const counts = speechSuggestionCounts(session.suggestions);
    const event: SpeechAuditEvent = {
      eventType,
      encounterId: session.encounterId,
      sessionId: session.id,
      ...(beforeStatus === undefined ? {} : { beforeStatus }),
      afterStatus: session.status,
      metadata: speechAuditMetadataSchema.parse({
        encounterId: session.encounterId,
        sessionId: session.id,
        synthetic: true,
        runtimeMode: this.dependencies.runtimeMode,
        status: session.status,
        durationMs: session.durationMs ?? 0,
        providerType: session.provider.providerType,
        providerVersion: session.provider.providerVersion,
        networkUsed: session.provider.networkUsed,
        retainedAudio: false,
        ...counts,
      }),
      createdAt: session.updatedAt,
    };
    try {
      this.dependencies.auditSink.append(event);
    } catch {
      throw new SpeechError(speechErrorCodes.AUDIT_FAILED, "语音审计未能安全记录。 ");
    }
  }

  createSession(input: CreateSpeechSessionInput): SpeechSession {
    this.assertWritable();
    const capability = speechCapabilitySchema.parse(this.dependencies.port.capability);
    if (capability.status !== "READY") throw capabilityError(capability);
    if (!speechIdSchema.safeParse(input.encounterId).success) {
      throw new SpeechError(speechErrorCodes.SESSION_NOT_FOUND, "当前接诊标识无效。 ");
    }
    const autoAssignHistory = input.autoAssignHistory ?? true;

    const timestamp = nowIso(this.dependencies.clock);
    const session = speechSessionSchema.parse({
      schemaVersion: "1.0.0",
      id: this.dependencies.idFactory("SESSION"),
      encounterId: input.encounterId,
      status: "PERMISSION_REQUIRED",
      autoAssignHistory,
      ...(input.selectedTarget === undefined ? {} : { selectedTarget: input.selectedTarget }),
      provider: this.dependencies.port.provider,
      retainedAudio: false,
      suggestions: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.appendAudit(session, undefined);
    return session;
  }

  async startRecording(session: SpeechSession): Promise<SpeechSession> {
    this.assertWritable();
    const current = speechSessionSchema.parse(session);
    assertSessionBelongsToPort(current, this.dependencies.port);
    if (current.status !== "PERMISSION_REQUIRED" && current.status !== "PERMISSION_DENIED") {
      throw new SpeechError(speechErrorCodes.INVALID_STATE, "当前语音会话不能开始录音。 ");
    }

    let result;
    try {
      result = speechPortStartResultSchema.parse(await this.dependencies.port.startRecording(current.id));
    } catch {
      result = { status: "FAILED" as const, errorCode: speechErrorCodes.PROVIDER_FAILED };
    }
    const timestamp = nowIso(this.dependencies.clock);
    if (result.status === "PERMISSION_REQUIRED") return current;
    const targetStatus = result.status === "RECORDING"
      ? "RECORDING"
      : result.status === "PERMISSION_DENIED"
        ? "PERMISSION_DENIED"
        : "FAILED";
    const next = transitionSpeechSession(current, targetStatus, timestamp, {
      ...(targetStatus === "FAILED" && result.status === "FAILED"
        ? { errorCode: safeErrorCode(result.errorCode) }
        : {}),
      ...(targetStatus === "FAILED" && result.status === "FAILED" && result.failureReason !== undefined
        ? { failureReason: result.failureReason }
        : {}),
    });
    this.appendAudit(next, current.status);
    return next;
  }

  async stopAndTranscribe(
    session: SpeechSession,
    onTranscribing?: (session: SpeechSession) => void,
  ): Promise<SpeechSession> {
    this.assertWritable();
    const current = speechSessionSchema.parse(session);
    assertSessionBelongsToPort(current, this.dependencies.port);
    if (current.status !== "RECORDING") {
      throw new SpeechError(speechErrorCodes.INVALID_STATE, "当前语音会话不能停止并转写。 ");
    }

    const transcribing = transitionSpeechSession(current, "TRANSCRIBING", nowIso(this.dependencies.clock));
    this.appendAudit(transcribing, current.status);
    onTranscribing?.(transcribing);

    let result;
    try {
      result = speechPortSuccessSchema.or(speechPortFailureSchema).parse(
        await this.dependencies.port.stopAndTranscribe(current.id),
      );
    } catch {
      result = {
        ok: false as const,
        sessionId: current.id,
        provider: current.provider,
        errorCode: speechErrorCodes.PROVIDER_FAILED,
        durationMs: 0,
      };
    }

    // Cancellation can complete while the provider's in-flight promise is
    // still pending. The cancellation path owns the terminal transition;
    // this late result must not create a second terminal state or audit event.
    if (this.cancelledTranscriptionSessionIds.delete(current.id)) {
      return transcribing;
    }

    if (!result.ok) {
      const status = result.errorCode === speechErrorCodes.CANCELLED ? "CANCELLED" : "FAILED";
      const next = transitionSpeechSession(transcribing, status, nowIso(this.dependencies.clock), {
        errorCode: result.errorCode,
        durationMs: result.durationMs,
        ...(status === "FAILED" && result.failureReason !== undefined
          ? { failureReason: result.failureReason }
          : {}),
      });
      this.appendAudit(next, transcribing.status);
      return next;
    }

    if (result.sessionId !== current.id
      || result.provider.providerType !== current.provider.providerType
      || result.provider.providerVersion !== current.provider.providerVersion) {
      const next = transitionSpeechSession(transcribing, "FAILED", nowIso(this.dependencies.clock), {
        errorCode: speechErrorCodes.PROVIDER_FAILED,
        durationMs: result.durationMs,
      });
      this.appendAudit(next, transcribing.status);
      return next;
    }

    try {
      const suggestions = structureTranscript({
        sessionId: current.id,
        transcript: result.transcript,
        autoAssignHistory: current.autoAssignHistory,
        selectedTarget: current.selectedTarget,
        suggestionIdFactory: () => this.dependencies.idFactory("SUGGESTION"),
      });
      const withResult = speechSessionSchema.parse({
        ...transcribing,
        transcript: result.transcript,
        suggestions,
      });
      const next = transitionSpeechSession(withResult, "NEEDS_REVIEW", nowIso(this.dependencies.clock), {
        durationMs: result.durationMs,
      });
      this.appendAudit(next, transcribing.status);
      return next;
    } catch (error) {
      const code = error instanceof SpeechError || error instanceof Error && "code" in error
        ? safeErrorCode((error as { code?: unknown }).code)
        : speechErrorCodes.PROVIDER_FAILED;
      const next = transitionSpeechSession(transcribing, "FAILED", nowIso(this.dependencies.clock), {
        errorCode: code,
        durationMs: result.durationMs,
      });
      this.appendAudit(next, transcribing.status);
      return next;
    }
  }

  async cancel(session: SpeechSession): Promise<SpeechSession> {
    this.assertWritable();
    const current = speechSessionSchema.parse(session);
    assertSessionBelongsToPort(current, this.dependencies.port);
    if (["ACCEPTED", "FAILED", "CANCELLED"].includes(current.status)) {
      throw new SpeechError(speechErrorCodes.INVALID_STATE, "已结束的语音会话不能取消。 ");
    }

    if (current.status === "TRANSCRIBING") {
      this.cancelledTranscriptionSessionIds.add(current.id);
    }

    if (current.status === "RECORDING" || current.status === "TRANSCRIBING" || current.status === "PERMISSION_REQUIRED" || current.status === "PERMISSION_DENIED") {
      try {
        speechPortFailureSchema.parse(await this.dependencies.port.cancel(current.id));
      } catch {
        // Cancellation remains a local, fail-closed state even when the
        // provider has already released its temporary audio buffer.
      }
    }
    const next = transitionSpeechSession(current, "CANCELLED", nowIso(this.dependencies.clock), {
      errorCode: speechErrorCodes.CANCELLED,
    });
    this.appendAudit(next, current.status);
    return next;
  }

  editSuggestion(session: SpeechSession, suggestionId: string, text: string, target?: SpeechTarget): SpeechSession {
    this.assertWritable();
    return editTranscriptSuggestion(session, suggestionId, text, target);
  }

  updateAssignment(
    session: SpeechSession,
    autoAssignHistory: boolean,
    selectedTarget?: SpeechTarget,
  ): SpeechSession {
    this.assertWritable();
    const current = speechSessionSchema.parse(session);
    const pendingSuggestions = current.suggestions.map((suggestion) => {
      if (suggestion.decision !== "PENDING") return suggestion;
      if (autoAssignHistory) {
        return speechSuggestionSchema.parse({ ...suggestion, target: "presentIllness" });
      }
      const withoutTarget = { ...suggestion };
      delete withoutTarget.target;
      return speechSuggestionSchema.parse(withoutTarget);
    });
    const { selectedTarget: _currentTarget, ...withoutSelectedTarget } = current;
    return speechSessionSchema.parse({
      ...withoutSelectedTarget,
      autoAssignHistory,
      ...(autoAssignHistory
        ? {}
        : selectedTarget === undefined && _currentTarget === undefined
          ? {}
          : { selectedTarget: selectedTarget ?? _currentTarget }),
      suggestions: pendingSuggestions,
    });
  }

  decideSuggestion(
    session: SpeechSession,
    suggestionId: string,
    decision: Exclude<SpeechSuggestionDecision, "PENDING">,
    record: EncounterRecordPayload,
    target?: SpeechTarget,
  ): SpeechSuggestionDecisionResult {
    this.assertWritable();
    const current = speechSessionSchema.parse(session);
    const updatedAt = nowIso(this.dependencies.clock);
    const next = decideTranscriptSuggestion(current, suggestionId, decision, updatedAt, target);
    const nextSuggestion = next.suggestions.find((suggestion) => suggestion.id === suggestionId);
    if (!nextSuggestion) throw new SpeechError(speechErrorCodes.SUGGESTION_NOT_FOUND, "语音建议不存在。 ");
    const nextRecord = decision === "ACCEPTED"
      ? applyAcceptedTranscriptSuggestion(record, nextSuggestion)
      : record;
    this.appendAudit(next, current.status, "SPEECH_SUGGESTIONS_PROCESSED");
    return { session: next, record: nextRecord };
  }
}

export function createInMemorySpeechAuditSink(): { events: SpeechAuditEvent[]; sink: SpeechAuditSink } {
  const events: SpeechAuditEvent[] = [];
  return {
    events,
    sink: {
      append(event) {
        events.push(event);
      },
    },
  };
}
