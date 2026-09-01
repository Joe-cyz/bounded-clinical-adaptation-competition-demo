import Image from "next/image";
import Link from "next/link";

import { readRuntimeConfig } from "@/server/runtime-config";

import styles from "./home.module.css";
import { projectPublicPatientDisplayName } from "@/domain/physician-patient-display-name";

const capabilities = [
  { title: "病历记录", description: "记录病史与检查" },
  { title: "AI参考", description: "查阅资料与辅助判断" },
  { title: "诊疗复核", description: "确认遗漏项" },
] as const;

export const dynamic = "force-dynamic";

export default function HomePage() {
  const encounterStartHref = readRuntimeConfig().runtimeMode === "local-research"
    ? "/encounters/new"
    : "/encounters/demo/record";

  return (
    <main className={styles.homePage}>
      <section className={styles.hero} aria-labelledby="home-title">
        <div className={styles.heroCopy}>
          <h1 id="home-title">
            <span>记录病历、</span>
            <span>查阅资料、</span>
            <span>结束前复核</span>
          </h1>
          <p>从一次接诊开始，按日常顺序完成记录与复核。</p>
          <Link className={styles.primaryAction} href={encounterStartHref}>
            开始接诊
          </Link>
        </div>
        <div className={styles.heroVisual} aria-hidden="true">
          <Image
            className={styles.heroImage}
            src="/assets/physician-workflow-line-art.png"
            width={1774}
            height={887}
            sizes="(max-width: 760px) 100vw, 48vw"
            loading="eager"
            alt=""
          />
        </div>
      </section>

      <section aria-label="主要功能" className={styles.capabilities}>
        {capabilities.map((capability) => (
          <article className={styles.capability} key={capability.title}>
            <h2>{capability.title}</h2>
            <p>{capability.description}</p>
          </article>
        ))}
      </section>

      <section className={styles.continueSection} aria-labelledby="continue-title">
        <h2 id="continue-title">继续记录</h2>
        <article className={styles.encounterRow}>
          <div className={styles.encounterIdentity}>
            <span>合成患者</span>
            <strong>{projectPublicPatientDisplayName()}</strong>
          </div>
          <time dateTime="2026-08-21">2026-08-21</time>
          <span className={styles.recordStatus}>病历待完善</span>
          <Link className={styles.secondaryAction} href="/encounters/demo/record">
            继续记录
          </Link>
        </article>
      </section>

      <section className={styles.researchSection} aria-labelledby="research-title">
        <h2 id="research-title">研究对照与验证证据</h2>
        <p>查看公平对照、治理记录和工程评测。</p>
        <Link className={styles.researchPrimaryAction} href="/research">
          进入研究页面
        </Link>
        <nav className={styles.researchLinks} aria-label="研究与治理入口">
          <Link href="/research/comparison">公平对照</Link>
          <Link href="/audit">治理与审计</Link>
          <Link href="/evaluation">工程评测</Link>
        </nav>
      </section>
    </main>
  );
}
