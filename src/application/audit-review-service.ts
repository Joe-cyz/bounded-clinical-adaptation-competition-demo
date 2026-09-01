import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { physicianProfiles, seedManifest } from "@/data/seed-loader";
import {
  draftRevisionDiffSummarySchema,
  type DraftLineOperation,
  type DraftRevisionRecord,
} from "@/domain/draft-revisions";
import {
  isoUtcTimestampSchema,
  type AuditEventRecord,
  type FeedbackEventRecord,
  type GenerationRunRecord,
  type JsonObject,
  type PhysicianProfileVersionRecord,
  type ReviewDecisionRecord,
} from "@/domain/runtime-records";
import { physicianPreferenceSchema, sectionKeySchema } from "@/domain/schemas";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { isPersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_EVENT_TYPES,
  AUDIT_SIMULATED_ROLES,
  createAuditEventRepository,
  type AuditEventQuery,
} from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createDraftRevisionRepository } from "@/infrastructure/sqlite/repositories/draft-revision-repository";
import { createFeedbackEventRepository } from "@/infrastructure/sqlite/repositories/feedback-event-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { createReviewDecisionRepository } from "@/infrastructure/sqlite/repositories/review-decision-repository";

export { AUDIT_ENTITY_TYPES, AUDIT_EVENT_TYPES, AUDIT_SIMULATED_ROLES };

export const AUDIT_READ_RULE_IDS = {
  INPUT_INVALID: "AUDIT_READ_INPUT_INVALID",
  RUN_NOT_FOUND: "AUDIT_RUN_NOT_FOUND",
  DATA_CORRUPTION: "AUDIT_DATA_CORRUPTION",
  PERSISTENCE_FAILED: "AUDIT_PERSISTENCE_FAILED",
} as const;

export type AuditReadFailure = {
  ok: false;
  ruleId: (typeof AUDIT_READ_RULE_IDS)[keyof typeof AUDIT_READ_RULE_IDS];
  message: string;
};

export type AuditReadResult<T> = { ok: true; data: T } | AuditReadFailure;

const safeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const auditReadMessages = {
  input: "审计查询参数未通过服务端校验。",
  runNotFound: "未找到该生成运行，未构造审计链路。",
  corruption: "审计链路数据损坏，未返回原始数据。",
  persistence: "审计查询未完成，未返回内部错误详情。",
} as const;

const safeLineOperationSchema = z.object({
  operation: z.enum(["ADD", "DELETE", "REWRITE"]),
  index: z.number().int().nonnegative().max(100_000),
  before: z.string().max(500).optional(),
  after: z.string().max(500).optional(),
}).strict();

const safeRevisionEvidenceSchema = z.object({
  changedSectionKey: sectionKeySchema.optional(),
  beforeSectionOrder: z.array(sectionKeySchema).max(12).optional(),
  afterSectionOrder: z.array(sectionKeySchema).max(12).optional(),
  operations: z.array(safeLineOperationSchema).max(80),
  redacted: z.boolean(),
  highRiskBodyStored: z.boolean(),
}).strict();

const safeDiffMetricsSchema = z.object({
  changedSectionCount: z.number().int().nonnegative().max(12),
  addedLineCount: z.number().int().nonnegative().max(100_000),
  removedLineCount: z.number().int().nonnegative().max(100_000),
  addedCharacterCount: z.number().int().nonnegative().max(30_000),
  removedCharacterCount: z.number().int().nonnegative().max(30_000),
  editBurdenRatio: z.number().finite().nonnegative().max(1),
}).strict();

const safeRevisionSchema = z.object({
  id: safeIdSchema,
  generationRunId: safeIdSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  editorId: safeIdSchema,
  createdAt: isoUtcTimestampSchema,
  orderChanged: z.boolean(),
  metrics: safeDiffMetricsSchema,
  changedSectionKeys: z.array(sectionKeySchema).max(12),
  feedbackEventIds: z.array(safeIdSchema).max(100),
}).strict();

const safeDecisionSchema = z.object({
  id: safeIdSchema,
  feedbackEventId: safeIdSchema,
  actorId: safeIdSchema,
  simulatedRole: z.enum(["PHYSICIAN", "REVIEWER"]),
  decision: z.enum(["CONFIRMED", "DISMISSED", "APPROVED", "REJECTED"]),
  rationale: z.string().min(1).max(500),
  expectedProfileVersion: z.number().int().positive().max(100_000).optional(),
  createdAt: isoUtcTimestampSchema,
}).strict();

const safeProfileVersionSchema = z.object({
  profileId: safeIdSchema,
  version: z.number().int().positive().max(100_000),
  status: z.enum(["ACTIVE", "FROZEN", "ARCHIVED"]),
  synthetic: z.literal(true),
  preferences: physicianPreferenceSchema,
  previousVersion: z.number().int().positive().optional(),
  sourceType: z.string().min(1).max(64),
  createdAt: z.string().min(1).max(100),
  persisted: z.boolean(),
}).strict();

const safeProfileSchema = z.object({
  id: safeIdSchema,
  displayName: z.string().min(1).max(200),
  synthetic: z.literal(true),
  sourceNote: z.string().min(1).max(500),
  seedBridged: z.boolean(),
  current: safeProfileVersionSchema,
  history: z.array(safeProfileVersionSchema).max(100),
}).strict();

const safeFeedbackSchema = z.object({
  id: safeIdSchema,
  generationRunId: safeIdSchema,
  draftRevisionId: safeIdSchema.optional(),
  revisionNumber: z.number().int().positive().max(100_000).optional(),
  proposalId: safeIdSchema,
  profileId: safeIdSchema,
  profileVersion: z.number().int().positive().max(100_000),
  rulesVersion: z.string().min(1).max(100),
  changeType: z.enum(["FORMAT", "REORDER", "ADD", "DELETE", "REWRITE"]),
  status: z.enum(["CANDIDATE", "HELD_FOR_REVIEW", "REJECTED"]),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "UNCERTAIN"]),
  decision: z.enum(["PENDING", "CONFIRMED", "DISMISSED", "APPROVED", "REJECTED"]),
  affectedField: z.union([sectionKeySchema, z.literal("sectionOrder"), z.literal("unknown")]),
  ruleHits: z.array(z.string().max(100)).max(20),
  safetyReason: z.string().min(1).max(500),
  nextAllowedActions: z.array(z.string().max(50)).max(4),
  evidence: z.object({
    operationCount: z.number().int().nonnegative(),
    addedLineCount: z.number().int().nonnegative(),
    removedLineCount: z.number().int().nonnegative(),
    addedCharacterCount: z.number().int().nonnegative(),
    removedCharacterCount: z.number().int().nonnegative(),
    orderChanged: z.boolean(),
  }).strict(),
  candidatePatch: z.object({ type: z.literal("sectionOrder"), sectionOrder: z.array(sectionKeySchema).max(12) }).strict().optional(),
  decisionRecord: safeDecisionSchema.optional(),
  revisionEvidence: safeRevisionEvidenceSchema,
  relationWarnings: z.array(z.string().max(200)).max(20),
  createdAt: isoUtcTimestampSchema,
}).strict();

const safeAuditSchema = z.object({
  id: safeIdSchema,
  eventType: z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/),
  actorId: safeIdSchema,
  simulatedRole: z.enum(["SYSTEM", "PHYSICIAN", "REVIEWER", "RESEARCHER"]),
  entityType: z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/),
  entityId: safeIdSchema,
  beforeVersion: z.string().max(100).optional(),
  afterVersion: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.union([
    z.string().max(500),
    z.number().finite(),
    z.boolean(),
    z.array(z.union([z.string().max(200), z.number().finite(), z.boolean()])).max(100),
  ])),
  createdAt: isoUtcTimestampSchema,
}).strict();

export type SafeRevision = z.infer<typeof safeRevisionSchema>;
export type SafeDecision = z.infer<typeof safeDecisionSchema>;
export type SafeProfileVersion = z.infer<typeof safeProfileVersionSchema>;
export type SafeProfile = z.infer<typeof safeProfileSchema>;
export type SafeFeedback = z.infer<typeof safeFeedbackSchema>;
export type SafeAuditEvent = z.infer<typeof safeAuditSchema>;

export type ProfileReadModel = { profiles: SafeProfile[] };
export type FeedbackReadModel = { events: SafeFeedback[] };
export type AuditReadModel = { events: SafeAuditEvent[]; nextCursor?: string };

export type SafeGenerationRun = {
  id: string;
  status: GenerationRunRecord["status"];
  mode: GenerationRunRecord["mode"];
  case: { id: string; version: string; specialty: string; visitType: string; title: string; chiefConcern: string };
  datasetVersion: string;
  safetyCore: { id: string; version: string };
  policy: { id: string; version: string };
  profileId?: string;
  profileVersion?: number;
  configurationKey: string;
  provider: { id: string; modelId: string; promptVersion: string };
  hasOutputSnapshot: boolean;
  errorType?: string;
  createdAt: string;
};

export type GenerationTrace = {
  runId: string;
  traceIntegrity: "COMPLETE" | "INCOMPLETE" | "CORRUPTED";
  missingRelations: string[];
  run?: SafeGenerationRun;
  revisions: SafeRevision[];
  feedback: SafeFeedback[];
  profiles: SafeProfile[];
  audits: SafeAuditEvent[];
  highRiskBodyStored: false;
};

export type GenerationTraceResult = AuditReadResult<GenerationTrace>;

export type FeedbackQuery = {
  riskLevel?: SafeFeedback["riskLevel"];
  status?: SafeFeedback["status"];
  profileId?: string;
  feedbackEventId?: string;
  hasDecision?: boolean;
};

function failure(ruleId: AuditReadFailure["ruleId"], message: string): AuditReadFailure {
  return { ok: false, ruleId, message };
}

function mapReadError(error: unknown): AuditReadFailure {
  if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
    return failure(AUDIT_READ_RULE_IDS.DATA_CORRUPTION, auditReadMessages.corruption);
  }
  if (isPersistenceError(error) && error.code === persistenceErrorCodes.VALIDATION_FAILED) {
    return failure(AUDIT_READ_RULE_IDS.INPUT_INVALID, auditReadMessages.input);
  }
  return failure(AUDIT_READ_RULE_IDS.PERSISTENCE_FAILED, auditReadMessages.persistence);
}

function safeJsonScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" && value.length <= 500) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

const safeAuditMetadataKeys = new Set([
  "requestId",
  "runId",
  "generationRunId",
  "feedbackEventId",
  "draftRevisionId",
  "revisionNumber",
  "profileId",
  "sourceType",
  "changedField",
  "riskLevel",
  "status",
  "rulesVersion",
  "ruleIds",
  "profileUpdated",
  "rollbackTargetVersion",
  "changedSectionCount",
  "addedLineCount",
  "removedLineCount",
  "addedCharacterCount",
  "removedCharacterCount",
  "editBurdenRatio",
  "rationale",
  "mode",
  "providerId",
  "modelId",
  "promptVersion",
  "configurationKey",
  "caseId",
  "caseVersion",
  "datasetVersion",
  "safetyCoreVersion",
  "policyVersion",
  "errorType",
  "safetyCoreId",
  "feedbackRulesVersion",
  "failureTypes",
  "evaluationBatchId",
  "evaluationRunId",
  "evaluationResultId",
  "pairKey",
  "failureType",
  "failureRuleId",
  "attemptCount",
  "pairCount",
  "failureCount",
  "metricCount",
  "artifactType",
  "exportSchemaVersion",
  "matrixVersion",
  "profileVersion",
  "status",
]);

function safeAuditMetadata(metadata: JsonObject): SafeAuditEvent["metadata"] {
  const result: SafeAuditEvent["metadata"] = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!safeAuditMetadataKeys.has(key)) continue;
    const scalar = safeJsonScalar(value);
    if (scalar !== undefined) {
      result[key] = scalar;
      continue;
    }
    if (Array.isArray(value) && value.length <= 100) {
      const values = value.map(safeJsonScalar);
      if (values.every((item) => item !== undefined && (typeof item !== "string" || item.length <= 200))) {
        result[key] = values as Array<string | number | boolean>;
      }
    }
  }
  return result;
}

function safeAudit(event: AuditEventRecord): SafeAuditEvent {
  return safeAuditSchema.parse({
    id: event.id,
    eventType: event.eventType,
    actorId: event.actorId,
    simulatedRole: event.simulatedRole,
    entityType: event.entityType,
    entityId: event.entityId,
    ...(event.beforeVersion ? { beforeVersion: event.beforeVersion } : {}),
    ...(event.afterVersion ? { afterVersion: event.afterVersion } : {}),
    metadata: safeAuditMetadata(event.metadata),
    createdAt: event.createdAt,
  });
}

function safeProfileVersion(record: PhysicianProfileVersionRecord, persisted: boolean): SafeProfileVersion {
  return safeProfileVersionSchema.parse({
    profileId: record.profileId,
    version: record.version,
    status: record.status,
    synthetic: record.synthetic,
    preferences: record.preferences,
    ...(record.previousVersion === undefined ? {} : { previousVersion: record.previousVersion }),
    sourceType: record.sourceType,
    createdAt: record.createdAt,
    persisted,
  });
}

function seedProfileVersion(profileId: string): SafeProfileVersion {
  const seed = physicianProfiles.find((profile) => profile.id === profileId);
  if (!seed) throw new Error("Unknown seed profile.");
  return safeProfileVersionSchema.parse({
    profileId: seed.id,
    version: seed.version,
    status: seed.status,
    synthetic: true,
    preferences: seed.preferences,
    sourceType: "GIT_SEED",
    createdAt: `seed-${seedManifest.datasetVersion}`,
    persisted: false,
  });
}

function profileView(
  profileId: string,
  history: PhysicianProfileVersionRecord[],
): SafeProfile {
  const seed = physicianProfiles.find((profile) => profile.id === profileId);
  if (!seed) throw new Error("Unknown seed profile.");
  const persistedHistory = [...new Map(
    history.map((record) => [record.version, record]),
  ).values()]
    .sort((left, right) => left.version - right.version || left.createdAt.localeCompare(right.createdAt))
    .map((record) => safeProfileVersion(record, true));
  const versions = persistedHistory.length > 0 ? persistedHistory : [seedProfileVersion(profileId)];
  return safeProfileSchema.parse({
    id: seed.id,
    displayName: seed.displayName,
    synthetic: true,
    sourceNote: seed.sourceNote,
    seedBridged: persistedHistory.length > 0,
    current: versions[versions.length - 1],
    history: versions,
  });
}

function operationsForSection(section: DraftRevisionRecord["diffSummary"]["changedSections"][number]): DraftLineOperation[] {
  if ("operations" in section) return section.operations;
  return section.lineChanges.map((change) => ({
    operation: change.before !== undefined && change.after !== undefined
      ? "REWRITE" as const
      : change.before !== undefined ? "DELETE" as const : "ADD" as const,
    index: change.index,
    ...(change.before !== undefined ? { before: change.before } : {}),
    ...(change.after !== undefined ? { after: change.after } : {}),
  }));
}

function safeRevisionEvidence(
  revision: DraftRevisionRecord | undefined,
  event: FeedbackEventRecord,
): SafeFeedback["revisionEvidence"] {
  if (!revision) {
    return { operations: [], redacted: false, highRiskBodyStored: false };
  }
  const diff = draftRevisionDiffSummarySchema.parse(revision.diffSummary);
  const section = event.affectedField !== "sectionOrder" && event.affectedField !== "unknown"
    ? diff.changedSections.find((candidate) => candidate.key === event.affectedField)
    : undefined;
  const operations = section ? operationsForSection(section) : [];
  const containsPii = operations.some((operation) => scanSuspectedPii({ before: operation.before, after: operation.after }).length > 0);
  return safeRevisionEvidenceSchema.parse({
    ...(section ? { changedSectionKey: section.key } : {}),
    ...(diff.orderChanged ? { beforeSectionOrder: diff.beforeSectionOrder, afterSectionOrder: diff.afterSectionOrder } : {}),
    operations: operations.map((operation) => ({
      operation: operation.operation,
      index: operation.index,
      ...(containsPii ? {} : operation.before !== undefined ? { before: operation.before } : {}),
      ...(containsPii ? {} : operation.after !== undefined ? { after: operation.after } : {}),
    })),
    redacted: containsPii,
    highRiskBodyStored: false,
  });
}

function safeDecision(decision: ReviewDecisionRecord | undefined): SafeDecision | undefined {
  return decision
    ? safeDecisionSchema.parse({
        id: decision.id,
        feedbackEventId: decision.feedbackEventId,
        actorId: decision.actorId,
        simulatedRole: decision.simulatedRole,
        decision: decision.decision,
        rationale: decision.rationale,
        ...(decision.expectedProfileVersion === undefined ? {} : { expectedProfileVersion: decision.expectedProfileVersion }),
        createdAt: decision.createdAt,
      })
    : undefined;
}

function buildFeedbackView(
  event: FeedbackEventRecord,
  revision: DraftRevisionRecord | undefined,
  decision: ReviewDecisionRecord | undefined,
): SafeFeedback {
  const relationWarnings: string[] = [];
  if (event.draftRevisionId && !revision) relationWarnings.push(`DRAFT_REVISION:${event.draftRevisionId}`);
  const decisionView = safeDecision(decision);
  return safeFeedbackSchema.parse({
    id: event.id,
    generationRunId: event.generationRunId,
    ...(event.draftRevisionId ? { draftRevisionId: event.draftRevisionId } : {}),
    ...(event.revisionNumber === undefined ? {} : { revisionNumber: event.revisionNumber }),
    proposalId: event.proposalId,
    profileId: event.profileId,
    profileVersion: event.profileVersion,
    rulesVersion: event.rulesVersion,
    changeType: event.changeType,
    status: event.status,
    riskLevel: event.riskLevel,
    decision: event.decision,
    affectedField: event.affectedField,
    ruleHits: event.ruleHits,
    safetyReason: event.safetyReason,
    nextAllowedActions: event.nextAllowedActions,
    evidence: event.evidence,
    ...(event.candidatePatch ? { candidatePatch: event.candidatePatch } : {}),
    ...(decisionView ? { decisionRecord: decisionView } : {}),
    revisionEvidence: safeRevisionEvidence(revision, event),
    relationWarnings,
    createdAt: event.createdAt,
  });
}

function dedupeById<T extends { id: string }>(records: readonly T[]): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

export function listProfileReadModel(database: DatabaseSync): AuditReadResult<ProfileReadModel> {
  try {
    const repository = createPhysicianProfileVersionRepository(database);
    return {
      ok: true,
      data: { profiles: physicianProfiles.map((profile) => profileView(profile.id, repository.listHistory(profile.id))) },
    };
  } catch (error) {
    return mapReadError(error);
  }
}

export function listFeedbackReadModel(
  database: DatabaseSync,
  filter: FeedbackQuery = {},
): AuditReadResult<FeedbackReadModel> {
  try {
    const feedbackRepository = createFeedbackEventRepository(database);
    const revisionRepository = createDraftRevisionRepository(database);
    const decisionRepository = createReviewDecisionRepository(database);
    const events = dedupeById(feedbackRepository.listByStatusRisk(filter.status, filter.riskLevel))
      .filter((event) => filter.profileId === undefined || event.profileId === filter.profileId)
      .filter((event) => filter.feedbackEventId === undefined || event.id === filter.feedbackEventId)
      .map((event) => {
        const revision = event.draftRevisionId ? revisionRepository.getById(event.draftRevisionId) : undefined;
        const decision = decisionRepository.getByFeedbackEvent(event.id);
        return buildFeedbackView(event, revision, decision);
      })
      .filter((event) => filter.hasDecision === undefined || (event.decisionRecord !== undefined) === filter.hasDecision)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return { ok: true, data: { events } };
  } catch (error) {
    return mapReadError(error);
  }
}

function safeRun(run: GenerationRunRecord): SafeGenerationRun {
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    case: {
      id: run.inputCaseSnapshot.id,
      version: run.inputCaseSnapshot.version,
      specialty: run.inputCaseSnapshot.specialty,
      visitType: run.inputCaseSnapshot.visitType,
      title: run.inputCaseSnapshot.title,
      chiefConcern: run.inputCaseSnapshot.chiefConcern,
    },
    datasetVersion: run.datasetVersion,
    safetyCore: { id: run.safetyCoreId, version: run.safetyCoreVersion },
    policy: { id: run.policyId, version: run.policyVersion },
    ...(run.profileId ? { profileId: run.profileId } : {}),
    ...(run.profileVersion === undefined ? {} : { profileVersion: run.profileVersion }),
    configurationKey: run.configurationKey,
    provider: { id: run.providerId, modelId: run.modelId, promptVersion: run.promptVersion },
    hasOutputSnapshot: run.outputDraftSnapshot !== undefined,
    ...(run.errorType ? { errorType: run.errorType } : {}),
    createdAt: run.createdAt,
  };
}

function safeRevision(
  revision: DraftRevisionRecord,
  feedback: readonly FeedbackEventRecord[],
): SafeRevision {
  const diff = draftRevisionDiffSummarySchema.parse(revision.diffSummary);
  return safeRevisionSchema.parse({
    id: revision.id,
    generationRunId: revision.generationRunId,
    revisionNumber: revision.revisionNumber,
    editorId: revision.editorId,
    createdAt: revision.createdAt,
    orderChanged: diff.orderChanged,
    metrics: diff.metrics,
    changedSectionKeys: diff.changedSections.map((section) => section.key),
    feedbackEventIds: feedback.filter((event) => event.draftRevisionId === revision.id).map((event) => event.id),
  });
}

function expectedAuditPresent(
  audits: readonly AuditEventRecord[],
  entityType: string,
  entityId: string,
  eventTypes: readonly string[],
): boolean {
  return audits.some((audit) => audit.entityType === entityType && audit.entityId === entityId && eventTypes.includes(audit.eventType));
}

function metadataString(event: AuditEventRecord, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function auditGenerationRunId(event: AuditEventRecord): string | undefined {
  return metadataString(event, "generationRunId") ?? metadataString(event, "runId");
}

function isProfileVersionAuditForFeedback(
  audit: AuditEventRecord,
  feedbackEvent: FeedbackEventRecord,
): boolean {
  if (audit.eventType !== "PROFILE_VERSION_CREATED" || audit.entityId !== feedbackEvent.profileId) return false;
  if (metadataString(audit, "feedbackEventId") === feedbackEvent.id) return true;
  return metadataString(audit, "sourceType") === "CONFIRMED_FEEDBACK"
    && audit.beforeVersion === String(feedbackEvent.profileVersion)
    && audit.afterVersion === String(feedbackEvent.profileVersion + 1);
}

function collectTraceAudits(
  auditRepository: ReturnType<typeof createAuditEventRepository>,
  generationRunId: string,
  feedbackEvents: readonly FeedbackEventRecord[],
): AuditEventRecord[] {
  const byId = new Map<string, AuditEventRecord>();
  const add = (audit: AuditEventRecord): void => {
    const linkedRunId = auditGenerationRunId(audit);
    if (linkedRunId !== undefined && linkedRunId !== generationRunId) return;
    byId.set(audit.id, audit);
  };

  for (const audit of auditRepository.listByGenerationRun(generationRunId)) add(audit);
  for (const feedbackEvent of feedbackEvents) {
    for (const audit of auditRepository.listByEntity("FEEDBACK_EVENT", feedbackEvent.id)) add(audit);
    for (const audit of auditRepository.listByEntity("PHYSICIAN_PROFILE", feedbackEvent.profileId)) {
      if (isProfileVersionAuditForFeedback(audit, feedbackEvent)) add(audit);
    }
  }
  return [...byId.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function findAudit(
  audits: readonly AuditEventRecord[],
  entityType: string,
  entityId: string,
  eventType: string,
): AuditEventRecord | undefined {
  return audits.find((audit) => audit.entityType === entityType && audit.entityId === entityId && audit.eventType === eventType);
}

export function buildGenerationTrace(database: DatabaseSync, runId: string): GenerationTraceResult {
  if (!safeIdSchema.safeParse(runId).success) return failure(AUDIT_READ_RULE_IDS.INPUT_INVALID, auditReadMessages.input);
  try {
    const run = createGenerationRunRepository(database).getById(runId);
    if (!run) return failure(AUDIT_READ_RULE_IDS.RUN_NOT_FOUND, auditReadMessages.runNotFound);
    const revisionRepository = createDraftRevisionRepository(database);
    const feedbackRepository = createFeedbackEventRepository(database);
    const decisionRepository = createReviewDecisionRepository(database);
    const profileRepository = createPhysicianProfileVersionRepository(database);
    const auditRepository = createAuditEventRepository(database);
    const revisions = dedupeById(revisionRepository.listByGenerationRun(runId))
      .sort((left, right) => left.revisionNumber - right.revisionNumber || left.id.localeCompare(right.id));
    const feedbackEvents = dedupeById(feedbackRepository.listByGenerationRun(runId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const decisions = new Map<string, ReviewDecisionRecord | undefined>();
    for (const event of feedbackEvents) decisions.set(event.id, decisionRepository.getByFeedbackEvent(event.id));
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const feedback = feedbackEvents.map((event) => buildFeedbackView(
      event,
      event.draftRevisionId ? revisionById.get(event.draftRevisionId) : undefined,
      decisions.get(event.id),
    ));
    const safeRevisions = revisions.map((revision) => safeRevision(revision, feedbackEvents));
    const profileIds = [...new Set([
      ...(run.profileId ? [run.profileId] : []),
      ...feedbackEvents.map((event) => event.profileId),
    ])];
    const profiles = profileIds.map((profileId) => profileView(profileId, profileRepository.listHistory(profileId)));
    const rawAudits = collectTraceAudits(auditRepository, runId, feedbackEvents);
    const audits = rawAudits.map(safeAudit);
    const missingRelations: string[] = [];
    const runAuditTypes = run.status === "SUCCEEDED" ? ["GENERATION_RUN_SUCCEEDED"] : ["GENERATION_RUN_FAILED"];
    if (!expectedAuditPresent(rawAudits, "GENERATION_RUN", run.id, runAuditTypes)) missingRelations.push(`AUDIT:GENERATION_RUN:${run.id}`);
    for (const revision of revisions) {
      if (!expectedAuditPresent(rawAudits, "DRAFT_REVISION", revision.id, ["REVISION_SAVED"])) {
        missingRelations.push(`AUDIT:DRAFT_REVISION:${revision.id}`);
      }
    }
    for (const event of feedbackEvents) {
      if (!expectedAuditPresent(rawAudits, "FEEDBACK_EVENT", event.id, ["FEEDBACK_CLASSIFIED"])) {
        missingRelations.push(`AUDIT:FEEDBACK_EVENT:${event.id}`);
      }
      if (event.draftRevisionId && !revisionById.has(event.draftRevisionId)) missingRelations.push(`DRAFT_REVISION:${event.draftRevisionId}`);
      const decision = decisions.get(event.id);
      if (decision) {
        const expected = decision.decision === "CONFIRMED"
          ? "CANDIDATE_CONFIRMED"
          : decision.decision === "DISMISSED"
            ? "CANDIDATE_DISMISSED"
            : decision.decision === "APPROVED" ? "REVIEW_APPROVED" : "REVIEW_REJECTED";
        const decisionAudit = findAudit(rawAudits, "FEEDBACK_EVENT", event.id, expected);
        if (!decisionAudit) {
          missingRelations.push(`AUDIT:DECISION:${event.id}`);
        } else if (decision.decision === "CONFIRMED") {
          const beforeVersion = decisionAudit.beforeVersion;
          const afterVersion = decisionAudit.afterVersion;
          const profileVersion = afterVersion ? Number(afterVersion) : NaN;
          const profile = profiles.find((candidate) => candidate.id === event.profileId);
          const versionRecord = Number.isInteger(profileVersion)
            ? profile?.history.find((version) => version.version === profileVersion)
            : undefined;
          if (beforeVersion !== String(event.profileVersion) || !versionRecord || versionRecord.previousVersion !== event.profileVersion) {
            missingRelations.push(`PROFILE_VERSION:${event.profileId}@${afterVersion ?? "unknown"}`);
          }
          const profileAudit = Number.isInteger(profileVersion)
            ? rawAudits.find((audit) => audit.entityType === "PHYSICIAN_PROFILE"
              && audit.entityId === event.profileId
              && audit.eventType === "PROFILE_VERSION_CREATED"
              && audit.beforeVersion === String(event.profileVersion)
              && audit.afterVersion === String(profileVersion)
              && (metadataString(audit, "feedbackEventId") === event.id || metadataString(audit, "sourceType") === "CONFIRMED_FEEDBACK"))
            : undefined;
          if (!profileAudit) missingRelations.push(`AUDIT:PROFILE_VERSION_CREATED:${event.profileId}@${afterVersion ?? "unknown"}`);
        }
      }
    }
    for (const event of feedbackEvents) {
      if (!profiles.some((profile) => profile.id === event.profileId && profile.history.some((version) => version.version === event.profileVersion))) {
        missingRelations.push(`PROFILE:${event.profileId}@${event.profileVersion}`);
      }
    }
    if (run.profileId && run.profileVersion !== undefined
      && !profiles.some((profile) => profile.id === run.profileId && profile.history.some((version) => version.version === run.profileVersion))) {
      missingRelations.push(`PROFILE:${run.profileId}@${run.profileVersion}`);
    }
    return {
      ok: true,
      data: {
        runId,
        traceIntegrity: missingRelations.length > 0 ? "INCOMPLETE" : "COMPLETE",
        missingRelations: [...new Set(missingRelations)].sort(),
        run: safeRun(run),
        revisions: safeRevisions,
        feedback,
        profiles,
        audits,
        highRiskBodyStored: false,
      },
    };
  } catch (error) {
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
      return {
        ok: true,
        data: {
          runId,
          traceIntegrity: "CORRUPTED",
          missingRelations: ["TRACE_DATA"],
          revisions: [],
          feedback: [],
          profiles: [],
          audits: [],
          highRiskBodyStored: false,
        },
      };
    }
    return mapReadError(error);
  }
}

export function listAuditReadModel(
  database: DatabaseSync,
  filter: AuditEventQuery = {},
): AuditReadResult<AuditReadModel> {
  try {
    const page = createAuditEventRepository(database).listPage(filter);
    return {
      ok: true,
      data: {
        events: dedupeById(page.items).map(safeAudit),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
    };
  } catch (error) {
    return mapReadError(error);
  }
}

export function profileById(readModel: ProfileReadModel, profileId: string): SafeProfile | undefined {
  return readModel.profiles.find((profile) => profile.id === profileId);
}

export const auditReadDtoSchemas = {
  safeAuditSchema,
  safeDecisionSchema,
  safeFeedbackSchema,
  safeProfileSchema,
  safeProfileVersionSchema,
  safeRevisionSchema,
} as const;
