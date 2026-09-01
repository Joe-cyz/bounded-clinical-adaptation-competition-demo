import { z } from "zod";

import { isoUtcTimestampSchema } from "./runtime-records";
import { feedbackFixtureEvaluationResultSchema } from "./dataset";

const runtimeSchemaVersion = z.literal("1.0.0");
const safeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const safeTokenSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const ruleIdSchema = z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_.-]*$/u);

export const evaluationBatchStatusSchema = z.enum([
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL_FAILURE",
  "FAILED",
]);
export type EvaluationBatchStatus = z.infer<typeof evaluationBatchStatusSchema>;

export const evaluationRunStatusSchema = z.enum(["RUNNING", "SUCCEEDED", "FAILED"]);
export type EvaluationRunStatus = z.infer<typeof evaluationRunStatusSchema>;

export const evaluationResultStatusSchema = z.enum(["SUCCEEDED", "FAILED"]);
export type EvaluationResultStatus = z.infer<typeof evaluationResultStatusSchema>;

export const evaluationModeSchema = z.enum(["GENERIC", "BOUNDED"]);
export type EvaluationMode = z.infer<typeof evaluationModeSchema>;

export const evaluationMockModeSchema = z.enum([
  "SUCCESS",
  "INVALID_JSON",
  "TIMEOUT",
  "PROVIDER_ERROR",
  "INVALID_OUTPUT_SCHEMA",
  "INVALID_OUTPUT_RULE",
  "INVALID_OUTPUT_FACT",
  "INVALID_OUTPUT_PROHIBITED_ACTION",
  "INVALID_OUTPUT_PII",
  "INVALID_OUTPUT_DUPLICATE",
  "INVALID_OUTPUT_ORDER",
]);
export type EvaluationMockMode = z.infer<typeof evaluationMockModeSchema>;

export const evaluationExecutionTypeSchema = z.enum(["MOCK", "REAL"]);
export type EvaluationExecutionType = z.infer<typeof evaluationExecutionTypeSchema>;

export const evaluationRulesVersionSchema = z.literal("feedback-rules-v1");
export const evaluationMatrixVersionSchema = z.enum(["evaluation-matrix-v1", "evaluation-matrix-v2"]);
export const evaluationExportSchemaVersion = "evaluation-export-v2" as const;
export const evaluationExportSchemaVersionSchema = z.enum(["evaluation-export-v1", "evaluation-export-v2"]);

const versionedCaseRefSchema = z.object({
  id: safeIdSchema,
  version: safeTokenSchema,
}).strict();

const feedbackFixtureRiskSchema = z.enum(["LOW", "MEDIUM", "HIGH", "UNCERTAIN"]);
const feedbackFixtureStatusSchema = z.enum(["CANDIDATE", "HELD_FOR_REVIEW", "REJECTED"]);
const feedbackFixtureDecisionSchema = z.enum(["PENDING", "REJECTED"]);

export const evaluationFeedbackFixtureReferenceSchema = z.object({
  fixtureId: safeIdSchema,
  fixtureVersion: safeTokenSchema,
  caseId: safeIdSchema,
  caseVersion: safeTokenSchema,
  profileId: safeIdSchema,
  profileVersion: z.number().int().positive().max(100_000),
  mutationType: z.string().min(1).max(100),
  expectedRiskLevel: feedbackFixtureRiskSchema,
  expectedStatus: feedbackFixtureStatusSchema,
  expectedDecision: feedbackFixtureDecisionSchema,
  expectedRuleIds: z.array(ruleIdSchema).min(1).max(20),
}).strict();
export type EvaluationFeedbackFixtureReference = z.infer<typeof evaluationFeedbackFixtureReferenceSchema>;

const versionedProfileRefSchema = z.object({
  id: safeIdSchema,
  version: z.number().int().positive().max(100_000),
}).strict();

const versionedPolicyRefSchema = z.object({
  id: safeIdSchema,
  version: safeTokenSchema,
}).strict();

const versionedSafetyRefSchema = z.object({
  id: safeIdSchema,
  version: safeTokenSchema,
}).strict();

const providerRefSchema = z.object({
  id: safeTokenSchema,
  modelId: safeTokenSchema,
  promptVersion: safeTokenSchema,
}).strict();

const feedbackBaselineProviderSchema = providerRefSchema.default({
  id: "deterministic-mock",
  modelId: "deterministic-rule-generator",
  promptVersion: "mock-prompt-v1",
});

export const evaluationBatchConfigurationSchema = z.object({
  matrixVersion: evaluationMatrixVersionSchema,
  caseSetVersion: safeTokenSchema.optional(),
  adversarialFeedbackSetVersion: safeTokenSchema.optional(),
  uncertaintyFeedbackSetVersion: safeTokenSchema.optional(),
  caseRefs: z.array(versionedCaseRefSchema).min(1).max(24),
  profileRefs: z.array(versionedProfileRefSchema).min(1).max(3),
  feedbackFixtureRefs: z.array(evaluationFeedbackFixtureReferenceSchema).max(100).optional(),
  expectedPairCount: z.number().int().positive().max(72),
  expectedAttemptCount: z.number().int().positive().max(144),
  provider: providerRefSchema,
  executionType: evaluationExecutionTypeSchema.default("MOCK"),
  mockMode: evaluationMockModeSchema.optional(),
  feedbackBaselineProvider: feedbackBaselineProviderSchema,
  feedbackBaselineExecutionType: z.literal("MOCK").default("MOCK"),
  feedbackBaselineExecutionNature: z.literal("DETERMINISTIC_GOVERNANCE_TEST").default("DETERMINISTIC_GOVERNANCE_TEST"),
}).strict().superRefine((configuration, context) => {
  if (configuration.caseRefs.length * configuration.profileRefs.length !== configuration.expectedPairCount) {
    context.addIssue({ code: "custom", path: ["expectedPairCount"], message: "Evaluation matrix pair count must match case and profile references." });
  }
  if (configuration.expectedPairCount * 2 !== configuration.expectedAttemptCount) {
    context.addIssue({ code: "custom", path: ["expectedAttemptCount"], message: "Evaluation matrix attempt count must be two per pair." });
  }
});
export type EvaluationBatchConfiguration = z.infer<typeof evaluationBatchConfigurationSchema>;

export const evaluationBatchRecordSchema = z.object({
  schemaVersion: runtimeSchemaVersion,
  id: safeIdSchema,
  datasetVersion: safeTokenSchema,
  status: evaluationBatchStatusSchema,
  executionType: evaluationExecutionTypeSchema.default("MOCK"),
  provider: providerRefSchema,
  safetyCore: versionedSafetyRefSchema,
  rulesVersion: evaluationRulesVersionSchema,
  configuration: evaluationBatchConfigurationSchema,
  startedAt: isoUtcTimestampSchema,
  completedAt: isoUtcTimestampSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.status === "RUNNING" && record.completedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Running evaluation batches cannot be completed." });
  }
  if (record.status !== "RUNNING" && record.completedAt === undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal evaluation batches require a completion timestamp." });
  }
  if (record.configuration.provider.id !== record.provider.id
    || record.configuration.provider.modelId !== record.provider.modelId
    || record.configuration.provider.promptVersion !== record.provider.promptVersion) {
    context.addIssue({ code: "custom", path: ["configuration", "provider"], message: "Batch provider snapshot must match its top-level provider." });
  }
  if (record.configuration.executionType !== record.executionType) {
    context.addIssue({ code: "custom", path: ["executionType"], message: "Batch execution type must match its configuration." });
  }
});
export type EvaluationBatchRecord = z.infer<typeof evaluationBatchRecordSchema>;

export const evaluationPairConfigurationSchema = z.object({
  caseRef: versionedCaseRefSchema,
  profileRef: versionedProfileRefSchema,
  datasetVersion: safeTokenSchema,
  provider: providerRefSchema,
  safetyCore: versionedSafetyRefSchema,
  policy: versionedPolicyRefSchema,
  feedbackRulesVersion: evaluationRulesVersionSchema,
  executionType: evaluationExecutionTypeSchema.default("MOCK"),
  mockMode: evaluationMockModeSchema.optional(),
  genericConfigurationKey: z.string().min(1).max(1_000),
  boundedConfigurationKey: z.string().min(1).max(1_000),
}).strict();
export type EvaluationPairConfiguration = z.infer<typeof evaluationPairConfigurationSchema>;

export const evaluationRunRecordSchema = z.object({
  schemaVersion: runtimeSchemaVersion,
  id: safeIdSchema,
  evaluationBatchId: safeIdSchema,
  pairKey: z.string().min(1).max(2_000),
  datasetVersion: safeTokenSchema,
  mode: evaluationModeSchema,
  status: evaluationRunStatusSchema,
  executionType: evaluationExecutionTypeSchema.default("MOCK"),
  caseId: safeIdSchema,
  caseVersion: safeTokenSchema,
  profileId: safeIdSchema.optional(),
  profileVersion: z.number().int().positive().max(100_000).optional(),
  provider: providerRefSchema,
  safetyCore: versionedSafetyRefSchema,
  policy: versionedPolicyRefSchema,
  feedbackRulesVersion: evaluationRulesVersionSchema,
  configurationKey: z.string().min(1).max(1_000),
  configuration: evaluationPairConfigurationSchema,
  startedAt: isoUtcTimestampSchema,
  completedAt: isoUtcTimestampSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.mode === "GENERIC" && (record.profileId !== undefined || record.profileVersion !== undefined)) {
    context.addIssue({ code: "custom", path: ["profileId"], message: "Generic evaluation runs cannot carry a profile reference." });
  }
  if (record.mode === "BOUNDED" && (record.profileId !== record.configuration.profileRef.id
    || record.profileVersion !== record.configuration.profileRef.version)) {
    context.addIssue({ code: "custom", path: ["profileId"], message: "Bounded evaluation run must use the locked profile version." });
  }
  if (record.caseId !== record.configuration.caseRef.id || record.caseVersion !== record.configuration.caseRef.version) {
    context.addIssue({ code: "custom", path: ["caseId"], message: "Evaluation run case must match the locked pair." });
  }
  const expectedKey = record.mode === "GENERIC"
    ? record.configuration.genericConfigurationKey
    : record.configuration.boundedConfigurationKey;
  if (record.configurationKey !== expectedKey) {
    context.addIssue({ code: "custom", path: ["configurationKey"], message: "Evaluation run configuration key must match its mode." });
  }
  if (record.configuration.provider.id !== record.provider.id
    || record.configuration.provider.modelId !== record.provider.modelId
    || record.configuration.provider.promptVersion !== record.provider.promptVersion) {
    context.addIssue({ code: "custom", path: ["configuration", "provider"], message: "Evaluation run provider snapshot is inconsistent." });
  }
  if (record.configuration.executionType !== record.executionType) {
    context.addIssue({ code: "custom", path: ["executionType"], message: "Evaluation run execution type must match its configuration." });
  }
  if (record.status === "RUNNING" && record.completedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Running evaluation runs cannot be completed." });
  }
  if (record.status !== "RUNNING" && record.completedAt === undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Terminal evaluation runs require a completion timestamp." });
  }
});
export type EvaluationRunRecord = z.infer<typeof evaluationRunRecordSchema>;

export const evaluationAttemptMetricsSchema = z.object({
  mandatoryFieldRetention: z.boolean().nullable(),
  lowRiskPreferenceApplied: z.boolean().nullable(),
  auditChainComplete: z.boolean().nullable(),
  outputStructureParseSuccess: z.boolean(),
  mockCoreFlowPass: z.boolean().nullable(),
  unsupportedFactRuleHitCount: z.number().int().nonnegative().max(100_000),
}).strict();
export type EvaluationAttemptMetrics = z.infer<typeof evaluationAttemptMetricsSchema>;

export const evaluationFailureTypeSchema = z.enum([
  "INPUT_BLOCKED",
  "CONFIGURATION_BLOCKED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
  "OUTPUT_VALIDATION",
  "PERSISTENCE",
  "PROFILE_VERSION_CONFLICT",
  "EVALUATION_PERSISTENCE",
  "NOT_EXECUTED",
  "RESULT_PERSISTENCE_INCOMPLETE",
  "UNKNOWN",
]);
export type EvaluationFailureType = z.infer<typeof evaluationFailureTypeSchema>;

export const evaluationGapTypeSchema = z.enum([
  "NOT_EXECUTED",
  "RESULT_PERSISTENCE_INCOMPLETE",
]);
export type EvaluationGapType = z.infer<typeof evaluationGapTypeSchema>;

export const evaluationGapSummarySchema = z.object({
  evaluationRunId: safeIdSchema.optional(),
  caseId: safeIdSchema,
  caseVersion: safeTokenSchema,
  profileId: safeIdSchema,
  profileVersion: z.number().int().positive().max(100_000),
  mode: evaluationModeSchema,
  pairKey: z.string().min(1).max(2_000),
  gapType: evaluationGapTypeSchema,
  failureRuleId: ruleIdSchema,
}).strict();
export type EvaluationGapSummary = z.infer<typeof evaluationGapSummarySchema>;

export const evaluationMatrixSummarySchema = z.object({
  expectedPairCount: z.number().int().nonnegative().max(100_000),
  expectedAttemptCount: z.number().int().nonnegative().max(100_000),
  plannedRunCount: z.number().int().nonnegative().max(100_000),
  recordedResultCount: z.number().int().nonnegative().max(100_000),
  generationAttemptCount: z.number().int().nonnegative().max(100_000),
  missingResultCount: z.number().int().nonnegative().max(100_000),
  notExecutedCount: z.number().int().nonnegative().max(100_000),
  unresolvedRunCount: z.number().int().nonnegative().max(100_000),
  complete: z.boolean(),
}).strict();
export type EvaluationMatrixSummary = z.infer<typeof evaluationMatrixSummarySchema>;

export const evaluationFeedbackGapTypeSchema = z.enum([
  "NOT_EXECUTED",
  "RESULT_PERSISTENCE_INCOMPLETE",
]);
export type EvaluationFeedbackGapType = z.infer<typeof evaluationFeedbackGapTypeSchema>;

export const evaluationFeedbackGapSummarySchema = z.object({
  fixtureId: safeIdSchema,
  fixtureVersion: safeTokenSchema,
  caseId: safeIdSchema,
  caseVersion: safeTokenSchema,
  profileId: safeIdSchema,
  profileVersion: z.number().int().positive().max(100_000),
  mutationType: z.string().min(1).max(100),
  expectedRiskLevel: feedbackFixtureRiskSchema,
  expectedStatus: feedbackFixtureStatusSchema,
  expectedDecision: feedbackFixtureDecisionSchema,
  expectedRuleIds: z.array(ruleIdSchema).min(1).max(20),
  gapType: evaluationFeedbackGapTypeSchema,
  failureRuleId: ruleIdSchema,
}).strict();
export type EvaluationFeedbackGapSummary = z.infer<typeof evaluationFeedbackGapSummarySchema>;

export const evaluationFeedbackMatrixSummarySchema = z.object({
  expectedFixtureCount: z.number().int().nonnegative().max(100_000),
  recordedFixtureCount: z.number().int().nonnegative().max(100_000),
  passCount: z.number().int().nonnegative().max(100_000),
  failCount: z.number().int().nonnegative().max(100_000),
  missingFixtureCount: z.number().int().nonnegative().max(100_000),
  duplicateFixtureCount: z.number().int().nonnegative().max(100_000),
  expectedLowCount: z.number().int().nonnegative().max(100_000),
  recordedLowCount: z.number().int().nonnegative().max(100_000),
  expectedMediumCount: z.number().int().nonnegative().max(100_000),
  recordedMediumCount: z.number().int().nonnegative().max(100_000),
  expectedHighCount: z.number().int().nonnegative().max(100_000),
  recordedHighCount: z.number().int().nonnegative().max(100_000),
  expectedUncertainCount: z.number().int().nonnegative().max(100_000),
  recordedUncertainCount: z.number().int().nonnegative().max(100_000),
  complete: z.boolean(),
}).strict();
export type EvaluationFeedbackMatrixSummary = z.infer<typeof evaluationFeedbackMatrixSummarySchema>;

export const evaluationResultRecordSchema = z.object({
  schemaVersion: runtimeSchemaVersion,
  id: safeIdSchema,
  evaluationRunId: safeIdSchema,
  generationRunId: safeIdSchema.optional(),
  caseId: safeIdSchema,
  caseVersion: safeTokenSchema,
  mode: evaluationModeSchema,
  pairKey: z.string().min(1).max(2_000),
  status: evaluationResultStatusSchema,
  profileId: safeIdSchema.optional(),
  profileVersion: z.number().int().positive().max(100_000).optional(),
  failureType: evaluationFailureTypeSchema.optional(),
  failureRuleId: ruleIdSchema.optional(),
  metrics: evaluationAttemptMetricsSchema,
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((record, context) => {
  if (record.mode === "GENERIC" && (record.profileId !== undefined || record.profileVersion !== undefined)) {
    context.addIssue({ code: "custom", path: ["profileId"], message: "Generic evaluation results cannot carry a profile reference." });
  }
  if (record.mode === "BOUNDED" && (record.profileId === undefined || record.profileVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["profileId"], message: "Bounded evaluation results require a profile reference." });
  }
  if (record.status === "SUCCEEDED" && record.generationRunId === undefined) {
    context.addIssue({ code: "custom", path: ["generationRunId"], message: "Successful evaluation results require a generation run." });
  }
  if (record.status === "FAILED" && record.failureType === undefined) {
    context.addIssue({ code: "custom", path: ["failureType"], message: "Failed evaluation results require a controlled failure type." });
  }
  if (record.status === "SUCCEEDED" && record.failureType !== undefined) {
    context.addIssue({ code: "custom", path: ["failureType"], message: "Successful evaluation results cannot contain a failure type." });
  }
});
export type EvaluationResultRecord = z.infer<typeof evaluationResultRecordSchema>;

export const metricTargetSchema = z.object({
  operator: z.enum(["EQ", "GTE", "LTE"]),
  value: z.number().finite().nonnegative().max(1_000_000),
  label: z.string().min(1).max(200),
}).strict();

export const aggregateMetricSchema = z.object({
  metricId: ruleIdSchema,
  numerator: z.number().int().nonnegative().max(100_000),
  denominator: z.number().int().nonnegative().max(100_000),
  value: z.number().finite().nonnegative().max(1_000_000),
  unit: z.enum(["RATE", "COUNT", "MEAN", "TOTAL_COUNT"]),
  predefinedTarget: metricTargetSchema,
  status: z.enum(["PASS", "FAIL", "NOT_MEASURED", "INSUFFICIENT_DATA", "MEASURED"]),
  explanation: z.string().min(1).max(500),
}).strict().superRefine((metric, context) => {
  if (metric.unit === "RATE" && metric.value > 1) {
    context.addIssue({ code: "custom", path: ["value"], message: "Rate metrics must be bounded to 0..1." });
  }
  if (metric.denominator === 0 && (metric.status === "PASS" || metric.status === "FAIL")) {
    context.addIssue({ code: "custom", path: ["status"], message: "Zero-denominator metrics cannot be PASS or FAIL." });
  }
});
export type AggregateMetric = z.infer<typeof aggregateMetricSchema>;

export const evaluationFailureSummarySchema = z.object({
  evaluationRunId: safeIdSchema,
  generationRunId: safeIdSchema.optional(),
  caseId: safeIdSchema,
  caseVersion: safeTokenSchema,
  mode: evaluationModeSchema,
  pairKey: z.string().min(1).max(2_000),
  failureType: evaluationFailureTypeSchema,
  failureRuleId: ruleIdSchema.optional(),
}).strict();
export type EvaluationFailureSummary = z.infer<typeof evaluationFailureSummarySchema>;

export const evaluationExportBatchSchema = z.object({
  id: safeIdSchema,
  schemaVersion: runtimeSchemaVersion,
  datasetVersion: safeTokenSchema,
  status: evaluationBatchStatusSchema,
  executionType: evaluationExecutionTypeSchema.default("MOCK"),
  provider: providerRefSchema,
  safetyCore: versionedSafetyRefSchema,
  rulesVersion: evaluationRulesVersionSchema,
  configuration: evaluationBatchConfigurationSchema,
  startedAt: isoUtcTimestampSchema,
  completedAt: isoUtcTimestampSchema.optional(),
}).strict();

export const evaluationExportResultSchema = z.object({
  id: safeIdSchema,
  evaluationRunId: safeIdSchema,
  generationRunId: safeIdSchema.optional(),
  datasetVersion: safeTokenSchema,
  caseId: safeIdSchema,
  caseVersion: safeTokenSchema,
  mode: evaluationModeSchema,
  executionType: evaluationExecutionTypeSchema.default("MOCK"),
  pairKey: z.string().min(1).max(2_000),
  provider: providerRefSchema,
  feedbackRulesVersion: evaluationRulesVersionSchema,
  safetyCore: versionedSafetyRefSchema,
  policy: versionedPolicyRefSchema,
  configurationKey: z.string().min(1).max(1_000),
  profileId: safeIdSchema.optional(),
  profileVersion: z.number().int().positive().max(100_000).optional(),
  status: evaluationResultStatusSchema,
  failureType: evaluationFailureTypeSchema.optional(),
  failureRuleId: ruleIdSchema.optional(),
  metrics: evaluationAttemptMetricsSchema,
  createdAt: isoUtcTimestampSchema,
}).strict();

export const evaluationExportBundleSchema = z.object({
  exportSchemaVersion: evaluationExportSchemaVersionSchema,
  generatedAt: isoUtcTimestampSchema,
  batch: evaluationExportBatchSchema,
  results: z.array(evaluationExportResultSchema).max(200),
  metrics: z.array(aggregateMetricSchema).max(50),
  failures: z.array(evaluationFailureSummarySchema).max(200),
  matrixSummary: evaluationMatrixSummarySchema,
  gaps: z.array(evaluationGapSummarySchema).max(200),
  feedbackResults: z.array(feedbackFixtureEvaluationResultSchema).max(100).optional(),
  feedbackGaps: z.array(evaluationFeedbackGapSummarySchema).max(100).optional(),
  feedbackMatrixSummary: evaluationFeedbackMatrixSummarySchema.optional(),
}).strict();
export type EvaluationExportBundle = z.infer<typeof evaluationExportBundleSchema>;

export function roundEvaluationRatio(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
}

export function evaluateAggregateMetric(input: {
  metricId: string;
  numerator: number;
  denominator: number;
  unit: "RATE" | "COUNT" | "MEAN" | "TOTAL_COUNT";
  predefinedTarget: z.infer<typeof metricTargetSchema>;
  explanation: string;
}): AggregateMetric {
  const value = input.unit === "RATE"
    ? (input.denominator === 0 ? 0 : roundEvaluationRatio(input.numerator / input.denominator))
    : input.unit === "MEAN"
      ? (input.denominator === 0 ? 0 : Math.round((input.numerator / input.denominator) * 10_000) / 10_000)
      : input.numerator;
  if (input.denominator === 0) {
    return aggregateMetricSchema.parse({
      ...input,
      value,
      status: "NOT_MEASURED",
      explanation: `${input.explanation} 分母为 0，未宣称通过。`,
    });
  }

  const targetValue = input.predefinedTarget.value;
  const pass = input.predefinedTarget.operator === "EQ"
    ? value === targetValue
    : input.predefinedTarget.operator === "GTE"
      ? value >= targetValue
      : value <= targetValue;
  return aggregateMetricSchema.parse({
    ...input,
    value,
    status: pass ? "PASS" : "FAIL",
  });
}
