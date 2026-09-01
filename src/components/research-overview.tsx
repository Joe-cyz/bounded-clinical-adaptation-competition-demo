import Link from "next/link";

import styles from "./research-overview.module.css";

const governanceEntries = [
  { href: "/profiles", title: "医生画像", description: "查看受治理的合成画像与版本历史。" },
  { href: "/feedback", title: "反馈审核", description: "查看反馈事件、风险状态和审核决定。" },
  { href: "/audit", title: "治理与审计", description: "追溯运行、修订、决定和审计证据。" },
  { href: "/evaluation", title: "工程评测", description: "查看锁定版本的工程评测与安全导出。" },
] as const;

export function ResearchOverview({ publicDemoReadOnly }: { publicDemoReadOnly: boolean }) {
  return (
    <main className={styles.page}>
      <section className={styles.heading} aria-labelledby="research-overview-title">
        <p className="eyebrow">RESEARCH & GOVERNANCE</p>
        <h1 id="research-overview-title">研究与治理</h1>
        <p>集中查看公平对照、治理记录和工程评测。</p>
        <div className={styles.boundary} aria-label="研究边界">
          <span>仅合成数据</span>
          <span>临床前原型</span>
          {publicDemoReadOnly ? <span>只读</span> : null}
        </div>
      </section>

      <section className={styles.featureSection} aria-labelledby="comparison-title">
        <div className={styles.sectionHeading}>
          <p className="eyebrow">PRIMARY RESEARCH ENTRY</p>
          <h2 id="comparison-title">公平对照</h2>
          <p>比较通用生成与受约束适配结果。</p>
        </div>
        <Link className={styles.primaryLink} href="/research/comparison">
          进入公平对照
        </Link>
      </section>

      <section className={styles.governanceSection} aria-labelledby="governance-title">
        <div className={styles.sectionHeading}>
          <p className="eyebrow">GOVERNANCE & VALIDATION</p>
          <h2 id="governance-title">治理与验证</h2>
          <p>从入口进入对应的治理记录和工程证据。</p>
        </div>
        <nav className={styles.entryList} aria-label="治理与验证入口">
          {governanceEntries.map((entry) => (
            <Link className={styles.entry} href={entry.href} key={entry.href}>
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.description}</small>
              </span>
              <span className={styles.entryArrow} aria-hidden="true">→</span>
            </Link>
          ))}
        </nav>
      </section>
    </main>
  );
}
