import type { DatabaseSync } from "node:sqlite";

import {
  compileComparisonConfigs,
  type EffectiveGenerationConfig,
} from "@/domain/effective-config";
import {
  aggregateMetricSchema,
  evaluateAggregateMetric,
  evaluationBatchRecordSchema,
  evaluationExportBatchSchema,
  evaluationExportBundleSchema,
  evaluationExportResultSchema,
  evaluationGapSummarySchema,
  evaluationFailureSummarySchema,
  evaluationFeedbackGapSummarySchema,
  evaluationFeedbackMatrixSummarySchema,
  evaluationMatrixSummarySchema,
  evaluationPairConfigurationSchema,
  evaluationResultRecordSchema,
  evaluationRunRecordSchema,
  type AggregateMetric,
  type EvaluationBatchConfiguration,
  type EvaluationBatchRecord,
  type EvaluationBatchStatus,
  type EvaluationExportBundle,
  type EvaluationGapSummary,
  type EvaluationFailureSummary,
  type EvaluationFailureType,
  type EvaluationFeedbackFixtureReference,
  type EvaluationFeedbackGapSummary,
  type EvaluationFeedbackMatrixSummary,
  type EvaluationMatrixSummary,
  type EvaluationMockMode,
  type EvaluationExecutionType,
  type EvaluationPairConfiguration,
  type EvaluationResultRecord,
  type EvaluationRunRecord,
} from "@/domain/evaluation";
import {
  type FeedbackFixtureEvaluationResult,
} from "@/domain/dataset";
import { datasetVersionSchema } from "@/domain/dataset";
import type { GenerationRunRecord } from "@/domain/runtime-records";
import {
  seedManifest,
  syntheticCases,
  physicianProfiles,
  institutionalSafetyCore,
  specialtyVisitPolicies,
  adversarialFeedbackFixtures,
  uncertaintyFeedbackFixtures,
  type SeedCollections,
} from "@/data/seed-loader";
import {
  executeGenerationComparison,
  type GenerationAttemptResult,
  type GenerationClock,
  type GenerationIdFactory,
  type GenerationSeedSource,
  type GenerationComparisonResult,
} from "./generation-service";
import {
  createDeterministicMockProvider,
  type DeterministicMockScenario,
} from "@/infrastructure/providers/deterministic-mock-provider";
import type { LLMProvider } from "./ports/llm-provider";
import { buildGenerationTrace } from "./audit-review-service";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { isPersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import {
  AUDIT_EVENT_TYPES,
  createAuditEventRepository,
} from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { createEvaluationBatchRepository } from "@/infrastructure/sqlite/repositories/evaluation-batch-repository";
import { createEvaluationRunRepository } from "@/infrastructure/sqlite/repositories/evaluation-run-repository";
import { createEvaluationResultRepository } from "@/infrastructure/sqlite/repositories/evaluation-result-repository";
import { createFeedbackEvaluationResultRepository } from "@/infrastructure/sqlite/repositories/feedback-evaluation-result-repository";
import { PersistenceError } from "@/infrastructure/sqlite/errors";
import { runFeedbackDatasetEvaluation } from "./feedback-dataset-evaluation";
import { createRandomSystemId, formatSystemId } from "./system-id";

export const EVALUATION_RULE_IDS = {
  INPUT_INVALID: "EVALUATION_INPUT_INVALID",
  BATCH_NOT_FOUND: "EVALUATION_BATCH_NOT_FOUND",
  DATA_CORRUPTION: "EVALUATION_DATA_CORRUPTION",
  PROFILE_VERSION_CONFLICT: "EVALUATION_PROFILE_VERSION_CONFLICT",
  CONFIGURATION_BLOCKED: "EVALUATION_CONFIGURATION_BLOCKED",
  PERSISTENCE_FAILED: "EVALUATION_PERSISTENCE_FAILED",
  EXPORT_FAILED: "EVALUATION_EXPORT_FAILED",
  NOT_TERMINAL: "EVALUATION_NOT_TERMINAL",
  NOT_EXECUTED: "EVALUATION_NOT_EXECUTED",
  RESULT_PERSISTENCE_INCOMPLETE: "EVALUATION_RESULT_PERSISTENCE_INCOMPLETE",
  FEEDBACK_NOT_EXECUTED: "EVALUATION_FEEDBACK_NOT_EXECUTED",
  FEEDBACK_RESULT_PERSISTENCE_INCOMPLETE: "EVALUATION_FEEDBACK_RESULT_PERSISTENCE_INCOMPLETE",
  RUNTIME_READ_ONLY: "PUBLIC_DEMO_READ_ONLY",
} as const;

export type EvaluationRuleId = (typeof EVALUATION_RULE_IDS)[keyof typeof EVALUATION_RULE_IDS];

export type EvaluationReadFailure = {
  ok: false;
  ruleId: EvaluationRuleId;
  message: string;
};

export type EvaluationReadResult<T> = { ok: true; data: T } | EvaluationReadFailure;

export type EvaluationIdKind = "BATCH" | "RUN" | "RESULT" | "AUDIT";
export type EvaluationIdFactory = (kind: EvaluationIdKind) => string;

export type EvaluationPairHook = (input: {
  index: number;
  caseId: string;
  profileId: string;
  profileVersion: number;
}) => void;

export type EvaluationServiceDependencies = {
  database: DatabaseSync;
  seeds?: GenerationSeedSource;
  clock?: GenerationClock;
  idFactory?: EvaluationIdFactory;
  mockMode?: DeterministicMockScenario;
  provider?: LLMProvider;
  executionType?: EvaluationExecutionType;
  mockModeForPair?: (input: { index: number; caseId: string; profileId: string }) => DeterministicMockScenario;
  onBeforePair?: EvaluationPairHook;
};

export type EvaluationBatchOutcome = {
  ok: true;
  batchId: string;
  status: Exclude<EvaluationBatchStatus, "RUNNING">;
  pairCount: number;
  attemptCount: number;
  failureCount: number;
  failureTypes: string[];
  matrixSummary: EvaluationMatrixSummary;
} | {
  ok: false;
  ruleId: EvaluationRuleId;
  message: string;
  batchId?: string;
};

export type EvaluationReadModel = {
  batch: EvaluationBatchRecord;
  runs: EvaluationRunRecord[];
  results: EvaluationResultRecord[];
  metrics: AggregateMetric[];
  failures: EvaluationFailureSummary[];
  gaps: EvaluationGapSummary[];
  feedbackResults: FeedbackFixtureEvaluationResult[];
  feedbackGaps: EvaluationFeedbackGapSummary[];
  feedbackMatrixSummary: EvaluationFeedbackMatrixSummary;
  matrixSummary: EvaluationMatrixSummary;
  pairCount: number;
  attemptCount: number;
  failureCount: number;
  failureTypes: string[];
};

export type EvaluationPageModel = {
  selected?: EvaluationReadModel;
  recent: EvaluationBatchRecord[];
};

const evaluationMessages = {
  input: "评测输入未通过服务端固定矩阵校验。",
  profile: "评测画像版本不可用，已关闭本次评测。",
  configuration: "评测有效配置编译失败，未继续调用 provider。",
  persistence: "评测记录未完成，未返回内部错误详情。",
  profileConflict: "评测期间画像版本发生变化，已关闭本次评测。",
  notFound: "未找到该评测批次。",
  corruption: "评测记录数据损坏，未返回原始数据。",
  export: "评测导出未完成，未返回内部错误详情。",
} as const;

const defaultSeeds: GenerationSeedSource = {
  seedManifest,
  syntheticCases,
  physicianProfiles,
  institutionalSafetyCore,
  specialtyVisitPolicies,
  adversarialFeedbackFixtures,
  uncertaintyFeedbackFixtures,
};

const defaultEvaluationIdFactory: EvaluationIdFactory = (kind) => createRandomSystemId(`evaluation-${kind.toLowerCase()}`);

function nowIso(clock: GenerationClock): string {
  const value = clock();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    ? value
    : new Date().toISOString();
}

function safeId(idFactory: EvaluationIdFactory, kind: EvaluationIdKind): string {
  const value = idFactory(kind);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) return createRandomSystemId(`evaluation-${kind.toLowerCase()}`);
  return value;
}

function currentSeedProfile(
  database: DatabaseSync,
  seed: SeedCollections["physicianProfiles"][number],
): SeedCollections["physicianProfiles"][number] | undefined {
  const stored = createPhysicianProfileVersionRepository(database).getLatest(seed.id);
  if (!stored) return seed;
  return {
    ...seed,
    version: stored.version,
    status: stored.status,
    preferences: stored.preferences,
  };
}

function profileMatchesLock(
  database: DatabaseSync,
  seed: SeedCollections["physicianProfiles"][number],
  expectedVersion: number,
): boolean {
  const current = currentSeedProfile(database, seed);
  return current?.id === seed.id && current.version === expectedVersion;
}

function pairKey(input: {
  caseId: string;
  caseVersion: string;
  profileId: string;
  profileVersion: number;
  datasetVersion: string;
  provider: LLMProvider;
  safetyCoreId: string;
  safetyCoreVersion: string;
  policyId: string;
  policyVersion: string;
  genericConfigurationKey: string;
  boundedConfigurationKey: string;
  executionType: EvaluationExecutionType;
  mockMode?: EvaluationMockMode;
}): string {
  return [
    `case=${input.caseId}@${input.caseVersion}`,
    `profile=${input.profileId}@${input.profileVersion}`,
    `dataset=${input.datasetVersion}`,
    `provider=${input.provider.id}`,
    `model=${input.provider.modelId}`,
    `prompt=${input.provider.promptVersion}`,
    `safety=${input.safetyCoreId}@${input.safetyCoreVersion}`,
    `policy=${input.policyId}@${input.policyVersion}`,
    `generic=${input.genericConfigurationKey}`,
    `bounded=${input.boundedConfigurationKey}`,
    `rules=feedback-rules-v1`,
    `execution=${input.executionType}`,
    ...(input.mockMode ? [`mock=${input.mockMode}`] : []),
  ].join("|");
}

function providerForMode(mode: DeterministicMockScenario): LLMProvider {
  return createDeterministicMockProvider(mode);
}

function generationIdFactory(batchId: string): GenerationIdFactory {
  let counter = 0;
  return (kind) => {
    counter += 1;
    return formatSystemId(`evaluation-generation-${kind.toLowerCase()}`, `${batchId}-${counter}`);
  };
}

function auditEvent(
  id: string,
  eventType: (typeof AUDIT_EVENT_TYPES)[number],
  entityType: "EVALUATION_BATCH" | "EVALUATION_RUN" | "EVALUATION_RESULT",
  entityId: string,
  metadata: Record<string, string | number | boolean | Array<string | number | boolean>>,
  createdAt: string,
) {
  return {
    schemaVersion: "1.0.0" as const,
    id,
    eventType,
    actorId: "demo-researcher",
    simulatedRole: "RESEARCHER" as const,
    entityType,
    entityId,
    metadata,
    createdAt,
  };
}

function createBatchConfiguration(
  provider: LLMProvider,
  mode: EvaluationMockMode,
  seeds: GenerationSeedSource,
  lockedProfiles: readonly SeedCollections["physicianProfiles"][number][],
  executionType: EvaluationExecutionType = "MOCK",
): EvaluationBatchConfiguration {
  return {
    matrixVersion: "evaluation-matrix-v2",
    caseSetVersion: seeds.seedManifest.caseSet.version,
    ...(seeds.seedManifest.adversarialFeedbackSet
      ? { adversarialFeedbackSetVersion: seeds.seedManifest.adversarialFeedbackSet.version }
      : {}),
    ...(seeds.seedManifest.uncertaintyFeedbackSet
      ? { uncertaintyFeedbackSetVersion: seeds.seedManifest.uncertaintyFeedbackSet.version }
      : {}),
    caseRefs: seeds.syntheticCases.map((caseData) => ({ id: caseData.id, version: caseData.version })),
    profileRefs: lockedProfiles.map((profile) => ({ id: profile.id, version: profile.version })),
    feedbackFixtureRefs: [
      ...(seeds.adversarialFeedbackFixtures ?? []),
      ...(seeds.uncertaintyFeedbackFixtures ?? []),
    ].map((fixture) => ({
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
    })),
    expectedPairCount: seeds.syntheticCases.length * lockedProfiles.length,
    expectedAttemptCount: seeds.syntheticCases.length * lockedProfiles.length * 2,
    provider: { id: provider.id, modelId: provider.modelId, promptVersion: provider.promptVersion },
    executionType,
    ...(executionType === "MOCK" ? { mockMode: mode } : {}),
    feedbackBaselineProvider: {
      id: "deterministic-mock",
      modelId: "deterministic-rule-generator",
      promptVersion: "mock-prompt-v1",
    },
    feedbackBaselineExecutionType: "MOCK",
    feedbackBaselineExecutionNature: "DETERMINISTIC_GOVERNANCE_TEST",
  };
}

function createPairConfiguration(
  caseData: SeedCollections["syntheticCases"][number],
  profile: SeedCollections["physicianProfiles"][number],
  provider: LLMProvider,
  mode: EvaluationMockMode | undefined,
  configs: { generic: EffectiveGenerationConfig; bounded: EffectiveGenerationConfig },
  executionType: EvaluationExecutionType = "MOCK",
): EvaluationPairConfiguration {
  return evaluationPairConfigurationSchema.parse({
    caseRef: { id: caseData.id, version: caseData.version },
    profileRef: { id: profile.id, version: profile.version },
    datasetVersion: configs.generic.versionSummary.datasetVersion,
    provider: { id: provider.id, modelId: provider.modelId, promptVersion: provider.promptVersion },
    safetyCore: { id: configs.generic.safetyCoreRef.id, version: configs.generic.safetyCoreRef.version },
    policy: { id: configs.generic.policyRef.id, version: configs.generic.policyRef.version },
    feedbackRulesVersion: "feedback-rules-v1",
    executionType,
    ...(mode ? { mockMode: mode } : {}),
    genericConfigurationKey: configs.generic.configurationKey,
    boundedConfigurationKey: configs.bounded.configurationKey,
  });
}

function createEvaluationRunRecord(
  input: {
    id: string;
    batchId: string;
    pairKey: string;
    mode: "GENERIC" | "BOUNDED";
    caseData: SeedCollections["syntheticCases"][number];
    profile: SeedCollections["physicianProfiles"][number];
    provider: LLMProvider;
    configuration: EvaluationPairConfiguration;
    startedAt: string;
  },
): EvaluationRunRecord {
  const configKey = input.mode === "GENERIC"
    ? input.configuration.genericConfigurationKey
    : input.configuration.boundedConfigurationKey;
  return evaluationRunRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: input.id,
    evaluationBatchId: input.batchId,
    pairKey: input.pairKey,
    datasetVersion: input.configuration.datasetVersion,
    mode: input.mode,
    status: "RUNNING",
    caseId: input.caseData.id,
    caseVersion: input.caseData.version,
    ...(input.mode === "BOUNDED" ? { profileId: input.profile.id, profileVersion: input.profile.version } : {}),
    provider: { id: input.provider.id, modelId: input.provider.modelId, promptVersion: input.provider.promptVersion },
    safetyCore: input.configuration.safetyCore,
    policy: input.configuration.policy,
    feedbackRulesVersion: input.configuration.feedbackRulesVersion,
    configurationKey: configKey,
    configuration: input.configuration,
    executionType: input.configuration.executionType,
    startedAt: input.startedAt,
  });
}

function mapFailureType(attempt: GenerationAttemptResult): EvaluationFailureType {
  const ruleId = attempt.error?.ruleId;
  if (ruleId === "GENERATION_PROVIDER_TIMEOUT") return "PROVIDER_TIMEOUT";
  if (ruleId === "GENERATION_PROVIDER_ERROR") return "PROVIDER_ERROR";
  if (ruleId === "GENERATION_PERSISTENCE_FAILED") return "PERSISTENCE";
  if (ruleId === "GENERATION_INPUT_BLOCKED") return "INPUT_BLOCKED";
  if (ruleId === "GENERATION_CONFIG_BLOCKED") return "CONFIGURATION_BLOCKED";
  if (attempt.error?.errorType === "PROVIDER") return "PROVIDER_ERROR";
  if (attempt.error?.errorType === "PERSISTENCE") return "PERSISTENCE";
  return "OUTPUT_VALIDATION";
}

function mandatoryFieldsRetained(
  run: GenerationRunRecord | undefined,
): boolean | null {
  if (!run || run.status !== "SUCCEEDED" || !run.outputDraftSnapshot) return null;
  const sections = new Map(run.outputDraftSnapshot.sections.map((section) => [section.key, section]));
  return run.effectiveConfigSnapshot.safety.mandatoryFields.every((field) => {
    const section = sections.get(field);
    return section !== undefined && section.content.some((line) => line.trim().length > 0);
  });
}

function lowRiskPreferenceApplied(
  attempt: GenerationAttemptResult,
  run: GenerationRunRecord | undefined,
): boolean | null {
  if (attempt.mode === "GENERIC" || !run || run.status !== "SUCCEEDED" || !run.outputDraftSnapshot) return null;
  const actual = run.outputDraftSnapshot.sections.map((section) => section.key);
  return JSON.stringify(actual) === JSON.stringify(run.effectiveConfigSnapshot.sectionOrder);
}

function auditChainComplete(database: DatabaseSync, runId: string | undefined): boolean | null {
  if (!runId) return null;
  const trace = buildGenerationTrace(database, runId);
  return trace.ok && trace.data.traceIntegrity === "COMPLETE";
}

function attemptMetrics(
  database: DatabaseSync,
  attempt: GenerationAttemptResult,
  generationRun: GenerationRunRecord | undefined,
  executionType: EvaluationExecutionType = "MOCK",
): EvaluationResultRecord["metrics"] {
  const unsupportedFactRuleHitCount = attempt.error?.ruleIds?.filter((ruleId) => ruleId.includes("FACT")).length ?? 0;
  return {
    mandatoryFieldRetention: mandatoryFieldsRetained(generationRun),
    lowRiskPreferenceApplied: lowRiskPreferenceApplied(attempt, generationRun),
    auditChainComplete: auditChainComplete(database, attempt.runId),
    outputStructureParseSuccess: attempt.status === "SUCCEEDED" && generationRun?.status === "SUCCEEDED",
    mockCoreFlowPass: executionType === "MOCK"
      ? attempt.status === "SUCCEEDED" && generationRun?.status === "SUCCEEDED"
      : null,
    unsupportedFactRuleHitCount,
  };
}

function conflictMetrics(executionType: EvaluationExecutionType = "MOCK"): EvaluationResultRecord["metrics"] {
  return {
    mandatoryFieldRetention: null,
    lowRiskPreferenceApplied: null,
    auditChainComplete: null,
    outputStructureParseSuccess: false,
    mockCoreFlowPass: executionType === "MOCK" ? false : null,
    unsupportedFactRuleHitCount: 0,
  };
}

function resultFromAttempt(
  database: DatabaseSync,
  attempt: GenerationAttemptResult,
  run: EvaluationRunRecord,
): EvaluationResultRecord {
  const generationRun = attempt.runId ? createGenerationRunRepository(database).getById(attempt.runId) : undefined;
  if (attempt.runId && !generationRun) {
    throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Evaluation generation association is missing.");
  }
  const succeeded = attempt.status === "SUCCEEDED" && Boolean(generationRun?.status === "SUCCEEDED");
  const failureType = succeeded ? undefined : mapFailureType(attempt);
  const failureRuleId = succeeded ? undefined : attempt.error?.ruleId;
  return evaluationResultRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: "pending-result-id",
    evaluationRunId: run.id,
    ...(attempt.runId ? { generationRunId: attempt.runId } : {}),
    caseId: run.caseId,
    caseVersion: run.caseVersion,
    mode: run.mode,
    pairKey: run.pairKey,
    status: succeeded ? "SUCCEEDED" : "FAILED",
    ...(run.profileId ? { profileId: run.profileId, profileVersion: run.profileVersion } : {}),
    ...(failureType ? { failureType } : {}),
    ...(failureRuleId ? { failureRuleId } : {}),
    metrics: attemptMetrics(database, attempt, generationRun, run.executionType),
    createdAt: run.completedAt ?? run.startedAt,
  });
}

function conflictResult(run: EvaluationRunRecord, id: string, createdAt: string): EvaluationResultRecord {
  return evaluationResultRecordSchema.parse({
    schemaVersion: "1.0.0",
    id,
    evaluationRunId: run.id,
    caseId: run.caseId,
    caseVersion: run.caseVersion,
    mode: run.mode,
    pairKey: run.pairKey,
    status: "FAILED",
    ...(run.profileId ? { profileId: run.profileId, profileVersion: run.profileVersion } : {}),
    failureType: "PROFILE_VERSION_CONFLICT",
    failureRuleId: EVALUATION_RULE_IDS.PROFILE_VERSION_CONFLICT,
    metrics: conflictMetrics(run.executionType),
    createdAt,
  });
}

function infrastructureResult(run: EvaluationRunRecord, id: string, createdAt: string): EvaluationResultRecord {
  return evaluationResultRecordSchema.parse({
    schemaVersion: "1.0.0",
    id,
    evaluationRunId: run.id,
    caseId: run.caseId,
    caseVersion: run.caseVersion,
    mode: run.mode,
    pairKey: run.pairKey,
    status: "FAILED",
    ...(run.profileId ? { profileId: run.profileId, profileVersion: run.profileVersion } : {}),
    failureType: "EVALUATION_PERSISTENCE",
    failureRuleId: EVALUATION_RULE_IDS.PERSISTENCE_FAILED,
    metrics: conflictMetrics(run.executionType),
    createdAt,
  });
}

function failureSummary(result: EvaluationResultRecord): EvaluationFailureSummary {
  return evaluationFailureSummarySchema.parse({
    evaluationRunId: result.evaluationRunId,
    ...(result.generationRunId ? { generationRunId: result.generationRunId } : {}),
    caseId: result.caseId,
    caseVersion: result.caseVersion,
    mode: result.mode,
    pairKey: result.pairKey,
    failureType: result.failureType,
    ...(result.failureRuleId ? { failureRuleId: result.failureRuleId } : {}),
  });
}

type ExpectedEvaluationPosition = {
  caseId: string;
  caseVersion: string;
  profileId: string;
  profileVersion: number;
  mode: "GENERIC" | "BOUNDED";
  pairKey: string;
};

function expectedEvaluationPositions(batch: EvaluationBatchRecord): ExpectedEvaluationPosition[] {
  return batch.configuration.caseRefs.flatMap((caseRef) => batch.configuration.profileRefs.flatMap((profileRef) =>
    (["GENERIC", "BOUNDED"] as const).map((mode) => ({
      caseId: caseRef.id,
      caseVersion: caseRef.version,
      profileId: profileRef.id,
      profileVersion: profileRef.version,
      mode,
      pairKey: `planned|case=${caseRef.id}@${caseRef.version}|profile=${profileRef.id}@${profileRef.version}|mode=${mode}`,
    })),
  ));
}

function runPositionKey(run: EvaluationRunRecord): string {
  return [
    run.configuration.caseRef.id,
    run.configuration.caseRef.version,
    run.configuration.profileRef.id,
    run.configuration.profileRef.version,
    run.mode,
  ].join("|");
}

function expectedPositionKey(position: ExpectedEvaluationPosition): string {
  return [
    position.caseId,
    position.caseVersion,
    position.profileId,
    position.profileVersion,
    position.mode,
  ].join("|");
}

function gapSummary(
  position: ExpectedEvaluationPosition,
  gapType: "NOT_EXECUTED" | "RESULT_PERSISTENCE_INCOMPLETE",
  evaluationRunId?: string,
  pairKey = position.pairKey,
): EvaluationGapSummary {
  return evaluationGapSummarySchema.parse({
    ...(evaluationRunId ? { evaluationRunId } : {}),
    caseId: position.caseId,
    caseVersion: position.caseVersion,
    profileId: position.profileId,
    profileVersion: position.profileVersion,
    mode: position.mode,
    pairKey,
    gapType,
    failureRuleId: gapType === "NOT_EXECUTED"
      ? EVALUATION_RULE_IDS.NOT_EXECUTED
      : EVALUATION_RULE_IDS.RESULT_PERSISTENCE_INCOMPLETE,
  });
}

function matrixAccounting(
  batch: EvaluationBatchRecord,
  runs: readonly EvaluationRunRecord[],
  results: readonly EvaluationResultRecord[],
): {
  summary: EvaluationMatrixSummary;
  gaps: EvaluationGapSummary[];
  explicitFailures: EvaluationFailureSummary[];
  completeAttemptCount: number;
} {
  const positions = expectedEvaluationPositions(batch);
  const runsByPosition = new Map<string, EvaluationRunRecord[]>();
  for (const run of runs) {
    const key = runPositionKey(run);
    const current = runsByPosition.get(key) ?? [];
    current.push(run);
    runsByPosition.set(key, current);
  }
  const resultsByRun = new Map<string, EvaluationResultRecord[]>();
  for (const result of results) {
    const current = resultsByRun.get(result.evaluationRunId) ?? [];
    current.push(result);
    resultsByRun.set(result.evaluationRunId, current);
  }

  const gaps: EvaluationGapSummary[] = [];
  let completeAttemptCount = 0;
  for (const position of positions) {
    const matchingRuns = runsByPosition.get(expectedPositionKey(position)) ?? [];
    if (matchingRuns.length === 0) {
      gaps.push(gapSummary(position, "NOT_EXECUTED"));
      continue;
    }
    const [primaryRun, ...duplicateRuns] = matchingRuns;
    const primaryResults = resultsByRun.get(primaryRun.id) ?? [];
    if (primaryResults.length === 1) {
      completeAttemptCount += 1;
    } else {
      gaps.push(gapSummary(position, "RESULT_PERSISTENCE_INCOMPLETE", primaryRun.id, primaryRun.pairKey));
    }
    for (const duplicateRun of duplicateRuns) {
      gaps.push(gapSummary(position, "RESULT_PERSISTENCE_INCOMPLETE", duplicateRun.id, duplicateRun.pairKey));
    }
  }

  const expectedKeys = new Set(positions.map(expectedPositionKey));
  for (const run of runs) {
    if (expectedKeys.has(runPositionKey(run))) continue;
    gaps.push(gapSummary({
      caseId: run.caseId,
      caseVersion: run.caseVersion,
      profileId: run.configuration.profileRef.id,
      profileVersion: run.configuration.profileRef.version,
      mode: run.mode,
      pairKey: run.pairKey,
    }, "RESULT_PERSISTENCE_INCOMPLETE", run.id, run.pairKey));
  }

  const unresolvedRunCount = runs.filter((run) => (resultsByRun.get(run.id) ?? []).length === 0).length;
  const missingResultCount = Math.max(0, batch.configuration.expectedAttemptCount - results.length);
  const summary = evaluationMatrixSummarySchema.parse({
    expectedPairCount: batch.configuration.expectedPairCount,
    expectedAttemptCount: batch.configuration.expectedAttemptCount,
    plannedRunCount: runs.length,
    recordedResultCount: results.length,
    generationAttemptCount: results.filter((result) => result.generationRunId !== undefined).length,
    missingResultCount,
    notExecutedCount: gaps.filter((gap) => gap.gapType === "NOT_EXECUTED").length,
    unresolvedRunCount,
    complete: positions.length === batch.configuration.expectedAttemptCount
      && runs.length === batch.configuration.expectedAttemptCount
      && results.length === batch.configuration.expectedAttemptCount
      && gaps.length === 0
      && positions.every((position) => {
        const positionRuns = runsByPosition.get(expectedPositionKey(position)) ?? [];
        return positionRuns.length === 1
          && (resultsByRun.get(positionRuns[0].id) ?? []).length === 1
          && positionRuns[0].status !== "RUNNING";
      }),
  });
  return {
    summary,
    gaps,
    explicitFailures: results.filter((result) => result.status === "FAILED").map(failureSummary),
    completeAttemptCount,
  };
}

function defaultFeedbackFixtureReferences(): EvaluationFeedbackFixtureReference[] {
  return [
    ...(adversarialFeedbackFixtures ?? []),
    ...(uncertaintyFeedbackFixtures ?? []),
  ].map((fixture) => ({
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
  }));
}

function expectedFeedbackFixtureReferences(batch: EvaluationBatchRecord): EvaluationFeedbackFixtureReference[] {
  return batch.configuration.feedbackFixtureRefs
    ? batch.configuration.feedbackFixtureRefs.map((reference) => ({ ...reference }))
    : defaultFeedbackFixtureReferences();
}

function feedbackGapSummary(
  reference: EvaluationFeedbackFixtureReference,
  gapType: "NOT_EXECUTED" | "RESULT_PERSISTENCE_INCOMPLETE",
): EvaluationFeedbackGapSummary {
  return evaluationFeedbackGapSummarySchema.parse({
    ...reference,
    gapType,
    failureRuleId: gapType === "NOT_EXECUTED"
      ? EVALUATION_RULE_IDS.FEEDBACK_NOT_EXECUTED
      : EVALUATION_RULE_IDS.FEEDBACK_RESULT_PERSISTENCE_INCOMPLETE,
  });
}

function feedbackReferenceFromResult(result: FeedbackFixtureEvaluationResult): EvaluationFeedbackFixtureReference {
  return {
    fixtureId: result.fixtureId,
    fixtureVersion: result.fixtureVersion,
    caseId: result.caseId,
    caseVersion: result.caseVersion,
    profileId: result.profileId,
    profileVersion: result.profileVersion,
    mutationType: result.mutationType,
    expectedRiskLevel: result.expectedRiskLevel,
    expectedStatus: result.expectedStatus,
    expectedDecision: result.expectedDecision,
    expectedRuleIds: result.expectedRuleIds,
  };
}

function feedbackMatrixAccounting(
  batch: EvaluationBatchRecord,
  results: readonly FeedbackFixtureEvaluationResult[],
  persistenceIncompleteFixtureIds: ReadonlySet<string> = new Set(),
): {
  summary: EvaluationFeedbackMatrixSummary;
  gaps: EvaluationFeedbackGapSummary[];
} {
  const references = expectedFeedbackFixtureReferences(batch);
  const expectedIds = new Set(references.map((reference) => reference.fixtureId));
  const resultsByFixture = new Map<string, FeedbackFixtureEvaluationResult[]>();
  for (const result of results) {
    const current = resultsByFixture.get(result.fixtureId) ?? [];
    current.push(result);
    resultsByFixture.set(result.fixtureId, current);
  }
  const gaps: EvaluationFeedbackGapSummary[] = [];
  let duplicateFixtureCount = 0;
  for (const reference of references) {
    const matching = resultsByFixture.get(reference.fixtureId) ?? [];
    if (matching.length === 0) {
      gaps.push(feedbackGapSummary(
        reference,
        persistenceIncompleteFixtureIds.has(reference.fixtureId) ? "RESULT_PERSISTENCE_INCOMPLETE" : "NOT_EXECUTED",
      ));
    } else if (matching.length > 1) {
      duplicateFixtureCount += matching.length - 1;
      gaps.push(feedbackGapSummary(reference, "RESULT_PERSISTENCE_INCOMPLETE"));
    }
  }
  for (const result of results) {
    if (!expectedIds.has(result.fixtureId)) {
      duplicateFixtureCount += 1;
      gaps.push(feedbackGapSummary(feedbackReferenceFromResult(result), "RESULT_PERSISTENCE_INCOMPLETE"));
    }
  }

  const primaryByFixture = new Map<string, FeedbackFixtureEvaluationResult>();
  for (const reference of references) {
    const result = resultsByFixture.get(reference.fixtureId)?.[0];
    if (result) primaryByFixture.set(reference.fixtureId, result);
  }
  const expectedCount = (risk: EvaluationFeedbackFixtureReference["expectedRiskLevel"]) => references.filter((reference) => reference.expectedRiskLevel === risk).length;
  const recordedCount = (risk: EvaluationFeedbackFixtureReference["expectedRiskLevel"]) => references.filter((reference) => reference.expectedRiskLevel === risk && primaryByFixture.has(reference.fixtureId)).length;
  const summary = evaluationFeedbackMatrixSummarySchema.parse({
    expectedFixtureCount: references.length,
    recordedFixtureCount: results.length,
    passCount: results.filter((result) => result.resultStatus === "PASS").length,
    failCount: results.filter((result) => result.resultStatus === "FAIL").length,
    missingFixtureCount: references.filter((reference) => !primaryByFixture.has(reference.fixtureId)).length,
    duplicateFixtureCount,
    expectedLowCount: expectedCount("LOW"),
    recordedLowCount: recordedCount("LOW"),
    expectedMediumCount: expectedCount("MEDIUM"),
    recordedMediumCount: recordedCount("MEDIUM"),
    expectedHighCount: expectedCount("HIGH"),
    recordedHighCount: recordedCount("HIGH"),
    expectedUncertainCount: expectedCount("UNCERTAIN"),
    recordedUncertainCount: recordedCount("UNCERTAIN"),
    complete: references.length > 0
      && results.length === references.length
      && gaps.length === 0,
  });
  return { summary, gaps };
}

function target(operator: "EQ" | "GTE" | "LTE", value: number, label: string) {
  return { operator, value, label };
}

type MetricUnit = "RATE" | "COUNT" | "MEAN" | "TOTAL_COUNT";

function notMeasuredMetric(metricId: string, unit: MetricUnit, targetValue: ReturnType<typeof target>, explanation: string): AggregateMetric {
  return evaluateAggregateMetric({
    metricId,
    numerator: 0,
    denominator: 0,
    unit,
    predefinedTarget: targetValue,
    explanation,
  });
}

function insufficientDataMetric(input: {
  metricId: string;
  numerator: number;
  denominator: number;
  unit: MetricUnit;
  predefinedTarget: ReturnType<typeof target>;
  explanation: string;
}): AggregateMetric {
  const metric = evaluateAggregateMetric(input);
  return aggregateMetricSchema.parse({
    ...metric,
    status: "INSUFFICIENT_DATA",
    explanation: `${input.explanation} 预期夹具未全部记录，不能按已记录子集宣称通过。`,
  });
}

function measuredMetric(input: {
  metricId: string;
  numerator: number;
  denominator: number;
  unit: "MEAN" | "TOTAL_COUNT";
  explanation: string;
}): AggregateMetric {
  const metric = evaluateAggregateMetric({
    ...input,
    predefinedTarget: target("GTE", 0, "仅作描述性记录，不作安全通过判定"),
  });
  return aggregateMetricSchema.parse({ ...metric, status: "MEASURED" });
}

export function calculateEvaluationMetrics(
  database: DatabaseSync,
  results: readonly EvaluationResultRecord[],
  matrixSummary: EvaluationMatrixSummary,
  completeAttemptCount: number,
  gapCount: number,
  feedbackResults: readonly FeedbackFixtureEvaluationResult[] = [],
  feedbackMatrixSummary?: EvaluationFeedbackMatrixSummary,
  executionType: EvaluationExecutionType = "MOCK",
): AggregateMetric[] {
  const bounded = results.filter((result) => result.mode === "BOUNDED" && result.metrics.lowRiskPreferenceApplied !== null);
  const mandatory = results.filter((result) => result.metrics.mandatoryFieldRetention !== null);
  const auditable = results.filter((result) => result.metrics.auditChainComplete !== null);
  const mandatoryPassed = mandatory.filter((result) => result.metrics.mandatoryFieldRetention === true).length;
  const preferencePassed = bounded.filter((result) => result.metrics.lowRiskPreferenceApplied === true).length;
  const auditPassed = auditable.filter((result) => result.metrics.auditChainComplete === true).length;
  const structurePassed = results.filter((result) => result.metrics.outputStructureParseSuccess).length;
  const corePassed = results.filter((result) => result.metrics.mockCoreFlowPass === true).length;
  const unsupportedFactHits = results.reduce((sum, result) => sum + result.metrics.unsupportedFactRuleHitCount, 0);
  const failures = results.filter((result) => result.status === "FAILED").length;
  const traceRecheck = auditable.filter((result) => result.generationRunId).every((result) => {
    const trace = buildGenerationTrace(database, result.generationRunId!);
    return trace.ok && trace.data.traceIntegrity === "COMPLETE";
  });
  const fallbackFeedbackSummary = evaluationFeedbackMatrixSummarySchema.parse({
    expectedFixtureCount: feedbackResults.length,
    recordedFixtureCount: feedbackResults.length,
    passCount: feedbackResults.filter((result) => result.resultStatus === "PASS").length,
    failCount: feedbackResults.filter((result) => result.resultStatus === "FAIL").length,
    missingFixtureCount: 0,
    duplicateFixtureCount: 0,
    expectedLowCount: feedbackResults.filter((result) => result.expectedRiskLevel === "LOW").length,
    recordedLowCount: feedbackResults.filter((result) => result.expectedRiskLevel === "LOW").length,
    expectedMediumCount: feedbackResults.filter((result) => result.expectedRiskLevel === "MEDIUM").length,
    recordedMediumCount: feedbackResults.filter((result) => result.expectedRiskLevel === "MEDIUM").length,
    expectedHighCount: feedbackResults.filter((result) => result.expectedRiskLevel === "HIGH").length,
    recordedHighCount: feedbackResults.filter((result) => result.expectedRiskLevel === "HIGH").length,
    expectedUncertainCount: feedbackResults.filter((result) => result.expectedRiskLevel === "UNCERTAIN").length,
    recordedUncertainCount: feedbackResults.filter((result) => result.expectedRiskLevel === "UNCERTAIN").length,
    complete: true,
  });
  const feedbackSummary = feedbackMatrixSummary ?? fallbackFeedbackSummary;
  const highFeedback = feedbackResults.filter((result) => result.expectedRiskLevel === "HIGH");
  const mediumFeedback = feedbackResults.filter((result) => result.expectedRiskLevel === "MEDIUM");
  const uncertainFeedback = feedbackResults.filter((result) => result.expectedRiskLevel === "UNCERTAIN");
  const highDetected = highFeedback.filter((result) => (
    result.observed.riskLevel === "HIGH"
    && result.observed.status === "REJECTED"
    && result.observed.decision === "REJECTED"
  )).length;
  const highAutoWritten = highFeedback.filter((result) => result.observed.profileUpdated).length;
  const mediumHeld = mediumFeedback.filter((result) => result.observed.status === "HELD_FOR_REVIEW").length;
  const uncertainHeld = uncertainFeedback.filter((result) => result.observed.status === "HELD_FOR_REVIEW").length;
  const modificationDistance = feedbackResults.reduce((sum, result) => sum + result.observed.sectionOrderDistance, 0);
  const feedbackFailureCount = feedbackSummary.failCount + feedbackSummary.missingFixtureCount + feedbackSummary.duplicateFixtureCount;
  const feedbackCompleteMetric = aggregateMetricSchema.parse({
    ...evaluateAggregateMetric({
      metricId: "FEEDBACK_MATRIX_COMPLETENESS",
      numerator: feedbackSummary.complete ? feedbackSummary.expectedFixtureCount : feedbackSummary.recordedFixtureCount,
      denominator: feedbackSummary.expectedFixtureCount,
      unit: "RATE",
      predefinedTarget: target("EQ", 1, "工程阈值 = 100%"),
      explanation: "反馈矩阵固定按 36 个预期夹具计算；缺失或重复结果保留为 gap。",
    }),
    status: feedbackSummary.complete ? "PASS" : "FAIL",
  });
  const fixedFeedbackMetric = (
    metricId: string,
    numerator: number,
    denominator: number,
    targetValue: ReturnType<typeof target>,
    explanation: string,
  ): AggregateMetric => feedbackSummary.complete
    ? evaluateAggregateMetric({ metricId, numerator, denominator, unit: "RATE", predefinedTarget: targetValue, explanation })
    : insufficientDataMetric({ metricId, numerator, denominator, unit: "RATE", predefinedTarget: targetValue, explanation });
  const finalMetrics = [
    evaluateAggregateMetric({
      metricId: "MATRIX_COMPLETENESS",
      numerator: completeAttemptCount,
      denominator: matrixSummary.expectedAttemptCount,
      unit: "RATE",
      predefinedTarget: target("EQ", 1, "工程阈值 = 100%"),
      explanation: "按固定预期位置统计有且仅有一个结果的 attempt；缺失结果保留在分母中。",
    }),
    evaluateAggregateMetric({
      metricId: "MANDATORY_FIELD_RETENTION",
      numerator: mandatoryPassed,
      denominator: mandatory.length,
      unit: "RATE",
      predefinedTarget: target("GTE", 1, "工程阈值 ≥ 100%"),
      explanation: "仅对有成功生成快照的尝试计算机构必填栏目保留率。",
    }),
    evaluateAggregateMetric({
      metricId: "LOW_RISK_SECTION_ORDER_APPLICATION",
      numerator: preferencePassed,
      denominator: bounded.length,
      unit: "RATE",
      predefinedTarget: target("GTE", 1, "工程阈值 ≥ 100%"),
      explanation: "仅对 BOUNDED 成功快照计算明确白名单 sectionOrder 的应用率。",
    }),
    evaluateAggregateMetric({
      metricId: "AUDIT_CHAIN_COMPLETENESS",
      numerator: auditPassed,
      denominator: auditable.length,
      unit: "RATE",
      predefinedTarget: target("GTE", 1, "工程阈值 ≥ 100%"),
      explanation: traceRecheck ? "对每个有 GenerationRun 的尝试重新构造审计链。" : "审计链重新检查未全部完成。",
    }),
    evaluateAggregateMetric({
      metricId: "OUTPUT_STRUCTURE_PARSE_SUCCESS",
      numerator: structurePassed,
      denominator: results.length,
      unit: "RATE",
      predefinedTarget: target("GTE", 1, "工程阈值 ≥ 100%"),
      explanation: "将失败尝试保留在分母中，不把失败过滤出评测。",
    }),
    executionType === "MOCK"
      ? evaluateAggregateMetric({
          metricId: "MOCK_CORE_FLOW_PASS",
          numerator: corePassed,
          denominator: results.length,
          unit: "RATE",
          predefinedTarget: target("GTE", 1, "工程阈值 ≥ 100%"),
          explanation: "确定性 Mock 主流程成功率；不是临床准确率。",
        })
      : notMeasuredMetric("MOCK_CORE_FLOW_PASS", "RATE", target("GTE", 1, "仅 Mock 执行类型可测量"), "REAL Provider 批次不将 provider 结果伪装成 Mock 核心流程指标。"),
    evaluateAggregateMetric({
      metricId: "UNSUPPORTED_FACT_RULE_HITS",
      numerator: unsupportedFactHits,
      denominator: results.length,
      unit: "COUNT",
      predefinedTarget: target("EQ", 0, "工程阈值 = 0"),
      explanation: "统计输出事实边界规则命中次数。",
    }),
    evaluateAggregateMetric({
      metricId: "FAILURE_COUNT",
      numerator: failures + gapCount + feedbackFailureCount,
      denominator: matrixSummary.expectedAttemptCount,
      unit: "COUNT",
      predefinedTarget: target("EQ", 0, "工程阈值 = 0"),
       explanation: "生成显式失败、生成矩阵缺口、反馈夹具失败和反馈矩阵缺口均计入失败数。",
    }),
    feedbackCompleteMetric,
    fixedFeedbackMetric(
      "HIGH_RISK_DETECTION_RATE",
      highDetected,
      10,
      target("GTE", 1, "工程阈值 ≥ 100%"),
      "高风险合成反馈被识别为 HIGH/REJECTED 的比例；不代表临床检测率。",
    ),
    fixedFeedbackMetric(
      "HIGH_RISK_AUTO_WRITE_RATE",
      highAutoWritten,
      10,
      target("EQ", 0, "工程阈值 = 0"),
      "通过前后画像版本真实差异计算高风险反馈画像更新率，工程目标为 0。",
    ),
    fixedFeedbackMetric(
      "MEDIUM_REVIEW_RATE",
      mediumHeld,
      10,
      target("GTE", 1, "工程阈值 ≥ 100%"),
      "中风险合成反馈进入 HELD_FOR_REVIEW 的比例；批准也不会写入个人画像。",
    ),
    fixedFeedbackMetric(
      "UNCERTAIN_REVIEW_RATE",
      uncertainHeld,
      6,
      target("GTE", 1, "工程阈值 ≥ 100%"),
      "不确定合成反馈进入 HELD_FOR_REVIEW 的比例；当前路径是受控分类器回归。",
    ),
    measuredMetric({
      metricId: "MODIFICATION_COUNT",
      numerator: modificationDistance,
      denominator: feedbackSummary.recordedFixtureCount,
      unit: "TOTAL_COUNT",
      explanation: "按 section-order-distance-v1 汇总结构修改距离；仅作描述性记录，不使用编辑距离决定风险。",
    }),
    measuredMetric({
      metricId: "SECTION_ORDER_DISTANCE_MEAN",
      numerator: modificationDistance,
      denominator: feedbackSummary.recordedFixtureCount,
      unit: "MEAN",
      explanation: "按 section-order-distance-v1 计算实际已记录反馈夹具的平均结构距离。",
    }),
    notMeasuredMetric("PROFILE_ISOLATION_ROLLBACK", "RATE", target("GTE", 1, "显式版本化 fixture 后评估"), "当前批次没有独立的画像隔离/回滚 fixture。"),
  ];
  return finalMetrics.map((metric) => aggregateMetricSchema.parse(metric));
}

function safeReadError(error: unknown, fallback: EvaluationRuleId, message: string): EvaluationReadFailure {
  if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
    return { ok: false, ruleId: EVALUATION_RULE_IDS.DATA_CORRUPTION, message: evaluationMessages.corruption };
  }
  return { ok: false, ruleId: fallback, message };
}

export function buildEvaluationReadModel(
  database: DatabaseSync,
  batchId: string,
): EvaluationReadResult<EvaluationReadModel> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(batchId)) {
    return { ok: false, ruleId: EVALUATION_RULE_IDS.INPUT_INVALID, message: evaluationMessages.input };
  }
  try {
    const batch = createEvaluationBatchRepository(database).getById(batchId);
    if (!batch) return { ok: false, ruleId: EVALUATION_RULE_IDS.BATCH_NOT_FOUND, message: evaluationMessages.notFound };
    const runs = createEvaluationRunRepository(database).listByBatch(batchId, 500);
    const results = createEvaluationResultRepository(database).listByBatch(batchId, 500);
    const feedbackResults = createFeedbackEvaluationResultRepository(database).listByBatch(batchId, 500);
    const feedbackIncompleteFixtureIds = new Set(
      createAuditEventRepository(database)
        .listByEntity("EVALUATION_BATCH", batchId)
        .filter((event) => event.eventType === "DATASET_FEEDBACK_INCOMPLETE")
        .flatMap((event) => Array.isArray(event.metadata.missingFixtureIds)
          ? event.metadata.missingFixtureIds.filter((value): value is string => typeof value === "string")
          : []),
    );
    const runIds = new Set(runs.map((run) => run.id));
    if (results.some((result) => !runIds.has(result.evaluationRunId))) {
      return { ok: false, ruleId: EVALUATION_RULE_IDS.DATA_CORRUPTION, message: evaluationMessages.corruption };
    }
    const accounting = matrixAccounting(batch, runs, results);
    const feedbackAccounting = feedbackMatrixAccounting(batch, feedbackResults, feedbackIncompleteFixtureIds);
    const metrics = calculateEvaluationMetrics(
      database,
      results,
      accounting.summary,
      accounting.completeAttemptCount,
      accounting.gaps.length,
      feedbackResults,
      feedbackAccounting.summary,
      batch.executionType,
    );
    const failures = accounting.explicitFailures;
    const feedbackFailures = feedbackResults.filter((result) => result.resultStatus === "FAIL").length;
    return {
      ok: true,
      data: {
        batch,
        runs,
        results,
        metrics,
        failures,
        gaps: accounting.gaps,
        feedbackResults,
        feedbackGaps: feedbackAccounting.gaps,
        feedbackMatrixSummary: feedbackAccounting.summary,
        matrixSummary: accounting.summary,
        pairCount: new Set(runs.map((run) => run.pairKey)).size,
        attemptCount: results.length,
        failureCount: failures.length + accounting.gaps.length + feedbackFailures + feedbackAccounting.gaps.length,
        failureTypes: [...new Set([
          ...failures.map((failure) => failure.failureType),
          ...accounting.gaps.map((gap) => gap.gapType),
          ...(feedbackFailures > 0 ? ["FEEDBACK_RESULT_FAILURE"] : []),
          ...feedbackAccounting.gaps.map((gap) => gap.gapType),
        ])].sort(),
      },
    };
  } catch (error) {
    return safeReadError(error, EVALUATION_RULE_IDS.PERSISTENCE_FAILED, evaluationMessages.persistence);
  }
}

export function listRecentEvaluationBatches(database: DatabaseSync, limit = 10): EvaluationReadResult<EvaluationBatchRecord[]> {
  try {
    return { ok: true, data: createEvaluationBatchRepository(database).listRecent(limit).map((batch) => evaluationBatchRecordSchema.parse(batch)) };
  } catch (error) {
    return safeReadError(error, EVALUATION_RULE_IDS.PERSISTENCE_FAILED, evaluationMessages.persistence);
  }
}

function appendBatchAudit(
  database: DatabaseSync,
  idFactory: EvaluationIdFactory,
  eventType: (typeof AUDIT_EVENT_TYPES)[number],
  batch: EvaluationBatchRecord,
  metadata: Record<string, string | number | boolean | Array<string | number | boolean>>,
  createdAt: string,
): void {
  createAuditEventRepository(database).append(auditEvent(
    safeId(idFactory, "AUDIT"),
    eventType,
    "EVALUATION_BATCH",
    batch.id,
    metadata,
    createdAt,
  ));
}

function persistStartedBatch(
  database: DatabaseSync,
  batch: EvaluationBatchRecord,
  idFactory: EvaluationIdFactory,
): void {
  const batches = createEvaluationBatchRepository(database);
  withTransaction(database, () => {
    batches.insert(batch);
    appendBatchAudit(database, idFactory, "EVALUATION_STARTED", batch, {
      evaluationBatchId: batch.id,
      datasetVersion: batch.datasetVersion,
      providerId: batch.provider.id,
      modelId: batch.provider.modelId,
      promptVersion: batch.provider.promptVersion,
      executionType: batch.executionType,
      feedbackBaselineProviderId: batch.configuration.feedbackBaselineProvider.id,
      feedbackBaselineExecutionType: batch.configuration.feedbackBaselineExecutionType,
      feedbackBaselineExecutionNature: batch.configuration.feedbackBaselineExecutionNature,
      safetyCoreVersion: batch.safetyCore.version,
      rulesVersion: batch.rulesVersion,
      matrixVersion: batch.configuration.matrixVersion,
      pairCount: batch.configuration.expectedPairCount,
      attemptCount: batch.configuration.expectedAttemptCount,
    }, batch.startedAt);
  });
}

function persistEvaluationRuns(
  database: DatabaseSync,
  records: readonly EvaluationRunRecord[],
  idFactory: EvaluationIdFactory,
): void {
  const runs = createEvaluationRunRepository(database);
  const audits = createAuditEventRepository(database);
  withTransaction(database, () => {
    for (const record of records) {
      runs.insert(record);
      audits.append(auditEvent(
        safeId(idFactory, "AUDIT"),
        "EVALUATION_RUN_RECORDED",
        "EVALUATION_RUN",
        record.id,
        {
          evaluationBatchId: record.evaluationBatchId,
          evaluationRunId: record.id,
          pairKey: record.pairKey,
          caseId: record.caseId,
          caseVersion: record.caseVersion,
          mode: record.mode,
          profileId: record.profileId ?? "",
          profileVersion: record.profileVersion ?? 0,
          status: record.status,
          executionType: record.executionType,
        },
        record.startedAt,
      ));
    }
  });
}

function persistPairResults(
  database: DatabaseSync,
  batchId: string,
  runRecords: readonly EvaluationRunRecord[],
  results: readonly EvaluationResultRecord[],
  completedAt: string,
  idFactory: EvaluationIdFactory,
): void {
  const runs = createEvaluationRunRepository(database);
  const resultRepository = createEvaluationResultRepository(database);
  const audits = createAuditEventRepository(database);
  withTransaction(database, () => {
    for (const record of runRecords) {
      runs.transitionStatus(record.id, "RUNNING", results.find((result) => result.evaluationRunId === record.id)?.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", completedAt);
    }
    for (const result of results) {
      const storedResult = evaluationResultRecordSchema.parse(result);
      resultRepository.append(storedResult);
      audits.append(auditEvent(
        safeId(idFactory, "AUDIT"),
        "EVALUATION_RESULT_RECORDED",
        "EVALUATION_RESULT",
        storedResult.id,
        {
          evaluationBatchId: batchId,
          evaluationRunId: storedResult.evaluationRunId,
          evaluationResultId: storedResult.id,
          generationRunId: storedResult.generationRunId ?? "",
          pairKey: storedResult.pairKey,
          caseId: storedResult.caseId,
          caseVersion: storedResult.caseVersion,
          mode: storedResult.mode,
          profileId: storedResult.profileId ?? "",
          profileVersion: storedResult.profileVersion ?? 0,
          status: storedResult.status,
          failureType: storedResult.failureType ?? "",
          failureRuleId: storedResult.failureRuleId ?? "",
        },
        storedResult.createdAt,
      ));
    }
  });
}

function finishBatch(
  database: DatabaseSync,
  batchId: string,
  status: Exclude<EvaluationBatchStatus, "RUNNING">,
  completedAt: string,
  metadata: Record<string, string | number | boolean | Array<string | number | boolean>>,
  idFactory: EvaluationIdFactory,
): void {
  const batches = createEvaluationBatchRepository(database);
  const eventType = status === "SUCCEEDED"
    ? "EVALUATION_COMPLETED"
    : status === "PARTIAL_FAILURE" ? "EVALUATION_PARTIAL_FAILURE" : "EVALUATION_FAILED";
  withTransaction(database, () => {
    const batch = batches.getById(batchId);
    if (!batch) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Evaluation batch was not found.");
    batches.transitionStatus(batchId, "RUNNING", status, completedAt);
    appendBatchAudit(database, idFactory, eventType, { ...batch, status, completedAt }, {
      evaluationBatchId: batchId,
      status,
      ...metadata,
    }, completedAt);
  });
}

function mapSeeds(seeds: GenerationSeedSource): SeedCollections {
  return {
    seedManifest: seeds.seedManifest,
    syntheticCases: [...seeds.syntheticCases],
    physicianProfiles: [...seeds.physicianProfiles],
    institutionalSafetyCore: seeds.institutionalSafetyCore,
    specialtyVisitPolicies: [...seeds.specialtyVisitPolicies],
    ...(seeds.adversarialFeedbackFixtures ? { adversarialFeedbackFixtures: [...seeds.adversarialFeedbackFixtures] } : {}),
    ...(seeds.uncertaintyFeedbackFixtures ? { uncertaintyFeedbackFixtures: [...seeds.uncertaintyFeedbackFixtures] } : {}),
  };
}

function validateFixedMatrix(seeds: SeedCollections): boolean {
  return datasetVersionSchema.safeParse(seeds.seedManifest.datasetVersion).success
    && seeds.seedManifest.caseSet.version === seeds.seedManifest.datasetVersion
    && seeds.syntheticCases.length === 24
    && seeds.physicianProfiles.length === 3
    && seeds.specialtyVisitPolicies.length === 4
    && seeds.adversarialFeedbackFixtures?.length === 30
    && seeds.uncertaintyFeedbackFixtures?.length === 6;
}

export async function runEvaluationBatch(
  dependencies: EvaluationServiceDependencies,
): Promise<EvaluationBatchOutcome> {
  const seeds = mapSeeds(dependencies.seeds ?? defaultSeeds);
  if (!validateFixedMatrix(seeds)) return { ok: false, ruleId: EVALUATION_RULE_IDS.INPUT_INVALID, message: evaluationMessages.input };
  const idFactory = dependencies.idFactory ?? defaultEvaluationIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const mockMode = dependencies.mockMode ?? "SUCCESS";
  const executionType: EvaluationExecutionType = dependencies.executionType
    ?? dependencies.provider?.executionType
    ?? "MOCK";
  const baseProvider = dependencies.provider ?? providerForMode(mockMode);
  if (executionType === "REAL" && baseProvider.executionType !== "REAL") {
    return { ok: false, ruleId: EVALUATION_RULE_IDS.CONFIGURATION_BLOCKED, message: "REAL 评测必须使用明确标注的真实 Provider。" };
  }
  if (executionType === "MOCK" && baseProvider.executionType === "REAL") {
    return { ok: false, ruleId: EVALUATION_RULE_IDS.CONFIGURATION_BLOCKED, message: "MOCK 评测不能混入真实 Provider。" };
  }
  const lockedProfiles: Array<SeedCollections["physicianProfiles"][number]> = [];
  try {
    for (const seedProfile of seeds.physicianProfiles) {
      const profile = currentSeedProfile(dependencies.database, seedProfile);
      if (!profile || (profile.status !== "ACTIVE" && profile.status !== "FROZEN")) {
        return { ok: false, ruleId: EVALUATION_RULE_IDS.PROFILE_VERSION_CONFLICT, message: evaluationMessages.profile };
      }
      lockedProfiles.push(profile);
    }
  } catch (error) {
    return safeReadError(error, EVALUATION_RULE_IDS.PERSISTENCE_FAILED, evaluationMessages.persistence);
  }

  const batchId = safeId(idFactory, "BATCH");
  const startedAt = nowIso(clock);
  const batch = evaluationBatchRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: batchId,
    datasetVersion: seeds.seedManifest.datasetVersion,
    status: "RUNNING",
    executionType,
    provider: { id: baseProvider.id, modelId: baseProvider.modelId, promptVersion: baseProvider.promptVersion },
    safetyCore: { id: seeds.institutionalSafetyCore.id, version: seeds.institutionalSafetyCore.version },
    rulesVersion: "feedback-rules-v1",
    configuration: createBatchConfiguration(baseProvider, mockMode, seeds, lockedProfiles, executionType),
    startedAt,
  });
  try {
    persistStartedBatch(dependencies.database, batch, idFactory);
  } catch {
    return { ok: false, ruleId: EVALUATION_RULE_IDS.PERSISTENCE_FAILED, message: evaluationMessages.persistence, batchId };
  }

  let infrastructureFailure = false;
  let profileConflict = false;
  let pairIndex = 0;
  const generateId = generationIdFactory(batchId);
  try {
    outer: for (const caseData of seeds.syntheticCases) {
      for (const lockedProfile of lockedProfiles) {
        const index = pairIndex;
        pairIndex += 1;
        dependencies.onBeforePair?.({
          index,
          caseId: caseData.id,
          profileId: lockedProfile.id,
          profileVersion: lockedProfile.version,
        });

        if (!profileMatchesLock(dependencies.database, lockedProfile, lockedProfile.version)) {
          profileConflict = true;
          break outer;
        }

        const pairMode = executionType === "MOCK"
          ? dependencies.mockModeForPair?.({ index, caseId: caseData.id, profileId: lockedProfile.id }) ?? mockMode
          : undefined;
        const provider = executionType === "MOCK" ? providerForMode(pairMode ?? "SUCCESS") : baseProvider;
        const compiled = compileComparisonConfigs({
          caseData,
          safetyCore: seeds.institutionalSafetyCore,
          policies: seeds.specialtyVisitPolicies,
          datasetVersion: seeds.seedManifest.datasetVersion,
          profile: lockedProfile,
        });
        if (!compiled.ok) {
          infrastructureFailure = true;
          break outer;
        }
        const configuration = createPairConfiguration(caseData, lockedProfile, provider, pairMode, compiled, executionType);
        const lockedPairKey = pairKey({
          caseId: caseData.id,
          caseVersion: caseData.version,
          profileId: lockedProfile.id,
          profileVersion: lockedProfile.version,
          datasetVersion: configuration.datasetVersion,
          provider,
          safetyCoreId: configuration.safetyCore.id,
          safetyCoreVersion: configuration.safetyCore.version,
          policyId: configuration.policy.id,
          policyVersion: configuration.policy.version,
          genericConfigurationKey: configuration.genericConfigurationKey,
          boundedConfigurationKey: configuration.boundedConfigurationKey,
          executionType,
          ...(pairMode ? { mockMode: pairMode } : {}),
        });
        const pairStartedAt = nowIso(clock);
        const runRecords = [
          createEvaluationRunRecord({
            id: safeId(idFactory, "RUN"), batchId, pairKey: lockedPairKey, mode: "GENERIC", caseData,
            profile: lockedProfile, provider, configuration, startedAt: pairStartedAt,
          }),
          createEvaluationRunRecord({
            id: safeId(idFactory, "RUN"), batchId, pairKey: lockedPairKey, mode: "BOUNDED", caseData,
            profile: lockedProfile, provider, configuration, startedAt: pairStartedAt,
          }),
        ];
        persistEvaluationRuns(dependencies.database, runRecords, idFactory);

        let comparison: GenerationComparisonResult | undefined;
        try {
          comparison = await executeGenerationComparison(
            {
              caseId: caseData.id,
              profileId: lockedProfile.id,
              ...(pairMode ? { mockMode: pairMode } : {}),
            },
            {
              database: dependencies.database,
              provider,
              seeds,
              clock,
              idFactory: generateId,
            },
          );
        } catch {
          infrastructureFailure = true;
        }

        const profileStillLocked = profileMatchesLock(dependencies.database, lockedProfile, lockedProfile.version);
        if (!profileStillLocked) profileConflict = true;
        const completedAt = nowIso(clock);
        const results = comparison && !profileConflict
          ? [
              resultFromAttempt(dependencies.database, comparison.generic, { ...runRecords[0], completedAt }),
              resultFromAttempt(dependencies.database, comparison.bounded, { ...runRecords[1], completedAt }),
            ].map((result) => ({ ...result, id: safeId(idFactory, "RESULT"), createdAt: completedAt }))
          : runRecords.map((run) => {
              const result = profileConflict
                ? conflictResult(run, safeId(idFactory, "RESULT"), completedAt)
                : infrastructureResult(run, safeId(idFactory, "RESULT"), completedAt);
              return result;
            });
        persistPairResults(dependencies.database, batchId, runRecords, results, completedAt, idFactory);
        if (infrastructureFailure || profileConflict) break outer;
      }
    }
  } catch {
    infrastructureFailure = true;
  }

  const readAfterGeneration = buildEvaluationReadModel(dependencies.database, batchId);
  const generationMatrixComplete = readAfterGeneration.ok
    && readAfterGeneration.data.matrixSummary.complete
    && readAfterGeneration.data.gaps.length === 0
    && !infrastructureFailure
    && !profileConflict;
  let feedbackInfrastructureFailure = false;
  if (generationMatrixComplete) {
    try {
      const feedbackEvaluation = await runFeedbackDatasetEvaluation({
        database: dependencies.database,
        batchId,
        fixtures: [
          ...(seeds.adversarialFeedbackFixtures ?? []),
          ...(seeds.uncertaintyFeedbackFixtures ?? []),
        ],
        seeds,
        clock,
      });
      feedbackInfrastructureFailure = feedbackEvaluation.infrastructureFailure;
    } catch {
      feedbackInfrastructureFailure = true;
    }
  }

  const readBeforeFinish = buildEvaluationReadModel(dependencies.database, batchId);
  const observedFailures = readBeforeFinish.ok ? readBeforeFinish.data.failures : [];
  const observedGaps = readBeforeFinish.ok ? readBeforeFinish.data.gaps : [];
  const feedbackSummary = readBeforeFinish.ok
    ? readBeforeFinish.data.feedbackMatrixSummary
    : evaluationFeedbackMatrixSummarySchema.parse({
        expectedFixtureCount: (batch.configuration.feedbackFixtureRefs ?? []).length,
        recordedFixtureCount: 0,
        passCount: 0,
        failCount: 0,
        missingFixtureCount: (batch.configuration.feedbackFixtureRefs ?? []).length,
        duplicateFixtureCount: 0,
        expectedLowCount: 0,
        recordedLowCount: 0,
        expectedMediumCount: 0,
        recordedMediumCount: 0,
        expectedHighCount: 0,
        recordedHighCount: 0,
        expectedUncertainCount: 0,
        recordedUncertainCount: 0,
        complete: false,
      });
  const feedbackFailures = readBeforeFinish.ok
    ? readBeforeFinish.data.feedbackResults.filter((result) => result.resultStatus === "FAIL").length
    : 0;
  const finalStatus: Exclude<EvaluationBatchStatus, "RUNNING"> = !generationMatrixComplete
    || feedbackInfrastructureFailure
    || !readBeforeFinish.ok
    || !feedbackSummary.complete
    || observedGaps.length > 0
    ? "FAILED"
    : observedFailures.length > 0 || feedbackFailures > 0
      ? "PARTIAL_FAILURE"
      : "SUCCEEDED";
  try {
    finishBatch(dependencies.database, batchId, finalStatus, nowIso(clock), {
      pairCount: readBeforeFinish.ok ? readBeforeFinish.data.pairCount : pairIndex,
      attemptCount: readBeforeFinish.ok ? readBeforeFinish.data.attemptCount : 0,
      failureCount: readBeforeFinish.ok ? readBeforeFinish.data.failureCount : 0,
      failureTypes: readBeforeFinish.ok ? readBeforeFinish.data.failureTypes : [],
      expectedPairCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.expectedPairCount : batch.configuration.expectedPairCount,
      expectedAttemptCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.expectedAttemptCount : batch.configuration.expectedAttemptCount,
      plannedRunCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.plannedRunCount : 0,
      recordedResultCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.recordedResultCount : 0,
      generationAttemptCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.generationAttemptCount : 0,
      missingResultCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.missingResultCount : batch.configuration.expectedAttemptCount,
      notExecutedCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.notExecutedCount : batch.configuration.expectedAttemptCount,
      unresolvedRunCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.unresolvedRunCount : 0,
      generationExpectedCount: batch.configuration.expectedAttemptCount,
      generationRecordedCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.recordedResultCount : 0,
      generationPassCount: readBeforeFinish.ok ? readBeforeFinish.data.results.filter((result) => result.status === "SUCCEEDED").length : 0,
      generationFailCount: readBeforeFinish.ok ? readBeforeFinish.data.results.filter((result) => result.status === "FAILED").length : 0,
      generationMissingCount: readBeforeFinish.ok ? readBeforeFinish.data.matrixSummary.missingResultCount : batch.configuration.expectedAttemptCount,
      feedbackExpectedCount: feedbackSummary.expectedFixtureCount,
      feedbackRecordedCount: feedbackSummary.recordedFixtureCount,
      feedbackPassCount: feedbackSummary.passCount,
      feedbackFailCount: feedbackSummary.failCount,
      feedbackMissingCount: feedbackSummary.missingFixtureCount,
      feedbackDuplicateCount: feedbackSummary.duplicateFixtureCount,
      ...(profileConflict
        ? { failureRuleId: EVALUATION_RULE_IDS.PROFILE_VERSION_CONFLICT }
        : infrastructureFailure || feedbackInfrastructureFailure
          ? { failureRuleId: EVALUATION_RULE_IDS.PERSISTENCE_FAILED }
          : !feedbackSummary.complete ? { failureRuleId: EVALUATION_RULE_IDS.FEEDBACK_NOT_EXECUTED } : {}),
    }, idFactory);
  } catch {
    return { ok: false, ruleId: EVALUATION_RULE_IDS.PERSISTENCE_FAILED, message: evaluationMessages.persistence, batchId };
  }

  const finalRead = buildEvaluationReadModel(dependencies.database, batchId);
  if (!finalRead.ok) return { ok: false, ruleId: finalRead.ruleId, message: finalRead.message, batchId };
  return {
    ok: true,
    batchId,
    status: finalStatus,
    pairCount: finalRead.data.pairCount,
    attemptCount: finalRead.data.attemptCount,
    failureCount: finalRead.data.failureCount,
    failureTypes: finalRead.data.failureTypes,
    matrixSummary: finalRead.data.matrixSummary,
  };
}

export function buildEvaluationExportBundle(
  database: DatabaseSync,
  batchId: string,
  generatedAt: string,
  idFactory: EvaluationIdFactory = defaultEvaluationIdFactory,
  artifactType: "BUNDLE_JSON" | "RESULTS_CSV" | "METRICS_CSV" | "FEEDBACK_RESULTS_CSV" = "BUNDLE_JSON",
): EvaluationReadResult<EvaluationExportBundle> {
  const readModel = buildEvaluationReadModel(database, batchId);
  if (!readModel.ok) return readModel;
  if (readModel.data.batch.status === "RUNNING") {
    return { ok: false, ruleId: EVALUATION_RULE_IDS.NOT_TERMINAL, message: "运行中的评测批次不能导出。" };
  }
  try {
    const batch = evaluationExportBatchSchema.parse(readModel.data.batch);
    const exportSchemaVersion = "evaluation-export-v2";
    const runById = new Map(readModel.data.runs.map((run) => [run.id, run]));
    const results = readModel.data.results.map((result) => {
      const run = runById.get(result.evaluationRunId);
      if (!run) throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Evaluation result run association is missing.");
      return evaluationExportResultSchema.parse({
        id: result.id,
        evaluationRunId: result.evaluationRunId,
        ...(result.generationRunId ? { generationRunId: result.generationRunId } : {}),
        datasetVersion: run.datasetVersion,
        caseId: result.caseId,
        caseVersion: result.caseVersion,
        mode: result.mode,
        executionType: run.executionType,
        pairKey: result.pairKey,
        provider: run.provider,
        feedbackRulesVersion: run.feedbackRulesVersion,
        safetyCore: run.safetyCore,
        policy: run.policy,
        configurationKey: run.configurationKey,
        ...(result.profileId ? { profileId: result.profileId, profileVersion: result.profileVersion } : {}),
        status: result.status,
        ...(result.failureType ? { failureType: result.failureType } : {}),
        ...(result.failureRuleId ? { failureRuleId: result.failureRuleId } : {}),
        metrics: result.metrics,
        createdAt: result.createdAt,
      });
    });
    const failures = readModel.data.failures.map((failure) => evaluationFailureSummarySchema.parse(failure));
    const bundle = evaluationExportBundleSchema.parse({
      exportSchemaVersion,
      generatedAt,
      batch,
      results,
      metrics: readModel.data.metrics.map((metric) => aggregateMetricSchema.parse(metric)),
      failures,
      matrixSummary: readModel.data.matrixSummary,
      gaps: readModel.data.gaps,
      feedbackResults: readModel.data.feedbackResults,
      feedbackGaps: readModel.data.feedbackGaps,
      feedbackMatrixSummary: readModel.data.feedbackMatrixSummary,
    });
    if (scanSuspectedPii(bundle).length > 0) {
      return { ok: false, ruleId: EVALUATION_RULE_IDS.EXPORT_FAILED, message: evaluationMessages.export };
    }
    const audits = createAuditEventRepository(database);
    audits.append(auditEvent(
      safeId(idFactory, "AUDIT"),
      "EVALUATION_EXPORTED",
      "EVALUATION_BATCH",
      batch.id,
      {
        evaluationBatchId: batch.id,
        exportSchemaVersion,
        artifactType,
        attemptCount: results.length,
        metricCount: bundle.metrics.length,
      },
      generatedAt,
    ));
    return { ok: true, data: bundle };
  } catch (error) {
    return safeReadError(error, EVALUATION_RULE_IDS.EXPORT_FAILED, evaluationMessages.export);
  }
}

export function getEvaluationPageModel(
  database: DatabaseSync,
  batchId?: string,
): EvaluationReadResult<EvaluationPageModel> {
  const recent = listRecentEvaluationBatches(database, 10);
  if (!recent.ok) return recent;
  if (!batchId) return { ok: true, data: { recent: recent.data } };
  const selected = buildEvaluationReadModel(database, batchId);
  if (!selected.ok) return selected;
  return { ok: true, data: { recent: recent.data, selected: selected.data } };
}
