"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  confirmFeedbackCandidateAction,
  dismissFeedbackCandidateAction,
  freezeProfileReviewAction,
  reviewFeedbackEventAction,
  rollbackProfileReviewAction,
} from "@/app/review/actions";
import type { SafeFeedback, SafeProfile } from "@/application/audit-review-service";

const riskLabels = {
  LOW: "低风险",
  MEDIUM: "中风险",
  UNCERTAIN: "不确定",
  HIGH: "高风险",
} as const;

const statusLabels = {
  CANDIDATE: "待确认候选",
  HELD_FOR_REVIEW: "待审核",
  REJECTED: "自动拒绝",
} as const;

function resultMessage(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return "FEEDBACK_PERSISTENCE_FAILED · 服务端未返回受控结果。";
  const typed = response as { ok?: unknown; ruleId?: unknown; message?: unknown };
  if (typed.ok === true) return undefined;
  const ruleId = typeof typed.ruleId === "string" ? typed.ruleId : "FEEDBACK_ACTION_FAILED";
  const message = typeof typed.message === "string" ? typed.message : "反馈动作未完成。";
  return `${ruleId} · ${message}`;
}

function FeedbackEvidence({ event }: { event: SafeFeedback }) {
  const evidence = event.revisionEvidence;
  return (
    <div className="review-evidence">
      <strong>安全差异证据</strong>
      {event.riskLevel === "HIGH" ? <p>高风险路径：无 DraftRevision 正文，仅保留拒绝证据。</p> : null}
      {evidence.beforeSectionOrder && evidence.afterSectionOrder ? (
        <p>栏目顺序：{evidence.beforeSectionOrder.join(" → ")} <span aria-hidden="true">→</span> {evidence.afterSectionOrder.join(" → ")}</p>
      ) : null}
      {evidence.changedSectionKey ? <p>栏目：<code>{evidence.changedSectionKey}</code></p> : null}
      {evidence.operations.length > 0 ? (
        <ul>
          {evidence.operations.map((operation, index) => (
            <li key={`${operation.index}-${index}`}>
              <code>{operation.operation} · line {operation.index}</code>
              {operation.before !== undefined ? <span>前：{operation.before}</span> : null}
              {operation.after !== undefined ? <span>后：{operation.after}</span> : null}
            </li>
          ))}
        </ul>
      ) : <p>仅保存聚合计数，未找到可展示的栏目行操作。</p>}
      {evidence.redacted ? <small>差异文本命中隐私规则，已隐藏正文。</small> : null}
    </div>
  );
}

export function FeedbackQueue({ events, publicDemoReadOnly }: { events: SafeFeedback[]; publicDemoReadOnly: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  function runAction(eventId: string, action: () => Promise<unknown>) {
    setMessages((current) => ({ ...current, [eventId]: "请求处理中…" }));
    startTransition(async () => {
      try {
        const response = await action();
        const error = resultMessage(response);
        if (error) {
          setMessages((current) => ({ ...current, [eventId]: error }));
          return;
        }
        setMessages((current) => ({ ...current, [eventId]: "服务端已提交，正在刷新真实状态…" }));
        router.refresh();
      } catch {
        setMessages((current) => ({ ...current, [eventId]: "FEEDBACK_TRANSPORT_ERROR · 请求未完成，页面状态未修改。" }));
      }
    });
  }

  if (events.length === 0) {
    return <div className="review-empty" role="status">当前筛选下没有持久化反馈事件。生成一次 BOUNDED 草稿并保存结构化修订后，事件会出现在这里。</div>;
  }

  return (
    <div className="review-event-list">
      {events.map((event) => {
        const reason = reasons[event.id] ?? "";
        const decided = event.decisionRecord !== undefined;
        const message = messages[event.id];
        return (
          <article className={`review-event-card risk-${event.riskLevel.toLowerCase()}`} key={event.id}>
            <div className="review-event-heading">
              <div>
                <p className="eyebrow">{riskLabels[event.riskLevel]} · {event.changeType}</p>
                <h2>{statusLabels[event.status]} · {event.affectedField}</h2>
              </div>
              <span className="status status-neutral">{event.decision === "PENDING" ? "未决定" : event.decision}</span>
            </div>
            <dl className="review-event-meta">
              <div><dt>feedback ID</dt><dd><Link href={`/audit?runId=${encodeURIComponent(event.generationRunId)}`}>{event.id}</Link></dd></div>
              <div><dt>generation run</dt><dd><Link href={`/audit?runId=${encodeURIComponent(event.generationRunId)}`}>{event.generationRunId}</Link></dd></div>
              <div><dt>画像</dt><dd><Link href={`/profiles?profileId=${encodeURIComponent(event.profileId)}`}>{event.profileId}@v{event.profileVersion}</Link></dd></div>
              <div><dt>revision</dt><dd>{event.draftRevisionId ? <Link href={`/audit?runId=${encodeURIComponent(event.generationRunId)}`}>{event.draftRevisionId} · v{event.revisionNumber}</Link> : "无 DraftRevision 正文"}</dd></div>
              <div><dt>规则版本</dt><dd>{event.rulesVersion}</dd></div>
              <div><dt>创建时间</dt><dd>{event.createdAt}</dd></div>
            </dl>
            <div className="rule-hits" aria-label="命中规则">
              {event.ruleHits.map((ruleId) => <code key={ruleId}>{ruleId}</code>)}
            </div>
            <p className="review-reason">{event.safetyReason}</p>
            <p className="review-next">下一步：{event.nextAllowedActions.length > 0 ? event.nextAllowedActions.join(" / ") : "无，终态拒绝"} · 证据操作 {event.evidence.operationCount} · 字符 +{event.evidence.addedCharacterCount}/-{event.evidence.removedCharacterCount}</p>
            <FeedbackEvidence event={event} />

            {event.riskLevel === "LOW" && event.status === "CANDIDATE" && !decided ? (
              <div className="review-action-row">
                <strong>模拟医生 · 不是生产身份认证</strong>
                <button type="button" onClick={() => runAction(event.id, () => confirmFeedbackCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: event.profileVersion }))} disabled={publicDemoReadOnly || isPending}>确认候选</button>
                <button type="button" onClick={() => runAction(event.id, () => dismissFeedbackCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: event.profileVersion }))} disabled={publicDemoReadOnly || isPending}>放弃候选</button>
              </div>
            ) : null}

            {(event.riskLevel === "MEDIUM" || event.riskLevel === "UNCERTAIN") && event.status === "HELD_FOR_REVIEW" && !decided ? (
              <div className="review-action-row review-action-reviewer">
                <strong>模拟审核者 · 不是生产身份认证</strong>
                <label>
                  <span>决定理由（必填，最多 500 字）</span>
                  <textarea value={reason} maxLength={500} rows={3} disabled={publicDemoReadOnly || isPending} onChange={(input) => setReasons((current) => ({ ...current, [event.id]: input.target.value }))} />
                </label>
                <button type="button" onClick={() => runAction(event.id, () => reviewFeedbackEventAction({ feedbackEventId: event.id, decision: "APPROVE", rationale: reason }))} disabled={publicDemoReadOnly || isPending || reason.trim().length === 0}>审核批准（不写入画像）</button>
                <button type="button" onClick={() => runAction(event.id, () => reviewFeedbackEventAction({ feedbackEventId: event.id, decision: "REJECT", rationale: reason }))} disabled={publicDemoReadOnly || isPending || reason.trim().length === 0}>审核拒绝</button>
              </div>
            ) : null}

            {event.riskLevel === "HIGH" ? <p className="review-terminal">高风险终态：仅保留字段、结构计数、规则 ID 和拒绝理由；没有确认或审核按钮。</p> : null}
            {decided ? <p className="review-terminal">已存在终态决定：{event.decisionRecord?.decision} · {event.decisionRecord?.createdAt}。不可重复操作。</p> : null}
            {message ? <p className="review-action-message" role="status">{message}</p> : null}
          </article>
        );
      })}
    </div>
  );
}

function PreferenceValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <span>{value.join(" → ")}</span>;
  if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
  return <span>{String(value)}</span>;
}

export function ProfilesPanel({ profiles, focusProfileId, publicDemoReadOnly }: { profiles: SafeProfile[]; focusProfileId?: string; publicDemoReadOnly: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  function runProfileAction(profileId: string, action: () => Promise<unknown>) {
    setMessages((current) => ({ ...current, [profileId]: "请求处理中…" }));
    startTransition(async () => {
      try {
        const error = resultMessage(await action());
        if (error) {
          setMessages((current) => ({ ...current, [profileId]: error }));
          return;
        }
        setMessages((current) => ({ ...current, [profileId]: "服务端已提交，正在刷新画像历史…" }));
        router.refresh();
      } catch {
        setMessages((current) => ({ ...current, [profileId]: "FEEDBACK_TRANSPORT_ERROR · 请求未完成，页面状态未修改。" }));
      }
    });
  }

  return (
    <div className="profile-card-grid">
      {profiles.map((profile) => {
        const current = profile.current;
        const confirmation = confirmations[profile.id] ?? "";
        const target = targets[profile.id] ?? "";
        const updateAllowed = current.status === "ACTIVE";
        const message = messages[profile.id];
        return (
          <article className={`profile-card${focusProfileId === profile.id ? " profile-card-focused" : ""}`} key={profile.id} id={`profile-${profile.id}`}>
            <div className="profile-card-heading">
              <div>
                <p className="eyebrow">SYNTHETIC PHYSICIAN PROFILE</p>
                <h2>{profile.displayName}</h2>
              </div>
              <span className={`status ${current.status === "ACTIVE" ? "status-safe" : current.status === "FROZEN" ? "status-neutral" : "status-blocked"}`}>{current.status}</span>
            </div>
            <p className="profile-id"><code>{profile.id}</code> · current v{current.version}</p>
            <p className="profile-bridge">{profile.seedBridged ? "已桥接 SQLite 版本历史" : "Git seed v1 · 尚未桥接到数据库"}</p>
            <div className="profile-links"><Link href={`/feedback?profileId=${encodeURIComponent(profile.id)}`}>查看反馈</Link><Link href={`/audit?entityType=PHYSICIAN_PROFILE&entityId=${encodeURIComponent(profile.id)}`}>查看审计</Link></div>
            <div className="preference-list">
              {Object.entries(current.preferences).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><PreferenceValue value={value} /></dd></div>)}
            </div>
            <div className="profile-history">
              <strong>版本历史</strong>
              {profile.history.map((version) => (
                <div className="profile-history-row" key={`${profile.id}-${version.version}`}>
                  <span>v{version.version} · {version.status}</span>
                  <span>{version.sourceType} · {version.persisted ? "SQLite" : "Git seed"}</span>
                  <span>{version.previousVersion ? `previous v${version.previousVersion}` : "initial"}</span>
                  <Link href={`/audit?entityType=PHYSICIAN_PROFILE&entityId=${encodeURIComponent(profile.id)}`}>链路</Link>
                </div>
              ))}
            </div>
            <div className="profile-governance">
              <strong>治理操作 · 模拟审核者，不是生产身份认证</strong>
              {!updateAllowed ? <p>当前 {current.status} 画像只读：FROZEN 仍可用于生成，ARCHIVED 不能生成或更新。</p> : null}
              <label>
                <span>确认字段</span>
                <input value={confirmation} maxLength={30} disabled={publicDemoReadOnly || isPending || !updateAllowed} onChange={(input) => setConfirmations((values) => ({ ...values, [profile.id]: input.target.value }))} placeholder="FREEZE_PROFILE 或 ROLLBACK_PROFILE" />
              </label>
              <div className="profile-action-row">
                <button type="button" onClick={() => runProfileAction(profile.id, () => freezeProfileReviewAction({ profileId: profile.id, expectedProfileVersion: current.version, confirmation: "FREEZE_PROFILE" }))} disabled={publicDemoReadOnly || isPending || !updateAllowed || confirmation !== "FREEZE_PROFILE"}>冻结画像</button>
                <select value={target} disabled={publicDemoReadOnly || isPending || !updateAllowed} onChange={(input) => setTargets((values) => ({ ...values, [profile.id]: input.target.value }))} aria-label={`${profile.displayName}回滚目标版本`}>
                  <option value="">选择回滚目标</option>
                  {profile.history.filter((version) => version.version !== current.version).map((version) => <option key={version.version} value={version.version}>回滚到 v{version.version}</option>)}
                </select>
                <button type="button" onClick={() => runProfileAction(profile.id, () => rollbackProfileReviewAction({ profileId: profile.id, targetVersion: Number(target), expectedProfileVersion: current.version, confirmation: "ROLLBACK_PROFILE" }))} disabled={publicDemoReadOnly || isPending || !updateAllowed || confirmation !== "ROLLBACK_PROFILE" || target.length === 0}>回滚画像</button>
              </div>
              {message ? <p className="review-action-message" role="status">{message}</p> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
