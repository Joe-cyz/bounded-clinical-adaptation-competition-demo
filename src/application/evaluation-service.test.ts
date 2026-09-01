import { describe, expect, it } from "vitest";

import { runEvaluationBatch, buildEvaluationExportBundle, buildEvaluationReadModel, type EvaluationIdFactory } from "./evaluation-service";
import { adversarialFeedbackFixtures, uncertaintyFeedbackFixtures, seedManifest, syntheticCases, physicianProfiles, institutionalSafetyCore, specialtyVisitPolicies } from "@/data/seed-loader";
import type { GenerationSeedSource } from "./generation-service";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createEvaluationBatchRepository } from "@/infrastructure/sqlite/repositories/evaluation-batch-repository";
import { createEvaluationResultRepository } from "@/infrastructure/sqlite/repositories/evaluation-result-repository";
import { createEvaluationRunRepository } from "@/infrastructure/sqlite/repositories/evaluation-run-repository";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createDraftRevisionRepository } from "@/infrastructure/sqlite/repositories/draft-revision-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { fixtureProfileVersion } from "@/infrastructure/sqlite/test-fixtures";
import { serializeEvaluationFeedbackResultsCsv, serializeEvaluationMetricsCsv, serializeEvaluationResultsCsv, serializeEvaluationJson } from "@/infrastructure/exports/evaluation-export";
import { evaluationExportBundleSchema } from "@/domain/evaluation";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { generateDraft } from "@/domain/generate-draft";
import type { LLMProvider } from "./ports/llm-provider";
import { formatSystemId } from "./system-id";

// SYNTHETIC_TEST_ONLY: runtime-built value for the PII rejection path.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");

class OfflineRealProvider implements LLMProvider {
  readonly id = "deepseek";
  readonly modelId = "deepseek-v4-flash";
  readonly promptVersion = "deepseek-draft-v1";
  readonly executionType = "REAL" as const;
  readonly networkCall = true as const;

  async generateDraft(input: Parameters<LLMProvider["generateDraft"]>[0]) {
    return {
      ok: true as const,
      raw: JSON.stringify(generateDraft(input.caseData, input.config, input.runId)),
      metadata: { promptVersion: this.promptVersion, promptDigest: "0".repeat(64), responseModelId: "model-returned-by-api" },
    };
  }
}

const fixedClock = () => "2026-08-19T00:00:00.000Z";

function idFactory(): EvaluationIdFactory {
  let counter = 0;
  return (kind) => `${kind.toLowerCase()}-evaluation-${String(counter++).padStart(4, "0")}`;
}

function evaluationSeeds(overrides: Partial<GenerationSeedSource> = {}): GenerationSeedSource {
  return {
    seedManifest,
    syntheticCases,
    physicianProfiles,
    institutionalSafetyCore,
    specialtyVisitPolicies,
    adversarialFeedbackFixtures,
    uncertaintyFeedbackFixtures,
    ...overrides,
  };
}

describe("evaluation batch service", () => {
  it("keeps a REAL batch explicitly separated and marks Mock-only metrics NOT_MEASURED", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const result = await runEvaluationBatch({
      database,
      clock: fixedClock,
      idFactory: idFactory(),
      provider: new OfflineRealProvider(),
      executionType: "REAL",
    });
    expect(result).toEqual(expect.objectContaining({ ok: true, status: "SUCCEEDED", pairCount: 72, attemptCount: 144 }));
    if (result.ok) {
      const model = buildEvaluationReadModel(database, result.batchId);
      expect(model.ok).toBe(true);
      if (model.ok) {
        expect(model.data.batch.executionType).toBe("REAL");
        expect(model.data.batch.provider.modelId).toBe("deepseek-v4-flash");
        expect(model.data.runs.every((run) => run.provider.modelId === "deepseek-v4-flash")).toBe(true);
        expect(model.data.batch.configuration.feedbackBaselineProvider.id).toBe("deterministic-mock");
        expect(model.data.batch.configuration.feedbackBaselineExecutionNature).toBe("DETERMINISTIC_GOVERNANCE_TEST");
        expect(model.data.runs.every((run) => run.executionType === "REAL")).toBe(true);
        expect(model.data.results.every((item) => item.metrics.mockCoreFlowPass === null)).toBe(true);
        expect(model.data.metrics.find((metric) => metric.metricId === "MOCK_CORE_FLOW_PASS")).toEqual(expect.objectContaining({ status: "NOT_MEASURED", denominator: 0 }));
        const stored = database.prepare("SELECT provider_metadata_json FROM generation_runs WHERE provider_id = 'deepseek' LIMIT 1").get() as { provider_metadata_json?: string } | undefined;
        expect(stored?.provider_metadata_json).toContain("deepseek-draft-v1");
        expect(stored?.provider_metadata_json).toContain("model-returned-by-api");
      }
    }
    database.close();
  }, 30_000);

  it("runs the fixed 24-case / 72-pair / 144-attempt matrix and stores safe metrics", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const result = await runEvaluationBatch({ database, clock: fixedClock });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: "SUCCEEDED",
      pairCount: 72,
      attemptCount: 144,
      failureCount: 0,
    }));
    const batchId = result.ok ? result.batchId : "";
    const model = buildEvaluationReadModel(database, batchId);
    expect(model.ok).toBe(true);
    if (model.ok) {
      expect(model.data.runs).toHaveLength(144);
      expect(model.data.results).toHaveLength(144);
      expect(model.data.feedbackResults).toHaveLength(36);
      const generationRuns = database.prepare("SELECT id, mode FROM generation_runs ORDER BY id ASC").all() as Array<{
        id: string;
        mode: "GENERIC" | "BOUNDED";
      }>;
      expect(generationRuns).toHaveLength(180);
      expect(generationRuns.filter((run) => run.mode === "GENERIC")).toHaveLength(72);
      expect(generationRuns.filter((run) => run.mode === "BOUNDED")).toHaveLength(108);
      const generationRunModes = new Map(generationRuns.map((run) => [run.id, run.mode]));
      const feedbackRunIds = model.data.feedbackResults.map((item) => item.generationRunId);
      expect(new Set(feedbackRunIds).size).toBe(36);
      expect(feedbackRunIds.every((runId) => runId !== undefined && generationRunModes.get(runId) === "BOUNDED")).toBe(true);
      expect(model.data.feedbackResults.filter((item) => item.resultStatus === "PASS")).toHaveLength(36);
      expect(model.data.feedbackResults.filter((item) => item.expectedRiskLevel === "LOW" && item.observed.status === "CANDIDATE")).toHaveLength(10);
      expect(model.data.feedbackResults.filter((item) => item.expectedRiskLevel === "MEDIUM" && item.observed.status === "HELD_FOR_REVIEW")).toHaveLength(10);
      expect(model.data.feedbackResults.filter((item) => item.expectedRiskLevel === "UNCERTAIN" && item.observed.status === "HELD_FOR_REVIEW")).toHaveLength(6);
      const highResults = model.data.feedbackResults.filter((item) => item.expectedRiskLevel === "HIGH");
      expect(highResults.filter((item) => !item.observed.revisionSaved && !item.observed.profileUpdated && !item.observed.dangerousBodyStored)).toHaveLength(10);
      expect(highResults.every((item) => item.generationRunId && createDraftRevisionRepository(database).listByGenerationRun(item.generationRunId).length === 0)).toBe(true);
      expect(model.data.feedbackResults.filter((item) => item.expectedRiskLevel === "UNCERTAIN").every((item) => item.observed.executionPath === "CONTROLLED_CLASSIFIER_HARNESS")).toBe(true);
      expect(model.data.matrixSummary).toEqual(expect.objectContaining({
        expectedPairCount: 72,
        expectedAttemptCount: 144,
        plannedRunCount: 144,
        recordedResultCount: 144,
        generationAttemptCount: 144,
        missingResultCount: 0,
        notExecutedCount: 0,
        unresolvedRunCount: 0,
        complete: true,
      }));
      expect(model.data.metrics.find((metric) => metric.metricId === "OUTPUT_STRUCTURE_PARSE_SUCCESS")).toEqual(expect.objectContaining({
        numerator: 144,
        denominator: 144,
        value: 1,
        status: "PASS",
      }));
      expect(model.data.metrics.find((metric) => metric.metricId === "MATRIX_COMPLETENESS")).toEqual(expect.objectContaining({
        numerator: 144,
        denominator: 144,
        value: 1,
        status: "PASS",
      }));
      expect(model.data.metrics.find((metric) => metric.metricId === "HIGH_RISK_DETECTION_RATE")).toEqual(expect.objectContaining({
        status: "PASS",
        denominator: 10,
      }));
      expect(model.data.metrics.find((metric) => metric.metricId === "HIGH_RISK_AUTO_WRITE_RATE")).toEqual(expect.objectContaining({ status: "PASS", numerator: 0, denominator: 10 }));
      expect(model.data.metrics.find((metric) => metric.metricId === "MEDIUM_REVIEW_RATE")).toEqual(expect.objectContaining({ status: "PASS", numerator: 10, denominator: 10 }));
      expect(model.data.metrics.find((metric) => metric.metricId === "UNCERTAIN_REVIEW_RATE")).toEqual(expect.objectContaining({ status: "PASS", numerator: 6, denominator: 6 }));
      expect(model.data.metrics.find((metric) => metric.metricId === "MODIFICATION_COUNT")).toEqual(expect.objectContaining({ denominator: 36, status: "MEASURED", unit: "TOTAL_COUNT" }));
      expect(model.data.feedbackMatrixSummary).toEqual(expect.objectContaining({
        expectedFixtureCount: 36,
        recordedFixtureCount: 36,
        passCount: 36,
        failCount: 0,
        missingFixtureCount: 0,
        duplicateFixtureCount: 0,
        expectedLowCount: 10,
        recordedLowCount: 10,
        expectedMediumCount: 10,
        recordedMediumCount: 10,
        expectedHighCount: 10,
        recordedHighCount: 10,
        expectedUncertainCount: 6,
        recordedUncertainCount: 6,
        complete: true,
      }));
      expect(model.data.metrics.find((metric) => metric.metricId === "PROFILE_ISOLATION_ROLLBACK")).toEqual(expect.objectContaining({ status: "NOT_MEASURED", denominator: 0 }));
    }
    expect(createEvaluationBatchRepository(database).getById(batchId)?.status).toBe("SUCCEEDED");
    expect(createAuditEventRepository(database).listPage({ eventType: "EVALUATION_STARTED" }).items).toHaveLength(1);
    expect(createAuditEventRepository(database).listPage({ eventType: "DATASET_FEEDBACK_STARTED" }).items).toHaveLength(1);
    expect(createAuditEventRepository(database).listPage({ eventType: "DATASET_FEEDBACK_RESULT_RECORDED" }).items).toHaveLength(36);
    expect(createAuditEventRepository(database).listPage({ eventType: "DATASET_FEEDBACK_COMPLETED" }).items).toHaveLength(1);
    expect(createAuditEventRepository(database).listPage({ entityType: "EVALUATION_BATCH" }).items.every((event) => event.actorId === "demo-researcher" && event.simulatedRole === "RESEARCHER")).toBe(true);
    database.close();
  });

  it("preserves a pair failure and continues the remaining fixed matrix", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const result = await runEvaluationBatch({
      database,
      clock: fixedClock,
      idFactory: idFactory(),
      mockModeForPair: ({ index }) => index === 0 ? "INVALID_OUTPUT_FACT" : "SUCCESS",
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "PARTIAL_FAILURE", pairCount: 72, attemptCount: 144, failureCount: 2 }));
    if (result.ok) {
      const model = buildEvaluationReadModel(database, result.batchId);
      expect(model.ok).toBe(true);
      if (model.ok) {
        expect(model.data.results).toHaveLength(144);
        expect(model.data.failures.every((failure) => failure.failureType === "OUTPUT_VALIDATION")).toBe(true);
        expect(model.data.failureTypes).toEqual(["OUTPUT_VALIDATION"]);
        expect(model.data.metrics.find((metric) => metric.metricId === "UNSUPPORTED_FACT_RULE_HITS")?.value).toBe(2);
      }
    }
    database.close();
  });

  it("fails closed when a locked profile version changes between pairs", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const profileRepository = createPhysicianProfileVersionRepository(database);
    const result = await runEvaluationBatch({
      database,
      clock: fixedClock,
      idFactory: idFactory(),
      onBeforePair: ({ index }) => {
        if (index === 1) profileRepository.append(fixtureProfileVersion(2, 1), 1);
      },
    });

    expect(result).toEqual(expect.objectContaining({ ok: true, status: "FAILED", pairCount: 1, attemptCount: 2 }));
    if (result.ok) {
      const model = buildEvaluationReadModel(database, result.batchId);
      expect(model.ok).toBe(true);
      if (model.ok) {
        expect(model.data.failureCount).toBeGreaterThan(0);
        expect(model.data.gaps).toHaveLength(142);
        expect(model.data.gaps.every((gap) => gap.gapType === "NOT_EXECUTED")).toBe(true);
        expect(model.data.matrixSummary).toEqual(expect.objectContaining({
          expectedAttemptCount: 144,
          plannedRunCount: 2,
          recordedResultCount: 2,
          missingResultCount: 142,
          notExecutedCount: 142,
          unresolvedRunCount: 0,
          complete: false,
        }));
        expect(model.data.metrics.find((metric) => metric.metricId === "MATRIX_COMPLETENESS")).toEqual(expect.objectContaining({
          numerator: 2,
          denominator: 144,
          status: "FAIL",
        }));
      }
    }
    database.close();
  });

  it("builds privacy-bounded JSON and RFC4180 CSV artifacts with formula protection", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const result = await runEvaluationBatch({ database, clock: fixedClock, idFactory: idFactory() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundleResult = buildEvaluationExportBundle(database, result.batchId, fixedClock(), idFactory());
    expect(bundleResult.ok).toBe(true);
    if (!bundleResult.ok) return;
    const bundle = evaluationExportBundleSchema.parse(bundleResult.data);
    expect(bundle.exportSchemaVersion).toBe("evaluation-export-v2");
    expect(bundle.batch.datasetVersion).toBe("0.4.1");
    expect(bundle.batch.configuration).toEqual(expect.objectContaining({
      caseSetVersion: "0.4.1",
      adversarialFeedbackSetVersion: "0.4.0",
      uncertaintyFeedbackSetVersion: "0.4.0",
    }));
    expect(bundle.results.every((item) => item.datasetVersion === "0.4.1" && item.caseVersion.startsWith("0.4.1-"))).toBe(true);
    expect(bundle.feedbackResults).toHaveLength(36);
    expect((bundle.feedbackResults ?? []).every((item) => item.datasetVersion === "0.4.1" && item.fixtureVersion === "0.4.0")).toBe(true);
    expect(bundle.results[0]).toEqual(expect.objectContaining({
      datasetVersion: "0.4.1",
      provider: expect.objectContaining({ id: "deterministic-mock" }),
      feedbackRulesVersion: "feedback-rules-v1",
      safetyCore: expect.any(Object),
      policy: expect.any(Object),
      configurationKey: expect.stringContaining("effective-config@1.0.0"),
    }));
    const json = serializeEvaluationJson(bundle);
    expect(json).not.toContain("outputDraftSnapshot");
    expect(json).not.toContain("patientSummary");
    expect(serializeEvaluationResultsCsv(bundle).startsWith("\uFEFFexportSchemaVersion,batchId")).toBe(true);
    expect(serializeEvaluationFeedbackResultsCsv(bundle)).toContain("adv-low-001");
    expect(serializeEvaluationFeedbackResultsCsv(bundle)).toContain("0.4.1");
    expect(serializeEvaluationMetricsCsv(bundle)).toContain("NOT_MEASURED");
    const formulaBundle = {
      ...bundle,
      results: bundle.results.map((item, index) => index === 0 ? { ...item, pairKey: "=unsafe" } : item),
    };
    expect(serializeEvaluationResultsCsv(formulaBundle)).toContain("'=unsafe");
    expect(createAuditEventRepository(database).listPage({ eventType: "EVALUATION_EXPORTED" }).items).toHaveLength(1);
    database.close();
  });

  it("exposes append-only evaluation records and duplicate conflicts", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const result = await runEvaluationBatch({ database, clock: fixedClock, idFactory: idFactory() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runRepository = createEvaluationRunRepository(database);
    const resultRepository = createEvaluationResultRepository(database);
    const runs = runRepository.listByBatch(result.batchId, 500);
    const results = resultRepository.listByBatch(result.batchId, 500);
    expect(runs).toHaveLength(144);
    expect(results).toHaveLength(144);
    expect(() => resultRepository.append({
      ...results[0],
      id: "result-content-pii",
      pairKey: `联系电话：${syntheticTestOnlyPhone}`,
    })).toThrow(PersistenceError);
    expect(() => resultRepository.append(results[0])).toThrow(/Evaluation result ID|run result/);
    expect(runRepository.getById(runs[0].id)?.status).toBe("SUCCEEDED");
    expect(() => runRepository.transitionStatus(runs[0].id, "RUNNING", "FAILED", fixedClock())).toThrow(PersistenceError);
    expect(() => createEvaluationBatchRepository(database).transitionStatus(result.batchId, "RUNNING", "FAILED", fixedClock())).toThrow(PersistenceError);
    database.prepare("UPDATE evaluation_results SET metrics_json = ? WHERE id = ?").run("{invalid", results[0].id);
    try {
      resultRepository.getById(results[0].id);
      throw new Error("Expected corrupted evaluation result.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.DATA_CORRUPTION);
      expect((error as Error).message).not.toContain("{invalid");
    }
    database.close();
  });

  it("rolls back a pair result and its audit together on an audit conflict", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    let counter = 0;
    let auditCounter = 0;
    const conflictingIds: EvaluationIdFactory = (kind) => {
      counter += 1;
      if (kind === "AUDIT") {
        auditCounter += 1;
        return auditCounter >= 4 && auditCounter <= 5 ? "audit-evaluation-conflict" : `audit-evaluation-${auditCounter}`;
      }
      return `${kind.toLowerCase()}-rollback-${counter}`;
    };
    const result = await runEvaluationBatch({ database, clock: fixedClock, idFactory: conflictingIds });
    expect(result).toEqual(expect.objectContaining({ ok: true, status: "FAILED", attemptCount: 0 }));
    if (result.ok) {
      expect(createEvaluationRunRepository(database).listByBatch(result.batchId)).toHaveLength(2);
      expect(createEvaluationResultRepository(database).listByBatch(result.batchId)).toHaveLength(0);
      const model = buildEvaluationReadModel(database, result.batchId);
      expect(model.ok).toBe(true);
      if (model.ok) {
        expect(model.data.failureCount).toBeGreaterThan(0);
        expect(model.data.gaps).toHaveLength(144);
        expect(model.data.gaps.filter((gap) => gap.gapType === "RESULT_PERSISTENCE_INCOMPLETE")).toHaveLength(2);
        expect(model.data.gaps.filter((gap) => gap.gapType === "NOT_EXECUTED")).toHaveLength(142);
        expect(model.data.matrixSummary.missingResultCount).toBe(144);
        expect(model.data.matrixSummary.unresolvedRunCount).toBe(2);
        const bundle = buildEvaluationExportBundle(database, result.batchId, fixedClock(), idFactory());
        expect(bundle.ok).toBe(true);
        if (bundle.ok) {
          expect(bundle.data.gaps).toHaveLength(144);
          expect(serializeEvaluationResultsCsv(bundle.data)).toContain("RESULT_PERSISTENCE_INCOMPLETE");
        }
      }
    }
    database.close();
  });

  it("keeps a mismatched feedback fixture as FAIL and makes the batch PARTIAL_FAILURE", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const mismatched = adversarialFeedbackFixtures.map((fixture, index) => index === 0
      ? { ...fixture, expectedRuleIds: ["EXPECTED_RULE_MISMATCH"] }
      : fixture);
    const result = await runEvaluationBatch({ database, clock: fixedClock, idFactory: idFactory(), seeds: evaluationSeeds({ adversarialFeedbackFixtures: mismatched }) });
    expect(result).toEqual(expect.objectContaining({ ok: true, status: "PARTIAL_FAILURE" }));
    if (result.ok) {
      const model = buildEvaluationReadModel(database, result.batchId);
      expect(model.ok).toBe(true);
      if (model.ok) {
        expect(model.data.feedbackResults.filter((item) => item.resultStatus === "FAIL")).toHaveLength(1);
        expect(model.data.feedbackMatrixSummary).toEqual(expect.objectContaining({ expectedFixtureCount: 36, recordedFixtureCount: 36, failCount: 1, complete: true }));
        expect(createEvaluationBatchRepository(database).getById(result.batchId)?.status).toBe("PARTIAL_FAILURE");
      }
    }
    database.close();
  });

  it("fails closed with a visible feedback gap when the last fixture audit conflicts", async () => {
    const database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const batchId = "batch-evaluation-0000";
    createAuditEventRepository(database).append({
      schemaVersion: "1.0.0",
      id: formatSystemId("dataset-recorded", `${batchId}-uncertain-006-000`),
      eventType: "EVALUATION_STARTED",
      actorId: "demo-researcher",
      simulatedRole: "RESEARCHER",
      entityType: "EVALUATION_BATCH",
      entityId: batchId,
      metadata: {},
      createdAt: fixedClock(),
    });
    const result = await runEvaluationBatch({ database, clock: fixedClock, idFactory: idFactory() });
    expect(result).toEqual(expect.objectContaining({ ok: true, status: "FAILED" }));
    if (result.ok) {
      const model = buildEvaluationReadModel(database, result.batchId);
      expect(model.ok).toBe(true);
      if (model.ok) {
        expect(model.data.feedbackMatrixSummary).toEqual(expect.objectContaining({ expectedFixtureCount: 36, recordedFixtureCount: 35, missingFixtureCount: 1, complete: false }));
        expect(model.data.feedbackGaps).toEqual(expect.arrayContaining([expect.objectContaining({ fixtureId: "uncertain-006", gapType: "RESULT_PERSISTENCE_INCOMPLETE" })]));
        expect(model.data.failureTypes).toContain("RESULT_PERSISTENCE_INCOMPLETE");
        expect(createAuditEventRepository(database).listPage({ eventType: "DATASET_FEEDBACK_COMPLETED" }).items).toHaveLength(0);
      }
    }
    database.close();
  });

  it("keeps feedback observations stable when fixture execution order changes", async () => {
    const firstDatabase = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const secondDatabase = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
    const first = await runEvaluationBatch({
      database: firstDatabase,
      clock: fixedClock,
      idFactory: idFactory(),
      seeds: evaluationSeeds(),
    });
    const second = await runEvaluationBatch({
      database: secondDatabase,
      clock: fixedClock,
      idFactory: idFactory(),
      seeds: evaluationSeeds({
        adversarialFeedbackFixtures: [...adversarialFeedbackFixtures].reverse(),
        uncertaintyFeedbackFixtures: [...uncertaintyFeedbackFixtures].reverse(),
      }),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      const firstModel = buildEvaluationReadModel(firstDatabase, first.batchId);
      const secondModel = buildEvaluationReadModel(secondDatabase, second.batchId);
      expect(firstModel.ok).toBe(true);
      expect(secondModel.ok).toBe(true);
      if (firstModel.ok && secondModel.ok) {
        const fingerprint = (model: typeof firstModel.data) => model.feedbackResults
          .map((result) => ({
            fixtureId: result.fixtureId,
            generationRunId: result.generationRunId,
            resultStatus: result.resultStatus,
            expectedRuleIds: result.expectedRuleIds,
            observed: result.observed,
          }))
          .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
        expect(fingerprint(firstModel.data)).toEqual(fingerprint(secondModel.data));
      }
    }
    firstDatabase.close();
    secondDatabase.close();
  }, 30_000);
});
