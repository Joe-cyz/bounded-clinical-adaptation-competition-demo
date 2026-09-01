import {
  listFeedbackReadModel,
  type FeedbackQuery,
} from "@/application/audit-review-service";
import { FeedbackQueue } from "@/components/audit-review-actions";
import { getDatabase } from "@/server/database";
import { getProviderCapabilities } from "@/server/provider";

export const dynamic = "force-dynamic";

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilter(params: Record<string, string | string[] | undefined>): FeedbackQuery | undefined {
  const riskLevel = first(params.risk);
  const status = first(params.status);
  const hasDecision = first(params.decision);
  if (riskLevel && !["LOW", "MEDIUM", "UNCERTAIN", "HIGH"].includes(riskLevel)) return undefined;
  if (status && !["CANDIDATE", "HELD_FOR_REVIEW", "REJECTED"].includes(status)) return undefined;
  if (hasDecision && !["yes", "no"].includes(hasDecision)) return undefined;
  return {
    ...(riskLevel ? { riskLevel: riskLevel as FeedbackQuery["riskLevel"] } : {}),
    ...(status ? { status: status as FeedbackQuery["status"] } : {}),
    ...(first(params.profileId) ? { profileId: first(params.profileId) } : {}),
    ...(first(params.feedbackId) ? { feedbackEventId: first(params.feedbackId) } : {}),
    ...(hasDecision ? { hasDecision: hasDecision === "yes" } : {}),
  };
}

export default async function FeedbackPage({ searchParams }: PageProps) {
  if (process.env.APP_RUNTIME_MODE !== "local-research") {
    return (
      <main className="review-page">
        <section className="page-heading">
          <p className="eyebrow">FEEDBACK · REVIEW QUEUE</p>
          <h1>反馈与审核队列</h1>
          <p>公开只读演示不加载本地反馈和审核数据。</p>
        </section>
        <div className="review-boundary-strip"><strong>公开只读演示</strong><span>确认、审核和画像更新已关闭</span><span>不展示本地数据库内容</span></div>
      </main>
    );
  }

  const params = searchParams ? await searchParams : {};
  const filter = parseFilter(params);
  const result = filter ? listFeedbackReadModel(getDatabase(), filter) : { ok: false as const, ruleId: "AUDIT_READ_INPUT_INVALID", message: "审计查询参数未通过服务端校验。" };
  const providerCapabilities = getProviderCapabilities();

  return (
    <main className="review-page">
      <section className="page-heading">
        <p className="eyebrow">FEEDBACK · REVIEW QUEUE</p>
        <h1>反馈与审核队列</h1>
        <p>事件来自真实持久化修订差异。低风险候选必须明确确认；中风险和不确定修改进入审核；高风险只保留拒绝证据。</p>
      </section>
      <div className="review-boundary-strip"><strong>{providerCapabilities.publicDemoReadOnly ? "公开只读演示" : "本地模拟角色，不是生产身份认证"}</strong><span>内容编辑不会自动解释成偏好</span><span>审核批准不等于写入画像</span><span>{providerCapabilities.publicDemoReadOnly ? "确认、审核和画像更新已关闭" : "高风险无操作按钮"}</span></div>
      <form className="review-filters" method="get" aria-label="反馈筛选">
        <label><span>风险</span><select name="risk" defaultValue={first(params.risk) ?? ""}><option value="">全部</option><option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="UNCERTAIN">UNCERTAIN</option><option value="HIGH">HIGH</option></select></label>
        <label><span>状态</span><select name="status" defaultValue={first(params.status) ?? ""}><option value="">全部</option><option value="CANDIDATE">CANDIDATE</option><option value="HELD_FOR_REVIEW">HELD_FOR_REVIEW</option><option value="REJECTED">REJECTED</option></select></label>
        <label><span>是否已有决定</span><select name="decision" defaultValue={first(params.decision) ?? ""}><option value="">全部</option><option value="no">待决定</option><option value="yes">已决定</option></select></label>
        <label><span>画像 ID</span><input name="profileId" defaultValue={first(params.profileId) ?? ""} placeholder="可选" /></label>
        <button className="primary-action" type="submit">应用筛选</button>
      </form>
      {result.ok ? <FeedbackQueue events={result.data.events} publicDemoReadOnly={providerCapabilities.publicDemoReadOnly} /> : <div className="read-model-error" role="alert"><strong>{result.ruleId}</strong><span>{result.message}</span></div>}
    </main>
  );
}
