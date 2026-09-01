import { getDatabase } from "@/server/database";
import { listProfileReadModel } from "@/application/audit-review-service";
import { ProfilesPanel } from "@/components/audit-review-actions";
import { getProviderCapabilities } from "@/server/provider";

export const dynamic = "force-dynamic";

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProfilesPage({ searchParams }: PageProps) {
  if (process.env.APP_RUNTIME_MODE !== "local-research") {
    return (
      <main className="review-page">
        <section className="page-heading">
          <p className="eyebrow">PROFILES · GOVERNED VERSIONS</p>
          <h1>合成医生画像生命周期</h1>
          <p>公开只读演示不加载本地画像版本数据。</p>
        </section>
        <div className="review-boundary-strip"><strong>公开只读演示</strong><span>画像更新已关闭</span><span>不展示本地数据库内容</span></div>
      </main>
    );
  }

  const params = searchParams ? await searchParams : {};
  const focusProfileId = first(params.profileId);
  const result = listProfileReadModel(getDatabase());
  const providerCapabilities = getProviderCapabilities();

  return (
    <main className="review-page">
      <section className="page-heading">
        <p className="eyebrow">PROFILES · GOVERNED VERSIONS</p>
        <h1>合成医生画像生命周期</h1>
        <p>这里展示 Git seed、SQLite 版本历史和受治理的低风险偏好。画像只影响表达、布局和工作流偏好，不包含诊断或处方配置。</p>
      </section>
      <div className="review-boundary-strip"><strong>{providerCapabilities.publicDemoReadOnly ? "公开只读演示" : "模拟审核者 · 不是生产身份认证"}</strong><span>ACTIVE {providerCapabilities.publicDemoReadOnly ? "只读" : "可更新"}</span><span>FROZEN 可生成但只读</span><span>ARCHIVED 不能生成或更新</span></div>
      {result.ok ? <ProfilesPanel profiles={result.data.profiles} focusProfileId={focusProfileId} publicDemoReadOnly={providerCapabilities.publicDemoReadOnly} /> : <div className="read-model-error" role="alert"><strong>{result.ruleId}</strong><span>{result.message}</span></div>}
    </main>
  );
}
