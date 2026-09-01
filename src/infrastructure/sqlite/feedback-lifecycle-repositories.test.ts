import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { feedbackEventRecordSchema, reviewDecisionRecordSchema } from "@/domain/runtime-records";
import { createFeedbackEventRepository } from "./repositories/feedback-event-repository";
import { createReviewDecisionRepository } from "./repositories/review-decision-repository";
import { openRuntimeDatabase } from "./connection";
import { PersistenceError, persistenceErrorCodes } from "./errors";
import { fixtureGenerationRun } from "./test-fixtures";
import { createGenerationRunRepository } from "./repositories/generation-run-repository";

// SYNTHETIC_TEST_ONLY: runtime-built corruption marker avoids public email-like literals.
const syntheticCorruptMarker = ["not-json-with-synthetic", "example.invalid"].join("@");

describe("feedback lifecycle repositories", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:" });
    createGenerationRunRepository(database).insert(fixtureGenerationRun({ id: "run-feedback-repository" }));
  });

  afterEach(() => database.close());

  function event(id = "feedback-repository-001") {
    return feedbackEventRecordSchema.parse({
      schemaVersion: "1.0.0",
      id,
      eventType: "FEEDBACK_CLASSIFIED",
      generationRunId: "run-feedback-repository",
      proposalId: `${id}:proposal`,
      profileId: "profile-repository",
      profileVersion: 1,
      rulesVersion: "feedback-rules-v1",
      changeType: "REWRITE",
      status: "HELD_FOR_REVIEW",
      riskLevel: "MEDIUM",
      decision: "PENDING",
      affectedField: "summary",
      ruleHits: ["MEDIUM_CONTENT_REVIEW"],
      safetyReason: "内容变化需要审核。",
      nextAllowedActions: ["REVIEW_APPROVE", "REVIEW_REJECT"],
      evidence: {
        operationCount: 1,
        addedLineCount: 1,
        removedLineCount: 1,
        addedCharacterCount: 2,
        removedCharacterCount: 2,
        orderChanged: false,
      },
      createdAt: "2026-08-19T00:00:01.000Z",
    });
  }

  it("appends and queries immutable feedback events without正文 fields", () => {
    const repository = createFeedbackEventRepository(database);
    const first = event();
    repository.append(first);

    expect(repository.getById(first.id)).toEqual(first);
    expect(repository.listByGenerationRun(first.generationRunId)).toEqual([first]);
    expect(repository.listByStatusRisk("HELD_FOR_REVIEW", "MEDIUM")).toEqual([first]);
    expect(JSON.stringify(repository.getById(first.id))).not.toContain("before");
    expect(JSON.stringify(repository.getById(first.id))).not.toContain("after");

    expect(() => repository.append(first)).toThrow(PersistenceError);
    try {
      repository.append(first);
    } catch (error) {
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.CONFLICT);
    }
  });

  it("returns a redacted corruption error for damaged stored JSON", () => {
    const repository = createFeedbackEventRepository(database);
    const first = event();
    repository.append(first);
    database.prepare("UPDATE feedback_events SET evidence_json = ? WHERE id = ?").run(`{${syntheticCorruptMarker}}`, first.id);

    try {
      repository.getById(first.id);
      throw new Error("Expected data corruption.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.DATA_CORRUPTION);
      expect((error as Error).message).not.toContain(syntheticCorruptMarker);
    }
  });

  it("allows at most one review decision per feedback event", () => {
    const feedbackRepository = createFeedbackEventRepository(database);
    const reviewRepository = createReviewDecisionRepository(database);
    const first = event();
    feedbackRepository.append(first);
    const decision = reviewDecisionRecordSchema.parse({
      schemaVersion: "1.0.0",
      id: "decision-repository-001",
      feedbackEventId: first.id,
      actorId: "demo-reviewer",
      simulatedRole: "REVIEWER",
      decision: "APPROVED",
      rationale: "审核通过，但不写入个人画像。",
      createdAt: "2026-08-19T00:00:02.000Z",
    });
    reviewRepository.append(decision);
    expect(reviewRepository.getById(decision.id)).toEqual(decision);
    expect(reviewRepository.getByFeedbackEvent(first.id)).toEqual(decision);

    expect(() => reviewRepository.append({ ...decision, id: "decision-repository-002" })).toThrow(PersistenceError);
    try {
      reviewRepository.append({ ...decision, id: "decision-repository-003" });
    } catch (error) {
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.CONFLICT);
    }
  });

  it("blocks suspected PII before storing an event", () => {
    const repository = createFeedbackEventRepository(database);
    const unsafe = event("feedback-pii");
    expect(() => repository.append({ ...unsafe, safetyReason: "姓名：合成患者" })).toThrow(PersistenceError);
    expect(repository.getById(unsafe.id)).toBeUndefined();
  });
});
