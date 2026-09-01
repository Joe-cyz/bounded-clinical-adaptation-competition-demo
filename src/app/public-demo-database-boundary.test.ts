import { afterEach, describe, expect, it, vi } from "vitest";

const databaseFactory = vi.hoisted(() => vi.fn(() => {
  throw new Error("public-demo must not obtain a database");
}));
const auditReadModels = vi.hoisted(() => ({
  buildGenerationTrace: vi.fn(),
  listAuditReadModel: vi.fn(() => ({ ok: true, data: { events: [], nextCursor: undefined } })),
  listFeedbackReadModel: vi.fn(() => ({ ok: true, data: { events: [] } })),
  listProfileReadModel: vi.fn(() => ({ ok: true, data: { profiles: [] } })),
}));
const evaluationReadModels = vi.hoisted(() => ({
  EVALUATION_RULE_IDS: { RUNTIME_READ_ONLY: "PUBLIC_DEMO_READ_ONLY" },
  buildEvaluationExportBundle: vi.fn(() => ({ ok: false, ruleId: "EVALUATION_BATCH_NOT_FOUND", message: "not found" })),
  getEvaluationPageModel: vi.fn(() => ({ ok: true, data: { selected: undefined, recent: [] } })),
}));

vi.mock("@/server/database", () => ({ getDatabase: databaseFactory }));
vi.mock("@/application/audit-review-service", () => ({
  AUDIT_ENTITY_TYPES: [],
  AUDIT_EVENT_TYPES: [],
  AUDIT_SIMULATED_ROLES: [],
  ...auditReadModels,
}));
vi.mock("@/application/evaluation-service", () => evaluationReadModels);
vi.mock("@/infrastructure/sqlite/migrations", () => ({ getCurrentSchemaVersion: vi.fn(() => 1) }));

import AuditPage from "@/app/audit/page";
import EvaluationPage from "@/app/evaluation/page";
import { getEvaluationArtifact } from "@/app/evaluation/export-utils";
import FeedbackPage from "@/app/feedback/page";
import ProfilesPage from "@/app/profiles/page";
import { GET as evaluationHealth } from "@/app/api/evaluation/health/route";

const emptySearchParams = Promise.resolve({});
const fakeDatabase = {} as never;

describe("public-demo database initialization boundary", () => {
  const previousRuntimeMode = process.env.APP_RUNTIME_MODE;

  afterEach(() => {
    databaseFactory.mockClear();
    auditReadModels.buildGenerationTrace.mockClear();
    auditReadModels.listAuditReadModel.mockClear();
    auditReadModels.listFeedbackReadModel.mockClear();
    auditReadModels.listProfileReadModel.mockClear();
    evaluationReadModels.buildEvaluationExportBundle.mockClear();
    evaluationReadModels.getEvaluationPageModel.mockClear();
    if (previousRuntimeMode === undefined) delete process.env.APP_RUNTIME_MODE;
    else process.env.APP_RUNTIME_MODE = previousRuntimeMode;
  });

  it("keeps public-demo health, read pages, and evaluation exports before the database factory", async () => {
    process.env.APP_RUNTIME_MODE = "public-demo";

    const health = evaluationHealth();
    await AuditPage({ searchParams: emptySearchParams });
    await FeedbackPage({ searchParams: emptySearchParams });
    await ProfilesPage({ searchParams: emptySearchParams });
    await EvaluationPage({ searchParams: emptySearchParams });
    const exportResult = getEvaluationArtifact("batch-public-001", "BUNDLE_JSON");

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      runtime: "public-demo",
      syntheticOnly: true,
      readOnly: true,
    });
    expect(exportResult).toEqual({
      ok: false,
      ruleId: "PUBLIC_DEMO_READ_ONLY",
      message: "公开只读演示不提供评测导出。",
      status: 403,
    });
    expect(databaseFactory).toHaveBeenCalledTimes(0);
    expect(auditReadModels.listAuditReadModel).not.toHaveBeenCalled();
    expect(auditReadModels.listFeedbackReadModel).not.toHaveBeenCalled();
    expect(auditReadModels.listProfileReadModel).not.toHaveBeenCalled();
    expect(evaluationReadModels.getEvaluationPageModel).not.toHaveBeenCalled();
    expect(evaluationReadModels.buildEvaluationExportBundle).not.toHaveBeenCalled();
  });

  it("keeps local-research read behavior on the database factory", async () => {
    process.env.APP_RUNTIME_MODE = "local-research";
    databaseFactory.mockReturnValue(fakeDatabase);

    await AuditPage({ searchParams: emptySearchParams });
    await FeedbackPage({ searchParams: emptySearchParams });
    await ProfilesPage({ searchParams: emptySearchParams });
    await EvaluationPage({ searchParams: emptySearchParams });
    const exportResult = getEvaluationArtifact("batch-local-001", "BUNDLE_JSON");
    const health = evaluationHealth();

    expect(databaseFactory).toHaveBeenCalledTimes(6);
    expect(auditReadModels.listAuditReadModel).toHaveBeenCalledTimes(1);
    expect(auditReadModels.listFeedbackReadModel).toHaveBeenCalledTimes(1);
    expect(auditReadModels.listProfileReadModel).toHaveBeenCalledTimes(1);
    expect(evaluationReadModels.getEvaluationPageModel).toHaveBeenCalledTimes(1);
    expect(evaluationReadModels.buildEvaluationExportBundle).toHaveBeenCalledTimes(1);
    expect(exportResult).toMatchObject({ ok: false, ruleId: "EVALUATION_BATCH_NOT_FOUND" });
    expect(health.status).toBe(200);
  });
});
