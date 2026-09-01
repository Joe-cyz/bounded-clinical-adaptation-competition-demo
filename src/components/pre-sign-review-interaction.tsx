"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  confirmPhysicianRecordAction,
  recordReviewItemDecisionAction,
  type ReviewActionState,
} from "@/app/encounters/actions";
import {
  formatReviewItemTitle,
  type PreSignReviewPageView,
  type ReviewItem,
} from "@/domain/pre-sign-review";

import styles from "./pre-sign-review-workspace.module.css";

const initialState: ReviewActionState = { status: "idle" };

function statusLabel(item: ReviewItem): string {
  if (item.status === "BLOCKING") return "待补充";
  if (item.status === "PENDING") return "待核对";
  if (item.status === "NOT_APPLICABLE") return "不适用";
  return "已核对";
}

function DecisionActions({ view, item, title }: { view: PreSignReviewPageView; item: ReviewItem; title: string }) {
  const router = useRouter();
  const [state, action, isPending] = useActionState(recordReviewItemDecisionAction, initialState);
  const [reasonOpen, setReasonOpen] = useState(false);
  const reasonInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  useEffect(() => {
    if (reasonOpen) reasonInputRef.current?.focus();
  }, [reasonOpen]);

  if (view.readOnly || item.status !== "PENDING" || item.blocking || view.isStale) return null;

  const decisionRecorded = state.status === "success";
  const actionsLocked = isPending || decisionRecorded;

  return (
    <div aria-busy={isPending || undefined} className={styles.itemActions}>
      {!decisionRecorded && (
        <>
          <div className={styles.decisionButtons}>
            <form action={action}>
              <input name="encounterId" type="hidden" value={view.encounterId} readOnly />
              <input name="reviewId" type="hidden" value={view.reviewId} readOnly />
              <input name="itemId" type="hidden" value={item.id} readOnly />
              <input name="expectedUpdatedAt" type="hidden" value={view.expectedUpdatedAt} readOnly />
              <input name="decision" type="hidden" value="CHECKED" readOnly />
              <button aria-label={`标记已核对：${title}`} className={styles.smallButton} disabled={actionsLocked} type="submit">标记已核对</button>
            </form>
            {!reasonOpen && (
              <button aria-label={`不适用：${title}`} className={styles.smallButton} disabled={actionsLocked} onClick={() => setReasonOpen(true)} type="button">
                不适用
              </button>
            )}
          </div>
          {reasonOpen && (
            <form aria-busy={isPending || undefined} action={action} className={styles.reasonForm}>
              <input name="encounterId" type="hidden" value={view.encounterId} readOnly />
              <input name="reviewId" type="hidden" value={view.reviewId} readOnly />
              <input name="itemId" type="hidden" value={item.id} readOnly />
              <input name="expectedUpdatedAt" type="hidden" value={view.expectedUpdatedAt} readOnly />
              <input name="decision" type="hidden" value="NOT_APPLICABLE" readOnly />
              <label className={styles.srOnly} htmlFor={`reason-${item.id}`}>不适用理由：{title}</label>
              <input
                aria-describedby={`reason-hint-${item.id}`}
                className={styles.reasonInput}
                id={`reason-${item.id}`}
                name="reason"
                maxLength={200}
                placeholder="填写简短理由"
                ref={reasonInputRef}
                disabled={actionsLocked}
                required
              />
              <span className={styles.srOnly} id={`reason-hint-${item.id}`}>理由最多 200 个字符。</span>
              <button aria-label={`确认不适用：${title}`} className={styles.smallButton} disabled={actionsLocked} type="submit">确认不适用</button>
            </form>
          )}
        </>
      )}
      {state.status === "error" && (
        <span aria-live="polite" className={styles.actionError} role="alert">{state.message}</span>
      )}
      {state.status === "success" && (
        <span aria-live="polite" className={styles.srOnly} role="status">决定已记录，正在刷新。</span>
      )}
    </div>
  );
}

function ReviewItemRow({ view, item, title }: { view: PreSignReviewPageView; item: ReviewItem; title: string }) {
  const titleId = `review-title-${item.id}`;

  return (
    <article aria-labelledby={titleId} className={styles.item}>
      <div className={styles.itemLine}>
        <strong className={styles.itemTitle} id={titleId}>{title}</strong>
        <div className={styles.itemControls}>
          <span className={item.blocking ? styles.blockingStatus : item.status === "PENDING" ? styles.pendingStatus : item.status === "NOT_APPLICABLE" ? styles.notApplicableStatus : styles.checkedStatus}>
            {statusLabel(item)}
          </span>
          <DecisionActions item={item} title={title} view={view} />
        </div>
      </div>
    </article>
  );
}

function ConfirmationControls({ view }: { view: PreSignReviewPageView }) {
  const [state, action] = useActionState(confirmPhysicianRecordAction, initialState);
  const [accepted, setAccepted] = useState(false);
  const blocked = view.isStale || view.blockingCount > 0 || view.pendingCount > 0;

  if (view.readOnly || view.status === "CONFIRMED") return null;

  return (
    <section aria-labelledby="confirmation-title" className={styles.confirmation}>
      <div className={styles.confirmationHeader}>
        <div>
          <p className={styles.eyebrow}>最终确认</p>
          <h2 id="confirmation-title">完成本次记录</h2>
        </div>
        {blocked && <span className={styles.statusBadge}>尚有 {view.blockingCount + view.pendingCount} 项未完成</span>}
      </div>
      <p className={styles.resultCopy}>
        {blocked ? "完成必填项并处理待核对内容后，再进行最终确认。" : "请确认已核对本次记录。"}
      </p>
      <form action={action} className={styles.confirmationForm}>
        <input name="encounterId" type="hidden" value={view.encounterId} readOnly />
        <input name="reviewId" type="hidden" value={view.reviewId} readOnly />
        <input name="expectedUpdatedAt" type="hidden" value={view.expectedUpdatedAt} readOnly />
        <label className={styles.declaration}>
          <input
            checked={accepted}
            name="declarationAccepted"
            onChange={(event) => setAccepted(event.target.checked)}
            type="checkbox"
          />
          <span>我已核对以上内容，并确认本次记录由医生最终负责。</span>
        </label>
        <button className={styles.primaryButton} disabled={blocked || !accepted} type="submit">
          已核对，完成记录
        </button>
        {state.status === "error" && (
          <span aria-live="polite" className={styles.actionError} role="alert">{state.message}</span>
        )}
      </form>
    </section>
  );
}

export function PreSignReviewInteraction({ view }: { view: PreSignReviewPageView }) {
  const blocking = view.items.filter((item) => item.blocking);
  const pending = view.items.filter((item) => !item.blocking && item.status === "PENDING");
  const completed = view.items.filter((item) => !item.blocking && item.status !== "PENDING");
  const titleTotals = new Map<string, number>();
  const titleOccurrences = new Map<string, number>();
  const displayTitles = new Map<string, string>();

  for (const item of view.items) {
    if (item.source !== "PENDING_INFORMATION") continue;
    const occurrenceKey = item.evidenceCode;
    titleTotals.set(occurrenceKey, (titleTotals.get(occurrenceKey) ?? 0) + 1);
  }

  for (const item of view.items) {
    const occurrenceKey = item.source === "PENDING_INFORMATION" ? item.evidenceCode : item.id;
    const occurrence = (titleOccurrences.get(occurrenceKey) ?? 0) + 1;
    titleOccurrences.set(occurrenceKey, occurrence);
    displayTitles.set(item.id, formatReviewItemTitle(item, occurrence, titleTotals.get(occurrenceKey) ?? 1));
  }

  const titleFor = (item: ReviewItem) => displayTitles.get(item.id) ?? formatReviewItemTitle(item);
  const hasOpenItems = blocking.length > 0 || pending.length > 0;

  return (
    <>
      {blocking.length > 0 && (
        <section aria-labelledby="required-title" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>安全边界</p>
              <h2 id="required-title">必填项</h2>
            </div>
            <span className={styles.statusBadge}>{blocking.length} 项</span>
          </div>
          <div className={styles.itemList}>
            {blocking.map((item) => <ReviewItemRow item={item} key={item.id} title={titleFor(item)} view={view} />)}
          </div>
          <div className={styles.sectionActions}>
            <Link className={styles.smallButton} href={`/encounters/${view.encounterId}/record`}>返回病历补充</Link>
          </div>
        </section>
      )}

      {pending.length > 0 && (
        <section aria-labelledby="pending-title" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>医生核对</p>
              <h2 id="pending-title">待核对</h2>
            </div>
            <span className={styles.statusBadge}>{pending.length} 项</span>
          </div>
          <div className={styles.itemList}>
            {pending.map((item) => <ReviewItemRow item={item} key={item.id} title={titleFor(item)} view={view} />)}
          </div>
        </section>
      )}

      {!hasOpenItems && (
        <section aria-label="复核完成" className={styles.completeNotice}>
          <strong>复核项目已全部处理</strong>
          <span>可以进行最终确认。</span>
        </section>
      )}

      <details className={styles.completedDetails}>
        <summary>已核对（{completed.length}）</summary>
        {completed.length > 0 ? (
          <div className={styles.completedList}>
            {completed.map((item) => <ReviewItemRow item={item} key={item.id} title={titleFor(item)} view={view} />)}
          </div>
        ) : (
          <p className={styles.emptyDetails}>暂无已核对项目。</p>
        )}
      </details>

      <ConfirmationControls view={view} />
    </>
  );
}
