"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  createEncounterAction,
  type EncounterActionState,
} from "@/app/encounters/actions";

import styles from "./encounter-selection.module.css";

export type EncounterCaseOption = {
  caseId: string;
  caseVersion: string;
  specialty: string;
  visitType: string;
  title: string;
  patientDisplayName: string;
};

const initialState: EncounterActionState = { status: "idle" };

function EncounterSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button className={styles.primaryButton} disabled={pending} type="submit">
      {pending ? "创建中" : "开始接诊"}
    </button>
  );
}

export function EncounterCasePicker({ cases }: { cases: EncounterCaseOption[] }) {
  const [state, action] = useActionState(createEncounterAction, initialState);

  return (
    <>
      {state.status === "error" && <p className={styles.error} role="alert">{state.message}</p>}
      <div className={styles.caseList}>
        {cases.map((caseData) => (
          <form action={action} className={styles.caseCard} key={`${caseData.caseId}:${caseData.caseVersion}`}>
            <input name="caseId" type="hidden" value={caseData.caseId} />
            <input name="caseVersion" type="hidden" value={caseData.caseVersion} />
            <div className={styles.caseIdentity}>
              <span>{caseData.patientDisplayName}</span>
              <strong>{caseData.title}</strong>
            </div>
            <div className={styles.caseTags}>
              <span>{caseData.specialty}</span>
              <span>{caseData.visitType}</span>
            </div>
            <EncounterSubmitButton />
          </form>
        ))}
      </div>
    </>
  );
}
