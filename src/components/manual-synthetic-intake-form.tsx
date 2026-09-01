"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import {
  createManualSyntheticEncounterAction,
  type ManualSyntheticEncounterActionState,
} from "@/app/encounters/actions";

import styles from "./encounter-selection.module.css";

const initialState: ManualSyntheticEncounterActionState = { status: "idle" };

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button className={styles.primaryButton} disabled={pending} type="submit">
      {pending ? "创建中" : "创建病例"}
    </button>
  );
}

export function ManualSyntheticIntakeForm({ creationRequestId }: { creationRequestId: string }) {
  const [state, action] = useActionState(createManualSyntheticEncounterAction, initialState);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.status === "error") errorRef.current?.focus();
  }, [state.status]);

  return (
    <form action={action} className={styles.manualForm}>
      <input name="creationRequestId" type="hidden" value={creationRequestId} />
      <div className={styles.manualFormIntro}>
        <h2>接诊信息</h2>
      </div>

      {state.status === "error" && (
        <p ref={errorRef} className={styles.error} role="alert" tabIndex={-1}>{state.message}</p>
      )}

      <div className={styles.manualFields}>
        <label>
          <span>专科</span>
          <select defaultValue="" name="specialty" required>
            <option disabled value="">请选择专科</option>
            <option value="普通内科">普通内科</option>
            <option value="内分泌科">内分泌科</option>
          </select>
        </label>
        <label>
          <span>就诊类型</span>
          <select defaultValue="" name="visitType" required>
            <option disabled value="">请选择就诊类型</option>
            <option value="初诊">初诊</option>
            <option value="慢病复诊">慢病复诊</option>
          </select>
        </label>
        <label>
          <span>性别</span>
          <select defaultValue="" name="sex" required>
            <option disabled value="">请选择性别</option>
            <option value="FEMALE">女</option>
            <option value="MALE">男</option>
            <option value="INTERSEX">其他受控值</option>
          </select>
        </label>
        <label>
          <span>年龄</span>
          <input aria-describedby="manual-age-help" max="150" min="0" name="age" required step="1" type="number" />
          <small id="manual-age-help">0–150 岁，按整数记录</small>
        </label>
      </div>

      <div className={styles.manualFormFooter}>
        <SubmitButton />
      </div>
    </form>
  );
}
