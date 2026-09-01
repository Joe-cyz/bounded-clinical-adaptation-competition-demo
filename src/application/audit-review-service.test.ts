import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { syntheticCases, physicianProfiles } from "@/data/seed-loader";
import { createDeterministicMockProvider } from "@/infrastructure/providers/deterministic-mock-provider";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createFeedbackEventRepository } from "@/infrastructure/sqlite/repositories/feedback-event-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { executeGenerationComparison, type GenerationIdFactory } from "./generation-service";
import { saveDraftRevision, type DraftRevisionIdFactory } from "./draft-revision-service";
import { confirmCandidateAction, freezeProfileAction, reviewFeedbackAction } from "./feedback-lifecycle-service";
import {
  buildGenerationTrace,
  listAuditReadModel,
  listFeedbackReadModel,
  listProfileReadModel,
} from "./audit-review-service";
import type { GeneratedDraft } from "@/domain/schemas";

const fixedClock = () => "2026-08-19T00:00:00.000Z";

function ids(prefix: string): GenerationIdFactory {
  let sequence = 0;
  return (kind) => `${prefix}-${kind.toLowerCase()}-${++sequence}`;
}

function revisionIds(prefix: string): DraftRevisionIdFactory {
  let sequence = 0;
  return (kind) => `${prefix}-${kind.toLowerCase()}-${++sequence}`;
}

function sectionsFrom(draft: GeneratedDraft) {
  return draft.sections.map((section) => ({ key: section.key, content: [...section.content] }));
}

async function createRun(database: DatabaseSync, prefix: string, mockMode: "SUCCESS" | "INVALID_OUTPUT_RULE" = "SUCCESS") {
  const result = await executeGenerationComparison(
    { caseId: syntheticCases[0].id, profileId: physicianProfiles[0].id, mockMode },
    { database, provider: createDeterministicMockProvider(mockMode), clock: fixedClock, idFactory: ids(prefix) },
  );
  return { result, runId: result.bounded.runId!, draft: result.bounded.draft };
}

describe("audit and review read model", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
  });

  afterEach(() => database.close());

  it("builds a complete trace from run through revision and feedback", async () => {
    const generated = await createRun(database, "trace");
    expect(generated.draft).toBeDefined();
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("trace-revision") },
    );
    expect(saved.ok).toBe(true);

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "COMPLETE", runId: generated.runId } });
    if (!trace.ok) return;
    expect(trace.data.revisions).toHaveLength(1);
    expect(trace.data.feedback).toHaveLength(1);
    expect(trace.data.profiles[0].seedBridged).toBe(false);
    expect(trace.data.highRiskBodyStored).toBe(false);
  });

  it("keeps the high-risk path without a revision body", async () => {
    const generated = await createRun(database, "high-trace", "SUCCESS");
    const draft = generated.draft!;
    const unsafe = sectionsFrom(draft).map((section) => section.key === "summary"
      ? { ...section, content: ["以后自动诊断并开药"] }
      : section);
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: unsafe },
      { database, clock: fixedClock, idFactory: revisionIds("high-trace-revision") },
    );
    expect(saved.ok).toBe(false);

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "COMPLETE", revisions: [], highRiskBodyStored: false } });
    if (trace.ok) expect(trace.data.feedback[0].riskLevel).toBe("HIGH");
  });

  it("shows incomplete relation warnings when a stored revision is removed", async () => {
    const generated = await createRun(database, "incomplete");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("incomplete-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    database.exec("PRAGMA foreign_keys = OFF;");
    database.prepare("DELETE FROM draft_revisions WHERE id = ?").run(saved.revision.id);
    database.exec("PRAGMA foreign_keys = ON;");

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "INCOMPLETE" } });
    if (trace.ok) expect(trace.data.missingRelations).toContain(`DRAFT_REVISION:${saved.revision.id}`);
  });

  it("returns CORRUPTED without echoing broken JSON", async () => {
    const generated = await createRun(database, "corrupt");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("corrupt-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    database.prepare("UPDATE draft_revisions SET after_json = ? WHERE id = ?").run("secret-corrupt-payload", saved.revision.id);

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "CORRUPTED", revisions: [], feedback: [] } });
    expect(JSON.stringify(trace)).not.toContain("secret-corrupt-payload");
  });

  it("reads seed profiles, persisted decisions and filtered feedback as safe DTOs", async () => {
    const generated = await createRun(database, "dto");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("dto-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const confirmed = confirmCandidateAction(
      { feedbackEventId: saved.feedbackEvents[0].id, expectedProfileVersion: 1 },
      { database, clock: fixedClock },
    );
    expect(confirmed.ok).toBe(true);

    const profiles = listProfileReadModel(database);
    const feedback = listFeedbackReadModel(database, { hasDecision: true });
    const audits = listAuditReadModel(database, { entityType: "PHYSICIAN_PROFILE" });
    expect(profiles.ok).toBe(true);
    expect(feedback.ok).toBe(true);
    expect(audits.ok).toBe(true);
    if (profiles.ok) expect(profiles.data.profiles[0].history.map((version) => version.version)).toEqual([1, 2]);
    if (feedback.ok) expect(feedback.data.events[0].decisionRecord?.decision).toBe("CONFIRMED");
    if (audits.ok) expect(audits.data.events.every((event) => event.entityType === "PHYSICIAN_PROFILE")).toBe(true);
  });

  it("keeps the confirmed candidate trace complete with decision and profile audits", async () => {
    const generated = await createRun(database, "confirmed-trace");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("confirmed-trace-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    expect(confirmCandidateAction(
      { feedbackEventId: event.id, expectedProfileVersion: event.profileVersion },
      { database, clock: fixedClock },
    )).toMatchObject({ ok: true });

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "COMPLETE" } });
    if (!trace.ok) return;
    const confirmedAudit = trace.data.audits.find((audit) => audit.eventType === "CANDIDATE_CONFIRMED");
    const profileAudit = trace.data.audits.find((audit) => audit.eventType === "PROFILE_VERSION_CREATED" && audit.afterVersion === "2");
    expect(confirmedAudit?.metadata.generationRunId).toBe(generated.runId);
    expect(profileAudit?.metadata).toMatchObject({ generationRunId: generated.runId, feedbackEventId: event.id, profileId: event.profileId });
    expect(trace.data.profiles.find((profile) => profile.id === event.profileId)?.history.map((version) => version.version)).toEqual([1, 2]);
  });

  it("associates legacy decision audits without generationRunId through trusted entity and version links", async () => {
    const generated = await createRun(database, "legacy-trace");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("legacy-trace-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    expect(confirmCandidateAction(
      { feedbackEventId: event.id, expectedProfileVersion: event.profileVersion },
      { database, clock: fixedClock },
    )).toMatchObject({ ok: true });

    const auditRepository = createAuditEventRepository(database);
    const related = [
      ...auditRepository.listByEntity("FEEDBACK_EVENT", event.id).filter((audit) => audit.eventType === "CANDIDATE_CONFIRMED"),
      ...auditRepository.listByEntity("PHYSICIAN_PROFILE", event.profileId).filter((audit) => audit.eventType === "PROFILE_VERSION_CREATED" && audit.afterVersion === "2"),
    ];
    database.exec("DROP TRIGGER audit_events_no_update");
    for (const audit of related) {
      const row = database.prepare("SELECT metadata_json FROM audit_events WHERE id = ?").get(audit.id) as { metadata_json: string };
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      delete metadata.generationRunId;
      database.prepare("UPDATE audit_events SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), audit.id);
    }

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "COMPLETE" } });
  });

  it("marks a trace incomplete when the confirmation audit is removed", async () => {
    const generated = await createRun(database, "missing-confirmation-audit");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("missing-confirmation-audit-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    expect(confirmCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: 1 }, { database, clock: fixedClock })).toMatchObject({ ok: true });
    const audit = createAuditEventRepository(database).listByEntity("FEEDBACK_EVENT", event.id)
      .find((candidate) => candidate.eventType === "CANDIDATE_CONFIRMED");
    expect(audit).toBeDefined();
    database.exec("DROP TRIGGER audit_events_no_delete");
    database.prepare("DELETE FROM audit_events WHERE id = ?").run(audit!.id);

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "INCOMPLETE" } });
    if (trace.ok) expect(trace.data.missingRelations).toContain(`AUDIT:DECISION:${event.id}`);
  });

  it("marks a trace incomplete when the confirmed profile version or creation audit is missing", async () => {
    const generated = await createRun(database, "missing-profile-version");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("missing-profile-version-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    expect(confirmCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: 1 }, { database, clock: fixedClock })).toMatchObject({ ok: true });
    const profileAudit = createAuditEventRepository(database).listByEntity("PHYSICIAN_PROFILE", event.profileId)
      .find((audit) => audit.eventType === "PROFILE_VERSION_CREATED" && audit.afterVersion === "2");
    expect(profileAudit).toBeDefined();
    database.exec("DROP TRIGGER audit_events_no_delete");
    database.prepare("DELETE FROM audit_events WHERE id = ?").run(profileAudit!.id);
    database.prepare("DELETE FROM physician_profile_versions WHERE profile_id = ? AND version = ?").run(event.profileId, 2);

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "INCOMPLETE" } });
    if (trace.ok) {
      expect(trace.data.missingRelations).toContain(`PROFILE_VERSION:${event.profileId}@2`);
      expect(trace.data.missingRelations).toContain(`AUDIT:PROFILE_VERSION_CREATED:${event.profileId}@2`);
    }
  });

  it("does not require profile creation for approved or rejected review decisions", async () => {
    const makeReviewedRun = async (prefix: string, decision: "APPROVE" | "REJECT") => {
      const generated = await createRun(database, prefix);
      const sections = sectionsFrom(generated.draft!).map((section) => section.key === "summary"
        ? { ...section, content: [...section.content, "合成表达调整，保留人工复核"] }
        : section);
      const saved = saveDraftRevision(
        { generationRunId: generated.runId, sections },
        { database, clock: fixedClock, idFactory: revisionIds(`${prefix}-revision`) },
      );
      expect(saved.ok).toBe(true);
      if (!saved.ok) return undefined;
      expect(reviewFeedbackAction(
        { feedbackEventId: saved.feedbackEvents[0].id, decision, rationale: "记录审核决定，不更新个人画像。" },
        { database, clock: fixedClock },
      )).toMatchObject({ ok: true });
      return generated.runId;
    };

    const approvedRunId = await makeReviewedRun("review-approved-trace", "APPROVE");
    const rejectedRunId = await makeReviewedRun("review-rejected-trace", "REJECT");
    expect(approvedRunId).toBeDefined();
    expect(rejectedRunId).toBeDefined();
    if (!approvedRunId || !rejectedRunId) return;
    expect(buildGenerationTrace(database, approvedRunId)).toMatchObject({ ok: true, data: { traceIntegrity: "COMPLETE" } });
    expect(buildGenerationTrace(database, rejectedRunId)).toMatchObject({ ok: true, data: { traceIntegrity: "COMPLETE" } });
  });

  it("does not mix unrelated profile freeze audits into a confirmed run trace", async () => {
    const generated = await createRun(database, "unrelated-profile-audit");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("unrelated-profile-audit-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = saved.feedbackEvents[0];
    expect(confirmCandidateAction({ feedbackEventId: event.id, expectedProfileVersion: 1 }, { database, clock: fixedClock })).toMatchObject({ ok: true });
    expect(freezeProfileAction(
      { profileId: event.profileId, expectedProfileVersion: 2, confirmation: "FREEZE_PROFILE" },
      { database, clock: fixedClock },
    )).toMatchObject({ ok: true });

    const trace = buildGenerationTrace(database, generated.runId);
    expect(trace).toMatchObject({ ok: true, data: { traceIntegrity: "COMPLETE" } });
    if (trace.ok) expect(trace.data.audits.some((audit) => audit.eventType === "PROFILE_FROZEN")).toBe(false);
  });

  it("does not expose unsafe raw repository contents in the read model", () => {
    const repository = createAuditEventRepository(database);
    repository.append({
      schemaVersion: "1.0.0",
      id: "audit-read-safe",
      eventType: "GENERATION_RUN_RECORDED",
      actorId: "system",
      simulatedRole: "SYSTEM",
      entityType: "GENERATION_RUN",
      entityId: "run-read-safe",
      metadata: { requestId: "request-read-safe", internalSecret: "not-allowlisted" },
      createdAt: fixedClock(),
    });
    const result = listAuditReadModel(database);
    expect(result).toMatchObject({ ok: true, data: { events: [{ id: "audit-read-safe", metadata: { requestId: "request-read-safe" } }] } });
    if (result.ok) expect(result.data.events[0].metadata).not.toHaveProperty("internalSecret");
  });

  it("keeps profile version binding server-side after confirmation", async () => {
    const generated = await createRun(database, "profile-binding");
    const saved = saveDraftRevision(
      { generationRunId: generated.runId, sections: [...sectionsFrom(generated.draft!)].reverse() },
      { database, clock: fixedClock, idFactory: revisionIds("profile-binding-revision") },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const event = createFeedbackEventRepository(database).getById(saved.feedbackEvents[0].id)!;
    expect(event.profileId).toBe(physicianProfiles[0].id);
    expect(createPhysicianProfileVersionRepository(database).listHistory(event.profileId)).toEqual([]);
  });
});
