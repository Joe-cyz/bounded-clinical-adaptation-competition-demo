import { EvaluationPanel } from "@/components/evaluation-panel";
import { getEvaluationPageModel } from "@/application/evaluation-service";
import { getDatabase } from "@/server/database";
import { getProviderCapabilities } from "@/server/provider";

export const dynamic = "force-dynamic";

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function EvaluationPage({ searchParams }: PageProps) {
  if (process.env.APP_RUNTIME_MODE !== "local-research") {
    return (
      <main className="review-page evaluation-page">
        <section className="page-heading">
          <p className="eyebrow">EVALUATION · EXPORT</p>
          <h1>工程评测与安全导出</h1>
          <p>公开只读演示不加载评测批次或导出数据。</p>
        </section>
        <div className="review-boundary-strip"><strong>公开只读演示</strong><span>评测写入和导出已关闭</span><span>不展示本地数据库内容</span></div>
      </main>
    );
  }

  const params = searchParams ? await searchParams : {};
  const result = getEvaluationPageModel(getDatabase(), first(params.batchId));
  const providerCapabilities = getProviderCapabilities();
  return (
    <main className="review-page evaluation-page">
      <section className="page-heading">
        <p className="eyebrow">EVALUATION · EXPORT</p>
        <h1>工程评测与安全导出</h1>
        <p>评测复用既有 GENERIC / BOUNDED 生成流水线，锁定病例、画像版本、配置和安全规则；失败也会保留并进入结果与导出。</p>
      </section>
      <div className="review-boundary-strip"><strong>仅合成数据 · 主矩阵 24 病例 / 72 pairs / 144 attempts · 内容待领域复核</strong><span>{providerCapabilities.publicDemoReadOnly ? "公开只读演示 · Provider 仅展示 Mock" : "Mock 默认；DeepSeek 仅本机门控"}</span><span>模拟研究者，不是生产认证</span><span>不导出草稿正文、prompt 或路径</span></div>
      {result.ok ? <EvaluationPanel selected={result.data.selected} recent={result.data.recent} providerCapabilities={providerCapabilities} /> : <div className="read-model-error" role="alert"><strong>{result.ruleId}</strong><span>{result.message}</span></div>}
    </main>
  );
}
