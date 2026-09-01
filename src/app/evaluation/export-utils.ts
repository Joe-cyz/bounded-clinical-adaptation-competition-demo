import {
  buildEvaluationExportBundle,
  EVALUATION_RULE_IDS,
  type EvaluationRuleId,
} from "@/application/evaluation-service";
import {
  contentDisposition,
  exportTimestamp,
  sanitizeExportToken,
  serializeEvaluationJson,
  serializeEvaluationFeedbackResultsCsv,
  serializeEvaluationMetricsCsv,
  serializeEvaluationResultsCsv,
} from "@/infrastructure/exports/evaluation-export";
import { getDatabase } from "@/server/database";

export type EvaluationArtifactType = "BUNDLE_JSON" | "RESULTS_CSV" | "METRICS_CSV" | "FEEDBACK_RESULTS_CSV";

export type EvaluationArtifact = {
  content: string;
  contentType: string;
  disposition: string;
};

export type EvaluationArtifactError = {
  ok: false;
  ruleId: EvaluationRuleId;
  message: string;
  status: number;
};

function errorStatus(ruleId: EvaluationRuleId): number {
  if (ruleId === "EVALUATION_BATCH_NOT_FOUND") return 404;
  if (ruleId === "EVALUATION_NOT_TERMINAL") return 409;
  if (ruleId === "EVALUATION_INPUT_INVALID") return 400;
  if (ruleId === EVALUATION_RULE_IDS.RUNTIME_READ_ONLY) return 403;
  return 500;
}

export function getEvaluationArtifact(
  batchId: string,
  artifactType: EvaluationArtifactType,
): { ok: true; data: EvaluationArtifact } | EvaluationArtifactError {
  if (process.env.APP_RUNTIME_MODE !== "local-research") {
    return {
      ok: false,
      ruleId: EVALUATION_RULE_IDS.RUNTIME_READ_ONLY,
      message: "公开只读演示不提供评测导出。",
      status: 403,
    };
  }

  const result = buildEvaluationExportBundle(
    getDatabase(),
    batchId,
    new Date().toISOString(),
    undefined,
    artifactType,
  );
  if (!result.ok) return { ...result, status: errorStatus(result.ruleId) };

  const safeBatchId = sanitizeExportToken(result.data.batch.id);
  const safeDataset = sanitizeExportToken(result.data.batch.datasetVersion);
  const timestamp = exportTimestamp(result.data.generatedAt);
  if (artifactType === "BUNDLE_JSON") {
    return {
      ok: true,
      data: {
        content: serializeEvaluationJson(result.data),
        contentType: "application/json; charset=utf-8",
        disposition: contentDisposition(`evaluation-${safeBatchId}-${safeDataset}-${timestamp}.json`),
      },
    };
  }
  if (artifactType === "RESULTS_CSV") {
    return {
      ok: true,
      data: {
        content: serializeEvaluationResultsCsv(result.data),
        contentType: "text/csv; charset=utf-8",
        disposition: contentDisposition(`evaluation-${safeBatchId}-${safeDataset}-${timestamp}-results.csv`),
      },
    };
  }
  if (artifactType === "FEEDBACK_RESULTS_CSV") {
    return {
      ok: true,
      data: {
        content: serializeEvaluationFeedbackResultsCsv(result.data),
        contentType: "text/csv; charset=utf-8",
        disposition: contentDisposition(`evaluation-${safeBatchId}-${safeDataset}-${timestamp}-feedback-results.csv`),
      },
    };
  }
  return {
    ok: true,
    data: {
      content: serializeEvaluationMetricsCsv(result.data),
      contentType: "text/csv; charset=utf-8",
      disposition: contentDisposition(`evaluation-${safeBatchId}-${safeDataset}-${timestamp}-metrics.csv`),
    },
  };
}
