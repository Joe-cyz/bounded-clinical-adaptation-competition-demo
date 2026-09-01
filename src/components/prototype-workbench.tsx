"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";

import {
  confirmCandidateAction,
  dismissCandidateAction,
  reviewFeedbackAction,
  runGenerationAction,
  saveDraftRevisionAction,
} from "@/app/workbench/actions";
import type {
  GenerationAttemptResult,
  GenerationComparisonResult,
  GenerationFailure,
  GenerationProviderSummary,
} from "@/application/generation-service";
import type { DraftRevisionSummary, SaveDraftRevisionResult } from "@/application/draft-revision-service";
import { physicianProfiles, syntheticCases } from "@/data/demo";
import { computeDraftDiff, type DraftRevisionSectionInput } from "@/domain/draft-revisions";
import type { GeneratedDraft } from "@/domain/schemas";
import type { FeedbackEventRecord } from "@/domain/runtime-records";
import type { ProviderCapabilities, ProviderSelection } from "@/domain/provider";

const statusLabels = {
  IDLE: "尚未运行",
  RUNNING: "运行中",
  SUCCEEDED: "两侧成功",
  PARTIAL_FAILURE: "部分失败",
  FAILED: "运行失败",
  NOT_RUN: "未运行",
} as const;

const mockModeOptions = [
  ["SUCCESS", "成功基线"],
  ["INVALID_JSON", "格式错误演示（模拟故障）"],
  ["TIMEOUT", "超时演示（模拟故障）"],
  ["PROVIDER_ERROR", "Provider 错误演示（模拟故障）"],
  ["INVALID_OUTPUT_RULE", "输出规则失败演示（模拟故障）"],
  ["INVALID_OUTPUT_FACT", "虚构事实演示（模拟故障）"],
  ["INVALID_OUTPUT_PROHIBITED_ACTION", "禁止动作演示（模拟故障）"],
  ["INVALID_OUTPUT_PII", "疑似 PII 演示（模拟故障）"],
  ["INVALID_OUTPUT_DUPLICATE", "重复栏目演示（模拟故障）"],
  ["INVALID_OUTPUT_ORDER", "错误顺序演示（模拟故障）"],
] as const;

type MockMode = (typeof mockModeOptions)[number][0];
type WorkbenchState = "IDLE" | "RUNNING" | "SUCCEEDED" | "PARTIAL_FAILURE" | "FAILED";
type SubmittedInputSnapshot = { caseId: string; profileId: string; mockMode: MockMode; providerSelection: ProviderSelection };

function createTransportFailureResult(): GenerationComparisonResult {
  const provider: GenerationProviderSummary = {
    id: "unavailable",
    modelId: "unavailable",
    promptVersion: "unavailable",
  };
  const error: GenerationFailure = {
    ruleId: "GENERATION_TRANSPORT_ERROR",
    errorType: "TRANSPORT",
    message: "生成请求未完成，未返回服务端结果。",
    persisted: false,
  };
  return {
    requestId: "transport-unavailable",
    status: "FAILED",
    provider,
    generic: { mode: "GENERIC", status: "NOT_RUN", provider, error },
    bounded: { mode: "BOUNDED", status: "NOT_RUN", provider, error },
  };
}

function DraftPanel({ title, subtitle, draft }: { title: string; subtitle: string; draft: GeneratedDraft }) {
  return (
    <article className="draft-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{subtitle}</p>
          <h3>{title}</h3>
        </div>
        <span className="status status-safe">结构与规则校验通过</span>
      </div>

      <div className="draft-sections">
        {draft.sections.map((section, index) => (
          <section className={section.mandatory ? "draft-section mandatory" : "draft-section"} key={section.key}>
            <div className="section-title-row">
              <span className="section-index">{String(index + 1).padStart(2, "0")}</span>
              <h4>{section.title}</h4>
              {section.mandatory ? <span className="required-label">机构必填</span> : null}
            </div>
            <ul>
              {section.content.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}

const feedbackStatusLabels = {
  CANDIDATE: "待确认候选",
  HELD_FOR_REVIEW: "待审核",
  REJECTED: "已拒绝",
} as const;

const feedbackRiskLabels = {
  LOW: "低风险",
  MEDIUM: "中风险",
  HIGH: "高风险",
  UNCERTAIN: "不确定",
} as const;

function FeedbackLifecyclePanel({ events, readOnly }: { events: FeedbackEventRecord[]; readOnly: boolean }) {
  const [decisionState, setDecisionState] = useState<Record<string, { label: string; profileVersion?: number }>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActionPending, startAction] = useTransition();

  function runFeedbackAction(action: () => Promise<unknown>, eventId: string, successLabel: string) {
    setActionError(null);
    startAction(async () => {
      try {
        const response = await action() as { ok: boolean; ruleId?: string; message?: string; profileVersion?: { version: number } };
        if (!response.ok) {
          setActionError(`${response.ruleId ?? "FEEDBACK_ACTION_FAILED"} · ${response.message ?? "反馈动作未完成。"}`);
          return;
        }
        setDecisionState((current) => ({
          ...current,
          [eventId]: { label: successLabel, ...(response.profileVersion ? { profileVersion: response.profileVersion.version } : {}) },
        }));
      } catch {
        setActionError("FEEDBACK_TRANSPORT_ERROR · 反馈请求未完成，未更新界面状态。");
      }
    });
  }

  if (events.length === 0) return null;

  return (
    <section className="feedback-lifecycle-panel" aria-label="真实修订派生反馈">
      <div className="editor-history-heading">
        <strong>真实修订派生反馈</strong>
        <span>模拟角色，不是生产认证</span>
      </div>
      <p className="editor-boundary">反馈来自本次 revision 的栏目/行差异；内容编辑不会自动解释成偏好。中风险审核批准不等于“已学习”。</p>
      <div className="feedback-result-list">
        {events.map((event) => {
          const localDecision = decisionState[event.id];
          const reason = reasons[event.id] ?? "";
          return (
            <article className={`feedback-result-card risk-${event.riskLevel.toLowerCase()}`} key={event.id}>
              <div className="feedback-result-top">
                <strong>{feedbackRiskLabels[event.riskLevel]}</strong>
                <span>{localDecision?.label ?? feedbackStatusLabels[event.status]}</span>
                <Link href={`/audit?runId=${encodeURIComponent(event.generationRunId)}`}>审计链路</Link>
              </div>
              <dl className="feedback-result-meta">
                <div><dt>变化类型</dt><dd>{event.changeType}</dd></div>
                <div><dt>受影响字段</dt><dd>{event.affectedField}</dd></div>
                <div><dt>规则版本</dt><dd>{event.rulesVersion}</dd></div>
                <div><dt>画像</dt><dd><Link href={`/profiles?profileId=${encodeURIComponent(event.profileId)}`}>{event.profileId}@v{event.profileVersion}</Link></dd></div>
              </dl>
              <div className="rule-hits">{event.ruleHits.map((rule) => <code key={rule}>{rule}</code>)}</div>
              <p>{event.safetyReason}</p>
              <small>证据：{event.evidence.operationCount} 个操作 · 新增/删除 {event.evidence.addedCharacterCount}/{event.evidence.removedCharacterCount} 字符</small>
              {localDecision?.profileVersion ? <strong>已创建画像版本 v{localDecision.profileVersion}</strong> : null}

              {event.riskLevel === "LOW" && event.status === "CANDIDATE" && !localDecision ? (
                <div className="feedback-actions">
                  <span>模拟医生确认：</span>
                  <button type="button" onClick={() => runFeedbackAction(
                    () => confirmCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: event.profileVersion }),
                    event.id,
                    "候选已确认",
                  )} disabled={isActionPending || readOnly}>确认候选</button>
                  <button type="button" onClick={() => runFeedbackAction(
                    () => dismissCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: event.profileVersion }),
                    event.id,
                    "候选已放弃",
                  )} disabled={isActionPending || readOnly}>放弃候选</button>
                </div>
              ) : null}

              {(event.riskLevel === "MEDIUM" || event.riskLevel === "UNCERTAIN") && event.status === "HELD_FOR_REVIEW" && !localDecision ? (
                <div className="feedback-actions feedback-review-actions">
                  <label>
                    <span>模拟审核理由</span>
                    <textarea value={reason} onChange={(input) => setReasons((current) => ({ ...current, [event.id]: input.target.value }))} maxLength={500} rows={2} disabled={isActionPending || readOnly} />
                  </label>
                  <div>
                    <button type="button" onClick={() => runFeedbackAction(
                      () => reviewFeedbackAction({ feedbackEventId: event.id, decision: "APPROVE", rationale: reason }),
                      event.id,
                      "审核已批准（未写入画像）",
                    )} disabled={isActionPending || readOnly || reason.trim().length === 0}>审核批准</button>
                    <button type="button" onClick={() => runFeedbackAction(
                      () => reviewFeedbackAction({ feedbackEventId: event.id, decision: "REJECT", rationale: reason }),
                      event.id,
                      "审核已拒绝",
                    )} disabled={isActionPending || readOnly || reason.trim().length === 0}>审核拒绝</button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {actionError ? <div className="attempt-error editor-error" role="alert"><strong>{actionError.split(" · ")[0]}</strong><span>{actionError.split(" · ").slice(1).join(" · ")}</span></div> : null}
    </section>
  );
}

function StructuredDraftEditor({ draft, readOnly }: { draft: GeneratedDraft; readOnly: boolean }) {
  const [baseline, setBaseline] = useState(draft);
  const [sections, setSections] = useState<DraftRevisionSectionInput[]>(() => draft.sections.map((section) => ({
    key: section.key,
    content: [...section.content],
  })));
  const [revisionNumber, setRevisionNumber] = useState(0);
  const [history, setHistory] = useState<DraftRevisionSummary[]>([]);
  const [feedbackEvents, setFeedbackEvents] = useState<FeedbackEventRecord[]>([]);
  const [saveState, setSaveState] = useState<"IDLE" | "SAVING" | "SAVED" | "ERROR">("IDLE");
  const [saveError, setSaveError] = useState<Extract<SaveDraftRevisionResult, { ok: false }> | null>(null);
  const [isPending, startTransition] = useTransition();

  const baselineByKey = new Map(baseline.sections.map((section) => [section.key, section]));
  const editedDraft: GeneratedDraft = {
    ...baseline,
    sections: sections.map((editableSection) => ({
      ...baselineByKey.get(editableSection.key)!,
      content: editableSection.content,
    })),
  };
  const diff = computeDraftDiff(baseline, editedDraft);
  const hasChanges = diff.metrics.changedSectionCount > 0 || diff.orderChanged;

  function updateSection(index: number, value: string) {
    setSections((current) => current.map((section, sectionIndex) => sectionIndex === index
      ? { ...section, content: value.split(/\r?\n/gu) }
      : section));
    setSaveState("IDLE");
    setSaveError(null);
  }

  function moveSection(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sections.length) return;
    setSections((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
    setSaveState("IDLE");
    setSaveError(null);
  }

  function saveRevision() {
    if (isPending || saveState === "SAVING" || !hasChanges) return;
    setSaveState("SAVING");
    setSaveError(null);
    startTransition(async () => {
      try {
        const nextResult = await saveDraftRevisionAction({
          generationRunId: draft.runId,
          ...(revisionNumber > 0 ? { expectedPreviousRevision: revisionNumber } : {}),
          sections,
        });
        if (!nextResult.ok) {
          if (nextResult.feedbackEvents) setFeedbackEvents(nextResult.feedbackEvents);
          setSaveState("ERROR");
          setSaveError(nextResult);
          return;
        }
        setBaseline(nextResult.revision.afterSnapshot);
        setSections(nextResult.revision.afterSnapshot.sections.map((section) => ({
          key: section.key,
          content: [...section.content],
        })));
        setRevisionNumber(nextResult.revision.revisionNumber);
        setHistory(nextResult.history);
        setFeedbackEvents(nextResult.feedbackEvents);
        setSaveState("SAVED");
      } catch {
        setSaveState("ERROR");
        setSaveError({
          ok: false,
          ruleId: "REVISION_TRANSPORT_ERROR",
          message: "修订请求未完成，未返回服务端结果。",
          auditPersisted: false,
        });
      }
    });
  }

  return (
    <section className="structured-editor" aria-labelledby={`structured-editor-${draft.runId}`}>
      <div className="editor-heading">
        <div>
          <p className="eyebrow">STRUCTURED EDITING · BOUNDED ONLY</p>
          <h4 id={`structured-editor-${draft.runId}`}>适配草稿结构化修订</h4>
        </div>
        <span className="status status-safe">待反馈门控</span>
      </div>
      <p className="editor-boundary">
        客户端只提交栏目 key 与 content；服务端从可信快照重建元数据。修订已保存但尚未通过反馈门控，不会自动更新画像。
      </p>

      <div className="structured-editor-sections">
        {sections.map((editableSection, index) => {
          const section = baselineByKey.get(editableSection.key)!;
          return (
          <fieldset className={section.mandatory ? "editor-section editor-section-mandatory" : "editor-section"} key={section.key}>
            <span className="editor-section-heading">
              <strong>{section.title}</strong>
              <small>{section.mandatory ? "强制 · 可编辑内容" : "可编辑内容"}</small>
            </span>
            <span className="editor-order-controls">
              <button type="button" className="editor-order-button" onClick={() => moveSection(index, -1)} disabled={readOnly || index === 0 || isPending} aria-label={`${section.title}上移`}>↑</button>
              <button type="button" className="editor-order-button" onClick={() => moveSection(index, 1)} disabled={readOnly || index === sections.length - 1 || isPending} aria-label={`${section.title}下移`}>↓</button>
            </span>
            <textarea
              aria-label={`${section.title}修订内容`}
              readOnly={readOnly || section.key === "draftDisclaimer"}
              value={editableSection.content.join("\n")}
              onChange={(event) => updateSection(index, event.target.value)}
              rows={Math.min(8, Math.max(3, editableSection.content.length))}
            />
            {section.key === "draftDisclaimer" ? <small className="editor-readonly-note">免责声明只读，不能修改。</small> : null}
          </fieldset>
          );
        })}
      </div>

      <div className="editor-diff-summary">
        <div><span>变化栏目</span><strong>{diff.metrics.changedSectionCount}</strong></div>
        <div><span>新增/删除行</span><strong>{diff.metrics.addedLineCount} / {diff.metrics.removedLineCount}</strong></div>
        <div><span>新增/删除字符</span><strong>{diff.metrics.addedCharacterCount} / {diff.metrics.removedCharacterCount}</strong></div>
        <div><span>编辑负担</span><strong>{(diff.metrics.editBurdenRatio * 100).toFixed(2)}%</strong></div>
      </div>
      {diff.changedSections.length > 0 || diff.orderChanged ? (
        <ul className="editor-diff-list" aria-label="未保存字段级差异">
          {diff.orderChanged ? <li><code>sectionOrder</code><span>栏目顺序变化</span></li> : null}
          {diff.changedSections.map((section) => <li key={section.key}><code>{section.key}</code><span>{section.operations.length} 行操作</span></li>)}
        </ul>
      ) : <p className="editor-no-change">当前没有未保存变化。</p>}

      <div className="editor-actions">
        <button type="button" className="primary-action" onClick={saveRevision} disabled={readOnly || isPending || saveState === "SAVING" || !hasChanges}>
          {isPending || saveState === "SAVING" ? "保存中…" : "保存结构化修订"}
        </button>
        {saveState === "SAVED" ? <span className="editor-success">修订 #{revisionNumber} 已保存。</span> : null}
      </div>

      {saveError ? (
        <div className="attempt-error editor-error" role="alert">
          <strong>{saveError.ruleId}</strong>
          <span>{saveError.message}</span>
          {saveError.details?.map((detail) => (
            <code key={`${detail.ruleId}:${detail.fieldPath ?? ""}`}>{detail.ruleId}{detail.fieldPath ? ` · ${detail.fieldPath}` : ""}</code>
          ))}
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="editor-history">
          <strong>修订历史</strong>
          {history.map((summary) => (
            <Link key={summary.id} href={`/audit?runId=${encodeURIComponent(draft.runId)}#revision-${summary.id}`}>#{summary.revisionNumber} · {summary.id} · {summary.createdAt} · {summary.changedSectionCount} 栏目 · 负担 {(summary.editBurdenRatio * 100).toFixed(2)}%</Link>
          ))}
        </div>
      ) : null}
      <FeedbackLifecyclePanel events={feedbackEvents} readOnly={readOnly} />
    </section>
  );
}

function AttemptPanel({
  title,
  subtitle,
  attempt,
  editable = false,
  readOnly = false,
}: {
  title: string;
  subtitle: string;
  attempt: GenerationAttemptResult;
  editable?: boolean;
  readOnly?: boolean;
}) {
  return (
    <article className={`generation-attempt generation-attempt-${attempt.status.toLowerCase()}`}>
      <div className="panel-heading generation-attempt-heading">
        <div>
          <p className="eyebrow">{subtitle}</p>
          <h3>{title}</h3>
        </div>
        <span className={attempt.status === "SUCCEEDED" ? "status status-safe" : "status status-blocked"}>
          {statusLabels[attempt.status]}
        </span>
      </div>

      <details className="generation-evidence">
        <summary>查看运行与配置证据</summary>
        <dl className="generation-meta">
          <div><dt>run ID</dt><dd>{attempt.runId ? <Link href={`/audit?runId=${encodeURIComponent(attempt.runId)}`}>{attempt.runId}</Link> : "—"}</dd></div>
          <div><dt>provider</dt><dd>{attempt.provider.id}</dd></div>
          <div><dt>执行类型 / 网络</dt><dd>{attempt.provider.executionType ?? "MOCK"} · {attempt.provider.networkCall ? "网络" : "无网络"}</dd></div>
          <div><dt>model</dt><dd>{attempt.provider.modelId}</dd></div>
          <div><dt>prompt</dt><dd>{attempt.provider.promptVersion}</dd></div>
          <div><dt>配置键</dt><dd>{attempt.configurationKey ?? "前置阻断，未编译"}</dd></div>
        </dl>
      </details>

      {attempt.status === "SUCCEEDED" && attempt.draft ? (
        <>
          <DraftPanel title={title} subtitle={`${attempt.mode} · 已持久化`} draft={attempt.draft} />
          {editable ? <StructuredDraftEditor key={attempt.draft.runId} draft={attempt.draft} readOnly={readOnly} /> : null}
        </>
      ) : attempt.error ? (
        <div className="attempt-error" role="alert">
          <strong>{attempt.error.ruleId}</strong>
          <span>错误类型：{attempt.error.errorType}</span>
          <span>{attempt.error.message}</span>
          <small>
            {attempt.error.persisted
              ? "失败运行和审计事件已原子写入。"
              : "未形成成功结果；请检查服务端持久化状态。"}
          </small>
          {attempt.error.ruleIds?.length ? (
            <div className="rule-hits" aria-label="规则 ID">
              {attempt.error.ruleIds.map((rule) => <code key={rule}>{rule}</code>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function RunSummary({
  state,
  result,
  submittedInput,
  readOnly,
}: {
  state: WorkbenchState;
  result: GenerationComparisonResult | null;
  submittedInput: SubmittedInputSnapshot | null;
  readOnly: boolean;
}) {
  return (
    <section className="generation-run-panel" aria-live="polite" aria-labelledby="generation-run-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">AUDITED SERVER WORKFLOW</p>
          <h2 id="generation-run-title">运行状态与公平对照</h2>
        </div>
        <div className={`run-state run-state-${state.toLowerCase()}`}>
          <span>{state === "IDLE" || state === "RUNNING" ? "状态" : "终态"}</span>
          <strong>{statusLabels[state]}</strong>
        </div>
      </div>

      {result ? (
        <>
          <div className="run-summary-meta">
            <span>request ID：{result.requestId}</span>
            <Link href={`/audit?entityType=GENERATION_REQUEST&entityId=${encodeURIComponent(result.requestId)}`}>查看 request 审计</Link>
            <span>provider：{result.provider.id}</span>
            <span>model：{result.provider.modelId}</span>
            <span>prompt：{result.provider.promptVersion}</span>
            {submittedInput ? (
              <small>
                本次提交快照：病例 {submittedInput.caseId} · 画像 <Link href={`/profiles?profileId=${encodeURIComponent(submittedInput.profileId)}`}>{submittedInput.profileId}</Link> · {submittedInput.providerSelection} · Mock {submittedInput.mockMode}
              </small>
            ) : null}
            {result.shared ? (
              <small>
                共享病例 {result.shared.caseId}@{result.shared.caseVersion} · 数据集 {result.shared.datasetVersion} · 安全核心 {result.shared.safetyCoreId}@{result.shared.safetyCoreVersion} · 策略 {result.shared.policyId}@{result.shared.policyVersion}
              </small>
            ) : null}
          </div>
          <div className="generation-attempt-grid">
            <AttemptPanel title="医院通用草稿" subtitle="GENERIC CONFIGURATION" attempt={result.generic} readOnly={readOnly} />
            <AttemptPanel title="受约束适配草稿" subtitle="BOUNDED CONFIGURATION" attempt={result.bounded} editable readOnly={readOnly} />
          </div>
        </>
      ) : (
        <div className="workflow-note">
          <strong>尚未提交运行</strong>
          <p>服务端会根据病例 ID 和 ACTIVE 画像 ID 重新解析版本化合成 seed，再依次执行输入校验、有效配置编译、受门控 Provider、输出规则校验、generation run 与 audit 原子持久化。</p>
        </div>
      )}
    </section>
  );
}

export function PrototypeWorkbench({ providerCapabilities }: { providerCapabilities: ProviderCapabilities }) {
  const [caseId, setCaseId] = useState(syntheticCases[0].id);
  const [profileId, setProfileId] = useState(physicianProfiles[0].id);
  const [mockMode, setMockMode] = useState<MockMode>("SUCCESS");
  const [providerSelection, setProviderSelection] = useState<ProviderSelection>("MOCK");
  const [state, setState] = useState<WorkbenchState>("IDLE");
  const [result, setResult] = useState<GenerationComparisonResult | null>(null);
  const [submittedInput, setSubmittedInput] = useState<SubmittedInputSnapshot | null>(null);
  const [isPending, startTransition] = useTransition();
  const requestSequence = useRef(0);
  const publicDemoReadOnly = providerCapabilities.publicDemoReadOnly;

  const caseData = syntheticCases.find((item) => item.id === caseId) ?? syntheticCases[0];
  const profile = physicianProfiles.find((item) => item.id === profileId) ?? physicianProfiles[0];

  function clearRun() {
    requestSequence.current += 1;
    setState("IDLE");
    setResult(null);
    setSubmittedInput(null);
  }

  function runComparison() {
    if (publicDemoReadOnly) return;
    const requestSnapshot: SubmittedInputSnapshot = { caseId, profileId, mockMode, providerSelection };
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setSubmittedInput(requestSnapshot);
    setState("RUNNING");
    setResult(null);
    startTransition(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      try {
        const nextResult = await runGenerationAction(requestSnapshot);
        if (sequence !== requestSequence.current) return;
        setResult(nextResult);
        setState(nextResult.status);
      } catch {
        if (sequence !== requestSequence.current) return;
        setResult(createTransportFailureResult());
        setState("FAILED");
      }
    });
  }

  const runIsActive = isPending || state === "RUNNING";

  return (
    <main>
      <section className="hero workbench-hero">
        <div className="hero-copy">
          <div className="hero-kicker"><span /> WORKBENCH · Mock 默认 / DeepSeek 本机门控</div>
          <h1>运行一次公平对照，<br />保留每一步边界。</h1>
          <p>
            同一版本化合成病例、同一安全核心和同一 provider，只允许 WP-04 定义的呈现适配差异。默认不发起网络请求；DeepSeek 仅在服务端本机门控通过时可选，也不写回真实系统。
          </p>
          {publicDemoReadOnly ? <div className="review-boundary-strip"><strong>公开只读演示</strong><span>仅可读取安全数据；生成、编辑、反馈决定和画像更新已关闭。</span></div> : null}
        </div>
        <div className="principle-card">
          <p>当前边界</p>
          <strong>Mock by default.<br />Human review required.</strong>
          <span>仅合成数据 · 临床前技术原型 · 需人工复核</span>
        </div>
      </section>

      <section className="metrics" aria-label="workbench metrics">
        <div><span>模拟病例</span><strong>{syntheticCases.length}</strong><small>版本化合成 seed</small></div>
        <div><span>医生画像</span><strong>{physicianProfiles.length}</strong><small>仅使用 ACTIVE 画像</small></div>
          <div><span>当前 provider</span><strong>{providerSelection === "DEEPSEEK" ? "DeepSeek" : "Mock"}</strong><small>{providerSelection === "DEEPSEEK" ? "REAL · 本机门控" : "MOCK · 无网络、无密钥"}</small></div>
        <div><span>对照模式</span><strong>2×</strong><small>GENERIC / BOUNDED</small></div>
      </section>

      <section className="workbench-shell">
        <div className="section-heading">
          <div>
            <p className="eyebrow">SELECT VERSIONED INPUTS</p>
            <h2>选择病例与画像，显式启动运行</h2>
          </div>
          <p>选择变化会清除旧结果；运行中禁止重复提交。场景选择仅用于确定性故障演示。</p>
        </div>

        <div className="controls run-controls">
          <label>
            <span>模拟病例</span>
            <select disabled={publicDemoReadOnly || runIsActive} value={caseId} onChange={(event) => { setCaseId(event.target.value); clearRun(); }}>
              {syntheticCases.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>)}
            </select>
          </label>
          <label>
            <span>医生画像</span>
            <select disabled={publicDemoReadOnly || runIsActive} value={profileId} onChange={(event) => { setProfileId(event.target.value); clearRun(); }}>
              {physicianProfiles.map((item) => <option key={item.id} value={item.id}>{item.displayName} · v{item.version}</option>)}
            </select>
          </label>
          <label>
            <span>Provider 入口</span>
            <select disabled={publicDemoReadOnly || runIsActive} value={providerSelection} onChange={(event) => { setProviderSelection(event.target.value as ProviderSelection); clearRun(); }}>
              <option value="MOCK">确定性 Mock（无网络）</option>
              {!publicDemoReadOnly ? <option value="DEEPSEEK" disabled={!providerCapabilities.deepseek.available}>DeepSeek（{providerCapabilities.deepseek.available ? "本机研究" : "未启用"}）</option> : null}
            </select>
          </label>
          <label>
            <span>Mock 场景</span>
            <select disabled={publicDemoReadOnly || runIsActive || providerSelection === "DEEPSEEK"} value={mockMode} onChange={(event) => { setMockMode(event.target.value as MockMode); clearRun(); }}>
              {mockModeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <div className="case-meta">
            <span>{caseData.specialty}</span>
            <span>{caseData.visitType}</span>
            <span>ACTIVE · v{profile.version}</span>
          </div>
          <button type="button" className="primary-action" data-testid="run-generation" onClick={runComparison} disabled={publicDemoReadOnly || runIsActive}>
            {runIsActive ? "运行中…" : "运行公平对照"}
          </button>
          <small>运行模式：{providerCapabilities.runtimeMode}</small>
          <small>{publicDemoReadOnly ? "PUBLIC_DEMO_READ_ONLY · 公开只读演示不发起 Provider 或数据库写入。" : providerSelection === "DEEPSEEK" && !providerCapabilities.deepseek.available ? "PROVIDER_REAL_DISABLED · 本机真实 Provider 未启用，未发起网络请求。" : providerCapabilities.safetyNotice}</small>
        </div>

        <RunSummary state={state} result={result} submittedInput={submittedInput} readOnly={publicDemoReadOnly} />
      </section>

      <footer>
        <p>仅合成数据 · 临床前技术原型 · 需人工复核 · 不自动诊断、处方或写回病历</p>
        <span>Bounded Clinical Adaptation · Audited Provider Workflow</span>
      </footer>
    </main>
  );
}
