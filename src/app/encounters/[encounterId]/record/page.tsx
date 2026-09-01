import { notFound } from "next/navigation";

import { readSpeechTestFixture } from "@/domain/speech-test-fixture";
import { getDatabase } from "@/server/database";
import { readRuntimeConfig } from "@/server/runtime-config";
import { readSpeechRuntimeConfig } from "@/server/speech-runtime-config";
import { getMedicalRecordView, getPublicDemoMedicalRecord } from "@/application/medical-record-service";
import { EncounterWalkthroughShell } from "@/components/encounter-walkthrough-shell";
import { MedicalRecordEditor } from "@/components/medical-record-editor";

import styles from "@/components/medical-record-editor.module.css";

export const dynamic = "force-dynamic";

function controlledLoadError(mode: "public-demo" | "local-research") {
  return (
    <main className={styles.errorPage}>
      <span className={styles.eyebrow}>病历记录</span>
      <h1>当前病历无法读取</h1>
      <p>{mode === "local-research" ? "请返回合成病例选择入口重新开始。" : "只读演示资料暂时不可用。"}</p>
      {mode === "local-research" && <a className={styles.secondaryButton} href="/encounters/new">返回选择合成病例</a>}
    </main>
  );
}

export default async function RecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ encounterId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { encounterId } = await params;
  const runtimeMode = readRuntimeConfig().runtimeMode;
  const query = await searchParams;
  const requestedFixture = query?.__pwr5Speech;
  const speechTestFixture = readSpeechTestFixture(
    typeof requestedFixture === "string" ? requestedFixture : undefined,
    runtimeMode,
    process.env.PWR5_TEST_MODE === "true",
  );
  const speechCapability = speechTestFixture
    ? { status: "READY" as const }
    : readSpeechRuntimeConfig().capability;

  if (runtimeMode === "public-demo") {
    if (encounterId !== "demo") notFound();
    let view;
    try {
      view = getPublicDemoMedicalRecord();
    } catch {
      return controlledLoadError(runtimeMode);
    }
    return <MedicalRecordEditor view={view} speechCapability={speechCapability} />;
  }

  // Keep the accepted PWR-01 preview route available in local research. New
  // local-research work starts from /encounters/new and uses a real ID.
  if (encounterId === "demo") return <EncounterWalkthroughShell stage="record" />;

  let view;
  try {
    view = getMedicalRecordView(encounterId, {
      database: getDatabase(),
      runtimeMode,
    });
  } catch {
    return controlledLoadError(runtimeMode);
  }
  return <MedicalRecordEditor view={view} speechCapability={speechCapability} speechTestFixture={speechTestFixture} />;
}
