import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { executeGenerationComparison, type GenerationIdFactory } from "./generation-service";
import {
  FEEDBACK_ACTION_RULE_IDS,
  confirmCandidateAction,
  dismissCandidateAction,
  freezeProfileAction,
  reviewFeedbackAction,
  rollbackProfileAction,
} from "./feedback-lifecycle-service";
import { saveDraftRevision, type DraftRevisionIdFactory } from "./draft-revision-service";
import { createDraftRevisionRepository } from "@/infrastructure/sqlite/repositories/draft-revision-repository";
import { createFeedbackEventRepository } from "@/infrastructure/sqlite/repositories/feedback-event-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { createReviewDecisionRepository } from "@/infrastructure/sqlite/repositories/review-decision-repository";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createDeterministicMockProvider } from "@/infrastructure/providers/deterministic-mock-provider";
import { physicianProfiles, syntheticCases } from "@/data/seed-loader";
import type { GeneratedDraft } from "@/domain/schemas";

const fixedClock = () => "2026-08-19T00:00:00.000Z";

function generationIds(prefix: string): GenerationIdFactory {
  let sequence = 0;
  return (kind) => `${prefix}-${kind.toLowerCase()}-${++sequence}`;
}

function revisionIds(prefix: string): DraftRevisionIdFactory {
  let sequence = 0;
  return (kind) => `${prefix}-${kind.toLowerCase()}-${++sequence}`;
}

function request(profileId = physicianProfiles[0].id) {
  return { caseId: syntheticCases[0].id, profileId, mockMode: "SUCCESS" as const };
}

async function createBoundedRun(database: DatabaseSync, prefix = "feedback-run", profileId = physicianProfiles[0].id) {
  const result = await executeGenerationComparison(request(profileId), {
    database,
    provider: createDeterministicMockProvider(),
    clock: fixedClock,
    idFactory: generationIds(prefix),
  });
  if (result.bounded.status !== "SUCCEEDED" || !result.bounded.runId || !result.bounded.draft) throw new Error("Expected bounded run.");
  return { runId: result.bounded.runId, draft: result.bounded.draft };
}

function sectionsFrom(draft: GeneratedDraft) {
  return draft.sections.map((section) => ({ key: section.key, content: [...section.content] }));
}

describe("feedback lifecycle", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
  });

  afterEach(() => database.close());

  it("requires explicit confirmation before creating a profile version", async () => {
    const { runId, draft } = await createBoundedRun(database);
    const reordered = [...sectionsFrom(draft)].reverse();
    const saved = saveDraftRevision(
      { generationRunId: runId, sections: reordered },
      { database, clock: fixedClock, idFactory: revisionIds("low") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.feedbackEvents).toHaveLength(1);
    const event = saved.feedbackEvents[0];
    expect(event).toMatchObject({ riskLevel: "LOW", status: "CANDIDATE", decision: "PENDING", affectedField: "sectionOrder" });
    expect(createPhysicianProfileVersionRepository(database).listHistory(event.profileId)).toEqual([]);

    const confirmed = confirmCandidateAction(
      { feedbackEventId: event.id, expectedProfileVersion: event.profileVersion },
      { database, clock: fixedClock },
    );
    expect(confirmed).toMatchObject({ ok: true, action: "CONFIRMED" });
    if (!confirmed.ok) return;
    expect(confirmed.profileVersion.version).toBe(2);
    expect(confirmed.profileVersion.sourceType).toBe("CONFIRMED_FEEDBACK");
    expect(createPhysicianProfileVersionRepository(database).listHistory(event.profileId).map((item) => item.version)).toEqual([1, 2]);
    expect(createReviewDecisionRepository(database).getByFeedbackEvent(event.id)?.decision).toBe("CONFIRMED");

    const duplicate = confirmCandidateAction(
      { feedbackEventId: event.id, expectedProfileVersion: 1 },
      { database, clock: fixedClock },
    );
    expect(duplicate).toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT });
  });

  it("rejects a stale low-risk candidate after another candidate advances the profile", async () => {
    const firstRun = await createBoundedRun(database, "stale-a");
    const firstSaved = saveDraftRevision(
      { generationRunId: firstRun.runId, sections: [...sectionsFrom(firstRun.draft)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("stale-a-rev") },
    );
    const secondRun = await createBoundedRun(database, "stale-b");
    const secondSaved = saveDraftRevision(
      { generationRunId: secondRun.runId, sections: [...sectionsFrom(secondRun.draft)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("stale-b-rev") },
    );
    expect(firstSaved.ok).toBe(true);
    expect(secondSaved.ok).toBe(true);
    if (!firstSaved.ok || !secondSaved.ok) return;

    const confirmed = confirmCandidateAction(
      { feedbackEventId: secondSaved.feedbackEvents[0].id, expectedProfileVersion: 1 },
      { database, clock: fixedClock },
    );
    expect(confirmed.ok).toBe(true);
    const stale = confirmCandidateAction(
      { feedbackEventId: firstSaved.feedbackEvents[0].id, expectedProfileVersion: 2 },
      { database, clock: fixedClock },
    );
    expect(stale).toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT });
    expect(createReviewDecisionRepository(database).getByFeedbackEvent(firstSaved.feedbackEvents[0].id)).toBeUndefined();
    expect(createPhysicianProfileVersionRepository(database).listHistory(firstSaved.feedbackEvents[0].profileId).map((item) => item.version))
      .toEqual([1, 2]);

    const dismissed = dismissCandidateAction(
      { feedbackEventId: firstSaved.feedbackEvents[0].id, expectedProfileVersion: 1 },
      { database, clock: fixedClock },
    );
    expect(dismissed).toMatchObject({ ok: true, action: "DISMISSED" });
  });

  it("does not leave a seed baseline when confirmation or freeze has a wrong expected version", async () => {
    const { runId, draft } = await createBoundedRun(database, "empty-conflict");
    const saved = saveDraftRevision(
      { generationRunId: runId, sections: [...sectionsFrom(draft)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("empty-conflict-rev") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const profileId = saved.feedbackEvents[0].profileId;
    const wrongConfirm = confirmCandidateAction(
      { feedbackEventId: saved.feedbackEvents[0].id, expectedProfileVersion: 2 },
      { database, clock: fixedClock },
    );
    expect(wrongConfirm).toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT });
    expect(createPhysicianProfileVersionRepository(database).listHistory(profileId)).toEqual([]);

    const wrongFreeze = freezeProfileAction(
      { profileId: physicianProfiles[1].id, expectedProfileVersion: 2, confirmation: "FREEZE_PROFILE" },
      { database, clock: fixedClock },
    );
    expect(wrongFreeze).toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT });
    expect(createPhysicianProfileVersionRepository(database).listHistory(physicianProfiles[1].id)).toEqual([]);
  });

  it("rolls back all writes when an audit ID conflicts inside confirmation", async () => {
    const { runId, draft } = await createBoundedRun(database, "atomic-conflict");
    const saved = saveDraftRevision(
      { generationRunId: runId, sections: [...sectionsFrom(draft)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("atomic-conflict-rev") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const event = saved.feedbackEvents[0];
    const result = confirmCandidateAction(
      { feedbackEventId: event.id, expectedProfileVersion: 1 },
      { database, clock: fixedClock, idFactory: () => "atomic-conflict-id" },
    );
    expect(result.ok).toBe(false);
    expect(createPhysicianProfileVersionRepository(database).listHistory(event.profileId)).toEqual([]);
    expect(createReviewDecisionRepository(database).getByFeedbackEvent(event.id)).toBeUndefined();
    expect(createAuditEventRepository(database).listByEntity("PHYSICIAN_PROFILE", event.profileId))
      .toEqual([]);
  });

  it("dismisses a low-risk candidate without creating a profile version", async () => {
    const { runId, draft } = await createBoundedRun(database, "dismiss");
    const saved = saveDraftRevision(
      { generationRunId: runId, sections: [...sectionsFrom(draft)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("dismiss-rev") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    const dismissed = dismissCandidateAction(
      { feedbackEventId: event.id, expectedProfileVersion: event.profileVersion },
      { database, clock: fixedClock },
    );
    expect(dismissed).toMatchObject({ ok: true, action: "DISMISSED" });
    expect(createPhysicianProfileVersionRepository(database).listHistory(event.profileId)).toEqual([]);
  });

  it("holds content changes for review and never writes an approved medium event to the profile", async () => {
    const { runId, draft } = await createBoundedRun(database, "review");
    const sections = sectionsFrom(draft).map((section) => section.key === "summary"
      ? { ...section, content: [...section.content, "医生调整表达，但仍需审核"] }
      : section);
    const saved = saveDraftRevision(
      { generationRunId: runId, sections },
      { database, clock: fixedClock, idFactory: revisionIds("review-rev") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    expect(event).toMatchObject({ riskLevel: "MEDIUM", status: "HELD_FOR_REVIEW" });
    const approved = reviewFeedbackAction(
      { feedbackEventId: event.id, decision: "APPROVE", rationale: "审核通过表达变化，但不更新个人画像。" },
      { database, clock: fixedClock },
    );
    expect(approved).toMatchObject({ ok: true, action: "APPROVED", profileUpdated: false });
    expect(createPhysicianProfileVersionRepository(database).listHistory(event.profileId)).toEqual([]);
  });

  it("rejects suspected PII in a review rationale without persisting the decision", async () => {
    const { runId, draft } = await createBoundedRun(database, "review-pii");
    const sections = sectionsFrom(draft).map((section) => section.key === "summary"
      ? { ...section, content: [...section.content, "医生调整表达"] }
      : section);
    const saved = saveDraftRevision(
      { generationRunId: runId, sections },
      { database, clock: fixedClock, idFactory: revisionIds("review-pii-rev") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    const rejected = reviewFeedbackAction(
      { feedbackEventId: event.id, decision: "REJECT", rationale: "患者姓名：合成患者" },
      { database, clock: fixedClock },
    );
    expect(rejected).toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.RATIONALE_INVALID });
    expect(createReviewDecisionRepository(database).getByFeedbackEvent(event.id)).toBeUndefined();
  });

  it("rejects high-risk edits without saving a revision or dangerous正文", async () => {
    const { runId, draft } = await createBoundedRun(database, "high");
    const sections = sectionsFrom(draft).map((section) => section.key === "summary"
      ? { ...section, content: ["以后自动诊断并开药"] }
      : section);
    const saved = saveDraftRevision(
      { generationRunId: runId, sections },
      { database, clock: fixedClock, idFactory: revisionIds("high-rev") },
    );
    expect(saved).toMatchObject({ ok: false, riskLevel: "HIGH" });
    expect(JSON.stringify(saved)).not.toContain("以后自动诊断并开药");
    expect(createDraftRevisionRepository(database).listByGenerationRun(runId)).toEqual([]);
    if (!saved.ok) {
      expect(saved.feedbackEvents?.[0]).toMatchObject({ riskLevel: "HIGH", status: "REJECTED", decision: "REJECTED" });
      expect(JSON.stringify(createFeedbackEventRepository(database).listByGenerationRun(runId))).not.toContain("以后自动诊断并开药");
    }
  });

  it("closes mixed proposals when a high-risk event is present", async () => {
    const { runId, draft } = await createBoundedRun(database, "mixed");
    const sections = sectionsFrom(draft).map((section) => section.key === "summary"
      ? { ...section, content: ["以后自动诊断"] }
      : section).reverse();
    const saved = saveDraftRevision(
      { generationRunId: runId, sections },
      { database, clock: fixedClock, idFactory: revisionIds("mixed-rev") },
    );
    expect(saved).toMatchObject({ ok: false, riskLevel: "HIGH" });
    expect(createDraftRevisionRepository(database).listByGenerationRun(runId)).toEqual([]);
    if (!saved.ok) expect(saved.feedbackEvents?.every((event) => event.riskLevel === "HIGH")).toBe(true);
  });

  it("creates a frozen version that remains usable for generation but cannot be updated", async () => {
    const profileId = physicianProfiles[0].id;
    const frozen = freezeProfileAction(
      { profileId, expectedProfileVersion: 1, confirmation: "FREEZE_PROFILE" },
      { database, clock: fixedClock },
    );
    expect(frozen).toMatchObject({ ok: true, profileVersion: { version: 2, status: "FROZEN" } });
    const generated = await createBoundedRun(database, "frozen-generation");
    expect(generated.draft.physicianProfileVersion).toBe(2);
    const again = freezeProfileAction(
      { profileId, expectedProfileVersion: 2, confirmation: "FREEZE_PROFILE" },
      { database, clock: fixedClock },
    );
    expect(again).toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.PROFILE_FROZEN });
    const rollback = rollbackProfileAction(
      { profileId, targetVersion: 1, expectedProfileVersion: 2, confirmation: "ROLLBACK_PROFILE" },
      { database, clock: fixedClock },
    );
    expect(rollback).toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.PROFILE_FROZEN });
  });

  it("rolls back by appending a new active version with the target preferences", () => {
    const profileId = physicianProfiles[1].id;
    return createBoundedRun(database, "rollback", profileId).then(({ runId, draft }) => {
      const saved = saveDraftRevision(
        { generationRunId: runId, sections: [...sectionsFrom(draft)].reverse() },
        { database, clock: fixedClock, idFactory: revisionIds("rollback-rev") },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const confirmed = confirmCandidateAction(
        { feedbackEventId: saved.feedbackEvents[0].id, expectedProfileVersion: 1 },
        { database, clock: fixedClock },
      );
      expect(confirmed.ok).toBe(true);
      const rolledBack = rollbackProfileAction(
        { profileId, targetVersion: 1, expectedProfileVersion: 2, confirmation: "ROLLBACK_PROFILE" },
        { database, clock: fixedClock },
      );
      expect(rolledBack).toMatchObject({ ok: true, profileVersion: { version: 3, previousVersion: 2, sourceType: "ROLLBACK" } });
      if (rolledBack.ok) expect(rolledBack.profileVersion.preferences).toEqual(physicianProfiles[1].preferences);
    });
  });

  it("rejects reviewer role/status bypasses and duplicate decisions", async () => {
    const { runId, draft } = await createBoundedRun(database, "role");
    const saved = saveDraftRevision(
      { generationRunId: runId, sections: [...sectionsFrom(draft)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("role-rev") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    expect(reviewFeedbackAction({ feedbackEventId: event.id, decision: "APPROVE", rationale: "越权", simulatedRole: "REVIEWER" }, { database }))
      .toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.RATIONALE_INVALID });
    const confirmed = confirmCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: 1 }, { database, clock: fixedClock });
    expect(confirmed.ok).toBe(true);
    expect(dismissCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: 1 }, { database, clock: fixedClock }))
      .toMatchObject({ ok: false, ruleId: FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT });
    expect(createAuditEventRepository(database).listByEntity("FEEDBACK_EVENT", event.id).length).toBeGreaterThan(0);
  });
});
