import type { DatabaseSync } from "node:sqlite";

import {
  computeDraftDiff,
  draftRevisionRecordSchema,
  type DraftRevisionRecord,
  type DraftRevisionSectionInput,
} from "@/domain/draft-revisions";
import {
  feedbackFixtureEvaluationResultSchema,
  type FeedbackFixture,
  type FeedbackFixtureEvaluationResult,
  type FeedbackFixtureObserved,
} from "@/domain/dataset";
import type {
  FeedbackEventRecord,
  GenerationRunRecord,
  JsonObject,
  PhysicianProfileVersionRecord,
} from "@/domain/runtime-records";
import type { GeneratedDraft, SectionKey } from "@/domain/schemas";
import { classifyFeedback, type FeedbackProposal } from "@/domain/risk-gate";
import {
  executeGenerationSingleMode,
  type GenerationAttemptResult,
  type GenerationClock,
  type GenerationIdFactory,
  type GenerationSeedSource,
} from "./generation-service";
import { createDeterministicMockProvider } from "@/infrastructure/providers/deterministic-mock-provider";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createDraftRevisionRepository } from "@/infrastructure/sqlite/repositories/draft-revision-repository";
import { createFeedbackEventRepository } from "@/infrastructure/sqlite/repositories/feedback-event-repository";
import { createFeedbackEvaluationResultRepository } from "@/infrastructure/sqlite/repositories/feedback-evaluation-result-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { feedbackEventFromProposal } from "./feedback-lifecycle-service";
import { saveDraftRevision } from "./draft-revision-service";
import { formatSystemId } from "./system-id";

type FixtureClock = GenerationClock;
type FixtureIdKind = "REVISION" | "AUDIT" | "FEEDBACK";
type FixtureIdFactory = (kind: FixtureIdKind) => string;

export type FeedbackDatasetEvaluationInput = {
  database: DatabaseSync;
  batchId: string;
  fixtures: readonly FeedbackFixture[];
  seeds: GenerationSeedSource;
  clock: FixtureClock;
};

export type FeedbackDatasetEvaluationRun = {
  results: FeedbackFixtureEvaluationResult[];
  infrastructureFailure: boolean;
};

type FixtureMutation = {
  sections: DraftRevisionSectionInput[];
  sectionOrderDistance: number;
};

type FixtureBaseline = {
  attempt: GenerationAttemptResult;
  run?: GenerationRunRecord;
  profileHistoryBefore: PhysicianProfileVersionRecord[];
  revisionCountBefore: number;
};

const riskRank = { LOW: 1, UNCERTAIN: 2, MEDIUM: 3, HIGH: 4 } as const;

const prohibitedText: Record<NonNullable<FeedbackFixture["mutation"]["prohibitedAction"]>, string> = {
  "automatic-diagnosis": "自动直接生成诊断结论",
  "automatic-prescription": "自动默认开药并调整剂量",
  "automatic-record-writeback": "自动直接写回病历记录",
  "learning-from-unreviewed-edits": "未经审核自动学习医生编辑并更新画像",
  "inventing-missing-facts": "编造缺失事实和未提供药物剂量",
};

function safeFixtureId(batchId: string, fixtureId: string, kind: string, index = 0): string {
  return formatSystemId(`dataset-${kind}`, `${batchId}-${fixtureId}-${String(index).padStart(3, "0")}`);
}

function fixtureIdFactory(batchId: string, fixtureId: string): FixtureIdFactory {
  let counter = 0;
  return (kind) => safeFixtureId(batchId, fixtureId, kind.toLowerCase(), counter++);
}

function fixtureGenerationIdFactory(batchId: string, fixtureId: string): GenerationIdFactory {
  let counter = 0;
  return (kind) => formatSystemId(
    `feedback-generation-${kind.toLowerCase()}`,
    `${batchId}-${fixtureId}-${String(counter++).padStart(3, "0")}`,
  );
}

function nowIso(clock: FixtureClock): string {
  const value = clock();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    ? value
    : new Date().toISOString();
}

function sectionOrderDistance(before: readonly SectionKey[], after: readonly SectionKey[]): number {
  const afterIndexes = new Map(after.map((key, index) => [key, index]));
  let distance = Math.abs(before.length - after.length);
  before.forEach((key, index) => {
    if (afterIndexes.get(key) !== index) distance += 1;
  });
  return Math.min(100, distance);
}

function moveSection(sections: DraftRevisionSectionInput[], fromKey?: SectionKey, toKey?: SectionKey): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const fromIndex = sections.findIndex((section) => section.key === fromKey);
  const toIndex = sections.findIndex((section) => section.key === toKey);
  if (fromIndex < 0 || toIndex < 0) return;
  const [section] = sections.splice(fromIndex, 1);
  const targetIndex = sections.findIndex((item) => item.key === toKey);
  const insertionIndex = targetIndex < 0 ? toIndex : fromIndex < toIndex ? targetIndex + 1 : targetIndex;
  sections.splice(insertionIndex, 0, section);
}

function safeSyntheticLine(fixture: FeedbackFixture): string {
  return `合成评测反馈行 ${fixture.fixtureId}`;
}

function mutateSections(before: GeneratedDraft, fixture: FeedbackFixture): FixtureMutation {
  const sections = before.sections.map((section) => ({ key: section.key, content: [...section.content] }));
  const beforeOrder = sections.map((section) => section.key);
  const mutation = fixture.mutation;

  if (mutation.type === "REORDER_SECTIONS" || mutation.type === "MIXED_RISK_CHANGE") {
    moveSection(sections, mutation.fromSectionKey, mutation.toSectionKey);
  }

  if (mutation.type === "ADD_SECTION_LINE" || mutation.type === "MIXED_RISK_CHANGE") {
    const target = sections.find((section) => section.key === mutation.sectionKey);
    if (target) {
      const index = mutation.lineIndex === undefined
        ? target.content.length
        : Math.min(mutation.lineIndex, target.content.length);
      target.content.splice(index, 0, safeSyntheticLine(fixture));
    }
  }

  if (mutation.type === "REWRITE_SECTION") {
    const target = sections.find((section) => section.key === mutation.sectionKey);
    if (target) {
      const index = mutation.lineIndex === undefined ? 0 : Math.min(mutation.lineIndex, target.content.length);
      if (index < target.content.length) target.content[index] = safeSyntheticLine(fixture);
      else target.content.push(safeSyntheticLine(fixture));
    }
  }

  if (mutation.type === "UNKNOWN_FIELD_CHANGE") {
    const target = sections.find((section) => section.key === "patientEducation");
    if (target) target.content.push(safeSyntheticLine(fixture));
  }

  if (mutation.type === "CLEAR_MANDATORY_SECTION") {
    const target = sections.find((section) => section.key === mutation.sectionKey);
    if (target) target.content = [];
  }

  if (mutation.type === "REMOVE_MANDATORY_SECTION") {
    const index = sections.findIndex((section) => section.key === mutation.sectionKey);
    if (index >= 0) sections.splice(index, 1);
  }

  if (mutation.type === "ADD_PROHIBITED_ACTION") {
    const target = sections.find((section) => section.key === mutation.sectionKey);
    const text = mutation.prohibitedAction ? prohibitedText[mutation.prohibitedAction] : "合成评测禁止动作";
    if (target) target.content.push(text);
  }

  return {
    sections,
    sectionOrderDistance: sectionOrderDistance(beforeOrder, sections.map((section) => section.key)),
  };
}

function audit(
  database: DatabaseSync,
  id: string,
  eventType: string,
  entityType: string,
  entityId: string,
  actorId: "demo-physician" | "demo-researcher",
  simulatedRole: "PHYSICIAN" | "RESEARCHER",
  metadata: JsonObject,
  createdAt: string,
): void {
  createAuditEventRepository(database).append({
    schemaVersion: "1.0.0",
    id,
    eventType,
    actorId,
    simulatedRole,
    entityType,
    entityId,
    metadata,
    createdAt,
  });
}

function normalizeRuleId(ruleId: string): string {
  return ruleId.toUpperCase().replace(/[^A-Z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 100) || "UNKNOWN_RULE";
}

function operationsCount(diffSummary: DraftRevisionRecord["diffSummary"]): number {
  return diffSummary.changedSections.reduce((sum, section) => (
    sum + ("operations" in section ? section.operations.length : section.lineChanges.length)
  ), 0);
}

function evidenceFromDiff(diffSummary: DraftRevisionRecord["diffSummary"]): FeedbackProposal["evidence"] {
  return {
    operationCount: operationsCount(diffSummary),
    addedLineCount: diffSummary.metrics.addedLineCount,
    removedLineCount: diffSummary.metrics.removedLineCount,
    addedCharacterCount: diffSummary.metrics.addedCharacterCount,
    removedCharacterCount: diffSummary.metrics.removedCharacterCount,
    orderChanged: diffSummary.orderChanged,
  };
}

function feedbackProposalFromClassifier(
  revision: DraftRevisionRecord,
  fixture: FeedbackFixture,
  classified: ReturnType<typeof classifyFeedback>,
  context: { generationRunId: string; profileId: string; profileVersion: number },
): FeedbackProposal {
  const status: FeedbackProposal["status"] = classified.riskLevel === "LOW"
    ? "CANDIDATE"
    : classified.riskLevel === "HIGH" ? "REJECTED" : "HELD_FOR_REVIEW";
  const decision: FeedbackProposal["decision"] = classified.decision === "REJECTED" ? "REJECTED" : "PENDING";
  const nextAllowedActions: FeedbackProposal["nextAllowedActions"] = classified.riskLevel === "LOW"
    ? ["CONFIRM_CANDIDATE", "DISMISS_CANDIDATE"]
    : classified.riskLevel === "HIGH" ? [] : ["REVIEW_APPROVE", "REVIEW_REJECT"];
  return {
    proposalId: `${revision.id}:${fixture.fixtureId}:controlled-classifier`,
    eventType: "FEEDBACK_CLASSIFIED",
    generationRunId: context.generationRunId,
    draftRevisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    profileId: context.profileId,
    profileVersion: context.profileVersion,
    rulesVersion: "feedback-rules-v1",
    changeType: "REWRITE",
    status,
    riskLevel: classified.riskLevel,
    decision,
    affectedField: "unknown",
    ruleHits: [...new Set(classified.ruleHits.map(normalizeRuleId))],
    safetyReason: classified.rationale,
    nextAllowedActions,
    evidence: evidenceFromDiff(revision.diffSummary),
  };
}

function persistControlledClassifierRevision(
  database: DatabaseSync,
  run: GenerationRunRecord,
  beforeSnapshot: GeneratedDraft,
  afterSnapshot: GeneratedDraft,
  expectedPreviousRevision: number,
  fixture: FeedbackFixture,
  clock: FixtureClock,
  idFactory: FixtureIdFactory,
): void {
  const createdAt = nowIso(clock);
  const revision = draftRevisionRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: idFactory("REVISION"),
    generationRunId: run.id,
    revisionNumber: expectedPreviousRevision + 1,
    beforeSnapshot,
    afterSnapshot,
    diffSummary: computeDraftDiff(beforeSnapshot, afterSnapshot),
    editorId: "demo-physician",
    createdAt,
  });
  const classified = classifyFeedback({
    id: fixture.fixtureId,
    changeType: "REWRITE",
    affectedFields: ["unknown"],
    beforeText: "",
    afterText: safeSyntheticLine(fixture),
  });
  const proposal = feedbackProposalFromClassifier(revision, fixture, classified, {
    generationRunId: run.id,
    profileId: run.profileId!,
    profileVersion: run.profileVersion!,
  });
  const event = feedbackEventFromProposal(proposal, idFactory("FEEDBACK"), createdAt);
  withTransaction(database, () => {
    createDraftRevisionRepository(database).append(revision, expectedPreviousRevision);
    createFeedbackEventRepository(database).append(event);
    audit(database, idFactory("AUDIT"), "REVISION_SAVED", "DRAFT_REVISION", revision.id, "demo-physician", "PHYSICIAN", {
      generationRunId: run.id,
      revisionNumber: revision.revisionNumber,
      ruleIds: [],
      changedSectionCount: revision.diffSummary.metrics.changedSectionCount,
      addedLineCount: revision.diffSummary.metrics.addedLineCount,
      removedLineCount: revision.diffSummary.metrics.removedLineCount,
      addedCharacterCount: revision.diffSummary.metrics.addedCharacterCount,
      removedCharacterCount: revision.diffSummary.metrics.removedCharacterCount,
      editBurdenRatio: revision.diffSummary.metrics.editBurdenRatio,
    }, createdAt);
    audit(database, idFactory("AUDIT"), "FEEDBACK_CLASSIFIED", "FEEDBACK_EVENT", event.id, "demo-physician", "PHYSICIAN", {
      generationRunId: run.id,
      feedbackEventId: event.id,
      riskLevel: event.riskLevel,
      status: event.status,
      ruleIds: event.ruleHits,
      affectedField: event.affectedField,
      evidence: event.evidence,
    }, createdAt);
  });
}

function fixtureEvents(database: DatabaseSync, runId: string): FeedbackEventRecord[] {
  return createFeedbackEventRepository(database).listByGenerationRun(runId);
}

function observedFromPersistence(
  database: DatabaseSync,
  baseline: FixtureBaseline,
  executionPath: FeedbackFixtureObserved["executionPath"],
  fallbackDistance: number,
): FeedbackFixtureObserved {
  const runId = baseline.run?.id;
  const events = runId ? fixtureEvents(database, runId) : [];
  const revisions = runId ? createDraftRevisionRepository(database).listByGenerationRun(runId) : [];
  const audits = runId ? createAuditEventRepository(database).listByGenerationRun(runId) : [];
  const profileHistoryAfter = runId && baseline.run?.profileId
    ? createPhysicianProfileVersionRepository(database).listHistory(baseline.run.profileId)
    : baseline.profileHistoryBefore;
  const selected = [...events].sort((left, right) => riskRank[right.riskLevel] - riskRank[left.riskLevel])[0];
  const selectedDecision = selected?.decision === "PENDING" || selected?.decision === "REJECTED"
    ? selected.decision
    : undefined;
  const eventIds = new Set(events.map((event) => event.id));
  const auditRecorded = audits.some((event) => event.eventType === "FEEDBACK_CLASSIFIED" && event.entityType === "FEEDBACK_EVENT" && eventIds.has(event.entityId));
  const profileUpdated = profileHistoryAfter.length !== baseline.profileHistoryBefore.length
    || profileHistoryAfter.at(-1)?.version !== baseline.profileHistoryBefore.at(-1)?.version;
  const dangerousBodyStored = selected?.riskLevel === "HIGH" && revisions.length > baseline.revisionCountBefore;
  const latestRevision = revisions.at(-1);
  return {
    executionPath,
    ...(selected ? { riskLevel: selected.riskLevel, status: selected.status, ...(selectedDecision ? { decision: selectedDecision } : {}) } : {}),
    ruleIds: [...new Set(events.flatMap((event) => event.ruleHits))].sort(),
    feedbackEventIds: events.map((event) => event.id),
    revisionSaved: revisions.length > baseline.revisionCountBefore,
    profileUpdated,
    dangerousBodyStored,
    auditRecorded,
    sectionOrderDistance: latestRevision
      ? sectionOrderDistance(latestRevision.beforeSnapshot.sections.map((section) => section.key), latestRevision.afterSnapshot.sections.map((section) => section.key))
      : fallbackDistance,
    distanceAlgorithmVersion: "section-order-distance-v1",
  };
}

async function createFixtureBaseline(
  input: FeedbackDatasetEvaluationInput,
  fixture: FeedbackFixture,
): Promise<{ baseline?: FixtureBaseline; infrastructureFailure: boolean }> {
  const provider = createDeterministicMockProvider("SUCCESS");
  let attempt: GenerationAttemptResult;
  try {
    attempt = await executeGenerationSingleMode(
      { caseId: fixture.caseId, profileId: fixture.profileId, mockMode: "SUCCESS" },
      "BOUNDED",
      {
        database: input.database,
        provider,
        seeds: input.seeds,
        clock: input.clock,
        idFactory: fixtureGenerationIdFactory(input.batchId, fixture.fixtureId),
      },
    );
  } catch {
    return { infrastructureFailure: true };
  }
  try {
    const run = attempt.runId ? createGenerationRunRepository(input.database).getById(attempt.runId) : undefined;
    if (attempt.error?.errorType === "PERSISTENCE") return { infrastructureFailure: true };
    if (attempt.runId && !run) return { infrastructureFailure: true };
    if (run && run.mode !== "BOUNDED") return { infrastructureFailure: true };
    const history = createPhysicianProfileVersionRepository(input.database).listHistory(fixture.profileId);
    const revisions = run ? createDraftRevisionRepository(input.database).listByGenerationRun(run.id) : [];
    return {
      baseline: {
        attempt,
        run,
        profileHistoryBefore: history,
        revisionCountBefore: revisions.length,
      },
      infrastructureFailure: false,
    };
  } catch {
    return { infrastructureFailure: true };
  }
}

function resultForMissingBaseline(
  batchId: string,
  fixture: FeedbackFixture,
  attempt: GenerationAttemptResult,
  datasetVersion: string,
  createdAt: string,
): FeedbackFixtureEvaluationResult {
  return feedbackFixtureEvaluationResultSchema.parse({
    schemaVersion: "1.0.0",
    id: safeFixtureId(batchId, fixture.fixtureId, "result"),
    evaluationBatchId: batchId,
    ...(attempt.runId ? { generationRunId: attempt.runId } : {}),
    datasetVersion,
    fixtureId: fixture.fixtureId,
    fixtureVersion: fixture.fixtureVersion,
    caseId: fixture.caseId,
    caseVersion: fixture.caseVersion,
    profileId: fixture.profileId,
    profileVersion: fixture.profileVersion,
    mutationType: fixture.mutation.type,
    expectedRiskLevel: fixture.expectedRiskLevel,
    expectedStatus: fixture.expectedStatus,
    expectedDecision: fixture.expectedDecision,
    expectedRuleIds: fixture.expectedRuleIds,
    observed: {
      executionPath: fixture.mutation.type === "UNKNOWN_FIELD_CHANGE" ? "CONTROLLED_CLASSIFIER_HARNESS" : "WORKBENCH_REVISION",
      ruleIds: ["DATASET_GENERATION_RUN_MISSING"],
      feedbackEventIds: [],
      revisionSaved: false,
      profileUpdated: false,
      dangerousBodyStored: false,
      auditRecorded: false,
      sectionOrderDistance: 0,
      distanceAlgorithmVersion: "section-order-distance-v1",
    },
    resultStatus: "FAIL",
    rulesVersion: "feedback-rules-v1",
    createdAt,
  });
}

function resultForFixture(
  input: FeedbackDatasetEvaluationInput,
  fixture: FeedbackFixture,
  baseline: FixtureBaseline,
): FeedbackFixtureEvaluationResult {
  const createdAt = nowIso(input.clock);
  const run = baseline.run;
  if (!run?.outputDraftSnapshot) {
    return resultForMissingBaseline(input.batchId, fixture, baseline.attempt, input.seeds.seedManifest.datasetVersion, createdAt);
  }
  const beforeSnapshot = run.outputDraftSnapshot;
  const mutated = mutateSections(beforeSnapshot, fixture);
  const idFactory = fixtureIdFactory(input.batchId, fixture.fixtureId);
  const executionPath = fixture.mutation.type === "UNKNOWN_FIELD_CHANGE"
    ? "CONTROLLED_CLASSIFIER_HARNESS"
    : "WORKBENCH_REVISION";

  if (fixture.mutation.type === "UNKNOWN_FIELD_CHANGE") {
    const afterSnapshot = {
      ...beforeSnapshot,
      sections: mutated.sections.map((section) => ({
        ...beforeSnapshot.sections.find((candidate) => candidate.key === section.key)!,
        content: section.content,
      })),
    };
    persistControlledClassifierRevision(
      input.database,
      run,
      beforeSnapshot,
      afterSnapshot,
      baseline.revisionCountBefore,
      fixture,
      input.clock,
      idFactory,
    );
  } else {
    const saved = saveDraftRevision(
      {
        generationRunId: run.id,
        expectedPreviousRevision: baseline.revisionCountBefore,
        sections: mutated.sections,
      },
      { database: input.database, clock: input.clock, idFactory },
    );
    if (!saved.ok && saved.ruleId === "REVISION_PERSISTENCE_FAILED") throw new Error("feedback revision persistence failed");
  }

  const observed = observedFromPersistence(input.database, baseline, executionPath, mutated.sectionOrderDistance);
  const expectedMatches = observed.riskLevel === fixture.expectedRiskLevel
    && observed.status === fixture.expectedStatus
    && observed.decision === fixture.expectedDecision
    && fixture.expectedRuleIds.every((ruleId) => observed.ruleIds.includes(ruleId))
    && observed.revisionSaved === fixture.allowRevisionBody
    && observed.profileUpdated === fixture.allowProfileUpdate
    && observed.auditRecorded
    && observed.dangerousBodyStored === false;
  return feedbackFixtureEvaluationResultSchema.parse({
    schemaVersion: "1.0.0",
    id: safeFixtureId(input.batchId, fixture.fixtureId, "result"),
    evaluationBatchId: input.batchId,
    generationRunId: run.id,
    datasetVersion: input.seeds.seedManifest.datasetVersion,
    fixtureId: fixture.fixtureId,
    fixtureVersion: fixture.fixtureVersion,
    caseId: fixture.caseId,
    caseVersion: fixture.caseVersion,
    profileId: fixture.profileId,
    profileVersion: fixture.profileVersion,
    mutationType: fixture.mutation.type,
    expectedRiskLevel: fixture.expectedRiskLevel,
    expectedStatus: fixture.expectedStatus,
    expectedDecision: fixture.expectedDecision,
    expectedRuleIds: fixture.expectedRuleIds,
    observed,
    resultStatus: expectedMatches ? "PASS" : "FAIL",
    rulesVersion: "feedback-rules-v1",
    createdAt,
  });
}

export async function runFeedbackDatasetEvaluation(
  input: FeedbackDatasetEvaluationInput,
): Promise<FeedbackDatasetEvaluationRun> {
  const startedAt = nowIso(input.clock);
  audit(input.database, safeFixtureId(input.batchId, "dataset", "started"), "DATASET_FEEDBACK_STARTED", "EVALUATION_BATCH", input.batchId, "demo-researcher", "RESEARCHER", {
    evaluationBatchId: input.batchId,
    datasetVersion: input.seeds.seedManifest.datasetVersion,
    fixtureCount: input.fixtures.length,
    highCount: input.fixtures.filter((fixture) => fixture.expectedRiskLevel === "HIGH").length,
    mediumCount: input.fixtures.filter((fixture) => fixture.expectedRiskLevel === "MEDIUM").length,
    lowCount: input.fixtures.filter((fixture) => fixture.expectedRiskLevel === "LOW").length,
    uncertainCount: input.fixtures.filter((fixture) => fixture.expectedRiskLevel === "UNCERTAIN").length,
  }, startedAt);

  const resultRepository = createFeedbackEvaluationResultRepository(input.database);
  const results: FeedbackFixtureEvaluationResult[] = [];
  let infrastructureFailure = false;
  for (const fixture of input.fixtures) {
    const baselineResult = await createFixtureBaseline(input, fixture);
    if (baselineResult.infrastructureFailure || !baselineResult.baseline) {
      infrastructureFailure = true;
      break;
    }
    let result: FeedbackFixtureEvaluationResult;
    try {
      result = resultForFixture(input, fixture, baselineResult.baseline);
    } catch {
      infrastructureFailure = true;
      break;
    }
    try {
      withTransaction(input.database, () => {
        resultRepository.append(result);
        audit(input.database, safeFixtureId(input.batchId, fixture.fixtureId, "recorded"), "DATASET_FEEDBACK_RESULT_RECORDED", "FEEDBACK_EVALUATION_RESULT", result.id, "demo-researcher", "RESEARCHER", {
          evaluationBatchId: input.batchId,
          fixtureId: fixture.fixtureId,
          fixtureVersion: fixture.fixtureVersion,
          resultStatus: result.resultStatus,
          riskLevel: result.observed.riskLevel ?? "UNOBSERVED",
          ruleIds: result.observed.ruleIds,
          revisionSaved: result.observed.revisionSaved,
          profileUpdated: result.observed.profileUpdated,
          dangerousBodyStored: result.observed.dangerousBodyStored,
          executionPath: result.observed.executionPath,
          sectionOrderDistance: result.observed.sectionOrderDistance,
        }, result.createdAt);
      });
      results.push(result);
    } catch {
      infrastructureFailure = true;
      break;
    }
  }

  if (infrastructureFailure) {
    const recordedFixtureIds = new Set(results.map((result) => result.fixtureId));
    const missingFixtureIds = input.fixtures
      .map((fixture) => fixture.fixtureId)
      .filter((fixtureId) => !recordedFixtureIds.has(fixtureId));
    try {
      audit(
        input.database,
        safeFixtureId(input.batchId, "dataset", "incomplete"),
        "DATASET_FEEDBACK_INCOMPLETE",
        "EVALUATION_BATCH",
        input.batchId,
        "demo-researcher",
        "RESEARCHER",
        {
          evaluationBatchId: input.batchId,
          expectedFixtureCount: input.fixtures.length,
          recordedFixtureCount: results.length,
          missingFixtureIds,
          failureRuleId: "EVALUATION_FEEDBACK_RESULT_PERSISTENCE_INCOMPLETE",
        },
        nowIso(input.clock),
      );
    } catch {
      // The caller still treats the run as infrastructure-failed; the marker is best effort and contains no draft data.
    }
  }

  if (!infrastructureFailure && results.length === input.fixtures.length) {
    const completedAt = nowIso(input.clock);
    audit(input.database, safeFixtureId(input.batchId, "dataset", "completed"), "DATASET_FEEDBACK_COMPLETED", "EVALUATION_BATCH", input.batchId, "demo-researcher", "RESEARCHER", {
      evaluationBatchId: input.batchId,
      datasetVersion: input.seeds.seedManifest.datasetVersion,
      expectedFixtureCount: input.fixtures.length,
      recordedFixtureCount: results.length,
      passCount: results.filter((result) => result.resultStatus === "PASS").length,
      failCount: results.filter((result) => result.resultStatus === "FAIL").length,
      missingFixtureCount: 0,
    }, completedAt);
  }

  return {
    results: [...results].sort((left, right) => left.fixtureId.localeCompare(right.fixtureId)),
    infrastructureFailure,
  };
}
