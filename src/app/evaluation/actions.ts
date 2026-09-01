"use server";

import {
  EVALUATION_RULE_IDS,
  runEvaluationBatch,
  type EvaluationBatchOutcome,
} from "@/application/evaluation-service";
import { getDatabase } from "@/server/database";
import { resolveProvider } from "@/server/provider";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";

async function runSelectedEvaluation(selection: "MOCK" | "DEEPSEEK"): Promise<EvaluationBatchOutcome> {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) {
    return {
      ok: false,
      ruleId: EVALUATION_RULE_IDS.RUNTIME_READ_ONLY,
      message: PUBLIC_DEMO_READ_ONLY_MESSAGE,
    };
  }

  const resolved = resolveProvider(selection, { mockMode: "SUCCESS" });
  if (!resolved.ok) {
    return { ok: false, ruleId: "EVALUATION_CONFIGURATION_BLOCKED", message: `${resolved.ruleId} · ${resolved.message}` };
  }
  try {
    return await runEvaluationBatch({
      database: getDatabase(),
      provider: resolved.provider,
      executionType: resolved.provider.executionType ?? "MOCK",
      mockMode: "SUCCESS",
    });
  } catch {
    return {
      ok: false,
      ruleId: "EVALUATION_PERSISTENCE_FAILED",
      message: "评测请求未完成，未返回内部错误详情。",
    };
  }
}

export async function runEvaluationBatchAction(): Promise<EvaluationBatchOutcome> {
  return runSelectedEvaluation("MOCK");
}

export async function runDeepSeekEvaluationBatchAction(): Promise<EvaluationBatchOutcome> {
  return runSelectedEvaluation("DEEPSEEK");
}
