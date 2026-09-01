import Link from "next/link";

import type {
  GenerationTrace,
  SafeAuditEvent,
  SafeFeedback,
  SafeProfile,
  SafeRevision,
} from "@/application/audit-review-service";

const metadataLabel: Record<string, string> = {
  runId: "run",
  generationRunId: "generation run",
  feedbackEventId: "feedback",
  draftRevisionId: "revision",
  revisionNumber: "revision number",
  profileId: "profile",
  sourceType: "source",
  changedField: "changed field",
  riskLevel: "risk",
  status: "status",
  rulesVersion: "rules",
  ruleIds: "rules hit",
  profileUpdated: "profile updated",
  rollbackTargetVersion: "rollback target",
  changedSectionCount: "changed sections",
  addedLineCount: "added lines",
  removedLineCount: "removed lines",
  addedCharacterCount: "added characters",
  removedCharacterCount: "removed characters",
  editBurdenRatio: "edit burden",
  rationale: "decision rationale",
  mode: "mode",
  providerId: "provider",
  modelId: "model",
  promptVersion: "prompt",
  configurationKey: "configuration key",
  caseId: "case",
  caseVersion: "case version",
  datasetVersion: "dataset",
  safetyCoreVersion: "safety core version",
  policyVersion: "policy version",
  errorType: "error type",
  requestId: "request",
};

function MetadataSummary({ event }: { event: SafeAuditEvent }) {
  const entries = Object.entries(event.metadata);
  return entries.length > 0 ? (
    <div className="audit-metadata-summary">
      {entries.map(([key, value]) => (
        <span key={key}>
          <small>{metadataLabel[key] ?? key}</small>
          <strong>{Array.isArray(value) ? value.join(", ") : String(value)}</strong>
        </span>
      ))}
    </div>
  ) : <span className="audit-metadata-empty">无可展示的白名单 metadata</span>;
}

export function AuditTimeline({ events }: { events: SafeAuditEvent[] }) {
  if (events.length === 0) return <div className="review-empty" role="status">当前筛选下没有审计事件。</div>;
  return (
    <div className="audit-timeline">
      {events.map((event) => (
        <article className="audit-event-card" key={event.id}>
          <div className="audit-event-marker" aria-hidden="true" />
          <div className="audit-event-body">
            <div className="audit-event-heading">
              <div>
                <p className="eyebrow">{event.simulatedRole} · {event.entityType}</p>
                <h2>{event.eventType}</h2>
              </div>
              <time dateTime={event.createdAt}>{event.createdAt}</time>
            </div>
            <dl className="review-event-meta">
              <div><dt>audit ID</dt><dd><code>{event.id}</code></dd></div>
              <div><dt>actor</dt><dd>{event.actorId} · {event.simulatedRole}</dd></div>
              <div><dt>entity</dt><dd><code>{event.entityType}:{event.entityId}</code></dd></div>
              <div><dt>版本</dt><dd>{event.beforeVersion ?? "—"} → {event.afterVersion ?? "—"}</dd></div>
            </dl>
            <MetadataSummary event={event} />
          </div>
        </article>
      ))}
    </div>
  );
}

function TraceFeedback({ event }: { event: SafeFeedback }) {
  return (
    <article className={`trace-node trace-feedback risk-${event.riskLevel.toLowerCase()}`}>
      <div className="trace-node-heading"><strong>{event.riskLevel} · {event.changeType}</strong><span>{event.decision}</span></div>
      <p><Link href={`/feedback?feedbackId=${encodeURIComponent(event.id)}`}>{event.id}</Link> · 字段 {event.affectedField} · 规则 {event.rulesVersion}</p>
      <div className="rule-hits">{event.ruleHits.map((ruleId) => <code key={ruleId}>{ruleId}</code>)}</div>
      <p>{event.safetyReason}</p>
      {event.decisionRecord ? <p className="trace-decision">决定：{event.decisionRecord.decision} · {event.decisionRecord.simulatedRole} · {event.decisionRecord.rationale}</p> : <p className="trace-decision">尚无决定，下一步：{event.nextAllowedActions.join(" / ") || "无"}</p>}
      {event.riskLevel === "HIGH" ? <p className="review-terminal">高风险：无 DraftRevision 正文，仅保留拒绝证据。</p> : null}
    </article>
  );
}

function TraceRevision({ revision }: { revision: SafeRevision }) {
  return (
    <article className="trace-node trace-revision" id={`revision-${revision.id}`}>
      <div className="trace-node-heading"><strong>Revision #{revision.revisionNumber}</strong><span>{revision.createdAt}</span></div>
      <p><Link href={`/audit?runId=${encodeURIComponent(revision.generationRunId)}`}>{revision.id}</Link> · editor {revision.editorId}</p>
      <p>{revision.changedSectionKeys.length} 个变化栏目 · {revision.orderChanged ? "栏目顺序变化 · " : ""}编辑负担 {(revision.metrics.editBurdenRatio * 100).toFixed(2)}%</p>
      <p>反馈链接：{revision.feedbackEventIds.length > 0 ? revision.feedbackEventIds.join(", ") : "无"}</p>
    </article>
  );
}

function TraceProfile({ profile }: { profile: SafeProfile }) {
  return (
    <article className="trace-node trace-profile">
      <div className="trace-node-heading"><strong>{profile.displayName}</strong><span>v{profile.current.version} · {profile.current.status}</span></div>
      <p><Link href={`/profiles?profileId=${encodeURIComponent(profile.id)}`}>{profile.id}</Link> · {profile.seedBridged ? "SQLite 历史" : "Git seed v1，尚未桥接到数据库"}</p>
      <p>历史：{profile.history.map((version) => `v${version.version}/${version.sourceType}`).join(" · ")}</p>
    </article>
  );
}

export function GenerationTraceView({ trace }: { trace: GenerationTrace }) {
  return (
    <section className="trace-panel" aria-labelledby="trace-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">GENERATION RUN TRACE</p>
          <h2 id="trace-title">单次运行全链路追溯</h2>
        </div>
        <span className={`status ${trace.traceIntegrity === "COMPLETE" ? "status-safe" : trace.traceIntegrity === "INCOMPLETE" ? "status-neutral" : "status-blocked"}`}>{trace.traceIntegrity}</span>
      </div>
      <p className="trace-boundary">链路完整性是工程可追溯性，不是临床安全认证。所有角色均为本地模拟边界。</p>
      {trace.missingRelations.length > 0 ? (
        <div className="trace-warning" role="alert"><strong>完整性警告</strong>{trace.missingRelations.map((relation) => <code key={relation}>{relation}</code>)}</div>
      ) : null}
      {trace.run ? (
        <article className="trace-run-summary">
          <div className="trace-node-heading"><strong>{trace.run.mode} · {trace.run.status}</strong><span>{trace.run.createdAt}</span></div>
          <dl className="review-event-meta">
            <div><dt>run ID</dt><dd><code>{trace.run.id}</code></dd></div>
            <div><dt>病例</dt><dd>{trace.run.case.id}@{trace.run.case.version} · {trace.run.case.specialty} · {trace.run.case.visitType}</dd></div>
            <div><dt>provider / model</dt><dd>{trace.run.provider.id} / {trace.run.provider.modelId}</dd></div>
            <div><dt>prompt</dt><dd>{trace.run.provider.promptVersion}</dd></div>
            <div><dt>配置键</dt><dd><code>{trace.run.configurationKey}</code></dd></div>
            <div><dt>安全 / 策略</dt><dd>{trace.run.safetyCore.id}@{trace.run.safetyCore.version} / {trace.run.policy.id}@{trace.run.policy.version}</dd></div>
            <div><dt>画像</dt><dd>{trace.run.profileId ? `${trace.run.profileId}@v${trace.run.profileVersion}` : "GENERIC · 不使用画像"}</dd></div>
          </dl>
        </article>
      ) : <div className="trace-warning">无法安全展示运行快照。</div>}

      <div className="trace-columns">
        <div><h3>修订</h3>{trace.revisions.length > 0 ? trace.revisions.map((revision) => <TraceRevision key={revision.id} revision={revision} />) : <p className="trace-empty">无 DraftRevision；高风险路径正文不会保存。</p>}</div>
        <div><h3>反馈与决定</h3>{trace.feedback.length > 0 ? trace.feedback.map((event) => <TraceFeedback key={event.id} event={event} />) : <p className="trace-empty">该运行没有反馈事件。</p>}</div>
      </div>
      <div className="trace-columns">
        <div><h3>画像版本变化</h3>{trace.profiles.length > 0 ? trace.profiles.flatMap((profile) => profile.history.map((version) => <TraceProfile key={`${profile.id}-${version.version}`} profile={{ ...profile, current: version }} />)) : <p className="trace-empty">未关联画像。</p>}</div>
        <div><h3>运行相关审计</h3><AuditTimeline events={trace.audits} /></div>
      </div>
    </section>
  );
}
