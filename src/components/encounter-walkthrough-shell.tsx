import Link from "next/link";

import styles from "./encounter-walkthrough-shell.module.css";
import { projectPublicPatientDisplayName } from "@/domain/physician-patient-display-name";

type WalkthroughStage = "record" | "reference" | "review";

type StageConfiguration = {
  title: string;
  description: string;
  previousHref: string;
  previousLabel: string;
  nextHref: string;
  nextLabel: string;
};

const stageConfigurations: Record<WalkthroughStage, StageConfiguration> = {
  record: {
    title: "病历记录",
    description: "病史、体格检查和辅助检查将在后续工作包接入。当前页面不保存任何内容。",
    previousHref: "/",
    previousLabel: "返回首页",
    nextHref: "/encounters/demo/reference",
    nextLabel: "进入AI参考",
  },
  reference: {
    title: "AI参考",
    description: "AI参考与文献入口将在后续工作包接入。当前页面不会上传资料或调用模型。",
    previousHref: "/encounters/demo/record",
    previousLabel: "返回病历记录",
    nextHref: "/encounters/demo/review",
    nextLabel: "进入诊疗复核",
  },
  review: {
    title: "诊疗复核",
    description: "规则化遗漏项提醒将在后续工作包接入。当前页面不执行复核或医生确认。",
    previousHref: "/encounters/demo/reference",
    previousLabel: "返回AI参考",
    nextHref: "/",
    nextLabel: "返回医生首页",
  },
};

export function EncounterWalkthroughShell({
  stage,
  encounterLabel = projectPublicPatientDisplayName(),
  previousHref,
  nextHref,
}: {
  stage: WalkthroughStage;
  encounterLabel?: string;
  previousHref?: string;
  nextHref?: string;
}) {
  const configuration = stageConfigurations[stage];

  return (
    <main className={styles.page}>
      <header className={styles.heading}>
        <div className={styles.encounterContext}>
          <strong>{encounterLabel}</strong>
          <span>只读预览</span>
        </div>
        <h1>{configuration.title}</h1>
        <p>{configuration.description}</p>
      </header>

      <section className={styles.preview} aria-labelledby="preview-title">
        <h2 id="preview-title">页面结构预览</h2>
        <p>完整功能尚未接入，本页仅用于确认医生主线与页面跳转。</p>
      </section>

      <nav className={styles.stageNavigation} aria-label="接诊预览导航">
        <Link className={styles.previousLink} href={previousHref ?? configuration.previousHref}>
          {configuration.previousLabel}
        </Link>
        <Link className={styles.nextLink} href={nextHref ?? configuration.nextHref}>
          {configuration.nextLabel}
        </Link>
      </nav>
    </main>
  );
}
