"use client";

import { useActionState } from "react";

import {
  enterPreSignReviewAction,
  type ReviewActionState,
} from "@/app/encounters/actions";

import styles from "./reference-workspace.module.css";

const initialState: ReviewActionState = { status: "idle" };

export function ReviewEntryForm({
  encounterId,
  expectedUpdatedAt,
  currentRecordRevisionId,
}: {
  encounterId: string;
  expectedUpdatedAt: string;
  currentRecordRevisionId: string;
}) {
  const [state, action] = useActionState(enterPreSignReviewAction, initialState);

  return (
    <form action={action} className={styles.actionForm}>
      <input name="encounterId" type="hidden" value={encounterId} readOnly />
      <input name="expectedUpdatedAt" type="hidden" value={expectedUpdatedAt} readOnly />
      <input name="expectedCurrentRecordRevisionId" type="hidden" value={currentRecordRevisionId} readOnly />
      <button className={styles.primaryButton} type="submit">
        进入诊疗复核
      </button>
      {state.status === "error" && (
        <span aria-live="polite" className={styles.actionError} role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}
