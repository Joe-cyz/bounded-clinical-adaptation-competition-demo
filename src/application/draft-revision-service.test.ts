import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  executeGenerationComparison,
  type GenerationIdFactory,
} from "./generation-service";
import {
  REVISION_RULE_IDS,
  saveDraftRevision,
  type DraftRevisionIdFactory,
} from "./draft-revision-service";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createDraftRevisionRepository } from "@/infrastructure/sqlite/repositories/draft-revision-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { fixtureAuditEvent } from "@/infrastructure/sqlite/test-fixtures";
import { physicianProfiles, syntheticCases } from "@/data/seed-loader";
import { createDeterministicMockProvider } from "@/infrastructure/providers/deterministic-mock-provider";
import type { GeneratedDraft } from "@/domain/schemas";

const fixedClock = () => "2026-08-19T00:00:00.000Z";

function generationIds(prefix = "revision-test"): GenerationIdFactory {
  let sequence = 0;
  return (kind) => `${prefix}-${kind.toLowerCase()}-${++sequence}`;
}

function revisionIds(prefix: string): DraftRevisionIdFactory {
  let sequence = 0;
  return (kind) => `${prefix}-${kind.toLowerCase()}-${++sequence}`;
}

function request() {
  return {
    caseId: syntheticCases[0].id,
    profileId: physicianProfiles[0].id,
    mockMode: "SUCCESS" as const,
  };
}

async function createBoundedRun(database: DatabaseSync): Promise<{ runId: string; draft: GeneratedDraft }> {
  const result = await executeGenerationComparison(request(), {
    database,
    provider: createDeterministicMockProvider(),
    clock: fixedClock,
    idFactory: generationIds("bounded"),
  });
  if (result.bounded.status !== "SUCCEEDED" || !result.bounded.runId || !result.bounded.draft) {
    throw new Error("Expected a bounded successful generation fixture.");
  }
  return { runId: result.bounded.runId, draft: result.bounded.draft };
}

function sectionsFrom(draft: GeneratedDraft) {
  return draft.sections.map((section) => ({ key: section.key, content: [...section.content] }));
}

function withSectionContent(
  sections: ReturnType<typeof sectionsFrom>,
  key: GeneratedDraft["sections"][number]["key"],
  content: string[],
) {
  return sections.map((section) => section.key === key ? { ...section, content } : section);
}

describe("draft revision service", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
  });

  afterEach(() => {
    database.close();
  });

  it("saves a first revision and replays a continuous immutable chain", async () => {
    const { runId, draft } = await createBoundedRun(database);
    const editedSections = withSectionContent(
      sectionsFrom(draft),
      "summary",
      [...draft.sections.find((section) => section.key === "summary")!.content, "医生偏好：使用简洁表达"],
    );
    const firstResult = saveDraftRevision(
      { generationRunId: runId, sections: editedSections },
      { database, clock: fixedClock, idFactory: revisionIds("first") },
    );

    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;
    expect(firstResult.revision.revisionNumber).toBe(1);
    expect(firstResult.revision.beforeSnapshot).toEqual(draft);
    expect(firstResult.revision.afterSnapshot.sections.find((section) => section.key === "summary")?.content).toContain("医生偏好：使用简洁表达");
    expect(firstResult.revision.diffSummary.metrics.changedSectionCount).toBe(1);
    expect(firstResult.history).toHaveLength(1);

    const secondSections = withSectionContent(
      firstResult.revision.afterSnapshot.sections.map((section) => ({ key: section.key, content: [...section.content] })),
      "problems",
      [...firstResult.revision.afterSnapshot.sections.find((section) => section.key === "problems")!.content, "第二次编辑"],
    );
    const secondResult = saveDraftRevision(
      { generationRunId: runId, expectedPreviousRevision: 1, sections: secondSections },
      { database, clock: fixedClock, idFactory: revisionIds("second") },
    );

    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    expect(secondResult.revision.revisionNumber).toBe(2);
    expect(secondResult.revision.beforeSnapshot).toEqual(firstResult.revision.afterSnapshot);
    expect(secondResult.history.map((summary) => summary.revisionNumber)).toEqual([1, 2]);
    expect(createGenerationRunRepository(database).getById(runId)?.outputDraftSnapshot).toEqual(draft);
    expect(createAuditEventRepository(database).listByEntity("DRAFT_REVISION", secondResult.revision.id)[0]).toMatchObject({
      eventType: "REVISION_SAVED",
      actorId: "demo-physician",
      simulatedRole: "PHYSICIAN",
      metadata: expect.objectContaining({ revisionNumber: 2, changedSectionCount: 1 }),
    });

    const reordered = saveDraftRevision(
      {
        generationRunId: runId,
        expectedPreviousRevision: 2,
        sections: [...secondResult.revision.afterSnapshot.sections]
          .reverse()
          .map((section) => ({ key: section.key, content: [...section.content] })),
      },
      { database, clock: fixedClock, idFactory: revisionIds("reorder") },
    );
    expect(reordered.ok).toBe(true);
    if (reordered.ok) {
      expect(reordered.revision.revisionNumber).toBe(3);
      expect(reordered.revision.diffSummary.orderChanged).toBe(true);
      expect(reordered.revision.diffSummary.metrics.changedSectionCount).toBe(0);
    }
  });

  it("blocks no changes and stale optimistic versions with stable audits", async () => {
    const { runId, draft } = await createBoundedRun(database);
    const first = saveDraftRevision(
      { generationRunId: runId, sections: withSectionContent(sectionsFrom(draft), "summary", ["一次编辑"]) },
      { database, clock: fixedClock, idFactory: revisionIds("first") },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const noChange = saveDraftRevision(
      { generationRunId: runId, expectedPreviousRevision: 1, sections: first.revision.afterSnapshot.sections.map((section) => ({ key: section.key, content: [...section.content] })) },
      { database, clock: fixedClock, idFactory: revisionIds("no-change") },
    );
    expect(noChange).toMatchObject({ ok: false, ruleId: REVISION_RULE_IDS.NO_CHANGES, auditPersisted: true });

    const conflict = saveDraftRevision(
      { generationRunId: runId, expectedPreviousRevision: 0, sections: sectionsFrom(draft) },
      { database, clock: fixedClock, idFactory: revisionIds("conflict") },
    );
    expect(conflict).toMatchObject({ ok: false, ruleId: REVISION_RULE_IDS.VERSION_CONFLICT, auditPersisted: true });
    expect(createDraftRevisionRepository(database).listByGenerationRun(runId)).toHaveLength(1);
    const blockedAudits = createAuditEventRepository(database).listByEntity("DRAFT_REVISION", runId);
    expect(blockedAudits).toHaveLength(2);
    expect(JSON.stringify(blockedAudits)).not.toContain("一次编辑");
  });

  it("allows non-empty medication rewrites as ungated revisions", async () => {
    const { runId, draft } = await createBoundedRun(database);
    const medicationSection = draft.sections.find((section) => section.key === "currentMedications")!;
    const result = saveDraftRevision(
      {
        generationRunId: runId,
        sections: withSectionContent(
          sectionsFrom(draft),
          "currentMedications",
          [...medicationSection.content, "医生改写：仍需人工核对剂量"],
        ),
      },
      { database, clock: fixedClock, idFactory: revisionIds("medication") },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.revision.afterSnapshot.sections.find((section) => section.key === "currentMedications")?.content).toContain("医生改写：仍需人工核对剂量");
  });

  it.each([
    ["mandatory empty", (draft: GeneratedDraft) => withSectionContent(sectionsFrom(draft), "allergies", []) , REVISION_RULE_IDS.MANDATORY_SECTION_EMPTY],
    ["disclaimer edit", (draft: GeneratedDraft) => withSectionContent(sectionsFrom(draft), "draftDisclaimer", ["改写免责声明"]), REVISION_RULE_IDS.DISCLAIMER_READONLY],
    ["suspected PII", (draft: GeneratedDraft) => withSectionContent(sectionsFrom(draft), "summary", ["姓名：合成患者"]), REVISION_RULE_IDS.SUSPECTED_PII],
  ] as const)("blocks %s without storing the submitted text", async (_label, makeSections, ruleId) => {
    const { runId, draft } = await createBoundedRun(database);
    const result = saveDraftRevision(
      { generationRunId: runId, sections: makeSections(draft) },
      { database, clock: fixedClock, idFactory: revisionIds("blocked") },
    );

    expect(result).toMatchObject({ ok: false, ruleId, auditPersisted: true });
    expect(JSON.stringify(result)).not.toContain("合成患者");
    expect(createDraftRevisionRepository(database).listByGenerationRun(runId)).toEqual([]);
    expect(JSON.stringify(createAuditEventRepository(database).listByEntity("DRAFT_REVISION", runId))).not.toContain("合成患者");
  });

  it("rejects generic, failed, missing and spoofed runs server-side", async () => {
    const generated = await createBoundedRun(database);
    const genericRun = await executeGenerationComparison(request(), {
      database,
      provider: createDeterministicMockProvider(),
      clock: fixedClock,
      idFactory: generationIds("generic"),
    });
    const genericId = genericRun.generic.runId!;
    const genericResult = saveDraftRevision(
      { generationRunId: genericId, sections: sectionsFrom(generated.draft) },
      { database, clock: fixedClock, idFactory: revisionIds("generic") },
    );
    expect(genericResult).toMatchObject({ ok: false, ruleId: REVISION_RULE_IDS.RUN_NOT_EDITABLE, auditPersisted: true });

    const failedRun = await executeGenerationComparison({ ...request(), mockMode: "TIMEOUT" }, {
      database,
      provider: createDeterministicMockProvider("TIMEOUT"),
      clock: fixedClock,
      idFactory: generationIds("failed"),
    });
    const failedResult = saveDraftRevision(
      { generationRunId: failedRun.bounded.runId!, sections: sectionsFrom(generated.draft) },
      { database, clock: fixedClock, idFactory: revisionIds("failed") },
    );
    expect(failedResult).toMatchObject({ ok: false, ruleId: REVISION_RULE_IDS.RUN_NOT_EDITABLE, auditPersisted: true });

    const missingResult = saveDraftRevision(
      { generationRunId: "missing-run", sections: sectionsFrom(generated.draft) },
      { database, clock: fixedClock, idFactory: revisionIds("missing") },
    );
    expect(missingResult).toMatchObject({ ok: false, ruleId: REVISION_RULE_IDS.GENERATION_RUN_NOT_FOUND, auditPersisted: true });

    const spoofedResult = saveDraftRevision({
      generationRunId: generated.runId,
      sections: sectionsFrom(generated.draft),
      editorId: "attacker",
      simulatedRole: "SYSTEM",
      beforeSnapshot: generated.draft,
      revisionNumber: 99,
    }, { database, clock: fixedClock, idFactory: revisionIds("spoof") });
    expect(spoofedResult).toMatchObject({ ok: false, ruleId: REVISION_RULE_IDS.INPUT_INVALID, auditPersisted: false });
  });

  it("rolls back a revision when the saved audit ID collides", async () => {
    const { runId, draft } = await createBoundedRun(database);
    createAuditEventRepository(database).append(fixtureAuditEvent({ id: "audit-collision" }));
    const result = saveDraftRevision(
      { generationRunId: runId, sections: withSectionContent(sectionsFrom(draft), "summary", ["编辑内容"]) },
      {
        database,
        clock: fixedClock,
        idFactory: (kind) => kind === "REVISION" ? "revision-rollback" : "audit-collision",
      },
    );

    expect(result).toMatchObject({ ok: false, ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED, auditPersisted: false });
    expect(createDraftRevisionRepository(database).getById("revision-rollback")).toBeUndefined();
  });
});
