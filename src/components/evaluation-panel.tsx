"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { runDeepSeekEvaluationBatchAction, runEvaluationBatchAction } from "@/app/evaluation/actions";
import type { EvaluationReadModel } from "@/application/evaluation-service";
import type { EvaluationBatchRecord } from "@/domain/evaluation";
import type { ProviderCapabilities } from "@/domain/provider";
import { seedManifest } from "@/data/seed-loader";

const statusLabels = {
  RUNNING: "运行中",
  SUCCEEDED: "完成",
  PARTIAL_FAILURE: "部分失败",
  FAILED: "失败",
} as const;

function BatchSummary({ batch }: { batch: EvaluationBatchRecord }) {
  return (
    <div className="evaluation-meta-grid">
      <div><span>批次</span><strong>{batch.id}</strong></div>
      <div><span>数据集</span><strong>{batch.datasetVersion}</strong></div>
      <div><span>Provider / model</span><strong>{batch.provider.id} · {batch.provider.modelId}</strong></div>
      <div><span>执行类型 / 网络</span><strong>{batch.executionType} · {batch.executionType === "REAL" ? "允许本机网络" : "无网络"}</strong></div>
      <div><span>Prompt / rules</span><strong>{batch.provider.promptVersion} · {batch.rulesVersion}</strong></div>
      <div><span>安全核心</span><strong>{batch.safetyCore.id}@{batch.safetyCore.version}</strong></div>
      <div><span>矩阵锁定</span><strong>{batch.configuration.matrixVersion} · {batch.configuration.expectedPairCount} pairs / {batch.configuration.expectedAttemptCount} attempts</strong></div>
      <div><span>内容审核</span><strong>{batch.datasetVersion === seedManifest.datasetVersion ? "PENDING_DOMAIN_REVIEW" : "历史数据集"}</strong></div>
      <div><span>反馈夹具 Provider</span><strong>{batch.configuration.feedbackBaselineProvider.id} · {batch.configuration.feedbackBaselineExecutionNature}</strong></div>
    </div>
  );
}

function MetricsTable({ model }: { model: EvaluationReadModel }) {
  return (
    <div className="evaluation-table-wrap">
      <table className="evaluation-table">
        <thead><tr><th>指标</th><th>值</th><th>分子 / 分母</th><th>目标</th><th>状态</th></tr></thead>
        <tbody>
          {model.metrics.map((metric) => (
            <tr key={metric.metricId}>
              <td><strong>{metric.metricId}</strong><small>{metric.explanation}</small></td>
              <td>{metric.value}{metric.unit === "RATE" ? " · rate" : metric.unit === "MEAN" ? " · mean" : metric.unit === "TOTAL_COUNT" ? " · total" : " · count"}</td>
              <td>{metric.numerator} / {metric.denominator}</td>
              <td>{metric.predefinedTarget.operator} {metric.predefinedTarget.value}<small>{metric.predefinedTarget.label}</small></td>
              <td><span className={`status evaluation-status-${metric.status.toLowerCase()}`}>{metric.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FailureList({ model }: { model: EvaluationReadModel }) {
  if (model.failures.length === 0 && model.gaps.length === 0) return <p className="evaluation-empty">当前批次没有失败尝试或矩阵缺口。</p>;
  return (
    <ul className="evaluation-failures">
      {model.failures.map((failure) => (
        <li key={failure.evaluationRunId}>
          <strong>{failure.mode} · {failure.caseId}@{failure.caseVersion}</strong>
          <span>{failure.failureType}{failure.failureRuleId ? ` · ${failure.failureRuleId}` : ""}</span>
          <code>{failure.evaluationRunId}</code>
        </li>
      ))}
      {model.gaps.map((gap) => (
        <li key={`${gap.pairKey}:${gap.evaluationRunId ?? "missing"}`}>
          <strong>{gap.mode} · {gap.caseId}@{gap.caseVersion}</strong>
          <span>{gap.gapType} · {gap.failureRuleId}</span>
          <code>{gap.evaluationRunId ?? "未创建 evaluation run"}</code>
        </li>
      ))}
    </ul>
  );
}

function BatchLinks({ batchId }: { batchId: string }) {
  return (
    <div className="evaluation-export-links">
      <span>安全导出</span>
      <Link href={`/evaluation/${encodeURIComponent(batchId)}/bundle.json`}>JSON bundle</Link>
      <Link href={`/evaluation/${encodeURIComponent(batchId)}/results.csv`}>results.csv</Link>
      <Link href={`/evaluation/${encodeURIComponent(batchId)}/metrics.csv`}>metrics.csv</Link>
      <Link href={`/evaluation/${encodeURIComponent(batchId)}/feedback-results.csv`}>feedback-results.csv</Link>
    </div>
  );
}

export function EvaluationPanel({
  selected,
  recent,
  providerCapabilities,
}: {
  selected?: EvaluationReadModel;
  recent: EvaluationBatchRecord[];
  providerCapabilities: ProviderCapabilities;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string>("");
  const publicDemoReadOnly = providerCapabilities.publicDemoReadOnly;

  function startEvaluation() {
    setMessage("评测批次启动中，固定模拟研究者角色…");
    startTransition(async () => {
      const result = await runEvaluationBatchAction();
      if (result.ok) {
        setMessage(`批次 ${result.batchId} 已完成：${result.attemptCount} attempts，失败 ${result.failureCount}。`);
        router.push(`/evaluation?batchId=${encodeURIComponent(result.batchId)}`);
        router.refresh();
      } else {
        setMessage(`${result.ruleId} · ${result.message}`);
      }
    });
  }

  function startDeepSeekEvaluation() {
    setMessage("真实 Provider 评测启动中；仅本机研究门控可用…");
    startTransition(async () => {
      const result = await runDeepSeekEvaluationBatchAction();
      if (result.ok) {
        setMessage(`批次 ${result.batchId} 已完成：${result.attemptCount} attempts，失败 ${result.failureCount}。`);
        router.push(`/evaluation?batchId=${encodeURIComponent(result.batchId)}`);
        router.refresh();
      } else {
        setMessage(`${result.ruleId} · ${result.message}`);
      }
    });
  }

  return (
    <>
      <section className="evaluation-control-card">
        <div>
          <p className="eyebrow">ENGINEERING BASELINE</p>
          <h2>固定矩阵 · {publicDemoReadOnly ? "Mock 只读展示" : "Mock / DeepSeek 双入口"}</h2>
          <p>主矩阵固定为 24 个合成病例 × 3 个锁定画像 = 72 pairs；每个 pair 执行 GENERIC 与 BOUNDED，共 144 attempts。反馈夹具始终使用 deterministic-mock 的 BOUNDED 基线，性质是确定性治理测试，不是临床准确率评测。</p>
        </div>
        <div className="evaluation-action-group" data-testid="evaluation-action-group">
          <div className="evaluation-action-buttons" data-testid="evaluation-action-buttons">
            <button className="primary-action" type="button" onClick={startEvaluation} disabled={publicDemoReadOnly || pending}>
              {pending ? "评测运行中…" : "运行 Mock 24/72/144 评测"}
            </button>
            {!publicDemoReadOnly ? <button className="secondary-action" type="button" onClick={startDeepSeekEvaluation} disabled={pending || !providerCapabilities.deepseek.available}>
              {providerCapabilities.deepseek.available ? "运行 DeepSeek 本机评测" : "DeepSeek 未启用（不发起网络）"}
            </button> : null}
          </div>
          <small className="evaluation-safety-note" data-testid="evaluation-safety-note">{publicDemoReadOnly ? "公开只读演示 · PUBLIC_DEMO_READ_ONLY · 评测写入已关闭。" : `${providerCapabilities.runtimeMode} · ${providerCapabilities.safetyNotice}`}</small>
        </div>
      </section>
      {message ? <div className="evaluation-message" role="status">{message}</div> : null}

      {selected ? (
        <section className="evaluation-card">
          <div className="panel-heading">
            <div><p className="eyebrow">BATCH RESULT</p><h2>{selected.batch.id}</h2></div>
            <span className={`status evaluation-status-${selected.batch.status.toLowerCase()}`}>{statusLabels[selected.batch.status]}</span>
          </div>
          <BatchSummary batch={selected.batch} />
          <div className="evaluation-counts">
            <div><span>Pairs</span><strong>{selected.pairCount} / {selected.matrixSummary.expectedPairCount}</strong></div>
            <div><span>Generation attempts</span><strong>{selected.matrixSummary.generationAttemptCount} / {selected.matrixSummary.expectedAttemptCount}</strong></div>
            <div><span>Results</span><strong>{selected.matrixSummary.recordedResultCount} / {selected.matrixSummary.expectedAttemptCount}</strong></div>
            <div><span>Failures</span><strong>{selected.failureCount}</strong></div>
            <div><span>Missing / not executed</span><strong>{selected.matrixSummary.missingResultCount} / {selected.matrixSummary.notExecutedCount}</strong></div>
            <div><span>Unresolved runs</span><strong>{selected.matrixSummary.unresolvedRunCount}</strong></div>
            <div><span>Failure types</span><strong>{selected.failureTypes.length > 0 ? selected.failureTypes.join(", ") : "无"}</strong></div>
            <div><span>Feedback fixtures</span><strong>{selected.feedbackMatrixSummary.recordedFixtureCount} / {selected.feedbackMatrixSummary.expectedFixtureCount}</strong></div>
            <div><span>Feedback pass / fail</span><strong>{selected.feedbackMatrixSummary.passCount} / {selected.feedbackMatrixSummary.failCount}</strong></div>
            <div><span>Feedback gaps</span><strong>{selected.feedbackGaps.length}</strong></div>
          </div>
          <BatchLinks batchId={selected.batch.id} />
          <div className="evaluation-section-heading"><h3>工程指标</h3><span>阈值是开发工程门槛，不是临床结论</span></div>
          <MetricsTable model={selected} />
          <div className="evaluation-section-heading"><h3>失败尝试</h3><span>失败保留，不从分母中静默删除</span></div>
          <FailureList model={selected} />
          <div className="evaluation-section-heading"><h3>反馈夹具结果</h3><span>只展示安全字段；修订正文、原始 prompt 和完整输入不导出</span></div>
          {selected.feedbackResults.length === 0 && selected.feedbackGaps.length === 0 ? <p className="evaluation-empty">当前批次未完成反馈夹具评测。</p> : (
            <ul className="evaluation-failures">
              {selected.feedbackResults.map((result) => (
                <li key={result.id}>
                  <strong>{result.fixtureId} · {result.expectedRiskLevel}</strong>
                  <span>{result.resultStatus} · {result.observed.riskLevel ?? "UNOBSERVED"} · {result.observed.status ?? "未分类"} · {result.observed.executionPath}</span>
                  <code>{result.observed.ruleIds.join(", ") || "无规则命中"} · {result.observed.dangerousBodyStored ? "危险正文存在" : "危险正文未保存"}</code>
                </li>
              ))}
              {selected.feedbackGaps.map((gap) => (
                <li key={`feedback-gap-${gap.fixtureId}`}>
                  <strong>{gap.fixtureId} · {gap.expectedRiskLevel}</strong>
                  <span>GAP · {gap.gapType} · {gap.failureRuleId}</span>
                  <code>未生成反馈结果；预期规则 {gap.expectedRuleIds.join(", ")}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="evaluation-card evaluation-empty-card"><p className="eyebrow">NO SELECTED BATCH</p><h2>尚未选择评测批次</h2><p>运行固定工程基线后，页面会展示真实持久化结果、失败类型和可回链导出。</p></section>
      )}

      <section className="evaluation-card">
        <div className="evaluation-section-heading"><h2>最近批次</h2><span>只读 · 本地模拟研究者，不是生产认证</span></div>
        {recent.length === 0 ? <p className="evaluation-empty">暂无评测批次。</p> : (
          <ul className="evaluation-recent-list">
            {recent.map((batch) => (
              <li key={batch.id}>
                <Link href={`/evaluation?batchId=${encodeURIComponent(batch.id)}`}><strong>{batch.id}</strong></Link>
                <span>{statusLabels[batch.status]} · {batch.datasetVersion} · {batch.startedAt}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
