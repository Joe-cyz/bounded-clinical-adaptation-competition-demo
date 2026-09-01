"use client";

import { useEffect, useRef, useState } from "react";

import {
  type SpeechCapability,
  type SpeechSessionStatus,
  type SpeechTarget,
  type TranscriptSuggestion,
} from "@/domain/speech";

import { speechFailureReasonText, type SpeechWorkflowView } from "./speech-workflow-controller";
import styles from "./medical-record-editor.module.css";

export type { SpeechPanelTestFixture } from "./speech-workflow-controller";

type SpeechPanelProps = {
  capability: SpeechCapability;
  readOnly: boolean;
  onPendingCountChange?: (count: number) => void;
  onDismissReferencePrompt?: () => void;
  onIgnorePendingAndContinue?: () => void | Promise<void>;
  referencePromptVisible?: boolean;
  workflow?: SpeechWorkflowView;
};

const targetLabels: Record<SpeechTarget, string> = {
  chiefComplaint: "主诉",
  presentIllness: "现病史",
  pastHistory: "既往史",
  personalHistory: "个人史",
  familyHistory: "家族史",
  allergyHistory: "过敏史",
  currentMedications: "当前用药",
  problemFacts: "问题事实",
  recentChanges: "近期变化",
  redFlags: "危险信号",
  generalCondition: "一般情况",
  specialtyExam: "专科体格检查",
  notExaminedOrUnknown: "未检查/未知项",
  laboratory: "实验室检查",
  electrocardiogram: "心电检查",
  imaging: "影像检查",
  other: "其他辅助检查",
  missingInformation: "待补充事项",
};

const targetOptions = Object.entries(targetLabels) as Array<[SpeechTarget, string]>;

function statusText(status: SpeechSessionStatus): string {
  switch (status) {
    case "PERMISSION_REQUIRED": return "需要麦克风权限";
    case "PERMISSION_DENIED": return "麦克风权限被拒绝";
    case "RECORDING": return "录音中";
    case "TRANSCRIBING": return "正在转写";
    case "NEEDS_REVIEW": return "待医生处理";
    case "PARTIALLY_ACCEPTED": return "部分已处理";
    case "ACCEPTED": return "已处理";
    case "FAILED": return "语音转写失败";
    case "CANCELLED": return "已取消";
  }
}

function confidenceText(suggestion: TranscriptSuggestion): string {
  if (suggestion.confidenceStatus === "NOT_PROVIDED" || suggestion.confidence === undefined) {
    return "未提供置信度";
  }
  if (suggestion.confidence < 0.6) return `低置信度 · ${Math.round(suggestion.confidence * 100)}%`;
  return `置信度 ${Math.round(suggestion.confidence * 100)}%`;
}

function formatRecordingDuration(durationMs: number | undefined): string {
  const seconds = Math.min(15, Math.max(0, Math.floor((durationMs ?? 0) / 1_000)));
  return `${String(seconds).padStart(2, "0")}秒`;
}

export function SpeechPanel({
  capability,
  onDismissReferencePrompt,
  onIgnorePendingAndContinue,
  onPendingCountChange,
  readOnly,
  referencePromptVisible = false,
  workflow,
}: SpeechPanelProps) {
  const [expandedOverride, setExpandedOverride] = useState<boolean>();
  const promptRef = useRef<HTMLDivElement>(null);
  const previousPromptFocus = useRef<HTMLElement | null>(null);
  const promptWasVisible = useRef(false);

  const configured = capability.status === "READY" && !readOnly;
  const capabilityLabel = capability.status === "UNSUPPORTED"
    ? "当前环境不支持"
    : capability.status === "READY"
      ? "本地语音可用"
      : "语音未配置";
  const status = workflow?.session?.status;
  const suggestions = workflow?.suggestions ?? [];
  const pendingSuggestionCount = suggestions.filter((suggestion) => suggestion.decision === "PENDING").length;
  const hasPendingSuggestions = pendingSuggestionCount > 0;
  const reviewStatus = status && ["NEEDS_REVIEW", "PARTIALLY_ACCEPTED", "ACCEPTED"].includes(status)
    ? status
    : undefined;
  const promptIsVisible = referencePromptVisible && hasPendingSuggestions;

  useEffect(() => {
    onPendingCountChange?.(pendingSuggestionCount);
  }, [onPendingCountChange, pendingSuggestionCount]);

  const expanded = expandedOverride ?? workflow?.expanded ?? false;

  useEffect(() => {
    if (promptIsVisible && !promptWasVisible.current) {
      previousPromptFocus.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      promptRef.current?.scrollIntoView({ block: "nearest" });
      promptRef.current?.focus();
    }
    if (!promptIsVisible && promptWasVisible.current) {
      if (previousPromptFocus.current?.isConnected) previousPromptFocus.current.focus();
      previousPromptFocus.current = null;
    }
    promptWasVisible.current = promptIsVisible;
  }, [promptIsVisible]);

  function updateSuggestionText(suggestion: TranscriptSuggestion, text: string): void {
    if (!workflow) return;
    const target = workflow.draftTargets[suggestion.id]
      ?? suggestion.target
      ?? (workflow.autoAssignHistory ? "presentIllness" : undefined);
    workflow.editSuggestion(suggestion.id, text, target);
  }

  function updateSuggestionTarget(suggestion: TranscriptSuggestion, target: SpeechTarget): void {
    const text = workflow?.draftTexts[suggestion.id] ?? suggestion.text;
    workflow?.editSuggestion(suggestion.id, text, target);
  }

  async function ignorePendingAndContinue(): Promise<void> {
    if (!workflow) return;
    await workflow.ignorePendingAndContinue();
    onIgnorePendingAndContinue?.();
  }

  return (
    <aside className={styles.voicePanel} aria-labelledby="voice-title">
      <div className={styles.voiceHeader}>
        <h2 id="voice-title">语音录入</h2>
        <span className={styles.unconfigured}>{capabilityLabel}</span>
      </div>

      {configured && workflow && status !== undefined && status !== "CANCELLED" && (
        <div className={styles.speechStatus} role="status" aria-live="polite">
          <span>{statusText(status)}</span>
          {status === "RECORDING" && (
            <>
              <span className={styles.speechStatusDetail}>
                {formatRecordingDuration(workflow.recordingDurationMs)} · 最长15秒，将自动停止
              </span>
              <span className={styles.speechStatusDetail}>录音仅用于本次转写，停止、取消或失败后删除。</span>
            </>
          )}
        </div>
      )}

      {configured && workflow && (status === undefined || status === "PERMISSION_REQUIRED" || status === "PERMISSION_DENIED") && (
        <div className={styles.speechControls}>
          {status === "PERMISSION_DENIED" && <p className={styles.speechError}>麦克风权限未授予，仍可继续手动录入。</p>}
          <button
            className={styles.speechPrimaryButton}
            disabled={workflow.busy}
            type="button"
            onClick={() => void (status === "PERMISSION_DENIED" ? workflow.retryRecording() : workflow.startRecording())}
          >
            {status === "PERMISSION_DENIED" ? "重新请求权限" : "开始录音"}
          </button>
        </div>
      )}

      {configured && workflow && status === "RECORDING" && (
        <div className={styles.speechControls}>
          <button className={styles.speechPrimaryButton} disabled={workflow.busy} type="button" onClick={() => void workflow.stopRecording()}>停止录音</button>
          <button className={styles.speechTextButton} disabled={workflow.busy} type="button" onClick={() => void workflow.cancelRecording()}>取消</button>
        </div>
      )}

      {configured && workflow && status === "TRANSCRIBING" && (
        <div className={styles.speechControls}>
          <span className={styles.speechBusy}>正在转写，请稍候。</span>
          <button className={styles.speechTextButton} type="button" onClick={() => void workflow.cancelRecording()}>取消</button>
        </div>
      )}

      {configured && workflow && status === "FAILED" && (
        <div className={styles.speechControls}>
          <p className={styles.speechError}>{speechFailureReasonText(workflow.session?.failureReason)}</p>
          <button className={styles.speechTextButton} disabled={workflow.busy} type="button" onClick={() => void workflow.retryRecording()}>重新开始</button>
        </div>
      )}

      {configured && workflow && status === "CANCELLED" && (
        <div className={styles.speechControls}>
          <p className={styles.speechMuted}>本次语音已取消，原病历内容未改变。</p>
          <button className={styles.speechTextButton} disabled={workflow.busy} type="button" onClick={() => void workflow.retryRecording()}>重新开始</button>
        </div>
      )}

      {configured && workflow && (reviewStatus !== undefined || suggestions.length > 0) && (
        <details className={styles.recognitionResult} open={expanded} onToggle={(event) => setExpandedOverride(event.currentTarget.open)}>
          <summary>
            <span>识别结果</span><span aria-label="识别结果数量">（{suggestions.length}）</span>
          </summary>
          <div className={styles.speechReviewHeader}>
            <span>{reviewStatus === "ACCEPTED" ? "识别结果已处理" : hasPendingSuggestions ? "识别结果需医生确认" : "识别结果已处理"}</span>
            {status === "PARTIALLY_ACCEPTED" && <strong>仍有 {pendingSuggestionCount} 条待处理</strong>}
          </div>
          <div className={styles.speechSuggestionList}>
            {suggestions.map((suggestion, index) => {
              const target = workflow.draftTargets[suggestion.id]
                ?? suggestion.target
                ?? (workflow.autoAssignHistory ? "presentIllness" : undefined);
              const processed = suggestion.decision !== "PENDING";
              const draftText = workflow.draftTexts[suggestion.id] ?? suggestion.text;
              return (
                <article className={styles.speechSuggestion} key={suggestion.id}>
                  <div className={styles.speechSuggestionMeta}>
                    <span>语音建议 {index + 1}</span>
                    <span>{target ? `归入：${targetLabels[target]}` : "请选择归入栏目"}</span>
                  </div>
                  {!workflow.autoAssignHistory && !processed && (
                    <label className={styles.speechTargetField}>
                      <span>归入栏目</span>
                      <select
                        aria-label={`语音建议 ${index + 1}归入栏目`}
                        value={target ?? ""}
                        onChange={(event) => updateSuggestionTarget(suggestion, event.target.value as SpeechTarget)}
                      >
                        <option value="" disabled>请选择</option>
                        {targetOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                  )}
                  <textarea
                    aria-label={`语音建议 ${index + 1}`}
                    className={styles.speechSuggestionText}
                    disabled={processed || workflow.busy}
                    value={draftText}
                    onChange={(event) => updateSuggestionText(suggestion, event.target.value)}
                  />
                  <div className={styles.speechSuggestionFooter}>
                    <span className={suggestion.confidenceStatus === "PROVIDED" && (suggestion.confidence ?? 1) < 0.6 ? styles.speechLowConfidence : styles.speechConfidence}>
                      {confidenceText(suggestion)}
                    </span>
                    {suggestion.decision === "PENDING" ? (
                      <span className={styles.speechSuggestionActions}>
                        <button
                          className={styles.speechWriteButton}
                          disabled={workflow.busy}
                          type="button"
                          onClick={() => workflow.decideSuggestion(suggestion.id, "ACCEPTED", target)}
                        >写入</button>
                        <button className={styles.speechTextButton} disabled={workflow.busy} type="button" onClick={() => workflow.decideSuggestion(suggestion.id, "IGNORED")}>忽略</button>
                      </span>
                    ) : (
                      <span className={styles.speechProcessed}>{suggestion.decision === "ACCEPTED" ? "已写入" : "已忽略"}</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </details>
      )}

      {workflow?.error && <p className={styles.speechError} role="alert">{workflow.error}</p>}

      {promptIsVisible && (
        <div
          ref={promptRef}
          aria-label="未处理语音建议"
          aria-live="assertive"
          className={styles.speechPendingPrompt}
          role="status"
          tabIndex={-1}
        >
          <strong>仍有 {pendingSuggestionCount} 条识别结果未处理</strong>
          <div className={styles.speechPromptActions}>
            <button className={styles.speechTextButton} type="button" onClick={onDismissReferencePrompt}>返回处理</button>
            <button className={styles.speechWriteButton} disabled={workflow?.busy} type="button" onClick={() => void ignorePendingAndContinue()}>忽略并继续</button>
          </div>
        </div>
      )}

      {!configured && (
        <details className={styles.recognitionResult}>
          <summary>
            <span>识别结果</span><span aria-label="识别结果数量">（0）</span>
          </summary>
          <p>当前未配置语音转写服务，手动录入仍可用。</p>
        </details>
      )}

      <label className={styles.disabledVoiceControl}>
        <input
          aria-label="自动归入病史"
          checked={workflow?.autoAssignHistory ?? true}
          disabled={!configured || workflow === undefined || workflow.busy}
          type="checkbox"
          onChange={(event) => workflow?.updateAssignment(event.target.checked)}
        />
        <span>自动归入病史</span>
        {!configured && <small>未配置</small>}
      </label>
    </aside>
  );
}
