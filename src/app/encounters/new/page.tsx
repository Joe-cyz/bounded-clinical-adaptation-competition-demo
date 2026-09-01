import Link from "next/link";

import { syntheticCases, syntheticMedicalRecords } from "@/data/seed-loader";
import { readRuntimeConfig } from "@/server/runtime-config";
import { EncounterCasePicker, type EncounterCaseOption } from "@/components/encounter-case-picker";
import { projectSeededPatientDisplayName } from "@/domain/physician-patient-display-name";

import styles from "@/components/encounter-selection.module.css";

export const dynamic = "force-dynamic";

export default function NewEncounterPage() {
  const runtimeMode = readRuntimeConfig().runtimeMode;
  if (runtimeMode === "public-demo") {
    return (
      <main className={styles.page}>
        <span className={styles.eyebrow}>合成病例</span>
        <h1>选择一次接诊</h1>
        <p>公开演示只支持读取预置资料，不创建接诊或保存病历。</p>
        <Link className={styles.secondaryButton} href="/encounters/demo/record">查看只读演示</Link>
      </main>
    );
  }

  const cases: EncounterCaseOption[] = syntheticMedicalRecords.map((record) => {
    const source = syntheticCases.find((candidate) => candidate.id === record.caseId && candidate.version === record.caseVersion);
    return {
      caseId: record.caseId,
      caseVersion: record.caseVersion,
      specialty: record.specialty,
      visitType: record.visitType,
      title: source?.title ?? "合成病例",
      patientDisplayName: projectSeededPatientDisplayName(record.demographics.displayLabel),
    };
  });

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>本地研究 · 仅合成病例</span>
          <h1>选择一次接诊</h1>
          <p>选择预置病例，或新建病例后进入病历记录。</p>
        </div>
        <Link className={styles.backLink} href="/">返回医生首页</Link>
      </header>
      <div className={styles.primaryAction}>
        <Link className={styles.primaryButton} href="/encounters/new/manual">新建病例</Link>
      </div>
      <section className={styles.caseGrid} aria-labelledby="case-list-title">
        <div className={styles.sectionHeading}>
          <h2 id="case-list-title">从预置病例开始</h2>
          <span>{cases.length} 例可选</span>
        </div>
        <EncounterCasePicker cases={cases} />
      </section>
    </main>
  );
}
