import { useCallback, useEffect, useRef, useState } from "react";

import type { EncounterRecordPayload } from "@/domain/manual-synthetic-record";
import {
  type SpeechPanelTestFixture,
  type SpeechTestFlow,
} from "@/domain/speech-test-fixture";
import {
  speechSessionSchema,
  type SpeechCapability,
  type SpeechFailureReason,
  type SpeechRecognitionPort,
  type SpeechSession,
  type SpeechTarget,
  type TranscriptSuggestion,
} from "@/domain/speech";
import {
  createInMemorySpeechAuditSink,
  SpeechApplicationService,
  type SpeechAuditEvent,
} from "@/application/speech-service";
import {
  createFakeSpeechRecognitionProvider,
  type FakePermissionScenario,
  type FakeSpeechScenario,
} from "@/infrastructure/speech/fake-speech-provider";
import { createLocalSpeechRecognitionProvider } from "@/infrastructure/speech/local-speech-provider";

export type { SpeechPanelTestFixture, SpeechTestFlow } from "@/domain/speech-test-fixture";

export type SpeechWorkflowControllerOptions = {
  encounterId: string;
  initialRecord: EncounterRecordPayload;
  fixture?: SpeechPanelTestFixture;
  capability?: SpeechCapability;
  port?: SpeechRecognitionPort;
  onRecordChange: { bivarianceHack(record: EncounterRecordPayload): void }["bivarianceHack"];
};

export type SpeechWorkflowSnapshot = {
  session?: SpeechSession;
  busy: boolean;
  recordingDurationMs?: number;
  error?: string;
  autoAssignHistory: boolean;
  selectedTarget?: SpeechTarget;
  draftTexts: Record<string, string>;
  draftTargets: Record<string, SpeechTarget>;
  expanded: boolean;
};

export type SpeechWorkflowView = SpeechWorkflowSnapshot & {
  suggestions: TranscriptSuggestion[];
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  retryRecording: () => Promise<void>;
  startNewRecording: () => Promise<void>;
  editSuggestion: (suggestionId: string, text: string, target?: SpeechTarget) => void;
  decideSuggestion: (
    suggestionId: string,
    decision: "ACCEPTED" | "IGNORED",
    target?: SpeechTarget,
  ) => void;
  ignorePendingAndContinue: () => Promise<void>;
  updateAssignment: (autoAssignHistory: boolean) => void;
};

type ControllerListener = (snapshot: SpeechWorkflowSnapshot) => void;

const initialClockTime = Date.parse("2026-08-22T00:00:00.000Z");
const maximumRecordingDurationMs = 15_000;

function flowOptions(flow: SpeechTestFlow): {
  scenario: FakeSpeechScenario;
  permission: FakePermissionScenario;
  delayMs: number;
  segmentCount: number;
} {
  switch (flow) {
    case "permission-denied":
      return { scenario: "SUCCESS", permission: "DENIED_ONCE", delayMs: 120, segmentCount: 2 };
    case "low-confidence":
      return { scenario: "LOW_CONFIDENCE", permission: "GRANTED", delayMs: 120, segmentCount: 1 };
    case "no-confidence":
      return { scenario: "NO_CONFIDENCE", permission: "GRANTED", delayMs: 120, segmentCount: 1 };
    case "failed":
      return { scenario: "FAILURE", permission: "GRANTED", delayMs: 120, segmentCount: 2 };
    case "cancelled":
      return { scenario: "CANCELLED", permission: "GRANTED", delayMs: 120, segmentCount: 2 };
    case "transcribing":
      return { scenario: "SUCCESS", permission: "GRANTED", delayMs: 500, segmentCount: 2 };
    default:
      return { scenario: "SUCCESS", permission: "GRANTED", delayMs: 120, segmentCount: 2 };
  }
}

export function speechFailureReasonText(
  failureReason?: SpeechFailureReason,
  errorCode?: string,
): string {
  switch (failureReason) {
    case "SPEECH_BROWSER_UNSUPPORTED":
      return "当前浏览器不能录音，请改用最新版 Edge 或 Chrome，或继续手动录入。";
    case "SPEECH_MICROPHONE_NOT_FOUND":
      return "没有检测到可用麦克风，请连接或启用麦克风后重试。";
    case "SPEECH_MICROPHONE_BUSY":
      return "麦克风正被其他程序占用，请关闭占用程序后重试。";
    case "SPEECH_RECORDING_TOO_SHORT":
      return "录音太短，请连续说话至少 1 秒。";
    case "SPEECH_NO_AUDIO_DETECTED":
      return "未检测到声音，请检查麦克风后重试。";
    case "SPEECH_BROWSER_AUDIO_FAILED":
      return "浏览器未能处理录音，请重新录制。";
    case "SPEECH_LOCAL_SERVICE_UNAVAILABLE":
      return "本地语音服务不可用，请重新启动演示。";
    case "SPEECH_LOCAL_TRANSCRIPTION_FAILED":
      return "本地转写未完成，可重试一次或手动录入。";
    default:
      if (errorCode === "SPEECH_SUSPECTED_PII") {
        return "语音内容可能包含身份信息，已停止处理；请只使用虚构内容。";
      }
      if (errorCode === "SPEECH_UNSUPPORTED") {
        return "当前浏览器不能录音，请改用最新版 Edge 或 Chrome，或继续手动录入。";
      }
      return "语音转写失败，原病历内容未改变，仍可手动录入。";
  }
}

function safeWorkflowError(error: unknown): string {
  if (error instanceof Error && error.message.length <= 240) return error.message;
  return "语音操作未完成，原病历内容未改变。";
}

export class SpeechWorkflowController {
  private readonly service: SpeechApplicationService;
  private readonly fixture?: SpeechPanelTestFixture;
  private readonly encounterId: string;
  private readonly onRecordChange: (record: EncounterRecordPayload) => void;
  private readonly provider: SpeechRecognitionPort;
  private readonly listeners = new Set<ControllerListener>();
  private readonly auditEvents: SpeechAuditEvent[];
  private readonly idFactory = (() => {
    let sequence = 0;
    return (kind: "SESSION" | "SUGGESTION" | "AUDIT"): string => {
      sequence += 1;
      return `pwr5-${kind.toLowerCase()}-${String(sequence).padStart(3, "0")}`;
    };
  })();
  private clockTick = 0;
  private record: EncounterRecordPayload;
  private session?: SpeechSession;
  private busy = false;
  private error?: string;
  private autoAssignHistory = true;
  private selectedTarget?: SpeechTarget;
  private draftTexts: Record<string, string> = {};
  private draftTargets: Record<string, SpeechTarget> = {};
  private transcriptionSequence = 0;
  private activeTranscription?: { token: number; sessionId: string };
  private cancellationInFlight = false;
  private initialized = false;
  private disposed = false;
  private recordingStartedAt?: number;
  private recordingTimer?: ReturnType<typeof setInterval>;
  private autoStopRequested = false;

  constructor(options: SpeechWorkflowControllerOptions) {
    this.encounterId = options.encounterId;
    this.record = options.initialRecord;
    this.fixture = options.fixture;
    this.onRecordChange = options.onRecordChange;

    this.provider = options.port
      ?? (options.fixture
        ? createFakeSpeechRecognitionProvider(flowOptions(options.fixture.flow))
        : createLocalSpeechRecognitionProvider(options.capability ?? { status: "UNCONFIGURED", reason: "PROVIDER_NOT_CONFIGURED" }));
    const audit = createInMemorySpeechAuditSink();
    this.auditEvents = audit.events;
    this.service = new SpeechApplicationService({
      port: this.provider,
      runtimeMode: "local-research",
      auditSink: audit.sink,
      clock: () => new Date(initialClockTime + this.clockTick++).toISOString(),
      idFactory: this.idFactory,
    });
  }

  get audit(): readonly SpeechAuditEvent[] {
    return this.auditEvents;
  }

  get hasTemporaryAudio(): boolean {
    return this.provider.hasTemporaryAudio === true;
  }

  snapshot(): SpeechWorkflowSnapshot {
    return {
      ...(this.session === undefined ? {} : { session: this.session }),
      busy: this.busy,
      ...(this.recordingStartedAt === undefined
        ? {}
        : { recordingDurationMs: Math.max(0, Date.now() - this.recordingStartedAt) }),
      ...(this.error === undefined ? {} : { error: this.error }),
      autoAssignHistory: this.autoAssignHistory,
      selectedTarget: this.selectedTarget,
      draftTexts: { ...this.draftTexts },
      draftTargets: { ...this.draftTargets },
      expanded: this.fixture?.expanded === true || this.fixture?.flow === "expanded",
    };
  }

  subscribe(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setRecord(record: EncounterRecordPayload): void {
    this.record = record;
  }

  dispose(): void {
    const activeSession = this.session;
    this.disposed = true;
    this.listeners.clear();
    if (this.recordingTimer !== undefined) clearInterval(this.recordingTimer);
    this.recordingTimer = undefined;
    if (activeSession && ["PERMISSION_REQUIRED", "PERMISSION_DENIED", "RECORDING", "TRANSCRIBING"].includes(activeSession.status)) {
      void this.provider.cancel(activeSession.id).catch(() => undefined);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    await this.run(async () => {
      const created = this.service.createSession({
        encounterId: this.encounterId,
        autoAssignHistory: true,
      });
      this.setSession(created);

      if (this.fixture === undefined || this.fixture.flow === "permission-required") return;

      const recording = await this.service.startRecording(created);
      this.setSession(recording);
      if (recording.status !== "RECORDING") return;

      if (this.fixture.flow === "recording") return;
      if (this.fixture.flow === "cancelled") {
        this.setSession(await this.service.cancel(recording));
        return;
      }
      await this.transcribe(recording);
    });
  }

  async startRecording(): Promise<void> {
    await this.run(async () => {
      if (!this.session) return;
      this.setSession(await this.service.startRecording(this.session));
    });
  }

  async stopRecording(): Promise<void> {
    await this.run(async () => {
      if (!this.session) return;
      await this.transcribe(this.session);
    });
  }

  async cancelRecording(): Promise<void> {
    if (this.session?.status === "TRANSCRIBING" && this.activeTranscription !== undefined && this.busy) {
      await this.cancelActiveTranscription(this.session, this.activeTranscription.token);
      return;
    }
    await this.run(async () => {
      if (!this.session) return;
      this.setSession(await this.service.cancel(this.session));
    });
  }

  async retryRecording(): Promise<void> {
    await this.run(async () => {
      if (!this.session || ["FAILED", "CANCELLED"].includes(this.session.status)) {
        const created = this.service.createSession({
          encounterId: this.encounterId,
          autoAssignHistory: this.autoAssignHistory,
          ...(this.autoAssignHistory || this.selectedTarget === undefined
            ? {}
            : { selectedTarget: this.selectedTarget }),
        });
        this.setSession(created);
        return;
      }
      this.setSession(await this.service.startRecording(this.session));
    });
  }

  async startNewRecording(): Promise<void> {
    await this.run(async () => {
      if (this.session?.suggestions.some((suggestion) => suggestion.decision === "PENDING")) {
        throw new Error("请先处理当前语音建议，再开始下一段录音。");
      }
      const created = this.service.createSession({
        encounterId: this.encounterId,
        autoAssignHistory: this.autoAssignHistory,
        ...(this.autoAssignHistory || this.selectedTarget === undefined
          ? {}
          : { selectedTarget: this.selectedTarget }),
      });
      this.setSession(created);
      this.setSession(await this.service.startRecording(created));
    });
  }

  editSuggestion(suggestionId: string, text: string, target?: SpeechTarget): void {
    if (!this.session) return;
    this.draftTexts[suggestionId] = text;
    if (target === undefined) {
      delete this.draftTargets[suggestionId];
    } else {
      this.draftTargets[suggestionId] = target;
    }
    this.emit();
    if (this.busy) return;
    this.runSync(() => {
      this.setSession(this.service.editSuggestion(this.session!, suggestionId, text, target));
    });
  }

  decideSuggestion(
    suggestionId: string,
    decision: "ACCEPTED" | "IGNORED",
    target?: SpeechTarget,
  ): void {
    if (!this.session) return;
    this.runSync(() => {
      const suggestion = this.session!.suggestions.find((item) => item.id === suggestionId);
      if (!suggestion) return;
      const visibleText = this.draftTexts[suggestionId] ?? suggestion.text;
      const visibleTarget = target
        ?? this.draftTargets[suggestionId]
        ?? suggestion.target
        ?? (this.autoAssignHistory ? "presentIllness" : undefined);
      const candidate = decision === "ACCEPTED"
        ? this.service.editSuggestion(this.session!, suggestionId, visibleText, visibleTarget)
        : this.session!;
      const result = this.service.decideSuggestion(
        candidate,
        suggestionId,
        decision,
        this.record,
        decision === "ACCEPTED" ? visibleTarget : undefined,
      );
      this.setSession(result.session);
      if (decision === "ACCEPTED") {
        this.record = result.record;
        this.onRecordChange(result.record);
      }
    });
  }

  async ignorePendingAndContinue(): Promise<void> {
    await this.run(async () => {
      while (this.session) {
        const pending = this.session.suggestions.find((suggestion) => suggestion.decision === "PENDING");
        if (!pending) return;
        const result = this.service.decideSuggestion(this.session, pending.id, "IGNORED", this.record);
        this.setSession(result.session);
      }
    });
  }

  updateAssignment(autoAssignHistory: boolean): void {
    if (!this.session) return;
    this.runSync(() => {
      const pendingIds = this.session!.suggestions
        .filter((suggestion) => suggestion.decision === "PENDING")
        .map((suggestion) => suggestion.id);
      const next = this.service.updateAssignment(
        this.session!,
        autoAssignHistory,
        this.selectedTarget,
      );
      for (const suggestionId of pendingIds) delete this.draftTargets[suggestionId];
      this.setSession(next);
    });
  }

  private async transcribe(session: SpeechSession): Promise<void> {
    const token = ++this.transcriptionSequence;
    this.activeTranscription = { token, sessionId: session.id };
    try {
      const next = await this.service.stopAndTranscribe(session, (transcribing) => {
        if (this.isCurrentTranscription(token, session.id)) this.setSession(transcribing);
      });
      if (this.isCurrentTranscription(token, session.id)) this.setSession(next);
    } finally {
      if (this.activeTranscription?.token === token) this.activeTranscription = undefined;
    }
  }

  private async cancelActiveTranscription(session: SpeechSession, token: number): Promise<void> {
    if (this.disposed || this.cancellationInFlight) return;
    this.cancellationInFlight = true;
    // Invalidate the transcription continuation before awaiting the provider
    // acknowledgement. A late success/failure must not repaint the session
    // while cancellation is in flight.
    if (this.activeTranscription?.token === token) this.activeTranscription = undefined;
    this.error = undefined;
    this.emit();
    try {
      const next = await this.service.cancel(session);
      if (this.session?.id === session.id && this.session.status === "TRANSCRIBING") this.setSession(next);
    } catch (error) {
      this.error = safeWorkflowError(error);
      this.emit();
    } finally {
      this.cancellationInFlight = false;
      this.emit();
    }
  }

  private isCurrentTranscription(token: number, sessionId: string): boolean {
    return !this.disposed
      && this.activeTranscription?.token === token
      && this.activeTranscription.sessionId === sessionId
      && this.session?.id === sessionId;
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.emit();
    try {
      await operation();
    } catch (error) {
      this.error = safeWorkflowError(error);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  private runSync(operation: () => void): void {
    if (this.disposed || this.busy) return;
    this.error = undefined;
    try {
      operation();
    } catch (error) {
      this.error = safeWorkflowError(error);
      this.emit();
    }
  }

  private setSession(session: SpeechSession): void {
    const parsed = speechSessionSchema.parse(session);
    const nextDraftTexts: Record<string, string> = {};
    const nextDraftTargets: Record<string, SpeechTarget> = {};
    for (const suggestion of parsed.suggestions) {
      nextDraftTexts[suggestion.id] = this.draftTexts[suggestion.id] ?? suggestion.text;
      const target = this.draftTargets[suggestion.id] ?? suggestion.target;
      if (target !== undefined) nextDraftTargets[suggestion.id] = target;
    }
    this.draftTexts = nextDraftTexts;
    this.draftTargets = nextDraftTargets;
    this.session = parsed;
    if (parsed.status === "RECORDING") {
      this.recordingStartedAt ??= Date.now();
      this.autoStopRequested = false;
      if (this.recordingTimer === undefined) {
        this.recordingTimer = setInterval(() => {
          this.emit();
          const elapsed = Date.now() - (this.recordingStartedAt ?? Date.now());
          if (elapsed < maximumRecordingDurationMs || this.autoStopRequested || this.busy) return;
          this.autoStopRequested = true;
          void this.stopRecording();
        }, 250);
      }
    } else {
      this.recordingStartedAt = undefined;
      this.autoStopRequested = false;
      if (this.recordingTimer !== undefined) clearInterval(this.recordingTimer);
      this.recordingTimer = undefined;
    }
    this.autoAssignHistory = this.session.autoAssignHistory;
    this.selectedTarget = this.session.selectedTarget;
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

const emptySnapshot: SpeechWorkflowSnapshot = {
  busy: false,
  autoAssignHistory: true,
  draftTexts: {},
  draftTargets: {},
  expanded: false,
};

export function useSpeechWorkflow(options: {
  encounterId: string;
  record: EncounterRecordPayload;
  fixture?: SpeechPanelTestFixture;
  capability?: SpeechCapability;
  readOnly: boolean;
  onRecordChange: (record: EncounterRecordPayload) => void;
}): SpeechWorkflowView | undefined {
  const controllerRef = useRef<SpeechWorkflowController | undefined>(undefined);
  const fixtureRef = useRef<SpeechPanelTestFixture | undefined>(options.fixture);
  const recordRef = useRef(options.record);
  useEffect(() => {
    fixtureRef.current = options.fixture;
    recordRef.current = options.record;
  }, [options.fixture, options.record]);
  const fixtureKey = options.fixture === undefined
    ? ""
    : `${options.fixture.flow}:${options.fixture.expanded === true ? "expanded" : "collapsed"}`;
  const [snapshot, setSnapshot] = useState<SpeechWorkflowSnapshot>(emptySnapshot);

  useEffect(() => {
    const fixture = fixtureRef.current;
    const capability = options.capability ?? (fixture ? { status: "READY" as const } : undefined);
    if (options.readOnly || (fixture === undefined && capability?.status !== "READY")) {
      controllerRef.current = undefined;
      return;
    }

    const controller = new SpeechWorkflowController({
      encounterId: options.encounterId,
      initialRecord: recordRef.current,
      fixture,
      capability,
      onRecordChange: options.onRecordChange,
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    void controller.initialize();

    return () => {
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = undefined;
    };
  }, [fixtureKey, options.capability, options.encounterId, options.onRecordChange, options.readOnly]);

  useEffect(() => {
    controllerRef.current?.setRecord(options.record);
  }, [options.record]);

  const startRecording = useCallback(() => controllerRef.current?.startRecording() ?? Promise.resolve(), []);
  const stopRecording = useCallback(() => controllerRef.current?.stopRecording() ?? Promise.resolve(), []);
  const cancelRecording = useCallback(() => controllerRef.current?.cancelRecording() ?? Promise.resolve(), []);
  const retryRecording = useCallback(() => controllerRef.current?.retryRecording() ?? Promise.resolve(), []);
  const startNewRecording = useCallback(() => controllerRef.current?.startNewRecording() ?? Promise.resolve(), []);
  const editSuggestion = useCallback((suggestionId: string, text: string, target?: SpeechTarget) => {
    controllerRef.current?.editSuggestion(suggestionId, text, target);
  }, []);
  const decideSuggestion = useCallback((suggestionId: string, decision: "ACCEPTED" | "IGNORED", target?: SpeechTarget) => {
    controllerRef.current?.decideSuggestion(suggestionId, decision, target);
  }, []);
  const ignorePendingAndContinue = useCallback(() => controllerRef.current?.ignorePendingAndContinue() ?? Promise.resolve(), []);
  const updateAssignment = useCallback((autoAssignHistory: boolean) => {
    controllerRef.current?.updateAssignment(autoAssignHistory);
  }, []);

  const capability = options.capability ?? (options.fixture ? { status: "READY" as const } : undefined);
  if (options.readOnly || (options.fixture === undefined && capability?.status !== "READY")) return undefined;
  return {
    ...snapshot,
    suggestions: snapshot.session?.suggestions ?? [],
    startRecording,
    stopRecording,
    cancelRecording,
    retryRecording,
    startNewRecording,
    editSuggestion,
    decideSuggestion,
    ignorePendingAndContinue,
    updateAssignment,
  };
}
