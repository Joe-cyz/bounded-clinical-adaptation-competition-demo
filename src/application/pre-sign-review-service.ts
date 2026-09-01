import "server-only";

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  advanceEncounterStatus,
  encounterStatusChangedAuditMetadataSchema,
  encounterSourceOf,
  type EncounterRecord,
} from "@/domain/encounter";
import {
  medicalRecordErrorCodes,
  MedicalRecordValidationError,
  parseEncounterRecordV1,
} from "@/domain/medical-record";
import {
  assertEncounterRecordPayloadBinding,
  EncounterRecordBindingError,
  parseEncounterRecordPayload,
  type EncounterRecordPayload,
} from "@/domain/manual-synthetic-record";
import {
  appRuntimeModeSchema,
  type AppRuntimeMode,
} from "@/domain/runtime-mode";
import {
  auditEventRecordSchema,
  isoUtcTimestampSchema,
  type AuditEventRecord,
  type JsonObject,
} from "@/domain/runtime-records";
import {
  applyReviewDecisions,
  createPreSignReview,
  physicianConfirmationAuditMetadataSchema,
  physicianConfirmationSchema,
  PHYSICIAN_CONFIRMATION_DISCLAIMER_VERSION,
  preSignReviewCreatedAuditMetadataSchema,
  preSignReviewPageViewSchema,
  PRE_SIGN_REVIEW_RULESET_VERSION,
  PreSignReviewValidationError,
  reviewItemDecisionAuditMetadataSchema,
  reviewItemDecisionSchema,
  reviewItemSchema,
  type PhysicianConfirmation,
  type PreSignReview,
  type PreSignReviewPageView,
  type ReviewItemDecision,
  type ReviewItem,
  type ReviewRuntimeMode,
} from "@/domain/pre-sign-review";
import { getPublicDemoMedicalRecord } from "./medical-record-service";
import { readRuntimeConfig, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import {
  isPersistenceError,
  persistenceErrorCodes,
  PersistenceError,
  validationError,
} from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import {
  createPhysicianConfirmationRepository,
  createPreSignReviewRepository,
  createReviewItemDecisionRepository,
} from "@/infrastructure/sqlite/repositories/pre-sign-review-repository";
import { createModelReferenceRepository } from "@/infrastructure/sqlite/repositories/model-reference-repository";
import { validateRuntimeRecord } from "@/infrastructure/sqlite/record-validation";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { createRandomSystemId } from "./system-id";

const safeRuntimeIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const reviewEntryRequestSchema = z.object({
  encounterId: safeRuntimeIdSchema,
  expectedUpdatedAt: isoUtcTimestampSchema,
  expectedCurrentRecordRevisionId: safeRuntimeIdSchema,
}).strict();
export type ReviewEntryRequest = z.infer<typeof reviewEntryRequestSchema>;

const reviewDecisionRequestSchema = z.object({
  encounterId: safeRuntimeIdSchema,
  reviewId: safeRuntimeIdSchema,
  itemId: z.string().min(1).max(200).regex(/^[a-z][a-z0-9-]*$/u),
  expectedUpdatedAt: isoUtcTimestampSchema,
  decision: z.enum(["CHECKED", "NOT_APPLICABLE"]),
  reason: z.string().max(200).optional(),
}).strict();
export type ReviewDecisionRequest = z.infer<typeof reviewDecisionRequestSchema>;

const physicianConfirmationRequestSchema = z.object({
  encounterId: safeRuntimeIdSchema,
  reviewId: safeRuntimeIdSchema,
  expectedUpdatedAt: isoUtcTimestampSchema,
  declarationAccepted: z.literal(true),
}).strict();
export type PhysicianConfirmationRequest = z.infer<typeof physicianConfirmationRequestSchema>;

export const PRESIGN_REVIEW_SERVICE_RULE_IDS = {
  ENCOUNTER_NOT_FOUND: "PRESIGN_REVIEW_ENCOUNTER_NOT_FOUND",
  SYNTHETIC_ONLY: "PRESIGN_REVIEW_SYNTHETIC_ONLY",
  RUNTIME_MODE_MISMATCH: "PRESIGN_REVIEW_RUNTIME_MODE_MISMATCH",
  STATUS_INVALID: "PRESIGN_REVIEW_STATUS_INVALID",
  STATUS_INSUFFICIENT: "PRESIGN_REVIEW_STATUS_INSUFFICIENT",
  CURRENT_REVISION_MISSING: "PRESIGN_REVIEW_CURRENT_REVISION_MISSING",
  CURRENT_REVISION_NOT_LATEST: "PRESIGN_REVIEW_CURRENT_REVISION_NOT_LATEST",
  REVISION_MISMATCH: "PRESIGN_REVIEW_REVISION_MISMATCH",
  REVIEW_NOT_FOUND: "PRESIGN_REVIEW_NOT_FOUND",
  REVIEW_STALE: "PRESIGN_REVIEW_STALE",
  REVIEW_ITEM_NOT_FOUND: "PRESIGN_REVIEW_ITEM_NOT_FOUND",
  DECISION_NOT_ALLOWED: "PRESIGN_REVIEW_DECISION_NOT_ALLOWED",
  DECISION_ALREADY_RECORDED: "PRESIGN_REVIEW_DECISION_ALREADY_RECORDED",
  CONFIRMATION_ALREADY_RECORDED: "PRESIGN_REVIEW_CONFIRMATION_ALREADY_RECORDED",
  CONFIRMATION_BLOCKED: "PRESIGN_REVIEW_CONFIRMATION_BLOCKED",
  DECLARATION_REQUIRED: "PRESIGN_REVIEW_DECLARATION_REQUIRED",
  DATA_CORRUPTION: "PRESIGN_REVIEW_DATA_CORRUPTION",
} as const;

export type PreSignReviewIdKind = "REVIEW" | "DECISION" | "CONFIRMATION" | "AUDIT";
export type PreSignReviewClock = () => string;
export type PreSignReviewIdFactory = (kind: PreSignReviewIdKind) => string;

export type PreSignReviewServiceDependencies = {
  database?: DatabaseSync;
  runtimeMode?: ReviewRuntimeMode;
  env?: NodeJS.ProcessEnv;
  clock?: PreSignReviewClock;
  idFactory?: PreSignReviewIdFactory;
  actorId?: string;
};

export type EnterPreSignReviewResult = {
  encounter: EncounterRecord;
  review: PreSignReview;
  created: boolean;
};

export type RecordReviewDecisionResult = {
  decision: ReviewItemDecision;
  review: PreSignReview;
};

export type ConfirmPhysicianRecordResult = {
  encounter: EncounterRecord;
  confirmation: PhysicianConfirmation;
};

const defaultClock: PreSignReviewClock = () => new Date().toISOString();
const defaultIdFactory: PreSignReviewIdFactory = (kind) => createRandomSystemId(`pre-sign-${kind.toLowerCase()}`);

function trustedRuntimeMode(dependencies: PreSignReviewServiceDependencies): AppRuntimeMode {
  if (dependencies.runtimeMode !== undefined) return appRuntimeModeSchema.parse(dependencies.runtimeMode);
  return readRuntimeConfig(dependencies.env).runtimeMode;
}

function assertWriteAllowed(dependencies: PreSignReviewServiceDependencies): AppRuntimeMode {
  const mode = trustedRuntimeMode(dependencies);
  if (mode === "public-demo") {
    throw new PersistenceError(
      persistenceErrorCodes.RUNTIME_READ_ONLY,
      PUBLIC_DEMO_READ_ONLY_MESSAGE,
      { ruleId: PUBLIC_DEMO_READ_ONLY },
    );
  }
  return mode;
}

function requireDatabase(dependencies: PreSignReviewServiceDependencies): DatabaseSync {
  if (dependencies.database === undefined) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "当前复核数据无法安全读取。",
      { ruleId: PRESIGN_REVIEW_SERVICE_RULE_IDS.DATA_CORRUPTION },
    );
  }
  return dependencies.database;
}

function nowIso(clock: PreSignReviewClock): string {
  const value = clock();
  if (!isoUtcTimestampSchema.safeParse(value).success) throw validationError("clock");
  return value;
}

function dataError(message = "当前复核数据无法安全读取。", fieldPath?: string): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.DATA_CORRUPTION,
    message,
    { ...(fieldPath ? { fieldPath } : {}), ruleId: PRESIGN_REVIEW_SERVICE_RULE_IDS.DATA_CORRUPTION },
  );
}

function notFoundError(): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.NOT_FOUND,
    "当前接诊不存在。",
    { fieldPath: "encounterId", ruleId: PRESIGN_REVIEW_SERVICE_RULE_IDS.ENCOUNTER_NOT_FOUND },
  );
}

function conflictError(message: string, ruleId: string, fieldPath?: string): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.CONFLICT,
    message,
    { ...(fieldPath ? { fieldPath } : {}), ruleId },
  );
}

function parseStoredMedicalRecord(payload: unknown): EncounterRecordPayload {
  try {
    return parseEncounterRecordV1(payload);
  } catch (error) {
    if (error instanceof MedicalRecordValidationError
      && error.code === medicalRecordErrorCodes.SUSPECTED_PII) {
      throw new PersistenceError(
        persistenceErrorCodes.SUSPECTED_PII,
        "当前病历无法安全读取。",
        { ruleId: medicalRecordErrorCodes.SUSPECTED_PII },
      );
    }
    try {
      return parseEncounterRecordPayload(payload);
    } catch {
      throw dataError("当前病历无法安全读取。", "recordPayload");
    }
  }
}

function currentLatestRecord(
  encounter: EncounterRecord,
  database: DatabaseSync,
): { record: EncounterRecordPayload; revisionId: string; revisionNumber: number } {
  if (encounter.currentRecordRevisionId === undefined) {
    throw dataError("当前接诊没有已绑定的病历修订。", "currentRecordRevisionId");
  }
  const latest = createEncounterRecordRevisionRepository(database).getLatestByEncounter(encounter.id);
  if (!latest) throw dataError("当前接诊没有已保存的病历修订。", "currentRecordRevisionId");
  if (latest.encounterId !== encounter.id) {
    throw conflictError("当前病历修订与接诊不匹配。", PRESIGN_REVIEW_SERVICE_RULE_IDS.REVISION_MISMATCH, "currentRecordRevisionId");
  }
  if (latest.id !== encounter.currentRecordRevisionId) {
    throw conflictError("当前病历修订已变化，请返回病历并重新保存。", PRESIGN_REVIEW_SERVICE_RULE_IDS.CURRENT_REVISION_NOT_LATEST, "currentRecordRevisionId");
  }
  const record = parseStoredMedicalRecord(latest.recordPayload);
  try {
    assertEncounterRecordPayloadBinding({
      encounter,
      source: encounterSourceOf(encounter),
      record,
    });
  } catch (error) {
    if (error instanceof EncounterRecordBindingError) {
      throw conflictError("当前病历修订与接诊来源不匹配。", PRESIGN_REVIEW_SERVICE_RULE_IDS.REVISION_MISMATCH, "source");
    }
    throw error;
  }
  return { record, revisionId: latest.id, revisionNumber: latest.revisionNumber };
}

/**
 * PWR-08C follow-ups are opt-in, immutable and revision-bound. They are only
 * projected into a newly created review snapshot; they never mutate the
 * record or automatically create a review decision.
 */
function selectedModelReferenceFollowUpItems(
  database: DatabaseSync,
  encounterId: string,
  recordRevisionId: string,
): ReviewItem[] {
  const references = createModelReferenceRepository(database);
  return references.listSelectedFollowUps(encounterId, recordRevisionId).flatMap((followUp) => {
    const run = references.getById(followUp.referenceId);
    if (!run || run.status !== "COMPLETED" || run.recordRevisionId !== recordRevisionId) return [];
    const item = references.listItems(run.referenceId).find((candidate) => candidate.id === followUp.itemId);
    if (!item || item.kind !== "NEEDS_VERIFICATION") return [];
    return [reviewItemSchema.parse({
      id: `review-model-reference-${followUp.followUpId.replace(/[^a-z0-9-]/gu, "-")}`,
      ruleId: "MODEL_REFERENCE_NEEDS_VERIFICATION",
      category: "PENDING_INFORMATION",
      title: `AI参考：${Array.from(item.text).slice(0, 100).join("")}`,
      status: "PENDING",
      blocking: false,
      source: "MODEL_REFERENCE",
      fieldPath: "modelReferenceFollowUps",
      evidenceCode: "MODEL_REFERENCE_NEEDS_VERIFICATION",
    })];
  });
}

function assertEncounterMode(encounter: EncounterRecord, runtimeMode: AppRuntimeMode): void {
  if (encounter.synthetic !== true) {
    throw conflictError("诊疗复核仅支持合成接诊。", PRESIGN_REVIEW_SERVICE_RULE_IDS.SYNTHETIC_ONLY, "encounterId");
  }
  if (encounter.runtimeMode !== runtimeMode) {
    throw conflictError("接诊运行模式与服务端配置不匹配。", PRESIGN_REVIEW_SERVICE_RULE_IDS.RUNTIME_MODE_MISMATCH);
  }
}

function assertExpectedEntryVersion(
  encounter: EncounterRecord,
  request: ReviewEntryRequest,
): void {
  if (encounter.updatedAt !== request.expectedUpdatedAt
    || encounter.currentRecordRevisionId !== request.expectedCurrentRecordRevisionId) {
    throw conflictError("当前接诊或病历修订已变化，请重新载入后再进入诊疗复核。", PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INVALID, "expectedUpdatedAt");
  }
}

function assertExpectedStatus(encounter: EncounterRecord, status: "REVIEW_PENDING"): void {
  if (encounter.status !== status) {
    throw conflictError("当前接诊状态不允许执行该复核操作。", PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INVALID, "status");
  }
}

function auditEvent(
  dependencies: PreSignReviewServiceDependencies,
  input: {
    eventType: "PRE_SIGN_REVIEW_CREATED" | "REVIEW_ITEM_DECISION_RECORDED" | "PHYSICIAN_CONFIRMATION_RECORDED" | "ENCOUNTER_STATUS_CHANGED";
    entityId: string;
    beforeVersion?: string;
    afterVersion?: string;
    metadata: JsonObject;
    createdAt: string;
  },
): AuditEventRecord {
  const metadata = input.eventType === "PRE_SIGN_REVIEW_CREATED"
    ? preSignReviewCreatedAuditMetadataSchema.parse(input.metadata)
    : input.eventType === "REVIEW_ITEM_DECISION_RECORDED"
      ? reviewItemDecisionAuditMetadataSchema.parse(input.metadata)
      : input.eventType === "PHYSICIAN_CONFIRMATION_RECORDED"
      ? physicianConfirmationAuditMetadataSchema.parse(input.metadata)
        : encounterStatusChangedAuditMetadataSchema.parse(input.metadata);
  return validateRuntimeRecord(auditEventRecordSchema, {
    schemaVersion: "1.0.0",
    id: (dependencies.idFactory ?? defaultIdFactory)("AUDIT"),
    eventType: input.eventType,
    actorId: dependencies.actorId ?? "physician-review-service",
    simulatedRole: "PHYSICIAN",
    entityType: "ENCOUNTER",
    entityId: input.entityId,
    ...(input.beforeVersion === undefined ? {} : { beforeVersion: input.beforeVersion }),
    ...(input.afterVersion === undefined ? {} : { afterVersion: input.afterVersion }),
    metadata,
    createdAt: input.createdAt,
  });
}

function reviewCreatedAudit(
  dependencies: PreSignReviewServiceDependencies,
  encounter: EncounterRecord,
  review: PreSignReview,
): AuditEventRecord {
  return auditEvent(dependencies, {
    eventType: "PRE_SIGN_REVIEW_CREATED",
    entityId: encounter.id,
    afterVersion: review.revisionNumber.toString(10),
    metadata: {
      encounterId: encounter.id,
      reviewId: review.id,
      recordRevisionId: review.recordRevisionId,
      revisionNumber: review.revisionNumber,
      rulesetVersion: review.rulesetVersion,
      blockingCount: review.blockingCount,
      pendingCount: review.pendingCount,
      synthetic: true,
      runtimeMode: encounter.runtimeMode,
    },
    createdAt: review.createdAt,
  });
}

function statusChangedAudit(
  dependencies: PreSignReviewServiceDependencies,
  encounter: EncounterRecord,
  next: EncounterRecord,
): AuditEventRecord {
  return auditEvent(dependencies, {
    eventType: "ENCOUNTER_STATUS_CHANGED",
    entityId: encounter.id,
    beforeVersion: encounter.status,
    afterVersion: next.status,
    metadata: {
      encounterId: encounter.id,
      caseId: encounter.caseId,
      caseVersion: encounter.caseVersion,
      synthetic: true,
      runtimeMode: encounter.runtimeMode,
      fromStatus: encounter.status,
      toStatus: next.status,
    },
    createdAt: next.updatedAt,
  });
}

function publicReviewView(): PreSignReviewPageView {
  const publicRecord = getPublicDemoMedicalRecord();
  const review = createPreSignReview({
    id: "public-demo-review",
    encounterId: "demo",
    recordRevisionId: "public-demo-revision",
    revisionNumber: 1,
    record: publicRecord.record,
    createdAt: publicRecord.expectedUpdatedAt,
  });
  return preSignReviewPageViewSchema.parse({
    schemaVersion: "1.0.0",
    mode: "public-demo",
    readOnly: true,
    encounterId: "demo",
    encounterLabel: publicRecord.record.demographics.displayLabel,
    status: "REVIEW_PENDING",
    reviewId: review.id,
    recordRevisionId: review.recordRevisionId,
    reviewRevisionNumber: review.revisionNumber,
    currentRevisionNumber: review.revisionNumber,
    expectedUpdatedAt: publicRecord.expectedUpdatedAt,
    rulesetVersion: PRE_SIGN_REVIEW_RULESET_VERSION,
    items: review.items,
    blockingCount: review.blockingCount,
    pendingCount: review.pendingCount,
    isStale: false,
  });
}

function buildReviewPageView(
  mode: AppRuntimeMode,
  encounter: EncounterRecord,
  review: PreSignReview,
  decisions: readonly ReviewItemDecision[],
  currentRevisionNumber: number,
  confirmation?: PhysicianConfirmation,
): PreSignReviewPageView {
  let applied = applyReviewDecisions(review, decisions);
  const isStale = review.recordRevisionId !== encounter.currentRecordRevisionId;
  if (isStale) {
    applied = {
      ...applied,
      items: [
        ...applied.items,
        {
          id: "review-item-current-revision-not-latest",
          ruleId: "CURRENT_REVISION_LATEST_REQUIRED",
          category: "REQUIRED",
          title: "当前病历已有更新修订",
          status: "BLOCKING",
          blocking: true,
          source: "MEDICAL_RECORD",
          fieldPath: "currentRecordRevisionId",
          evidenceCode: "CURRENT_REVISION_NOT_LATEST",
        },
      ],
      summary: {
        ...applied.summary,
        blockingCount: applied.summary.blockingCount + 1,
      },
    };
  }
  return preSignReviewPageViewSchema.parse({
    schemaVersion: "1.0.0",
    mode,
    readOnly: mode === "public-demo",
    encounterId: encounter.id,
    encounterLabel: encounter.demographicSnapshot.displayLabel,
    status: encounter.status,
    reviewId: review.id,
    recordRevisionId: review.recordRevisionId,
    reviewRevisionNumber: review.revisionNumber,
    currentRevisionNumber,
    expectedUpdatedAt: encounter.updatedAt,
    rulesetVersion: review.rulesetVersion,
    items: applied.items,
    blockingCount: applied.summary.blockingCount,
    pendingCount: applied.summary.pendingCount,
    isStale,
    ...(confirmation === undefined ? {} : {
      confirmation: {
        id: confirmation.id,
        confirmedAt: confirmation.confirmedAt,
        revisionNumber: confirmation.revisionNumber,
        disclaimerVersion: confirmation.disclaimerVersion,
      },
    }),
  });
}

export function enterPreSignReview(
  value: unknown,
  dependencies: PreSignReviewServiceDependencies,
): EnterPreSignReviewResult {
  const runtimeMode = assertWriteAllowed(dependencies);
  const request = validateRuntimeRecord(reviewEntryRequestSchema, value);
  const database = requireDatabase(dependencies);
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const encounters = createEncounterRepository(database);
  const reviews = createPreSignReviewRepository(database);
  const audit = createAuditEventRepository(database);

  return withTransaction(database, () => {
    const encounter = encounters.getById(request.encounterId);
    if (!encounter) throw notFoundError();
    assertEncounterMode(encounter, runtimeMode);
    assertExpectedEntryVersion(encounter, request);
    if (encounter.status !== "REFERENCE_VIEWED" && encounter.status !== "REVIEW_PENDING") {
      throw conflictError(
        encounter.status === "CONFIRMED" ? "记录已完成，不能重新打开诊疗复核。" : "请先从诊疗参考进入复核。",
        encounter.status === "CONFIRMED" ? PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INVALID : PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INSUFFICIENT,
        "status",
      );
    }
    const latest = currentLatestRecord(encounter, database);
    if (latest.revisionId !== request.expectedCurrentRecordRevisionId) {
      throw conflictError("当前病历修订已变化，请重新载入后再进入诊疗复核。", PRESIGN_REVIEW_SERVICE_RULE_IDS.CURRENT_REVISION_NOT_LATEST, "currentRecordRevisionId");
    }

    const existing = reviews.getByEncounterRevision(encounter.id, latest.revisionId);
    if (existing) return { encounter, review: existing, created: false };

    const createdAt = nowIso(clock);
    const review = createPreSignReview({
      id: idFactory("REVIEW"),
      encounterId: encounter.id,
      recordRevisionId: latest.revisionId,
      revisionNumber: latest.revisionNumber,
      record: latest.record,
      additionalItems: selectedModelReferenceFollowUpItems(database, encounter.id, latest.revisionId),
      createdAt,
    });
    let nextEncounter = encounter;
    let statusAudit: AuditEventRecord | undefined;
    if (encounter.status === "REFERENCE_VIEWED") {
      try {
        nextEncounter = advanceEncounterStatus(encounter, "REVIEW_PENDING", createdAt, {
          currentRecordRevisionId: latest.revisionId,
        });
      } catch {
        throw conflictError("当前接诊状态无法进入诊疗复核。", PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INVALID, "status");
      }
      statusAudit = statusChangedAudit(dependencies, encounter, nextEncounter);
      encounters.updateStatus(nextEncounter, {
        status: encounter.status,
        updatedAt: encounter.updatedAt,
      });
    }
    reviews.insert(review);
    audit.append(reviewCreatedAudit(dependencies, nextEncounter, review));
    if (statusAudit) audit.append(statusAudit);
    return { encounter: nextEncounter, review, created: true };
  });
}

export function getPreSignReviewView(
  encounterId: string,
  dependencies: PreSignReviewServiceDependencies = {},
): PreSignReviewPageView {
  const parsedId = safeRuntimeIdSchema.safeParse(encounterId);
  if (!parsedId.success) throw validationError("encounterId");
  const runtimeMode = trustedRuntimeMode(dependencies);
  if (runtimeMode === "public-demo") {
    if (parsedId.data !== "demo") throw notFoundError();
    return publicReviewView();
  }

  const database = requireDatabase(dependencies);
  const encounters = createEncounterRepository(database);
  const encounter = encounters.getById(parsedId.data);
  if (!encounter) throw notFoundError();
  assertEncounterMode(encounter, runtimeMode);
  if (encounter.status !== "REVIEW_PENDING" && encounter.status !== "CONFIRMED") {
    throw conflictError("请先从诊疗参考进入诊疗复核。", PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INSUFFICIENT, "status");
  }
  const latest = currentLatestRecord(encounter, database);
  const reviews = createPreSignReviewRepository(database).listByEncounter(encounter.id);
  const review = reviews
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  if (!review) throw dataError("当前接诊缺少复核快照。", "reviewId");
  if (review.encounterId !== encounter.id) throw dataError("复核快照与接诊不匹配。", "reviewId");

  const decisions = createReviewItemDecisionRepository(database).listByReview(review.id);
  let confirmation: PhysicianConfirmation | undefined;
  if (encounter.status === "CONFIRMED") {
    confirmation = createPhysicianConfirmationRepository(database).getByEncounter(encounter.id);
    if (!confirmation) throw dataError("已完成接诊缺少医生确认记录。", "confirmationId");
    if (confirmation.reviewId !== review.id || confirmation.recordRevisionId !== latest.revisionId) {
      throw dataError("医生确认与当前复核修订不匹配。", "reviewId");
    }
  }
  return buildReviewPageView(runtimeMode, encounter, review, decisions, latest.revisionNumber, confirmation);
}

export function recordReviewItemDecision(
  value: unknown,
  dependencies: PreSignReviewServiceDependencies,
): RecordReviewDecisionResult {
  const runtimeMode = assertWriteAllowed(dependencies);
  const request = validateRuntimeRecord(reviewDecisionRequestSchema, value);
  const database = requireDatabase(dependencies);
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const encounters = createEncounterRepository(database);
  const reviews = createPreSignReviewRepository(database);
  const decisions = createReviewItemDecisionRepository(database);
  const audit = createAuditEventRepository(database);

  return withTransaction(database, () => {
    const encounter = encounters.getById(request.encounterId);
    if (!encounter) throw notFoundError();
    assertEncounterMode(encounter, runtimeMode);
    assertExpectedStatus(encounter, "REVIEW_PENDING");
    if (encounter.updatedAt !== request.expectedUpdatedAt) {
      throw conflictError("当前复核页面已过期，请重新载入。", PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INVALID, "expectedUpdatedAt");
    }
    const latest = currentLatestRecord(encounter, database);
    const review = reviews.getById(request.reviewId);
    if (!review || review.encounterId !== encounter.id) throw notFoundError();
    if (review.recordRevisionId !== latest.revisionId) {
      throw conflictError("病历已有新修订，请返回病历并重新进入复核。", PRESIGN_REVIEW_SERVICE_RULE_IDS.REVIEW_STALE, "reviewId");
    }
    const item = review.items.find((candidate) => candidate.id === request.itemId);
    if (!item) {
      throw new PersistenceError(
        persistenceErrorCodes.NOT_FOUND,
        "该待核对项不存在。",
        { fieldPath: "itemId", ruleId: PRESIGN_REVIEW_SERVICE_RULE_IDS.REVIEW_ITEM_NOT_FOUND },
      );
    }
    if (item.blocking) {
      throw conflictError("必填项不能在复核页直接解除，请返回病历补充。", PRESIGN_REVIEW_SERVICE_RULE_IDS.DECISION_NOT_ALLOWED, "itemId");
    }
    if (decisions.getByReviewItem(review.id, item.id)) {
      throw conflictError("该待核对项已经处理。", PRESIGN_REVIEW_SERVICE_RULE_IDS.DECISION_ALREADY_RECORDED, "itemId");
    }
    const decision = reviewItemDecisionSchema.parse({
      schemaVersion: "1.0.0",
      id: idFactory("DECISION"),
      reviewId: review.id,
      itemId: item.id,
      decision: request.decision,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      actorId: dependencies.actorId ?? "physician",
      simulatedRole: "PHYSICIAN",
      createdAt: nowIso(clock),
    });
    try {
      const validatedDecision = validateRuntimeRecord(reviewItemDecisionSchema, decision);
      if (validatedDecision.reason !== undefined) {
        // The shared persistence validator performs the PII scan without echoing the reason.
        // Parsing again through the domain helper keeps the boundary explicit for callers.
        const safeDecision = validateRuntimeRecord(reviewItemDecisionSchema, validatedDecision);
        decisions.insert(safeDecision);
        audit.append(auditEvent(dependencies, {
          eventType: "REVIEW_ITEM_DECISION_RECORDED",
          entityId: encounter.id,
          afterVersion: safeDecision.decision,
          metadata: {
            encounterId: encounter.id,
            reviewId: review.id,
            itemId: item.id,
            decision: safeDecision.decision,
            synthetic: true,
            runtimeMode: encounter.runtimeMode,
          },
          createdAt: safeDecision.createdAt,
        }));
        return { decision: safeDecision, review };
      }
      decisions.insert(validatedDecision);
      audit.append(auditEvent(dependencies, {
        eventType: "REVIEW_ITEM_DECISION_RECORDED",
        entityId: encounter.id,
        afterVersion: validatedDecision.decision,
        metadata: {
          encounterId: encounter.id,
          reviewId: review.id,
          itemId: item.id,
          decision: validatedDecision.decision,
          synthetic: true,
          runtimeMode: encounter.runtimeMode,
        },
        createdAt: validatedDecision.createdAt,
      }));
      return { decision: validatedDecision, review };
    } catch (error) {
      if (error instanceof PreSignReviewValidationError) throw validationError("reason");
      throw error;
    }
  });
}

export function confirmPhysicianRecord(
  value: unknown,
  dependencies: PreSignReviewServiceDependencies,
): ConfirmPhysicianRecordResult {
  const runtimeMode = assertWriteAllowed(dependencies);
  const request = validateRuntimeRecord(physicianConfirmationRequestSchema, value);
  const database = requireDatabase(dependencies);
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const encounters = createEncounterRepository(database);
  const reviews = createPreSignReviewRepository(database);
  const decisions = createReviewItemDecisionRepository(database);
  const confirmations = createPhysicianConfirmationRepository(database);
  const audit = createAuditEventRepository(database);

  return withTransaction(database, () => {
    const encounter = encounters.getById(request.encounterId);
    if (!encounter) throw notFoundError();
    assertEncounterMode(encounter, runtimeMode);
    assertExpectedStatus(encounter, "REVIEW_PENDING");
    if (encounter.updatedAt !== request.expectedUpdatedAt) {
      throw conflictError("当前复核页面已过期，请重新载入。", PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INVALID, "expectedUpdatedAt");
    }
    const latest = currentLatestRecord(encounter, database);
    const review = reviews.getById(request.reviewId);
    if (!review || review.encounterId !== encounter.id) throw notFoundError();
    if (review.recordRevisionId !== latest.revisionId) {
      throw conflictError("病历已有新修订，请返回病历并重新进入复核。", PRESIGN_REVIEW_SERVICE_RULE_IDS.REVIEW_STALE, "reviewId");
    }
    if (confirmations.getByEncounter(encounter.id)) {
      throw conflictError("该接诊已经完成确认，不能重复确认。", PRESIGN_REVIEW_SERVICE_RULE_IDS.CONFIRMATION_ALREADY_RECORDED, "encounterId");
    }
    const reviewDecisions = decisions.listByReview(review.id);
    let summary;
    try {
      summary = applyReviewDecisions(review, reviewDecisions).summary;
    } catch {
      throw dataError("当前复核决定无法安全读取。", "reviewItemDecisions");
    }
    if (summary.blockingCount !== 0 || summary.pendingCount !== 0) {
      throw conflictError(
        summary.blockingCount !== 0 ? "仍有必填项未完成。" : "仍有待核对项未处理。",
        PRESIGN_REVIEW_SERVICE_RULE_IDS.CONFIRMATION_BLOCKED,
        "reviewId",
      );
    }

    const confirmedAt = nowIso(clock);
    const confirmation = physicianConfirmationSchema.parse({
      schemaVersion: "1.0.0",
      id: idFactory("CONFIRMATION"),
      encounterId: encounter.id,
      reviewId: review.id,
      recordRevisionId: latest.revisionId,
      revisionNumber: latest.revisionNumber,
      decisionSummary: summary,
      disclaimerVersion: PHYSICIAN_CONFIRMATION_DISCLAIMER_VERSION,
      actorId: dependencies.actorId ?? "physician",
      simulatedRole: "PHYSICIAN",
      confirmedAt,
    });
    confirmations.insert(confirmation);
    let next: EncounterRecord;
    try {
      next = advanceEncounterStatus(encounter, "CONFIRMED", confirmedAt, {
        currentRecordRevisionId: latest.revisionId,
      });
    } catch {
      throw conflictError("当前接诊无法完成确认。", PRESIGN_REVIEW_SERVICE_RULE_IDS.STATUS_INVALID, "status");
    }
    encounters.updateStatus(next, { status: encounter.status, updatedAt: encounter.updatedAt });
    audit.append(statusChangedAudit(dependencies, encounter, next));
    audit.append(auditEvent(dependencies, {
      eventType: "PHYSICIAN_CONFIRMATION_RECORDED",
      entityId: encounter.id,
      afterVersion: next.status,
      metadata: {
        encounterId: encounter.id,
        confirmationId: confirmation.id,
        reviewId: review.id,
        recordRevisionId: latest.revisionId,
        revisionNumber: latest.revisionNumber,
        blockingCount: 0,
        pendingCount: 0,
        synthetic: true,
        runtimeMode: encounter.runtimeMode,
      },
      createdAt: confirmedAt,
    }));
    return { encounter: next, confirmation };
  });
}

export function reviewAccessMessage(error: unknown, mode: AppRuntimeMode): string {
  if (isPersistenceError(error)) {
    if (error.code === persistenceErrorCodes.NOT_FOUND) return "当前接诊不存在，请返回接诊入口。";
    if (error.code === persistenceErrorCodes.CONFLICT && error.fieldPath === "status") return "请先从诊疗参考进入诊疗复核。";
    if (error.code === persistenceErrorCodes.RUNTIME_READ_ONLY || mode === "public-demo") return "公开演示仅提供只读复核预览。";
    if (error.code === persistenceErrorCodes.CONFLICT) return error.message;
  }
  return mode === "public-demo" ? "只读复核预览暂时不可用。" : "当前复核暂时无法安全读取，请返回诊疗参考后重试。";
}

export function actionErrorMessage(error: unknown): { message: string; code?: string } {
  if (!isPersistenceError(error)) return { message: "复核操作未完成，请重新载入后重试。" };
  switch (error.code) {
    case persistenceErrorCodes.RUNTIME_READ_ONLY:
      return { message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
    case persistenceErrorCodes.NOT_FOUND:
      return { message: "当前接诊或待核对项不存在。", code: "NOT_FOUND" };
    case persistenceErrorCodes.CONFLICT:
      return { message: error.message, code: error.ruleId ?? "CONFLICT" };
    case persistenceErrorCodes.SUSPECTED_PII:
      return { message: "理由未通过安全校验，请移除身份信息后重试。", code: "REVIEW_REASON_SUSPECTED_PII" };
    case persistenceErrorCodes.VALIDATION_FAILED:
      return { message: "复核输入未通过校验，请检查后重试。", code: "VALIDATION_FAILED" };
    default:
      return { message: "复核操作未完成，请重新载入后重试。", code: error.code };
  }
}
