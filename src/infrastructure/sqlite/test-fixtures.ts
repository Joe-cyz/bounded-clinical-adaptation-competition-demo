import {
  institutionalSafetyCore,
  physicianProfiles,
  seedManifest,
  specialtyVisitPolicies,
  syntheticCases,
} from "@/data/seed-loader";
import { compileEffectiveConfig, type EffectiveGenerationConfig } from "@/domain/effective-config";
import { generateDraft } from "@/domain/generate-draft";
import {
  computeDraftDiff,
  draftRevisionRecordSchema,
  type DraftRevisionRecord,
} from "@/domain/draft-revisions";
import {
  auditEventRecordSchema,
  generationRunRecordSchema,
  physicianProfileVersionRecordSchema,
  type AuditEventRecord,
  type GenerationRunRecord,
  type PhysicianProfileVersionRecord,
} from "@/domain/runtime-records";

export const fixtureCase = syntheticCases[0];
export const fixtureProfile = physicianProfiles[0];

export function fixtureConfig(mode: "GENERIC" | "BOUNDED" = "GENERIC"): EffectiveGenerationConfig {
  const result = compileEffectiveConfig({
    caseData: fixtureCase,
    safetyCore: institutionalSafetyCore,
    policies: specialtyVisitPolicies,
    datasetVersion: seedManifest.datasetVersion,
    mode,
    ...(mode === "BOUNDED" ? { profile: fixtureProfile } : {}),
  });
  if (!result.ok) throw new Error("Fixture effective configuration failed to compile.");
  return result.config;
}

export function fixtureGenerationRun(
  overrides: Partial<GenerationRunRecord> = {},
): GenerationRunRecord {
  const config = fixtureConfig("GENERIC");
  const id = overrides.id ?? "run-fixture-001";
  const status = overrides.status ?? "SUCCEEDED";
  const outputDraft = status === "SUCCEEDED"
    ? overrides.outputDraftSnapshot ?? generateDraft(fixtureCase, config, id)
    : undefined;
  return generationRunRecordSchema.parse({
    schemaVersion: "1.0.0",
    id,
    status,
    mode: config.mode,
    caseId: fixtureCase.id,
    caseVersion: fixtureCase.version,
    datasetVersion: config.versionSummary.datasetVersion,
    safetyCoreId: config.safetyCoreRef.id,
    safetyCoreVersion: config.safetyCoreRef.version,
    policyId: config.policyRef.id,
    policyVersion: config.policyRef.version,
    configurationKey: config.configurationKey,
    providerId: "deterministic-mock",
    modelId: "deterministic-rule-generator",
    promptVersion: "mock-prompt-v1",
    inputCaseSnapshot: fixtureCase,
    effectiveConfigSnapshot: config,
    outputDraftSnapshot: outputDraft,
    inputValidationSummary: { status: "PASS", warningCount: 0 },
    outputValidationSummary: { status: "PASS", issueCount: 0 },
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  });
}

export function fixtureFailedGenerationRun(): GenerationRunRecord {
  const config = fixtureConfig("GENERIC");
  return generationRunRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: "run-fixture-failed-001",
    status: "FAILED",
    mode: config.mode,
    caseId: fixtureCase.id,
    caseVersion: fixtureCase.version,
    datasetVersion: config.versionSummary.datasetVersion,
    safetyCoreId: config.safetyCoreRef.id,
    safetyCoreVersion: config.safetyCoreRef.version,
    policyId: config.policyRef.id,
    policyVersion: config.policyRef.version,
    configurationKey: config.configurationKey,
    providerId: "deterministic-mock",
    modelId: "deterministic-rule-generator",
    promptVersion: "mock-prompt-v1",
    inputCaseSnapshot: fixtureCase,
    effectiveConfigSnapshot: config,
    inputValidationSummary: { status: "BLOCKED", errorCount: 1 },
    outputValidationSummary: { status: "NOT_RUN" },
    errorType: "INPUT_VALIDATION",
    errorMessage: "Input validation blocked generation.",
    createdAt: "2026-08-19T00:00:01.000Z",
  });
}

export function fixtureDraftRevision(
  overrides: Partial<DraftRevisionRecord> = {},
): DraftRevisionRecord {
  const generationRunId = overrides.generationRunId ?? "run-fixture-001";
  const run = fixtureGenerationRun({ id: generationRunId });
  const beforeSnapshot = overrides.beforeSnapshot ?? run.outputDraftSnapshot!;
  const afterSnapshot = overrides.afterSnapshot ?? {
    ...beforeSnapshot,
    sections: beforeSnapshot.sections.map((section, index) => index === 0
      ? { ...section, content: [...section.content, "编辑后的合成表达"] }
      : section),
  };
  const diffSummary = overrides.diffSummary ?? computeDraftDiff(beforeSnapshot, afterSnapshot);

  return draftRevisionRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: overrides.id ?? "revision-fixture-001",
    generationRunId,
    revisionNumber: overrides.revisionNumber ?? 1,
    beforeSnapshot,
    afterSnapshot,
    diffSummary,
    editorId: overrides.editorId ?? "demo-physician",
    createdAt: overrides.createdAt ?? "2026-08-19T00:00:02.000Z",
    ...overrides,
  });
}

export function fixtureProfileVersion(
  version = 1,
  previousVersion?: number,
  overrides: Partial<PhysicianProfileVersionRecord> = {},
): PhysicianProfileVersionRecord {
  return physicianProfileVersionRecordSchema.parse({
    schemaVersion: "1.0.0",
    profileId: fixtureProfile.id,
    version,
    status: fixtureProfile.status,
    synthetic: true,
    preferences: fixtureProfile.preferences,
    ...(previousVersion === undefined ? {} : { previousVersion }),
    sourceType: version === 1 ? "SEED" : "RUNTIME_CONFIRMED",
    createdAt: `2026-08-19T00:00:${String(version + 10).padStart(2, "0")}.000Z`,
    ...overrides,
  });
}

export function fixtureAuditEvent(overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return auditEventRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: "audit-fixture-001",
    eventType: "GENERATION_RUN_RECORDED",
    actorId: "system-fixture",
    simulatedRole: "SYSTEM",
    entityType: "GENERATION_RUN",
    entityId: "run-fixture-001",
    metadata: { source: "test-fixture", synthetic: true },
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  });
}
