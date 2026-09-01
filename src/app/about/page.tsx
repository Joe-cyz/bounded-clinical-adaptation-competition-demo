export default function AboutPage() {
  return (
    <main className="about-page">
      <section className="page-heading">
        <p className="eyebrow">ABOUT & LIMITS</p>
        <h1>实现状态、限制与数据政策</h1>
        <p>这是面向中国门诊场景的前临床研究原型，用于研究医院标准化之后的安全边界内适配。</p>
      </section>

      <section className="about-grid">
        <article className="overview-card">
          <p className="eyebrow">已实现</p>
          <h2>WP-12A Provider foundation</h2>
          <ul>
            <li>版本化合成病例和 ACTIVE 合成医生画像按 ID 由服务端解析。</li>
            <li>输入校验、有效配置编译、输出规则校验和 SQLite 原子审计已接通。</li>
            <li>GENERIC / BOUNDED 共享 Provider、model、prompt 和安全版本引用；评测批次明确记录 MOCK / REAL 执行类型。</li>
          </ul>
        </article>
        <article className="overview-card overview-card-accent">
          <p className="eyebrow">当前 Mock 技术演示</p>
          <h2>默认没有真实模型调用</h2>
          <p>默认 provider 是无密钥、无网络的确定性 Mock，使用已受治理的本地 `generateDraft` 逻辑生成可复现输出。DeepSeek 适配器只在 `local-research + enabled + 本机凭据` 同时满足时可选；本里程碑未进行真实请求或 live smoke。</p>
        </article>
        <article className="overview-card">
          <p className="eyebrow">后续计划</p>
          <h2>在边界完整后再评估扩展</h2>
          <p>后续工作包可能覆盖编辑反馈、审核状态机和评测运行器；这些能力当前未接入本页面，也不会把编辑行为直接当作学习真值。</p>
        </article>
        <article className="overview-card overview-card-warning">
          <p className="eyebrow">限制</p>
          <h2>不代表临床验证</h2>
          <p>本项目不是临床产品，不提供自主诊断、处方或真实医院系统接入。输出必须由人工复核，且只允许明确标注的合成数据。</p>
        </article>
      </section>

      <section className="boundary-strip">
        <strong>数据政策：</strong>
        <span>不提交真实病历</span>
        <span>不保存 API key</span>
        <span>public-demo 强制 Mock</span>
        <span>不进行真实 API 请求</span>
        <span>本地数据库仅作原型运行数据</span>
      </section>
    </main>
  );
}
