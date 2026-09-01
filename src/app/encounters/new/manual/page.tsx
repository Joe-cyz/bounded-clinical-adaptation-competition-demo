import Link from "next/link";

import {
  issueManualSyntheticCreationRequestId,
} from "@/application/manual-synthetic-encounter-service";
import { ManualSyntheticIntakeForm } from "@/components/manual-synthetic-intake-form";
import { readRuntimeConfig } from "@/server/runtime-config";

import styles from "@/components/encounter-selection.module.css";

export const dynamic = "force-dynamic";

export default function ManualSyntheticEncounterPage() {
  const runtimeMode = readRuntimeConfig().runtimeMode;

  if (runtimeMode === "public-demo") {
    return (
      <main className={styles.page}>
        <header className={styles.pageHeader}>
          <div>
            <span className={styles.eyebrow}>公开演示 · 只读</span>
            <h1>新建病例</h1>
            <p>公开演示中不能新建病例。</p>
          </div>
          <Link className={styles.backLink} href="/encounters/new">返回选择病例</Link>
        </header>
        <section aria-label="公开演示操作" className={styles.manualReadonly}>
          <Link className={styles.secondaryButton} href="/encounters/demo/record">查看只读演示</Link>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>本地研究 · 仅合成病例</span>
          <h1>新建病例</h1>
          <p>填写基本接诊信息，创建后进入病历记录。</p>
        </div>
        <Link className={styles.backLink} href="/encounters/new">返回选择病例</Link>
      </header>
      <ManualSyntheticIntakeForm creationRequestId={issueManualSyntheticCreationRequestId()} />
    </main>
  );
}
