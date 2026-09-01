import Link from "next/link";

import {
  formatReviewLocalTimestamp,
  type PreSignReviewPageView,
} from "@/domain/pre-sign-review";

import { PreSignReviewInteraction } from "./pre-sign-review-interaction";
import styles from "./pre-sign-review-workspace.module.css";

function ContextHeader({ view, patientDisplayName }: { view: PreSignReviewPageView; patientDisplayName: string }) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.contextLine}>
        <strong>{patientDisplayName}</strong>
        <span className={styles.badge}>合成病例</span>
        {view.readOnly && <span className={styles.readOnlyBadge}>只读预览</span>}
      </div>
      <p className={styles.eyebrow}>当前接诊</p>
      <h1>{view.status === "CONFIRMED" ? "诊疗复核 · 记录已完成" : "诊疗复核"}</h1>
      <p className={styles.subtitle}>{view.status === "CONFIRMED" ? "本次记录已由医生完成确认。" : "完成前安全复核"}</p>
    </header>
  );
}

function PageActions({ view }: { view: PreSignReviewPageView }) {
  return (
    <nav aria-label="诊疗复核操作" className={styles.pageActions}>
      <Link className={styles.secondaryButton} href={`/encounters/${view.encounterId}/record`}>返回病历</Link>
      <div className={styles.pageActionsGroup}>
        <Link className={styles.secondaryButton} href={`/encounters/${view.encounterId}/reference`}>返回AI参考</Link>
      </div>
    </nav>
  );
}

export function PreSignReviewWorkspace({ view, patientDisplayName }: { view: PreSignReviewPageView; patientDisplayName: string }) {
  const isConfirmed = view.status === "CONFIRMED" && view.confirmation !== undefined;

  return (
    <main className={styles.page}>
      <ContextHeader patientDisplayName={patientDisplayName} view={view} />

      <div aria-label="复核上下文" className={styles.contextGrid}>
        <div><span>接诊状态</span><strong>{isConfirmed ? "已完成" : view.readOnly ? "只读预览" : "待确认"}</strong></div>
        <div><span>病历版本</span><strong>第 {view.currentRevisionNumber} 版</strong></div>
      </div>

      {isConfirmed ? (
        <section aria-live="polite" className={styles.successState}>
          <p className={styles.eyebrow}>确认完成</p>
          <h2>记录已完成</h2>
          <p className={styles.resultCopy}>确认时间：{formatReviewLocalTimestamp(view.confirmation?.confirmedAt ?? "")}；当前病历版本：第 {view.confirmation?.revisionNumber} 版。</p>
        </section>
      ) : (
        <>
          <section aria-label="复核概览" className={styles.overview}>
            <div className={styles.overviewLine}>
              <span className={styles.countSummary}>必填项 {view.blockingCount} 项｜待核对 {view.pendingCount} 项</span>
              {view.isStale && <span className={styles.staleNotice}>病历已有更新修订</span>}
            </div>
          </section>
          <PreSignReviewInteraction view={view} />
        </>
      )}

      <PageActions view={view} />
    </main>
  );
}

export function ReviewAccessError({
  encounterId,
  message,
  mode,
}: {
  encounterId: string;
  message: string;
  mode: "public-demo" | "local-research";
}) {
  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.contextLine}>
          <strong>{mode === "public-demo" ? "公开演示" : "当前接诊"}</strong>
          <span className={styles.badge}>合成病例</span>
        </div>
        <p className={styles.eyebrow}>诊疗复核</p>
        <h1>当前页面无法打开</h1>
        <p className={styles.subtitle}>页面没有执行状态推进或写入。</p>
      </header>
      <section aria-live="polite" className={styles.errorState} role="alert">
        <h2>诊疗复核暂不可用</h2>
        <p>{message}</p>
      </section>
      <nav aria-label="返回操作" className={styles.pageActions}>
        <Link className={styles.secondaryButton} href={mode === "public-demo" ? "/encounters/demo/reference" : `/encounters/${encounterId}/reference`}>返回AI参考</Link>
        <Link className={styles.primaryButton} href={mode === "public-demo" ? "/encounters/demo/record" : `/encounters/${encounterId}/record`}>返回病历</Link>
      </nav>
    </main>
  );
}
