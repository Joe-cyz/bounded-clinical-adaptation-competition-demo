import Link from "next/link";

import {
  AUDIT_ENTITY_TYPES,
  AUDIT_EVENT_TYPES,
  AUDIT_SIMULATED_ROLES,
  buildGenerationTrace,
  listAuditReadModel,
} from "@/application/audit-review-service";
import { AuditTimeline, GenerationTraceView } from "@/components/audit-read-views";
import { getDatabase } from "@/server/database";

export const dynamic = "force-dynamic";

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asAllowed<T extends string>(value: string | undefined, values: readonly T[]): T | undefined {
  return value && values.includes(value as T) ? value as T : undefined;
}

function hasInvalidValue(value: string | undefined, values: readonly string[]): boolean {
  return value !== undefined && !values.includes(value);
}

export default async function AuditPage({ searchParams }: PageProps) {
  if (process.env.APP_RUNTIME_MODE !== "local-research") {
    return (
      <main className="review-page">
        <section className="page-heading">
          <p className="eyebrow">AUDIT · TRACEABILITY</p>
          <h1>审计时间线</h1>
          <p>公开只读演示不加载本地审计数据。</p>
        </section>
        <div className="review-boundary-strip"><strong>公开只读演示</strong><span>审计读取已关闭</span><span>不展示数据库、SQL 或路径</span></div>
      </main>
    );
  }

  const params = searchParams ? await searchParams : {};
  const runId = first(params.runId);
  const database = getDatabase();
  const trace = runId ? buildGenerationTrace(database, runId) : undefined;
  const eventType = asAllowed(first(params.eventType), AUDIT_EVENT_TYPES);
  const simulatedRole = asAllowed(first(params.role), AUDIT_SIMULATED_ROLES);
  const entityType = asAllowed(first(params.entityType), AUDIT_ENTITY_TYPES);
  const invalidFilter = hasInvalidValue(first(params.eventType), AUDIT_EVENT_TYPES)
    || hasInvalidValue(first(params.role), AUDIT_SIMULATED_ROLES)
    || hasInvalidValue(first(params.entityType), AUDIT_ENTITY_TYPES);
  const nextPageParams = new URLSearchParams();
  if (eventType) nextPageParams.set("eventType", eventType);
  if (simulatedRole) nextPageParams.set("role", simulatedRole);
  if (entityType) nextPageParams.set("entityType", entityType);
  if (first(params.entityId)) nextPageParams.set("entityId", first(params.entityId)!);
  if (runId) nextPageParams.set("runId", runId);
  const auditResult = invalidFilter
    ? { ok: false as const, ruleId: "AUDIT_READ_INPUT_INVALID", message: "审计查询参数未通过服务端校验。" }
    : listAuditReadModel(database, {
        ...(eventType ? { eventType } : {}),
        ...(simulatedRole ? { simulatedRole } : {}),
        ...(entityType ? { entityType } : {}),
        ...(first(params.entityId) ? { entityId: first(params.entityId) } : {}),
        ...(first(params.cursor) ? { cursor: first(params.cursor) } : {}),
        limit: 50,
      });

  return (
    <main className="review-page">
      <section className="page-heading">
        <p className="eyebrow">AUDIT · TRACEABILITY</p>
        <h1>{runId ? "单次运行审计链路" : "审计时间线"}</h1>
        <p>只读展示白名单审计字段、版本和安全聚合 metadata。审计链路完整性是工程证据，不是临床安全认证。</p>
      </section>
      <div className="review-boundary-strip"><strong>本地模拟角色，不是生产身份认证</strong><span>无任意 JSON 导出</span><span>WP-10 再实现导出</span><span>不展示 SQL、路径或堆栈</span></div>
      <form className="review-filters audit-filters" method="get" aria-label="审计筛选">
        <label><span>Event type</span><select name="eventType" defaultValue={eventType ?? ""}><option value="">全部</option>{AUDIT_EVENT_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>模拟角色</span><select name="role" defaultValue={simulatedRole ?? ""}><option value="">全部</option>{AUDIT_SIMULATED_ROLES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Entity type</span><select name="entityType" defaultValue={entityType ?? ""}><option value="">全部</option>{AUDIT_ENTITY_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>Entity ID</span><input name="entityId" defaultValue={first(params.entityId) ?? ""} /></label>
        {runId ? <input type="hidden" name="runId" value={runId} readOnly /> : null}
        <button className="primary-action" type="submit">应用筛选</button>
      </form>
      {trace ? (trace.ok ? <GenerationTraceView trace={trace.data} /> : <div className="read-model-error" role="alert"><strong>{trace.ruleId}</strong><span>{trace.message}</span></div>) : null}
      {!runId ? (
        auditResult.ok ? <><AuditTimeline events={auditResult.data.events} />{auditResult.data.nextCursor ? <Link className="audit-next-page" href={`/audit?${nextPageParams.toString()}${nextPageParams.size > 0 ? "&" : ""}cursor=${encodeURIComponent(auditResult.data.nextCursor)}`}>加载更早审计</Link> : null}</> : <div className="read-model-error" role="alert"><strong>{auditResult.ruleId}</strong><span>{auditResult.message}</span></div>
      ) : null}
    </main>
  );
}
