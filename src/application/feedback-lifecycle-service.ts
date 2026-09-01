import type { DatabaseSync } from "node:sqlite";

import { physicianProfiles } from "@/data/seed-loader";
import {
  feedbackEventRecordSchema,
  physicianProfileVersionRecordSchema,
  reviewDecisionRecordSchema,
  type FeedbackEventRecord,
  type GenerationRunRecord,
  type PhysicianProfileVersionRecord,
  type ReviewDecisionRecord,
  type JsonObject,
} from "@/domain/runtime-records";
import { physicianPreferenceSchema, type PhysicianProfile } from "@/domain/schemas";
import { extractFeedbackProposals, type FeedbackExtractionContext, type FeedbackProposal } from "@/domain/risk-gate";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createFeedbackEventRepository } from "@/infrastructure/sqlite/repositories/feedback-event-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import { createReviewDecisionRepository } from "@/infrastructure/sqlite/repositories/review-decision-repository";
import { isPersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { isoUtcTimestampSchema } from "@/domain/runtime-records";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { z } from "zod";
import { createRandomSystemId } from "./system-id";

export const FEEDBACK_ACTION_RULE_IDS = {
  INPUT_INVALID: "FEEDBACK_INPUT_INVALID",
  NOT_FOUND: "FEEDBACK_NOT_FOUND",
  RUN_NOT_FOUND: "FEEDBACK_RUN_NOT_FOUND",
  STATUS_INVALID: "FEEDBACK_STATUS_INVALID",
  ROLE_FORBIDDEN: "FEEDBACK_ROLE_FORBIDDEN",
  DECISION_CONFLICT: "FEEDBACK_DECISION_CONFLICT",
  PROFILE_NOT_FOUND: "FEEDBACK_PROFILE_NOT_FOUND",
  PROFILE_VERSION_CONFLICT: "FEEDBACK_PROFILE_VERSION_CONFLICT",
  PROFILE_FROZEN: "FEEDBACK_PROFILE_FROZEN",
  PROFILE_ARCHIVED: "FEEDBACK_PROFILE_ARCHIVED",
  PATCH_INVALID: "FEEDBACK_PATCH_INVALID",
  RATIONALE_INVALID: "FEEDBACK_RATIONALE_INVALID",
  DATA_CORRUPTION: "FEEDBACK_DATA_CORRUPTION",
  PERSISTENCE_FAILED: "FEEDBACK_PERSISTENCE_FAILED",
  RUNTIME_READ_ONLY: "PUBLIC_DEMO_READ_ONLY",
} as const;

export type FeedbackActionRuleId = (typeof FEEDBACK_ACTION_RULE_IDS)[keyof typeof FEEDBACK_ACTION_RULE_IDS];

const safeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const candidateActionRequestSchema = z.object({
  feedbackEventId: safeIdSchema,
  expectedProfileVersion: z.number().int().positive().max(100_000),
}).strict();
export const reviewFeedbackRequestSchema = z.object({
  feedbackEventId: safeIdSchema,
  decision: z.enum(["APPROVE", "REJECT"]),
  rationale: z.string().trim().min(1).max(500),
}).strict();
export const freezeProfileRequestSchema = z.object({
  profileId: safeIdSchema,
  expectedProfileVersion: z.number().int().positive().max(100_000),
  confirmation: z.literal("FREEZE_PROFILE"),
}).strict();
export const rollbackProfileRequestSchema = z.object({
  profileId: safeIdSchema,
  targetVersion: z.number().int().positive().max(100_000),
  expectedProfileVersion: z.number().int().positive().max(100_000),
  confirmation: z.literal("ROLLBACK_PROFILE"),
}).strict();

type FeedbackAuditActor = {
  actorId: "demo-physician" | "demo-reviewer";
  simulatedRole: "PHYSICIAN" | "REVIEWER";
};

class FeedbackDomainError extends Error {
  readonly ruleId: FeedbackActionRuleId;

  constructor(ruleId: FeedbackActionRuleId, message: string) {
    super(message);
    this.name = "FeedbackDomainError";
    this.ruleId = ruleId;
  }
}

export type FeedbackActionFailure = {
  ok: false;
  ruleId: FeedbackActionRuleId;
  message: string;
};
export type ConfirmCandidateSuccess = {
  ok: true;
  action: "CONFIRMED";
  feedbackEvent: FeedbackEventRecord;
  decision: ReviewDecisionRecord;
  profileVersion: PhysicianProfileVersionRecord;
};
export type DismissCandidateSuccess = {
  ok: true;
  action: "DISMISSED";
  feedbackEvent: FeedbackEventRecord;
  decision: ReviewDecisionRecord;
};
export type ReviewFeedbackSuccess = {
  ok: true;
  action: "APPROVED" | "REJECTED";
  feedbackEvent: FeedbackEventRecord;
  decision: ReviewDecisionRecord;
  profileUpdated: false;
};
export type ProfileActionSuccess = {
  ok: true;
  profileVersion: PhysicianProfileVersionRecord;
};

export type FeedbackIdKind = "DECISION" | "AUDIT" | "PROFILE" | "FEEDBACK";
export type FeedbackIdFactory = (kind: FeedbackIdKind) => string;
export type FeedbackClock = () => string;

export type FeedbackLifecycleDependencies = {
  database: DatabaseSync;
  clock?: FeedbackClock;
  idFactory?: FeedbackIdFactory;
};

const defaultIdFactory: FeedbackIdFactory = (kind) => createRandomSystemId(`feedback-${kind.toLowerCase()}`);
const messages = {
  input: "反馈动作未通过服务端输入校验。",
  notFound: "未找到反馈事件。",
  runNotFound: "反馈绑定的生成运行不存在。",
  status: "反馈当前状态不允许执行该动作。",
  role: "模拟角色无权执行该反馈动作。",
  conflict: "反馈决定或画像版本已变化，请重新载入。",
  profileNotFound: "未找到版本化合成医生画像。",
  frozen: "FROZEN 画像可以生成，但不能继续更新。",
  archived: "ARCHIVED 画像不能生成或更新。",
  patch: "候选 patch 不是受允许的 sectionOrder 白名单。",
  rationale: "审核理由不能为空且不得超过 500 个字符。",
  corruption: "反馈、决定或画像数据损坏，未返回原始内容。",
  persistence: "反馈生命周期持久化失败，已回滚。",
} as const;

function nowIso(clock: FeedbackClock): string {
  const value = clock();
  return isoUtcTimestampSchema.safeParse(value).success ? value : new Date().toISOString();
}

function failure(ruleId: FeedbackActionRuleId, message: string): FeedbackActionFailure {
  return { ok: false, ruleId, message };
}

function isFeedbackActionFailure(value: unknown): value is FeedbackActionFailure {
  return typeof value === "object"
    && value !== null
    && "ok" in value
    && (value as { ok?: unknown }).ok === false;
}

function profileFromSeed(profileId: string): PhysicianProfile | undefined {
  return physicianProfiles.find((profile) => profile.id === profileId);
}

function assertSectionOrderPatch(
  profile: PhysicianProfileVersionRecord,
  event: Pick<FeedbackEventRecord, "candidatePatch">,
): PhysicianProfileVersionRecord["preferences"] | undefined {
  if (!event.candidatePatch || event.candidatePatch.type !== "sectionOrder") return undefined;
  const nextOrder = event.candidatePatch.sectionOrder;
  const currentOrder = profile.preferences.sectionOrder;
  if (nextOrder.length !== currentOrder.length || new Set(nextOrder).size !== nextOrder.length) return undefined;
  const currentSet = new Set(currentOrder);
  if (nextOrder.some((key) => !currentSet.has(key))) return undefined;
  const parsed = physicianPreferenceSchema.safeParse({ ...profile.preferences, sectionOrder: nextOrder });
  return parsed.success ? parsed.data : undefined;
}

function isValidSectionOrderCandidate(event: FeedbackEventRecord): boolean {
  const expectedActions = new Set(["CONFIRM_CANDIDATE", "DISMISS_CANDIDATE"]);
  return event.riskLevel === "LOW"
    && event.status === "CANDIDATE"
    && event.decision === "PENDING"
    && event.changeType === "REORDER"
    && event.affectedField === "sectionOrder"
    && event.ruleHits.length === 1
    && event.ruleHits[0] === "LOW_WHITELIST_SECTION_ORDER"
    && event.nextAllowedActions.length === expectedActions.size
    && event.nextAllowedActions.every((action) => expectedActions.has(action))
    && event.candidatePatch?.type === "sectionOrder";
}

function appendAudit(
  database: DatabaseSync,
  idFactory: FeedbackIdFactory,
  clock: FeedbackClock,
  input: {
    actor: FeedbackAuditActor;
    eventType: string;
    entityType: string;
    entityId: string;
    beforeVersion?: string;
    afterVersion?: string;
    metadata: JsonObject;
  },
): void {
  createAuditEventRepository(database).append({
    schemaVersion: "1.0.0",
    id: idFactory("AUDIT"),
    eventType: input.eventType,
    actorId: input.actor.actorId,
    simulatedRole: input.actor.simulatedRole,
    entityType: input.entityType,
    entityId: input.entityId,
    ...(input.beforeVersion ? { beforeVersion: input.beforeVersion } : {}),
    ...(input.afterVersion ? { afterVersion: input.afterVersion } : {}),
    metadata: input.metadata,
    createdAt: nowIso(clock),
  });
}

export function feedbackEventFromProposal(
  proposal: FeedbackProposal,
  id: string,
  createdAt: string,
): FeedbackEventRecord {
  return feedbackEventRecordSchema.parse({
    schemaVersion: "1.0.0",
    id,
    ...proposal,
    createdAt,
  });
}

export function classifyRevisionFeedback(
  revision: Parameters<typeof extractFeedbackProposals>[0],
  context: FeedbackExtractionContext,
): ReturnType<typeof extractFeedbackProposals> {
  return extractFeedbackProposals(revision, context);
}

type LoadedFeedbackActionContext = {
  event: FeedbackEventRecord;
  run: GenerationRunRecord;
  decision?: ReviewDecisionRecord;
};

function getEventAndDecision(database: DatabaseSync, feedbackEventId: string): LoadedFeedbackActionContext | FeedbackActionFailure {
  try {
    const event = createFeedbackEventRepository(database).getById(feedbackEventId);
    if (!event) return failure(FEEDBACK_ACTION_RULE_IDS.NOT_FOUND, messages.notFound);
    const run = createGenerationRunRepository(database).getById(event.generationRunId);
    if (!run) return failure(FEEDBACK_ACTION_RULE_IDS.RUN_NOT_FOUND, messages.runNotFound);
    const decision = createReviewDecisionRepository(database).getByFeedbackEvent(feedbackEventId);
    return { event, run, ...(decision ? { decision } : {}) };
  } catch (error) {
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
      return failure(FEEDBACK_ACTION_RULE_IDS.DATA_CORRUPTION, messages.corruption);
    }
    return failure(FEEDBACK_ACTION_RULE_IDS.PERSISTENCE_FAILED, messages.persistence);
  }
}

function buildSeedBaseline(
  profileId: string,
  clock: FeedbackClock,
): PhysicianProfileVersionRecord | FeedbackActionFailure {
  const seed = profileFromSeed(profileId);
  if (!seed) return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_NOT_FOUND, messages.profileNotFound);
  const baseline = {
    schemaVersion: "1.0.0" as const,
    profileId: seed.id,
    version: 1,
    status: seed.status,
    synthetic: true as const,
    preferences: seed.preferences,
    sourceType: "SEED",
    createdAt: nowIso(clock),
  };
  return physicianProfileVersionRecordSchema.parse(baseline);
}

function readProfileOrSeed(
  profileId: string,
  clock: FeedbackClock,
  profileRepository: ReturnType<typeof createPhysicianProfileVersionRepository>,
): { profile: PhysicianProfileVersionRecord; seeded: boolean } | FeedbackActionFailure {
  const current = profileRepository.getLatest(profileId);
  if (current) return { profile: current, seeded: false };
  const baseline = buildSeedBaseline(profileId, clock);
  if (isFeedbackActionFailure(baseline)) return baseline;
  return { profile: baseline, seeded: true };
}

function throwDomainFailure(ruleId: FeedbackActionRuleId, message: string): never {
  throw new FeedbackDomainError(ruleId, message);
}

function requireLoadedEvent(
  database: DatabaseSync,
  feedbackEventId: string,
): LoadedFeedbackActionContext {
  const loaded = getEventAndDecision(database, feedbackEventId);
  if (isFeedbackActionFailure(loaded)) throwDomainFailure(loaded.ruleId, loaded.message);
  return loaded;
}

function actionTransactionError(error: unknown): FeedbackActionFailure {
  if (error instanceof FeedbackDomainError) return failure(error.ruleId, error.message);
  if (isPersistenceError(error)) {
    if (error.code === persistenceErrorCodes.DATA_CORRUPTION) return failure(FEEDBACK_ACTION_RULE_IDS.DATA_CORRUPTION, messages.corruption);
    if (error.code === persistenceErrorCodes.PROFILE_VERSION_CONFLICT) return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
    if (error.code === persistenceErrorCodes.CONFLICT) return failure(FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT, messages.conflict);
  }
  return failure(FEEDBACK_ACTION_RULE_IDS.PERSISTENCE_FAILED, messages.persistence);
}

export function confirmCandidateAction(
  input: unknown,
  dependencies: FeedbackLifecycleDependencies,
): ConfirmCandidateSuccess | FeedbackActionFailure {
  const parsed = candidateActionRequestSchema.safeParse(input);
  if (!parsed.success) return failure(FEEDBACK_ACTION_RULE_IDS.INPUT_INVALID, messages.input);
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const loaded = getEventAndDecision(dependencies.database, parsed.data.feedbackEventId);
  if (isFeedbackActionFailure(loaded)) return loaded;
  if (!("event" in loaded)) return failure(FEEDBACK_ACTION_RULE_IDS.NOT_FOUND, messages.notFound);
  const { event, decision: existingDecision } = loaded;
  if (existingDecision) return failure(FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT, messages.conflict);
  if (event.riskLevel !== "LOW" || event.status !== "CANDIDATE" || event.decision !== "PENDING" || !event.candidatePatch) {
    return failure(event.riskLevel === "HIGH" ? FEEDBACK_ACTION_RULE_IDS.ROLE_FORBIDDEN : FEEDBACK_ACTION_RULE_IDS.STATUS_INVALID, messages.status);
  }

  const profiles = createPhysicianProfileVersionRepository(dependencies.database);
  try {
    const initial = readProfileOrSeed(event.profileId, clock, profiles);
    if (isFeedbackActionFailure(initial)) return initial;
    if (event.profileId !== initial.profile.profileId
      || event.profileVersion !== parsed.data.expectedProfileVersion
      || initial.profile.version !== parsed.data.expectedProfileVersion) {
      return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
    }
    if (initial.profile.status === "FROZEN") return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_FROZEN, messages.frozen);
    if (initial.profile.status === "ARCHIVED") return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_ARCHIVED, messages.archived);
    if (!isValidSectionOrderCandidate(event)) return failure(FEEDBACK_ACTION_RULE_IDS.PATCH_INVALID, messages.patch);
    if (!assertSectionOrderPatch(initial.profile, event)) return failure(FEEDBACK_ACTION_RULE_IDS.PATCH_INVALID, messages.patch);

    return withTransaction(dependencies.database, () => {
      const txLoaded = requireLoadedEvent(dependencies.database, parsed.data.feedbackEventId);
      if (txLoaded.decision) throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT, messages.conflict);
      const txEvent = txLoaded.event;
      if (!isValidSectionOrderCandidate(txEvent)) throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PATCH_INVALID, messages.patch);

      const latest = profiles.getLatest(txEvent.profileId);
      if ((initial.seeded && latest) || (!initial.seeded && !latest)) {
        throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
      }
      const current = latest ?? initial.profile;
      if (txEvent.profileId !== current.profileId
        || txEvent.profileVersion !== parsed.data.expectedProfileVersion
        || current.version !== parsed.data.expectedProfileVersion) {
        throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
      }
      if (current.status === "FROZEN") throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_FROZEN, messages.frozen);
      if (current.status === "ARCHIVED") throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_ARCHIVED, messages.archived);
      const preferences = assertSectionOrderPatch(current, txEvent);
      if (!preferences) throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PATCH_INVALID, messages.patch);
      if (!latest) profiles.append(current);

      const profileVersion = physicianProfileVersionRecordSchema.parse({
        schemaVersion: "1.0.0",
        profileId: current.profileId,
        version: current.version + 1,
        status: "ACTIVE",
        synthetic: true,
        preferences,
        previousVersion: current.version,
        sourceType: "CONFIRMED_FEEDBACK",
        createdAt: nowIso(clock),
      });
      const reviewDecision = reviewDecisionRecordSchema.parse({
        schemaVersion: "1.0.0",
        id: idFactory("DECISION"),
        feedbackEventId: txEvent.id,
        actorId: "demo-physician",
        simulatedRole: "PHYSICIAN",
        decision: "CONFIRMED",
        rationale: "医生明确确认 sectionOrder 候选。",
        expectedProfileVersion: parsed.data.expectedProfileVersion,
        createdAt: nowIso(clock),
      });
      profiles.append(profileVersion, current.version);
      createReviewDecisionRepository(dependencies.database).append(reviewDecision);
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-physician", simulatedRole: "PHYSICIAN" },
        eventType: "CANDIDATE_CONFIRMED",
        entityType: "FEEDBACK_EVENT",
        entityId: txEvent.id,
        beforeVersion: String(current.version),
        afterVersion: String(profileVersion.version),
        metadata: { generationRunId: txLoaded.run.id, feedbackEventId: txEvent.id, profileId: current.profileId, rulesVersion: txEvent.rulesVersion, ruleIds: txEvent.ruleHits },
      });
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-physician", simulatedRole: "PHYSICIAN" },
        eventType: "PROFILE_VERSION_CREATED",
        entityType: "PHYSICIAN_PROFILE",
        entityId: current.profileId,
        beforeVersion: String(current.version),
        afterVersion: String(profileVersion.version),
        metadata: {
          generationRunId: txLoaded.run.id,
          feedbackEventId: txEvent.id,
          profileId: current.profileId,
          sourceType: profileVersion.sourceType,
          changedField: "sectionOrder",
        },
      });
      return { ok: true, action: "CONFIRMED" as const, feedbackEvent: txEvent, decision: reviewDecision, profileVersion };
    });
  } catch (error) {
    return actionTransactionError(error);
  }
}

export function dismissCandidateAction(
  input: unknown,
  dependencies: FeedbackLifecycleDependencies,
): DismissCandidateSuccess | FeedbackActionFailure {
  const parsed = candidateActionRequestSchema.safeParse(input);
  if (!parsed.success) return failure(FEEDBACK_ACTION_RULE_IDS.INPUT_INVALID, messages.input);
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const loaded = getEventAndDecision(dependencies.database, parsed.data.feedbackEventId);
  if (isFeedbackActionFailure(loaded)) return loaded;
  if (!("event" in loaded)) return failure(FEEDBACK_ACTION_RULE_IDS.NOT_FOUND, messages.notFound);
  const { event, decision: existingDecision } = loaded;
  if (existingDecision) return failure(FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT, messages.conflict);
  if (event.riskLevel !== "LOW" || event.status !== "CANDIDATE" || event.decision !== "PENDING") {
    return failure(FEEDBACK_ACTION_RULE_IDS.STATUS_INVALID, messages.status);
  }
  if (parsed.data.expectedProfileVersion !== event.profileVersion) {
    return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
  }
  const decision = reviewDecisionRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: idFactory("DECISION"),
    feedbackEventId: event.id,
    actorId: "demo-physician",
    simulatedRole: "PHYSICIAN",
    decision: "DISMISSED",
    rationale: "医生放弃该候选，不更新画像。",
    expectedProfileVersion: event.profileVersion,
    createdAt: nowIso(clock),
  });
  try {
    return withTransaction(dependencies.database, () => {
      const txLoaded = requireLoadedEvent(dependencies.database, parsed.data.feedbackEventId);
      if (txLoaded.decision) throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT, messages.conflict);
      if (txLoaded.event.profileVersion !== parsed.data.expectedProfileVersion
        || txLoaded.event.riskLevel !== "LOW"
        || txLoaded.event.status !== "CANDIDATE"
        || txLoaded.event.decision !== "PENDING") {
        throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
      }
      createReviewDecisionRepository(dependencies.database).append(decision);
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-physician", simulatedRole: "PHYSICIAN" },
        eventType: "CANDIDATE_DISMISSED",
        entityType: "FEEDBACK_EVENT",
        entityId: txLoaded.event.id,
        metadata: { generationRunId: txLoaded.run.id, feedbackEventId: txLoaded.event.id, profileId: txLoaded.event.profileId, rulesVersion: txLoaded.event.rulesVersion, ruleIds: txLoaded.event.ruleHits },
      });
      return { ok: true, action: "DISMISSED" as const, feedbackEvent: txLoaded.event, decision };
    });
  } catch (error) {
    return actionTransactionError(error);
  }
}

export function reviewFeedbackAction(
  input: unknown,
  dependencies: FeedbackLifecycleDependencies,
): ReviewFeedbackSuccess | FeedbackActionFailure {
  const parsed = reviewFeedbackRequestSchema.safeParse(input);
  if (!parsed.success) return failure(FEEDBACK_ACTION_RULE_IDS.RATIONALE_INVALID, messages.rationale);
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const loaded = getEventAndDecision(dependencies.database, parsed.data.feedbackEventId);
  if (isFeedbackActionFailure(loaded)) return loaded;
  if (!("event" in loaded)) return failure(FEEDBACK_ACTION_RULE_IDS.NOT_FOUND, messages.notFound);
  const { event, decision: existingDecision } = loaded;
  if (existingDecision) return failure(FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT, messages.conflict);
  if ((event.riskLevel !== "MEDIUM" && event.riskLevel !== "UNCERTAIN") || event.status !== "HELD_FOR_REVIEW") {
    return failure(FEEDBACK_ACTION_RULE_IDS.ROLE_FORBIDDEN, messages.role);
  }
  if (scanSuspectedPii(parsed.data.rationale).length > 0) {
    return failure(FEEDBACK_ACTION_RULE_IDS.RATIONALE_INVALID, messages.rationale);
  }
  const decisionValue: "APPROVED" | "REJECTED" = parsed.data.decision === "REJECT" ? "REJECTED" : "APPROVED";
  const decisionResult = reviewDecisionRecordSchema.safeParse({
    schemaVersion: "1.0.0",
    id: idFactory("DECISION"),
    feedbackEventId: event.id,
    actorId: "demo-reviewer",
    simulatedRole: "REVIEWER",
    decision: decisionValue,
    rationale: parsed.data.rationale,
    createdAt: nowIso(clock),
  });
  if (!decisionResult.success) return failure(FEEDBACK_ACTION_RULE_IDS.RATIONALE_INVALID, messages.rationale);
  const decision = decisionResult.data;
  try {
    return withTransaction(dependencies.database, () => {
      const txLoaded = requireLoadedEvent(dependencies.database, parsed.data.feedbackEventId);
      if (txLoaded.decision) throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.DECISION_CONFLICT, messages.conflict);
      if ((txLoaded.event.riskLevel !== "MEDIUM" && txLoaded.event.riskLevel !== "UNCERTAIN") || txLoaded.event.status !== "HELD_FOR_REVIEW") {
        throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.ROLE_FORBIDDEN, messages.role);
      }
      createReviewDecisionRepository(dependencies.database).append(decision);
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-reviewer", simulatedRole: "REVIEWER" },
        eventType: decision.decision === "APPROVED" ? "REVIEW_APPROVED" : "REVIEW_REJECTED",
        entityType: "FEEDBACK_EVENT",
        entityId: txLoaded.event.id,
        metadata: {
          generationRunId: txLoaded.run.id,
          feedbackEventId: txLoaded.event.id,
          riskLevel: txLoaded.event.riskLevel,
          rulesVersion: txLoaded.event.rulesVersion,
          ruleIds: txLoaded.event.ruleHits,
          rationale: decision.rationale,
          profileUpdated: false,
        },
      });
      return { ok: true, action: decisionValue, feedbackEvent: txLoaded.event, decision, profileUpdated: false as const };
    });
  } catch (error) {
    return actionTransactionError(error);
  }
}

export function freezeProfileAction(
  input: unknown,
  dependencies: FeedbackLifecycleDependencies,
): ProfileActionSuccess | FeedbackActionFailure {
  const parsed = freezeProfileRequestSchema.safeParse(input);
  if (!parsed.success) return failure(FEEDBACK_ACTION_RULE_IDS.INPUT_INVALID, messages.input);
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const profiles = createPhysicianProfileVersionRepository(dependencies.database);
  try {
    const initial = readProfileOrSeed(parsed.data.profileId, clock, profiles);
    if (isFeedbackActionFailure(initial)) return initial;
    if (initial.profile.version !== parsed.data.expectedProfileVersion) {
      return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
    }
    if (initial.profile.status === "FROZEN") return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_FROZEN, messages.frozen);
    if (initial.profile.status === "ARCHIVED") return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_ARCHIVED, messages.archived);

    return withTransaction(dependencies.database, () => {
      const latest = profiles.getLatest(parsed.data.profileId);
      if ((initial.seeded && latest) || (!initial.seeded && !latest)) {
        throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
      }
      const current = latest ?? initial.profile;
      if (current.version !== parsed.data.expectedProfileVersion) {
        throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
      }
      if (current.status === "FROZEN") throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_FROZEN, messages.frozen);
      if (current.status === "ARCHIVED") throwDomainFailure(FEEDBACK_ACTION_RULE_IDS.PROFILE_ARCHIVED, messages.archived);
      if (!latest) profiles.append(current);
      const frozen = physicianProfileVersionRecordSchema.parse({
        schemaVersion: "1.0.0" as const,
        profileId: current.profileId,
        version: current.version + 1,
        status: "FROZEN" as const,
        synthetic: true as const,
        preferences: current.preferences,
        previousVersion: current.version,
        sourceType: "FROZEN",
        createdAt: nowIso(clock),
      });
      profiles.append(frozen, current.version);
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-reviewer", simulatedRole: "REVIEWER" },
        eventType: "PROFILE_FROZEN",
        entityType: "PHYSICIAN_PROFILE",
        entityId: current.profileId,
        beforeVersion: String(current.version),
        afterVersion: String(frozen.version),
        metadata: { profileId: current.profileId, sourceType: frozen.sourceType },
      });
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-reviewer", simulatedRole: "REVIEWER" },
        eventType: "PROFILE_VERSION_CREATED",
        entityType: "PHYSICIAN_PROFILE",
        entityId: current.profileId,
        beforeVersion: String(current.version),
        afterVersion: String(frozen.version),
        metadata: { sourceType: frozen.sourceType },
      });
      return { ok: true, profileVersion: frozen };
    });
  } catch (error) {
    return actionTransactionError(error);
  }
}

export function rollbackProfileAction(
  input: unknown,
  dependencies: FeedbackLifecycleDependencies,
): ProfileActionSuccess | FeedbackActionFailure {
  const parsed = rollbackProfileRequestSchema.safeParse(input);
  if (!parsed.success) return failure(FEEDBACK_ACTION_RULE_IDS.INPUT_INVALID, messages.input);
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const profiles = createPhysicianProfileVersionRepository(dependencies.database);
  try {
    return withTransaction(dependencies.database, () => {
      const current = profiles.getLatest(parsed.data.profileId);
      if (!current) return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_NOT_FOUND, messages.profileNotFound);
      if (current.version !== parsed.data.expectedProfileVersion) return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_VERSION_CONFLICT, messages.conflict);
      if (current.status === "FROZEN") return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_FROZEN, messages.frozen);
      if (current.status === "ARCHIVED") return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_ARCHIVED, messages.archived);
      const target = profiles.get(parsed.data.profileId, parsed.data.targetVersion);
      if (!target) return failure(FEEDBACK_ACTION_RULE_IDS.PROFILE_NOT_FOUND, messages.profileNotFound);
      const rolledBack = {
        schemaVersion: "1.0.0" as const,
        profileId: current.profileId,
        version: current.version + 1,
        status: "ACTIVE" as const,
        synthetic: true as const,
        preferences: target.preferences,
        previousVersion: current.version,
        sourceType: "ROLLBACK",
        createdAt: nowIso(clock),
      };
      profiles.append(rolledBack, current.version);
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-reviewer", simulatedRole: "REVIEWER" },
        eventType: "PROFILE_ROLLED_BACK",
        entityType: "PHYSICIAN_PROFILE",
        entityId: current.profileId,
        beforeVersion: String(current.version),
        afterVersion: String(rolledBack.version),
        metadata: { profileId: current.profileId, rollbackTargetVersion: target.version },
      });
      appendAudit(dependencies.database, idFactory, clock, {
        actor: { actorId: "demo-reviewer", simulatedRole: "REVIEWER" },
        eventType: "PROFILE_VERSION_CREATED",
        entityType: "PHYSICIAN_PROFILE",
        entityId: current.profileId,
        beforeVersion: String(current.version),
        afterVersion: String(rolledBack.version),
        metadata: { sourceType: rolledBack.sourceType, rollbackTargetVersion: target.version },
      });
      return { ok: true, profileVersion: rolledBack };
    });
  } catch (error) {
    return actionTransactionError(error);
  }
}
