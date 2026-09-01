import { z } from "zod";

import { seedManifest, specialtyVisitPolicies, institutionalSafetyCore, syntheticCases, physicianProfiles } from "@/data/seed-loader";
import { compileComparisonConfigs, type EffectiveGenerationConfig } from "@/domain/effective-config";
import { validateCaseInput } from "@/domain/input-validation";
import {
  generatedDraftSchema,
  providerDraftEnvelopeSchema,
  type GeneratedDraft,
  type PhysicianProfile,
  type SyntheticCase,
} from "@/domain/schemas";
import { assembleCanonicalGeneratedDraft } from "@/domain/draft-projection";
import { classifyOutputShapeFailure, validateGeneratedDraft, type OutputValidationIssue } from "@/domain/safety-core";
import type { FeedbackFixture } from "@/domain/dataset";
import {
  generationRunRecordSchema,
  isoUtcTimestampSchema,
  type JsonObject,
  type GenerationRunRecord,
} from "@/domain/runtime-records";
import type { DatabaseSync } from "node:sqlite";

import type { LLMProvider, ProviderResult } from "./ports/llm-provider";
import { providerMetadataSchema, type ProviderMetadata } from "@/domain/provider";
import { providerSelectionSchema } from "@/domain/provider";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { isPersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { recordGenerationRunWithAudit } from "./runtime-persistence-service";
import type { DeterministicMockScenario } from "@/infrastructure/providers/deterministic-mock-provider";
import { createRandomSystemId } from "./system-id";

export const generationRequestSchema = z.object({
  caseId: z.string().min(1).max(200),
  profileId: z.string().min(1).max(200),
  mockMode: z.enum([
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
  ]).optional(),
  providerSelection: providerSelectionSchema.optional(),
}).strict();

export type GenerationRequest = z.infer<typeof generationRequestSchema>;

export const GENERATION_RULE_IDS = {
  CASE_NOT_FOUND: "GENERATION_CASE_NOT_FOUND",
  PROFILE_NOT_FOUND: "GENERATION_PROFILE_NOT_FOUND",
  DATA_CORRUPTION: "GENERATION_DATA_CORRUPTION",
  INPUT_BLOCKED: "GENERATION_INPUT_BLOCKED",
  CONFIG_BLOCKED: "GENERATION_CONFIG_BLOCKED",
  PROVIDER_TIMEOUT: "GENERATION_PROVIDER_TIMEOUT",
  PROVIDER_AUTH: "GENERATION_PROVIDER_AUTH",
  PROVIDER_ERROR: "GENERATION_PROVIDER_ERROR",
  PROVIDER_PROVENANCE_INVALID: "GENERATION_PROVIDER_PROVENANCE_INVALID",
  RUNTIME_READ_ONLY: "PUBLIC_DEMO_READ_ONLY",
  OUTPUT_FORMAT_INVALID: "GENERATION_OUTPUT_FORMAT_INVALID",
  OUTPUT_SCHEMA_INVALID: "GENERATION_OUTPUT_SCHEMA_INVALID",
  OUTPUT_RULE_BLOCKED: "GENERATION_OUTPUT_RULE_BLOCKED",
  PERSISTENCE_FAILED: "GENERATION_PERSISTENCE_FAILED",
  TRANSPORT_ERROR: "GENERATION_TRANSPORT_ERROR",
} as const;

export type GenerationRuleId = (typeof GENERATION_RULE_IDS)[keyof typeof GENERATION_RULE_IDS];
export type GenerationMode = "GENERIC" | "BOUNDED";
export type GenerationComparisonStatus = "SUCCEEDED" | "PARTIAL_FAILURE" | "FAILED";
export type GenerationAttemptStatus = "SUCCEEDED" | "FAILED" | "NOT_RUN";
export type GenerationFailureType = "INPUT" | "CONFIGURATION" | "PROVIDER" | "OUTPUT" | "PERSISTENCE" | "TRANSPORT";

export type GenerationProviderSummary = {
  id: string;
  modelId: string;
  promptVersion: string;
  executionType?: "MOCK" | "REAL";
  networkCall?: boolean;
};

export type GenerationFailure = {
  ruleId: GenerationRuleId;
  errorType: GenerationFailureType;
  message: string;
  ruleIds?: string[];
  details?: OutputValidationIssue[];
  persisted: boolean;
};

export type GenerationAttemptResult = {
  mode: "GENERIC" | "BOUNDED";
  status: GenerationAttemptStatus;
  runId?: string;
  configurationKey?: string;
  provider: GenerationProviderSummary;
  providerMetadata?: ProviderMetadata;
  draft?: GeneratedDraft;
  error?: GenerationFailure;
};

export type GenerationSharedSummary = {
  caseId: string;
  caseVersion: string;
  datasetVersion: string;
  safetyCoreId: string;
  safetyCoreVersion: string;
  policyId: string;
  policyVersion: string;
  profileId: string;
  profileVersion: number;
};

export type GenerationComparisonResult = {
  requestId: string;
  status: GenerationComparisonStatus;
  provider: GenerationProviderSummary;
  shared?: GenerationSharedSummary;
  generic: GenerationAttemptResult;
  bounded: GenerationAttemptResult;
};

export type GenerationIdKind = "REQUEST" | "RUN" | "AUDIT";
export type GenerationIdFactory = (kind: GenerationIdKind) => string;
export type GenerationClock = () => string;

export type GenerationSeedSource = {
  seedManifest: typeof seedManifest;
  syntheticCases: readonly SyntheticCase[];
  physicianProfiles: readonly PhysicianProfile[];
  institutionalSafetyCore: typeof institutionalSafetyCore;
  specialtyVisitPolicies: typeof specialtyVisitPolicies;
  adversarialFeedbackFixtures?: readonly FeedbackFixture[];
  uncertaintyFeedbackFixtures?: readonly FeedbackFixture[];
};

export type GenerationServiceDependencies = {
  database: DatabaseSync;
  provider: LLMProvider;
  seeds?: GenerationSeedSource;
  clock?: GenerationClock;
  idFactory?: GenerationIdFactory;
};

type CompiledGenerationConfigs = Extract<ReturnType<typeof compileComparisonConfigs>, { ok: true }>;

type PreparedGeneration = {
  ok: true;
  requestId: string;
  providerInfo: GenerationProviderSummary;
  caseData: SyntheticCase;
  profile: PhysicianProfile;
  configs: CompiledGenerationConfigs;
  inputSummary: Record<string, unknown>;
  clock: GenerationClock;
  idFactory: GenerationIdFactory;
};

type PreparationFailure = {
  ok: false;
  requestId: string;
  providerInfo: GenerationProviderSummary;
  error: GenerationFailure;
};

type PreparationResult = PreparedGeneration | PreparationFailure;

const defaultSeeds: GenerationSeedSource = {
  seedManifest,
  syntheticCases,
  physicianProfiles,
  institutionalSafetyCore,
  specialtyVisitPolicies,
};

const defaultIdFactory: GenerationIdFactory = (kind) => createRandomSystemId(`generation-${kind.toLowerCase()}`);

const controlledMessages = {
  caseNotFound: "未找到所选版本化合成病例，未调用 provider。",
  profileNotFound: "未找到可用于生成的 ACTIVE 或 FROZEN 版本化合成医生画像，未调用 provider。",
  profileDataCorruption: "版本化医生画像数据损坏，未调用 provider。",
  inputBlocked: "服务端输入校验阻断了生成，未调用 provider。",
  configBlocked: "服务端有效配置编译阻断了生成，未调用 provider。",
  providerTimeout: "provider 超时，未重试或切换 provider。",
  providerAuth: "provider 认证失败，未重试或切换 provider。",
  providerError: "provider 返回受控错误，未切换 provider。",
  providerFormat: "provider 未返回可解析的结构化输出。",
  outputFormat: "provider 输出不是有效 JSON，未保存原始输出。",
  outputSchema: "provider 输出未通过结构化输出 Schema。",
  outputRule: "provider 输出未通过机构安全规则，未展示为合格草稿。",
  providerProvenance: "真实 provider 来源元数据无效，未保存为成功结果。",
  persistence: "生成运行或审计事件持久化失败，未返回成功结果。",
} as const;

function nowIso(clock: GenerationClock): string {
  const value = clock();
  return isoUtcTimestampSchema.safeParse(value).success ? value : new Date().toISOString();
}

function providerSummary(provider: LLMProvider): GenerationProviderSummary {
  const executionType = provider.executionType ?? (provider.id === "deterministic-mock" ? "MOCK" : "REAL");
  return {
    id: provider.id,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    executionType,
    networkCall: provider.networkCall ?? executionType === "REAL",
  };
}

function failure(
  ruleId: GenerationRuleId,
  errorType: GenerationFailureType,
  message: string,
  persisted = false,
  ruleIds?: string[],
  details?: OutputValidationIssue[],
): GenerationFailure {
  return {
    ruleId,
    errorType,
    message,
    persisted,
    ...(ruleIds && ruleIds.length > 0 ? { ruleIds } : {}),
    ...(details && details.length > 0 ? { details } : {}),
  };
}

function notRun(
  mode: GenerationMode,
  provider: GenerationProviderSummary,
  blocked: GenerationFailure,
): GenerationAttemptResult {
  return { mode, status: "NOT_RUN", provider, error: blocked };
}

function resultStatus(
  generic: GenerationAttemptResult,
  bounded: GenerationAttemptResult,
): GenerationComparisonStatus {
  const genericSuccess = generic.status === "SUCCEEDED";
  const boundedSuccess = bounded.status === "SUCCEEDED";
  if (genericSuccess && boundedSuccess) return "SUCCEEDED";
  if (genericSuccess || boundedSuccess) return "PARTIAL_FAILURE";
  return "FAILED";
}

function providerFailure(providerResult: Extract<ProviderResult, { ok: false }>): GenerationFailure {
  switch (providerResult.errorType) {
    case "TIMEOUT":
      return failure(GENERATION_RULE_IDS.PROVIDER_TIMEOUT, "PROVIDER", controlledMessages.providerTimeout);
    case "AUTH":
      return failure(GENERATION_RULE_IDS.PROVIDER_AUTH, "PROVIDER", controlledMessages.providerAuth);
    case "FORMAT":
      return failure(
        GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED,
        "OUTPUT",
        controlledMessages.providerFormat,
        false,
        ["OUTPUT_FORMAT_INVALID"],
        [{ ruleId: "OUTPUT_FORMAT_INVALID" }],
      );
    case "PROVIDER":
    default:
      return failure(GENERATION_RULE_IDS.PROVIDER_ERROR, "PROVIDER", controlledMessages.providerError);
  }
}

function providerOutputCandidate(
  parsedOutput: unknown,
  provider: LLMProvider,
  input: {
    runId: string;
    caseData: SyntheticCase;
    config: EffectiveGenerationConfig;
  },
): { ok: true; candidate: unknown } | { ok: false; issues: OutputValidationIssue[] } {
  if (provider.outputContract !== "SECTION_ENVELOPE") {
    return { ok: true, candidate: parsedOutput };
  }

  const envelope = providerDraftEnvelopeSchema.safeParse(parsedOutput);
  if (!envelope.success) {
    return { ok: false, issues: classifyOutputShapeFailure(parsedOutput) };
  }
  const assembled = assembleCanonicalGeneratedDraft(envelope.data, input);
  return assembled
    ? { ok: true, candidate: assembled }
    : { ok: false, issues: [{ ruleId: "OUTPUT_SECTION_SET_INVALID", fieldPath: "sections" }] };
}

function metadataFor(
  requestId: string,
  mode: "GENERIC" | "BOUNDED",
  record: Pick<GenerationRunRecord, "id" | "caseId" | "caseVersion" | "datasetVersion" | "safetyCoreVersion" | "policyVersion" | "configurationKey" | "providerId" | "modelId" | "promptVersion"> & Pick<GenerationRunRecord, "providerMetadata">,
  failureData?: GenerationFailure,
): JsonObject {
  return {
    requestId,
    runId: record.id,
    mode,
    caseId: record.caseId,
    caseVersion: record.caseVersion,
    datasetVersion: record.datasetVersion,
    safetyCoreVersion: record.safetyCoreVersion,
    policyVersion: record.policyVersion,
    configurationKey: record.configurationKey,
    providerId: record.providerId,
    modelId: record.modelId,
    promptVersion: record.promptVersion,
    ...(record.providerMetadata ? {
      providerMetadata: {
        ...(record.providerMetadata.promptDigest ? { promptDigest: record.providerMetadata.promptDigest } : {}),
        promptVersion: record.providerMetadata.promptVersion,
        ...(record.providerMetadata.responseModelId ? { responseModelId: record.providerMetadata.responseModelId } : {}),
        ...(record.providerMetadata.finishReason ? { finishReason: record.providerMetadata.finishReason } : {}),
        ...(record.providerMetadata.inputTokens !== undefined ? { inputTokens: record.providerMetadata.inputTokens } : {}),
        ...(record.providerMetadata.outputTokens !== undefined ? { outputTokens: record.providerMetadata.outputTokens } : {}),
      },
    } : {}),
    ...(failureData
      ? {
          errorType: failureData.errorType,
          ruleId: failureData.ruleId,
          ...(failureData.ruleIds ? { ruleIds: failureData.ruleIds } : {}),
          ...(failureData.details
            ? { details: failureData.details.map((detail) => ({ ruleId: detail.ruleId, ...(detail.fieldPath ? { fieldPath: detail.fieldPath } : {}) })) }
            : {}),
        }
      : {}),
  };
}

function persistGenerationAttempt(
  database: DatabaseSync,
  requestId: string,
  mode: GenerationMode,
  record: GenerationRunRecord,
  eventType: "GENERATION_RUN_SUCCEEDED" | "GENERATION_RUN_FAILED",
  failureData?: GenerationFailure,
  idFactory: GenerationIdFactory = defaultIdFactory,
): boolean {
  const auditEvent = {
    schemaVersion: "1.0.0" as const,
    id: idFactory("AUDIT"),
    eventType,
    actorId: "system-generation-service",
    simulatedRole: "SYSTEM" as const,
    entityType: "GENERATION_RUN",
    entityId: record.id,
    metadata: metadataFor(requestId, mode, record, failureData),
    createdAt: record.createdAt,
  };

  try {
    recordGenerationRunWithAudit(database, record, auditEvent);
    return true;
  } catch {
    return false;
  }
}

function persistBlockedAudit(
  database: DatabaseSync,
  requestId: string,
  ruleId: GenerationRuleId,
  idFactory: GenerationIdFactory,
  clock: GenerationClock,
): boolean {
  try {
    createAuditEventRepository(database).append({
      schemaVersion: "1.0.0",
      id: idFactory("AUDIT"),
      eventType: "GENERATION_REQUEST_BLOCKED",
      actorId: "system-generation-service",
      simulatedRole: "SYSTEM",
      entityType: "GENERATION_REQUEST",
      entityId: requestId,
      metadata: { requestId, ruleId },
      createdAt: nowIso(clock),
    });
    return true;
  } catch {
    return false;
  }
}

function persistFailure(
  database: DatabaseSync,
  requestId: string,
  mode: GenerationMode,
  runId: string,
  caseData: SyntheticCase,
  config: EffectiveGenerationConfig,
  provider: GenerationProviderSummary,
  inputSummary: Record<string, unknown>,
  outputSummary: Record<string, unknown>,
  failureData: GenerationFailure,
  clock: GenerationClock,
  idFactory: GenerationIdFactory,
  providerMetadata?: ProviderMetadata,
): GenerationAttemptResult {
  const record = generationRunRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: runId,
    status: "FAILED",
    mode,
    caseId: caseData.id,
    caseVersion: caseData.version,
    datasetVersion: config.versionSummary.datasetVersion,
    safetyCoreId: config.safetyCoreRef.id,
    safetyCoreVersion: config.safetyCoreRef.version,
    policyId: config.policyRef.id,
    policyVersion: config.policyRef.version,
    ...(config.profileRef ? { profileId: config.profileRef.id, profileVersion: config.profileRef.version } : {}),
    configurationKey: config.configurationKey,
    providerId: provider.id,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    ...(providerMetadata ? { providerMetadata } : {}),
    inputCaseSnapshot: caseData,
    effectiveConfigSnapshot: config,
    inputValidationSummary: inputSummary,
    outputValidationSummary: outputSummary,
    errorType: failureData.errorType === "PROVIDER" ? "PROVIDER" : "OUTPUT_VALIDATION",
    errorMessage: failureData.message,
    createdAt: nowIso(clock),
  });
  const persisted = persistGenerationAttempt(
    database,
    requestId,
    mode,
    record,
    "GENERATION_RUN_FAILED",
    failureData,
    idFactory,
  );
  if (!persisted) {
    return {
      mode,
      status: "FAILED",
      runId,
      configurationKey: config.configurationKey,
      provider,
      error: failure(
        GENERATION_RULE_IDS.PERSISTENCE_FAILED,
        "PERSISTENCE",
        controlledMessages.persistence,
        false,
      ),
    };
  }
  return {
    mode,
    status: "FAILED",
    runId,
    configurationKey: config.configurationKey,
    provider,
    ...(providerMetadata ? { providerMetadata } : {}),
    error: { ...failureData, persisted: true },
  };
}

async function executeAttempt(
  database: DatabaseSync,
  requestId: string,
  mode: GenerationMode,
  caseData: SyntheticCase,
  config: EffectiveGenerationConfig,
  provider: LLMProvider,
  inputSummary: Record<string, unknown>,
  clock: GenerationClock,
  idFactory: GenerationIdFactory,
): Promise<GenerationAttemptResult> {
  const providerInfo = providerSummary(provider);
  const runId = idFactory("RUN");
  let providerResult: ProviderResult;
  try {
    providerResult = await provider.generateDraft({ runId, caseData, config });
  } catch {
    return persistFailure(
      database,
      requestId,
      mode,
      runId,
      caseData,
      config,
      providerInfo,
      inputSummary,
      { status: "NOT_RUN", ruleIds: [GENERATION_RULE_IDS.PROVIDER_ERROR] },
      failure(GENERATION_RULE_IDS.PROVIDER_ERROR, "PROVIDER", controlledMessages.providerError),
      clock,
      idFactory,
    );
  }

  const parsedProviderMetadata = providerResult.metadata === undefined
    ? undefined
    : providerMetadataSchema.safeParse(providerResult.metadata);
  const providerMetadata = parsedProviderMetadata?.success ? parsedProviderMetadata.data : undefined;
  const realProviderProvenanceInvalid = providerResult.ok && providerInfo.executionType === "REAL"
    && (!parsedProviderMetadata
      || !parsedProviderMetadata.success
      || parsedProviderMetadata.data.promptVersion !== providerInfo.promptVersion);

  if (realProviderProvenanceInvalid) {
    const provenanceFailure = failure(
      GENERATION_RULE_IDS.PROVIDER_PROVENANCE_INVALID,
      "PROVIDER",
      controlledMessages.providerProvenance,
      false,
      [GENERATION_RULE_IDS.PROVIDER_PROVENANCE_INVALID],
    );
    return persistFailure(
      database,
      requestId,
      mode,
      runId,
      caseData,
      config,
      providerInfo,
      inputSummary,
      { status: "BLOCKED", ruleIds: [GENERATION_RULE_IDS.PROVIDER_PROVENANCE_INVALID] },
      provenanceFailure,
      clock,
      idFactory,
    );
  }

  if (!providerResult.ok) {
    const providerError = providerFailure(providerResult);
    return persistFailure(
      database,
      requestId,
      mode,
      runId,
      caseData,
      config,
      providerInfo,
      inputSummary,
      { status: "NOT_RUN", providerError: providerResult.errorType },
      providerError,
      clock,
      idFactory,
      providerMetadata,
    );
  }

  let parsedOutput: unknown;
  try {
    if (typeof providerResult.raw !== "string") throw new Error("invalid provider raw type");
    parsedOutput = JSON.parse(providerResult.raw);
  } catch {
    return persistFailure(
      database,
      requestId,
      mode,
      runId,
      caseData,
      config,
      providerInfo,
      inputSummary,
      { status: "BLOCKED", ruleIds: ["OUTPUT_FORMAT_INVALID"], details: [{ ruleId: "OUTPUT_FORMAT_INVALID" }] },
      failure(
        GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED,
        "OUTPUT",
        controlledMessages.outputFormat,
        false,
        ["OUTPUT_FORMAT_INVALID"],
        [{ ruleId: "OUTPUT_FORMAT_INVALID" }],
      ),
      clock,
      idFactory,
      providerMetadata,
    );
  }

  const providerCandidate = providerOutputCandidate(parsedOutput, provider, {
    runId,
    caseData,
    config,
  });
  if (!providerCandidate.ok) {
    const details = providerCandidate.issues;
    return persistFailure(
      database,
      requestId,
      mode,
      runId,
      caseData,
      config,
      providerInfo,
      inputSummary,
      { status: "BLOCKED", ruleIds: details.map((detail) => detail.ruleId), details },
      failure(
        GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED,
        "OUTPUT",
        controlledMessages.outputSchema,
        false,
        details.map((detail) => detail.ruleId),
        details,
      ),
      clock,
      idFactory,
      providerMetadata,
    );
  }

  const draftResult = generatedDraftSchema.safeParse(providerCandidate.candidate);
  if (!draftResult.success) {
    const details: OutputValidationIssue[] = [{ ruleId: "OUTPUT_SCHEMA_INVALID", fieldPath: "output" }];
    return persistFailure(
      database,
      requestId,
      mode,
      runId,
      caseData,
      config,
      providerInfo,
      inputSummary,
      { status: "BLOCKED", ruleIds: details.map((detail) => detail.ruleId), details },
      failure(
        GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED,
        "OUTPUT",
        controlledMessages.outputSchema,
        false,
        details.map((detail) => detail.ruleId),
        details,
      ),
      clock,
      idFactory,
      providerMetadata,
    );
  }

  const outputValidation = validateGeneratedDraft(draftResult.data, {
    caseData,
    config,
    expectedRunId: runId,
  });
  if (!outputValidation.ok) {
    const details = outputValidation.issues;
    return persistFailure(
      database,
      requestId,
      mode,
      runId,
      caseData,
      config,
      providerInfo,
      inputSummary,
      { status: "BLOCKED", ruleIds: details.map((detail) => detail.ruleId), details },
      failure(
        GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED,
        "OUTPUT",
        controlledMessages.outputRule,
        false,
        details.map((detail) => detail.ruleId),
        details,
      ),
      clock,
      idFactory,
      providerMetadata,
    );
  }

  const record = generationRunRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: runId,
    status: "SUCCEEDED",
    mode,
    caseId: caseData.id,
    caseVersion: caseData.version,
    datasetVersion: config.versionSummary.datasetVersion,
    safetyCoreId: config.safetyCoreRef.id,
    safetyCoreVersion: config.safetyCoreRef.version,
    policyId: config.policyRef.id,
    policyVersion: config.policyRef.version,
    ...(config.profileRef ? { profileId: config.profileRef.id, profileVersion: config.profileRef.version } : {}),
    configurationKey: config.configurationKey,
    providerId: providerInfo.id,
    modelId: providerInfo.modelId,
    promptVersion: providerInfo.promptVersion,
    ...(providerMetadata ? { providerMetadata } : {}),
    inputCaseSnapshot: caseData,
    effectiveConfigSnapshot: config,
    outputDraftSnapshot: draftResult.data,
    inputValidationSummary: inputSummary,
    outputValidationSummary: { status: "PASS", issueCount: 0 },
    createdAt: nowIso(clock),
  });
  if (!persistGenerationAttempt(database, requestId, mode, record, "GENERATION_RUN_SUCCEEDED", undefined, idFactory)) {
    return {
      mode,
      status: "FAILED",
      runId,
      configurationKey: config.configurationKey,
      provider: providerInfo,
      error: failure(GENERATION_RULE_IDS.PERSISTENCE_FAILED, "PERSISTENCE", controlledMessages.persistence),
    };
  }

  return {
    mode,
    status: "SUCCEEDED",
    runId,
    configurationKey: config.configurationKey,
    provider: providerInfo,
    ...(providerMetadata ? { providerMetadata } : {}),
    draft: draftResult.data,
  };
}

export function parseGenerationRequest(value: unknown): GenerationRequest | undefined {
  const result = generationRequestSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function blockedPreparation(
  database: DatabaseSync,
  requestId: string,
  providerInfo: GenerationProviderSummary,
  blocked: GenerationFailure,
  idFactory: GenerationIdFactory,
  clock: GenerationClock,
): PreparationFailure {
  const auditPersisted = persistBlockedAudit(database, requestId, blocked.ruleId, idFactory, clock);
  return {
    ok: false,
    requestId,
    providerInfo,
    error: auditPersisted
      ? blocked
      : failure(GENERATION_RULE_IDS.PERSISTENCE_FAILED, "PERSISTENCE", controlledMessages.persistence),
  };
}

function prepareGeneration(
  request: unknown,
  dependencies: GenerationServiceDependencies,
): PreparationResult {
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const providerInfo = providerSummary(dependencies.provider);
  const requestId = idFactory("REQUEST");
  const parsedRequest = generationRequestSchema.safeParse(request);
  const seeds = dependencies.seeds ?? defaultSeeds;

  if (!parsedRequest.success) {
    return blockedPreparation(
      dependencies.database,
      requestId,
      providerInfo,
      failure(GENERATION_RULE_IDS.INPUT_BLOCKED, "INPUT", controlledMessages.inputBlocked),
      idFactory,
      clock,
    );
  }

  const { caseId, profileId } = parsedRequest.data;
  const caseData = seeds.syntheticCases.find((candidate) => candidate.id === caseId);
  if (!caseData) {
    return blockedPreparation(
      dependencies.database,
      requestId,
      providerInfo,
      failure(GENERATION_RULE_IDS.CASE_NOT_FOUND, "INPUT", controlledMessages.caseNotFound),
      idFactory,
      clock,
    );
  }

  const seedProfile = seeds.physicianProfiles.find((candidate) => candidate.id === profileId);
  let profile = seedProfile;
  if (seedProfile) {
    try {
      const storedProfile = createPhysicianProfileVersionRepository(dependencies.database).getLatest(seedProfile.id);
      if (storedProfile) {
        profile = {
          ...seedProfile,
          version: storedProfile.version,
          status: storedProfile.status,
          preferences: storedProfile.preferences,
        };
      }
    } catch (error) {
      const ruleId = isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION
        ? GENERATION_RULE_IDS.DATA_CORRUPTION
        : GENERATION_RULE_IDS.PERSISTENCE_FAILED;
      const message = ruleId === GENERATION_RULE_IDS.DATA_CORRUPTION
        ? controlledMessages.profileDataCorruption
        : controlledMessages.persistence;
      return blockedPreparation(
        dependencies.database,
        requestId,
        providerInfo,
        failure(ruleId, "PERSISTENCE", message),
        idFactory,
        clock,
      );
    }
  }
  if (!profile || (profile.status !== "ACTIVE" && profile.status !== "FROZEN")) {
    return blockedPreparation(
      dependencies.database,
      requestId,
      providerInfo,
      failure(GENERATION_RULE_IDS.PROFILE_NOT_FOUND, "INPUT", controlledMessages.profileNotFound),
      idFactory,
      clock,
    );
  }

  const inputValidation = validateCaseInput(caseData, { policies: seeds.specialtyVisitPolicies });
  if (!inputValidation.canGenerate) {
    return blockedPreparation(
      dependencies.database,
      requestId,
      providerInfo,
      failure(
        GENERATION_RULE_IDS.INPUT_BLOCKED,
        "INPUT",
        controlledMessages.inputBlocked,
        false,
        inputValidation.issues.filter((issue) => issue.severity === "ERROR").map((issue) => issue.ruleId),
      ),
      idFactory,
      clock,
    );
  }

  const configs = compileComparisonConfigs({
    caseData,
    safetyCore: seeds.institutionalSafetyCore,
    policies: seeds.specialtyVisitPolicies,
    datasetVersion: seeds.seedManifest.datasetVersion,
    profile,
  });
  if (!configs.ok) {
    return blockedPreparation(
      dependencies.database,
      requestId,
      providerInfo,
      failure(
        GENERATION_RULE_IDS.CONFIG_BLOCKED,
        "CONFIGURATION",
        controlledMessages.configBlocked,
        false,
        configs.issues.map((issue) => issue.ruleId),
      ),
      idFactory,
      clock,
    );
  }

  return {
    ok: true,
    requestId,
    providerInfo,
    caseData,
    profile,
    configs,
    inputSummary: {
      status: inputValidation.status,
      warningCount: inputValidation.issues.filter((issue) => issue.severity === "WARNING").length,
    },
    clock,
    idFactory,
  };
}

export async function executeGenerationSingleMode(
  request: unknown,
  mode: GenerationMode,
  dependencies: GenerationServiceDependencies,
): Promise<GenerationAttemptResult> {
  const prepared = prepareGeneration(request, dependencies);
  if (!prepared.ok) {
    return notRun(mode, prepared.providerInfo, prepared.error);
  }

  return executeAttempt(
    dependencies.database,
    prepared.requestId,
    mode,
    prepared.caseData,
    mode === "GENERIC" ? prepared.configs.generic : prepared.configs.bounded,
    dependencies.provider,
    prepared.inputSummary,
    prepared.clock,
    prepared.idFactory,
  );
}

export async function executeGenerationComparison(
  request: unknown,
  dependencies: GenerationServiceDependencies,
): Promise<GenerationComparisonResult> {
  const prepared = prepareGeneration(request, dependencies);
  if (!prepared.ok) {
    return {
      requestId: prepared.requestId,
      status: "FAILED",
      provider: prepared.providerInfo,
      generic: notRun("GENERIC", prepared.providerInfo, prepared.error),
      bounded: notRun("BOUNDED", prepared.providerInfo, prepared.error),
    };
  }

  const generic = await executeAttempt(
    dependencies.database,
    prepared.requestId,
    "GENERIC",
    prepared.caseData,
    prepared.configs.generic,
    dependencies.provider,
    prepared.inputSummary,
    prepared.clock,
    prepared.idFactory,
  );
  const bounded = await executeAttempt(
    dependencies.database,
    prepared.requestId,
    "BOUNDED",
    prepared.caseData,
    prepared.configs.bounded,
    dependencies.provider,
    prepared.inputSummary,
    prepared.clock,
    prepared.idFactory,
  );

  return {
    requestId: prepared.requestId,
    status: resultStatus(generic, bounded),
    provider: prepared.providerInfo,
    shared: {
      caseId: prepared.caseData.id,
      caseVersion: prepared.caseData.version,
      datasetVersion: prepared.configs.sharedVersionSummary.datasetVersion,
      safetyCoreId: prepared.configs.generic.safetyCoreRef.id,
      safetyCoreVersion: prepared.configs.sharedVersionSummary.safetyCoreVersion,
      policyId: prepared.configs.generic.policyRef.id,
      policyVersion: prepared.configs.sharedVersionSummary.policyVersion,
      profileId: prepared.profile.id,
      profileVersion: prepared.profile.version,
    },
    generic,
    bounded,
  };
}

export function createPersistenceFailureResult(provider: LLMProvider): GenerationComparisonResult {
  const providerInfo = providerSummary(provider);
  const error = failure(GENERATION_RULE_IDS.PERSISTENCE_FAILED, "PERSISTENCE", controlledMessages.persistence);
  return {
    requestId: createRandomSystemId("generation-request"),
    status: "FAILED",
    provider: providerInfo,
    generic: notRun("GENERIC", providerInfo, error),
    bounded: notRun("BOUNDED", providerInfo, error),
  };
}

export type { DeterministicMockScenario };
