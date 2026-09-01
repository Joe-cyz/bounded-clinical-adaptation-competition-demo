"use server";

import {
  createPersistenceFailureResult,
  executeGenerationComparison,
  GENERATION_RULE_IDS,
  parseGenerationRequest,
  type GenerationComparisonResult,
} from "@/application/generation-service";
import {
  REVISION_RULE_IDS,
  saveDraftRevision,
  type SaveDraftRevisionResult,
} from "@/application/draft-revision-service";
import {
  FEEDBACK_ACTION_RULE_IDS,
  confirmCandidateAction as confirmCandidate,
  dismissCandidateAction as dismissCandidate,
  freezeProfileAction as freezeProfile,
  reviewFeedbackAction as reviewFeedback,
  rollbackProfileAction as rollbackProfile,
  type FeedbackActionFailure,
} from "@/application/feedback-lifecycle-service";
import { getDatabase } from "@/server/database";
import { resolveProvider } from "@/server/provider";
import { providerSelectionSchema } from "@/domain/provider";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import { createRandomSystemId } from "@/application/system-id";

function publicReadOnlyGenerationResult(): GenerationComparisonResult {
  const requestId = createRandomSystemId("public-demo-request");
  const provider = {
    id: "deterministic-mock",
    modelId: "deterministic-rule-generator",
    promptVersion: "mock-prompt-v1",
    executionType: "MOCK" as const,
    networkCall: false,
  };
  const error = {
    ruleId: GENERATION_RULE_IDS.RUNTIME_READ_ONLY,
    errorType: "CONFIGURATION" as const,
    message: PUBLIC_DEMO_READ_ONLY_MESSAGE,
    persisted: false,
  };
  return {
    requestId,
    status: "FAILED",
    provider,
    generic: { mode: "GENERIC", status: "NOT_RUN", provider, error },
    bounded: { mode: "BOUNDED", status: "NOT_RUN", provider, error },
  };
}

export async function runGenerationAction(input: unknown): Promise<GenerationComparisonResult> {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyGenerationResult();

  const parsedRequest = parseGenerationRequest(input);
  const rawSelection = typeof input === "object" && input !== null && "providerSelection" in input
    ? (input as { providerSelection?: unknown }).providerSelection
    : "MOCK";
  const parsedSelection = providerSelectionSchema.safeParse(rawSelection);
  const selection = parsedSelection.success ? parsedSelection.data : "MOCK";
  const resolved = resolveProvider(
    parsedSelection.success ? parsedSelection.data : rawSelection,
    { mockMode: parsedRequest?.mockMode ?? "SUCCESS" },
  );
  if (!resolved.ok) {
    const provider = selection === "DEEPSEEK"
      ? { id: "deepseek", modelId: "deepseek-v4-flash", promptVersion: "deepseek-draft-v1", executionType: "REAL" as const, networkCall: true }
      : { id: "deterministic-mock", modelId: "deterministic-rule-generator", promptVersion: "mock-prompt-v1", executionType: "MOCK" as const, networkCall: false };
    const error = {
      ruleId: "GENERATION_CONFIG_BLOCKED" as const,
      errorType: "CONFIGURATION" as const,
      message: `${resolved.ruleId} · ${resolved.message}`,
      persisted: false,
    };
    return {
      requestId: createRandomSystemId("provider-selection-blocked"),
      status: "FAILED",
      provider,
      generic: { mode: "GENERIC", status: "NOT_RUN", provider, error },
      bounded: { mode: "BOUNDED", status: "NOT_RUN", provider, error },
    };
  }
  const provider = resolved.provider;

  try {
    return await executeGenerationComparison(input, {
      database: getDatabase(),
      provider,
    });
  } catch {
    return createPersistenceFailureResult(provider);
  }
}

export async function saveDraftRevisionAction(input: unknown): Promise<SaveDraftRevisionResult> {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) {
    return {
      ok: false,
      ruleId: REVISION_RULE_IDS.RUNTIME_READ_ONLY,
      message: PUBLIC_DEMO_READ_ONLY_MESSAGE,
      auditPersisted: false,
    };
  }

  try {
    return saveDraftRevision(input, { database: getDatabase() });
  } catch {
    return {
      ok: false,
      ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED,
      message: "修订与审计持久化失败，已回滚。",
      auditPersisted: false,
    };
  }
}

function feedbackTransportFailure(): FeedbackActionFailure {
  return {
    ok: false,
    ruleId: FEEDBACK_ACTION_RULE_IDS.PERSISTENCE_FAILED,
    message: "反馈请求未完成，服务端未返回成功结果。",
  };
}

function publicReadOnlyFeedbackFailure(): FeedbackActionFailure {
  return {
    ok: false,
    ruleId: FEEDBACK_ACTION_RULE_IDS.RUNTIME_READ_ONLY,
    message: PUBLIC_DEMO_READ_ONLY_MESSAGE,
  };
}

export async function confirmCandidateAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFeedbackFailure();
  try {
    return confirmCandidate(input, { database: getDatabase() });
  } catch {
    return feedbackTransportFailure();
  }
}

export async function dismissCandidateAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFeedbackFailure();
  try {
    return dismissCandidate(input, { database: getDatabase() });
  } catch {
    return feedbackTransportFailure();
  }
}

export async function reviewFeedbackAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFeedbackFailure();
  try {
    return reviewFeedback(input, { database: getDatabase() });
  } catch {
    return feedbackTransportFailure();
  }
}

export async function freezeProfileAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFeedbackFailure();
  try {
    return freezeProfile(input, { database: getDatabase() });
  } catch {
    return feedbackTransportFailure();
  }
}

export async function rollbackProfileAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFeedbackFailure();
  try {
    return rollbackProfile(input, { database: getDatabase() });
  } catch {
    return feedbackTransportFailure();
  }
}
