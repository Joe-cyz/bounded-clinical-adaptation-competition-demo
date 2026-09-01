import {
  evaluationExportBundleSchema,
  type EvaluationExportBundle,
} from "@/domain/evaluation";
import { stableJsonStringify } from "@/infrastructure/sqlite/record-validation";

const resultColumns = [
  "exportSchemaVersion",
  "batchId",
  "datasetVersion",
  "caseSetVersion",
  "adversarialFeedbackSetVersion",
  "uncertaintyFeedbackSetVersion",
  "caseId",
  "caseVersion",
  "mode",
  "executionType",
  "pairKey",
  "evaluationRunId",
  "generationRunId",
  "providerId",
  "modelId",
  "promptVersion",
  "feedbackRulesVersion",
  "safetyCoreId",
  "safetyCoreVersion",
  "policyId",
  "policyVersion",
  "configurationKey",
  "profileId",
  "profileVersion",
  "status",
  "failureType",
  "failureRuleId",
  "mandatoryFieldRetention",
  "lowRiskPreferenceApplied",
  "auditChainComplete",
  "outputStructureParseSuccess",
  "mockCoreFlowPass",
  "unsupportedFactRuleHitCount",
  "createdAt",
  "recordType",
  "gapType",
] as const;

const metricColumns = [
  "exportSchemaVersion",
  "batchId",
  "metricId",
  "numerator",
  "denominator",
  "value",
  "unit",
  "predefinedTargetOperator",
  "predefinedTargetValue",
  "predefinedTargetLabel",
  "status",
  "explanation",
] as const;

const feedbackResultColumns = [
  "exportSchemaVersion",
  "batchId",
  "datasetVersion",
  "caseSetVersion",
  "adversarialFeedbackSetVersion",
  "uncertaintyFeedbackSetVersion",
  "feedbackBaselineProviderId",
  "feedbackBaselineExecutionType",
  "feedbackBaselineExecutionNature",
  "fixtureId",
  "fixtureVersion",
  "caseId",
  "caseVersion",
  "profileId",
  "profileVersion",
  "mutationType",
  "expectedRiskLevel",
  "expectedStatus",
  "expectedDecision",
  "expectedRuleIds",
  "observedRiskLevel",
  "observedStatus",
  "observedDecision",
  "observedRuleIds",
  "resultStatus",
  "rulesVersion",
  "generationRunId",
  "revisionSaved",
  "profileUpdated",
  "auditRecorded",
  "sectionOrderDistance",
  "distanceAlgorithmVersion",
  "createdAt",
  "executionPath",
  "dangerousBodyStored",
  "recordType",
  "gapType",
] as const;

function cell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  if (/[",\r\n]/u.test(text)) return `"${text.replace(/"/gu, '""')}"`;
  return text;
}

function csv(rows: readonly (readonly unknown[])[]): string {
  return `\uFEFF${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function serializeEvaluationJson(bundle: EvaluationExportBundle): string {
  return stableJsonStringify(evaluationExportBundleSchema.parse(bundle));
}

export function serializeEvaluationResultsCsv(bundle: EvaluationExportBundle): string {
  const header = resultColumns;
  const rows = bundle.results.map((result) => [
    bundle.exportSchemaVersion,
    bundle.batch.id,
    bundle.batch.datasetVersion,
    bundle.batch.configuration.caseSetVersion,
    bundle.batch.configuration.adversarialFeedbackSetVersion,
    bundle.batch.configuration.uncertaintyFeedbackSetVersion,
    result.caseId,
    result.caseVersion,
    result.mode,
    result.executionType,
    result.pairKey,
    result.evaluationRunId,
    result.generationRunId,
    result.provider.id,
    result.provider.modelId,
    result.provider.promptVersion,
    result.feedbackRulesVersion,
    result.safetyCore.id,
    result.safetyCore.version,
    result.policy.id,
    result.policy.version,
    result.configurationKey,
    result.profileId,
    result.profileVersion,
    result.status,
    result.failureType,
    result.failureRuleId,
    result.metrics.mandatoryFieldRetention,
    result.metrics.lowRiskPreferenceApplied,
    result.metrics.auditChainComplete,
    result.metrics.outputStructureParseSuccess,
    result.metrics.mockCoreFlowPass,
    result.metrics.unsupportedFactRuleHitCount,
    result.createdAt,
    "RESULT",
    "",
  ]);
  const gapRows = bundle.gaps.map((gap) => [
    bundle.exportSchemaVersion,
    bundle.batch.id,
    bundle.batch.datasetVersion,
    bundle.batch.configuration.caseSetVersion,
    bundle.batch.configuration.adversarialFeedbackSetVersion,
    bundle.batch.configuration.uncertaintyFeedbackSetVersion,
    gap.caseId,
    gap.caseVersion,
    gap.mode,
    bundle.batch.executionType,
    gap.pairKey,
    gap.evaluationRunId,
    "",
    bundle.batch.provider.id,
    bundle.batch.provider.modelId,
    bundle.batch.provider.promptVersion,
    bundle.batch.rulesVersion,
    bundle.batch.safetyCore.id,
    bundle.batch.safetyCore.version,
    "",
    "",
    "",
    "",
    gap.profileId,
    gap.profileVersion,
    "FAILED",
    gap.gapType,
    gap.failureRuleId,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "GAP",
    gap.gapType,
  ]);
  return csv([header, ...rows, ...gapRows]);
}

export function serializeEvaluationMetricsCsv(bundle: EvaluationExportBundle): string {
  const header = metricColumns;
  const rows = bundle.metrics.map((metric) => [
    bundle.exportSchemaVersion,
    bundle.batch.id,
    metric.metricId,
    metric.numerator,
    metric.denominator,
    metric.value,
    metric.unit,
    metric.predefinedTarget.operator,
    metric.predefinedTarget.value,
    metric.predefinedTarget.label,
    metric.status,
    metric.explanation,
  ]);
  return csv([header, ...rows]);
}

export function serializeEvaluationFeedbackResultsCsv(bundle: EvaluationExportBundle): string {
  const rows = (bundle.feedbackResults ?? []).map((result) => [
    bundle.exportSchemaVersion,
    bundle.batch.id,
    result.datasetVersion,
    bundle.batch.configuration.caseSetVersion,
    bundle.batch.configuration.adversarialFeedbackSetVersion,
    bundle.batch.configuration.uncertaintyFeedbackSetVersion,
    bundle.batch.configuration.feedbackBaselineProvider.id,
    bundle.batch.configuration.feedbackBaselineExecutionType,
    bundle.batch.configuration.feedbackBaselineExecutionNature,
    result.fixtureId,
    result.fixtureVersion,
    result.caseId,
    result.caseVersion,
    result.profileId,
    result.profileVersion,
    result.mutationType,
    result.expectedRiskLevel,
    result.expectedStatus,
    result.expectedDecision,
    result.expectedRuleIds.join("|"),
    result.observed.riskLevel,
    result.observed.status,
    result.observed.decision,
    result.observed.ruleIds.join("|"),
    result.resultStatus,
    result.rulesVersion,
    result.generationRunId,
    result.observed.revisionSaved,
    result.observed.profileUpdated,
    result.observed.auditRecorded,
     result.observed.sectionOrderDistance,
     result.observed.distanceAlgorithmVersion,
     result.createdAt,
    result.observed.executionPath,
     result.observed.dangerousBodyStored,
     "RESULT",
     "",
   ]);
  const gapRows = (bundle.feedbackGaps ?? []).map((gap) => [
    bundle.exportSchemaVersion,
    bundle.batch.id,
    bundle.batch.datasetVersion,
    bundle.batch.configuration.caseSetVersion,
    bundle.batch.configuration.adversarialFeedbackSetVersion,
    bundle.batch.configuration.uncertaintyFeedbackSetVersion,
    bundle.batch.configuration.feedbackBaselineProvider.id,
    bundle.batch.configuration.feedbackBaselineExecutionType,
    bundle.batch.configuration.feedbackBaselineExecutionNature,
    gap.fixtureId,
    gap.fixtureVersion,
    gap.caseId,
    gap.caseVersion,
    gap.profileId,
    gap.profileVersion,
    gap.mutationType,
    gap.expectedRiskLevel,
    gap.expectedStatus,
    gap.expectedDecision,
    gap.expectedRuleIds.join("|"),
    "",
    "",
    "",
    "",
    "FAILED",
    bundle.batch.rulesVersion,
    "",
    false,
    false,
    false,
    "",
    "",
    "",
    "",
    "",
    gap.failureRuleId,
    "",
    "",
    "",
    "GAP",
    gap.gapType,
  ]);
  return csv([feedbackResultColumns, ...rows, ...gapRows]);
}

export function sanitizeExportToken(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  return sanitized || "evaluation";
}

export function exportTimestamp(value: string): string {
  return sanitizeExportToken(value.replace(/[-:.TZ]/gu, "").slice(0, 14));
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${sanitizeExportToken(filename)}"`;
}
