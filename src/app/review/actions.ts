"use server";

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
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";

function transportFailure(): FeedbackActionFailure {
  return {
    ok: false,
    ruleId: "FEEDBACK_PERSISTENCE_FAILED",
    message: "审核请求未完成，服务端未返回成功结果。",
  };
}

function publicReadOnlyFailure(): FeedbackActionFailure {
  return {
    ok: false,
    ruleId: FEEDBACK_ACTION_RULE_IDS.RUNTIME_READ_ONLY,
    message: PUBLIC_DEMO_READ_ONLY_MESSAGE,
  };
}

export async function confirmFeedbackCandidateAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFailure();
  try {
    return confirmCandidate(input, { database: getDatabase() });
  } catch {
    return transportFailure();
  }
}

export async function dismissFeedbackCandidateAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFailure();
  try {
    return dismissCandidate(input, { database: getDatabase() });
  } catch {
    return transportFailure();
  }
}

export async function reviewFeedbackEventAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFailure();
  try {
    return reviewFeedback(input, { database: getDatabase() });
  } catch {
    return transportFailure();
  }
}

export async function freezeProfileReviewAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFailure();
  try {
    return freezeProfile(input, { database: getDatabase() });
  } catch {
    return transportFailure();
  }
}

export async function rollbackProfileReviewAction(input: unknown) {
  const writeGate = assertRuntimeWriteAllowed();
  if (!writeGate.ok) return publicReadOnlyFailure();
  try {
    return rollbackProfile(input, { database: getDatabase() });
  } catch {
    return transportFailure();
  }
}
