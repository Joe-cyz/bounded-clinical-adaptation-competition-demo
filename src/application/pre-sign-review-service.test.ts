import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createEncounter, transitionEncounter } from "./encounter-service";
import {
  confirmPhysicianRecord,
  enterPreSignReview,
  getPreSignReviewView,
  recordReviewItemDecision,
  type PreSignReviewIdKind,
} from "./pre-sign-review-service";
import { getPublicDemoMedicalRecord, saveMedicalRecord } from "./medical-record-service";
import { createManualSyntheticEncounter } from "./manual-synthetic-encounter-service";
import {
  encounterRecordRevisionSchema,
  encounterRecordSchema,
} from "@/domain/encounter";
import { parseEncounterRecordV1, type EncounterRecordV1 } from "@/domain/medical-record";
import { editableMedicalRecordPayloadOf } from "@/domain/medical-record-editing";
import {
  physicianConfirmationAuditMetadataSchema,
  preSignReviewCreatedAuditMetadataSchema,
  reviewItemDecisionAuditMetadataSchema,
} from "@/domain/pre-sign-review";
import { auditEventRecordSchema } from "@/domain/runtime-records";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import {
  createPhysicianConfirmationRepository,
  createPreSignReviewRepository,
  createReviewItemDecisionRepository,
} from "@/infrastructure/sqlite/repositories/pre-sign-review-repository";

const times = [
  "2026-08-21T00:00:00.000Z",
  "2026-08-21T00:00:01.000Z",
  "2026-08-21T00:00:02.000Z",
  "2026-08-21T00:00:03.000Z",
  "2026-08-21T00:00:04.000Z",
  "2026-08-21T00:00:05.000Z",
  "2026-08-21T00:00:06.000Z",
  "2026-08-21T00:00:07.000Z",
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createIds(prefix: string) {
  let audit = 0;
  return (kind: string) => {
    if (kind === "REVIEW") return `review-${prefix}-001`;
    if (kind === "DECISION") return `decision-${prefix}-${String(++audit).padStart(3, "0")}`;
    if (kind === "CONFIRMATION") return `confirmation-${prefix}-001`;
    return `review-audit-${prefix}-${String(++audit).padStart(3, "0")}`;
  };
}

function createEncounterFixture(database: DatabaseSync, prefix: string, record = getPublicDemoMedicalRecord().record) {
  const encounter = createEncounter({
    id: `encounter-review-${prefix}-001`,
    caseId: record.caseId,
    caseVersion: record.caseVersion,
    demographicSnapshot: { displayLabel: record.demographics.displayLabel, sex: "UNKNOWN", ageBand: "ADULT" },
  }, {
    database,
    runtimeMode: "local-research",
    clock: () => times[0],
    idFactory: (kind) => kind === "ENCOUNTER" ? `encounter-review-${prefix}-001` : `encounter-audit-${prefix}-001`,
  });
  const revisions = createEncounterRecordRevisionRepository(database);
  const first = encounterRecordRevisionSchema.parse({
    schemaVersion: "1.0.0",
    id: `record-revision-review-${prefix}-001`,
    encounterId: encounter.id,
    revisionNumber: 1,
    recordPayload: record,
    createdAt: times[0],
  });
  revisions.append(first);
  const transitionIds = createIds(`transition-${prefix}`);
  const recordSaved = transitionEncounter({
    encounterId: encounter.id,
    expectedStatus: encounter.status,
    expectedUpdatedAt: encounter.updatedAt,
    targetStatus: "RECORD_SAVED",
    currentRecordRevisionId: first.id,
  }, {
    database,
    runtimeMode: "local-research",
    clock: () => times[1],
    idFactory: transitionIds,
  });
  const referenceViewed = transitionEncounter({
    encounterId: encounter.id,
    expectedStatus: recordSaved.status,
    expectedUpdatedAt: recordSaved.updatedAt,
    targetStatus: "REFERENCE_VIEWED",
  }, {
    database,
    runtimeMode: "local-research",
    clock: () => times[2],
    idFactory: transitionIds,
  });
  return { encounter: referenceViewed, record, first };
}

function makeReadyRecord(): EncounterRecordV1 {
  const record = clone(getPublicDemoMedicalRecord().record);
  record.history.allergyHistory = { status: "NOT_APPLICABLE" };
  record.history.currentMedications = { status: "NOT_APPLICABLE" };
  record.history.redFlags = { status: "NOT_APPLICABLE" };
  record.history.pastHistory = { status: "PROVIDED", value: "无特殊既往史" };
  record.history.personalHistory = { status: "PROVIDED", value: "合成个人史已记录" };
  record.history.familyHistory = { status: "PROVIDED", value: "无特殊家族史" };
  record.physicalExam.vitalSigns = { status: "NOT_APPLICABLE" };
  record.physicalExam.generalCondition = { status: "NOT_APPLICABLE" };
  record.physicalExam.specialtyExam = { status: "NOT_APPLICABLE" };
  record.physicalExam.notExaminedOrUnknown = { status: "NOT_APPLICABLE" };
  record.auxiliaryExams = {
    laboratory: { status: "NOT_APPLICABLE" },
    electrocardiogram: { status: "NOT_APPLICABLE" },
    imaging: { status: "NOT_APPLICABLE" },
    other: { status: "NOT_APPLICABLE" },
  };
  record.missingInformation = { status: "NOT_APPLICABLE" };
  record.patientEducationFacts = { status: "NOT_APPLICABLE" };
  record.pendingInformation = [];
  return parseEncounterRecordV1(record);
}

function enterFixture(database: DatabaseSync, prefix: string, record?: EncounterRecordV1) {
  const fixture = createEncounterFixture(database, prefix, record);
  const result = enterPreSignReview({
    encounterId: fixture.encounter.id,
    expectedUpdatedAt: fixture.encounter.updatedAt,
    expectedCurrentRecordRevisionId: fixture.first.id,
  }, {
    database,
    runtimeMode: "local-research",
    clock: () => times[3],
    idFactory: createIds(prefix),
  });
  return { ...fixture, result };
}

describe("PWR-09 PreSignReviewService", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => times[0] });
  });

  afterEach(() => database.close());

  it("creates an immutable snapshot, advances once, and appends safe metadata atomically", () => {
    const fixture = enterFixture(database, "entry");
    expect(fixture.result.created).toBe(true);
    expect(fixture.result.encounter.status).toBe("REVIEW_PENDING");
    expect(createPreSignReviewRepository(database).getById(fixture.result.review.id)).toEqual(fixture.result.review);
    const audits = createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id);
    expect(audits.map((audit) => audit.eventType)).toEqual([
      "ENCOUNTER_CREATED",
      "ENCOUNTER_STATUS_CHANGED",
      "ENCOUNTER_STATUS_CHANGED",
      "ENCOUNTER_STATUS_CHANGED",
      "PRE_SIGN_REVIEW_CREATED",
    ]);
    expect(preSignReviewCreatedAuditMetadataSchema.safeParse(audits.at(-1)?.metadata).success).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("合成患者-01");
    expect(JSON.stringify(audits)).not.toContain("recordPayload");
  });

  it("keeps GET read-only and reuses a review for the same revision", () => {
    const fixture = enterFixture(database, "get");
    const beforeAudits = createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id);
    const view = getPreSignReviewView(fixture.encounter.id, { database, runtimeMode: "local-research" });
    const repeated = enterPreSignReview({
      encounterId: fixture.encounter.id,
      expectedUpdatedAt: fixture.result.encounter.updatedAt,
      expectedCurrentRecordRevisionId: fixture.first.id,
    }, { database, runtimeMode: "local-research", clock: () => times[4], idFactory: createIds("get-repeat") });
    expect(view.reviewId).toBe(fixture.result.review.id);
    expect(repeated.created).toBe(false);
    expect(createPreSignReviewRepository(database).listByEncounter(fixture.encounter.id)).toHaveLength(1);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id)).toHaveLength(beforeAudits.length);
  });

  it("loads a bound manual record into the existing immutable review snapshot", () => {
    let idNumber = 0;
    const created = createManualSyntheticEncounter({
      creationRequestId: "manual-request-review-servicez001",
      specialty: "内分泌科",
      visitType: "慢病复诊",
      sex: "FEMALE",
      age: 55,
    }, {
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clock: () => times[0],
      idFactory: (kind) => `manual-review-${kind.toLowerCase()}-${++idNumber}`,
    });
    let saveAuditNumber = 0;
    const saved = saveMedicalRecord({
      encounterId: created.encounter.id,
      expectedUpdatedAt: created.encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editableMedicalRecordPayloadOf(created.initialRecord),
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => times[1],
      idFactory: (kind) => kind === "RECORD_REVISION" ? "manual-review-record-001" : `manual-review-save-audit-${++saveAuditNumber}`,
    });
    const referenceViewed = transitionEncounter({
      encounterId: saved.encounter.id,
      expectedStatus: saved.encounter.status,
      expectedUpdatedAt: saved.encounter.updatedAt,
      targetStatus: "REFERENCE_VIEWED",
      currentRecordRevisionId: saved.revision.id,
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => times[2],
      idFactory: (kind) => `manual-review-transition-${kind.toLowerCase()}-001`,
    });

    const result = enterPreSignReview({
      encounterId: referenceViewed.id,
      expectedUpdatedAt: referenceViewed.updatedAt,
      expectedCurrentRecordRevisionId: saved.revision.id,
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => times[3],
      idFactory: createIds("manual-record"),
    });

    expect(result.created).toBe(true);
    expect(result.review.recordRevisionId).toBe(saved.revision.id);
    expect(result.review.items.length).toBeGreaterThan(0);
    expect(createPreSignReviewRepository(database).getById(result.review.id)?.encounterId).toBe(created.encounter.id);
  });

  it("invalidates an old revision and creates a new snapshot without repeating the status transition", () => {
    const fixture = enterFixture(database, "stale");
    const secondRecord = clone(fixture.record);
    secondRecord.history.presentIllness = { status: "PROVIDED", value: "更新后的合成现病史" };
    const second = encounterRecordRevisionSchema.parse({
      schemaVersion: "1.0.0",
      id: "record-revision-review-stale-002",
      encounterId: fixture.encounter.id,
      revisionNumber: 2,
      recordPayload: secondRecord,
      createdAt: times[4],
    });
    createEncounterRecordRevisionRepository(database).append(second, 1);
    const current = createEncounterRepository(database).getById(fixture.encounter.id);
    if (!current) throw new Error("fixture encounter missing");
    const rebound = encounterRecordSchema.parse({ ...current, currentRecordRevisionId: second.id, updatedAt: times[5] });
    createEncounterRepository(database).updateStatus(rebound, { status: current.status, updatedAt: current.updatedAt });

    const staleView = getPreSignReviewView(fixture.encounter.id, { database, runtimeMode: "local-research" });
    expect(staleView.isStale).toBe(true);
    expect(staleView.blockingCount).toBeGreaterThan(0);
    expect(() => confirmPhysicianRecord({
      encounterId: fixture.encounter.id,
      reviewId: fixture.result.review.id,
      expectedUpdatedAt: rebound.updatedAt,
      declarationAccepted: true,
    }, { database, runtimeMode: "local-research", clock: () => times[6], idFactory: createIds("stale-confirm") })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );

    const refreshed = enterPreSignReview({
      encounterId: fixture.encounter.id,
      expectedUpdatedAt: rebound.updatedAt,
      expectedCurrentRecordRevisionId: second.id,
    }, { database, runtimeMode: "local-research", clock: () => times[6], idFactory: createIds("stale-new") });
    expect(refreshed.created).toBe(true);
    expect(refreshed.review.recordRevisionId).toBe(second.id);
    expect(refreshed.encounter.status).toBe("REVIEW_PENDING");
    expect(createPreSignReviewRepository(database).listByEncounter(fixture.encounter.id)).toHaveLength(2);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id).filter((audit) => audit.eventType === "ENCOUNTER_STATUS_CHANGED")).toHaveLength(3);
  });

  it("allows only non-blocking decisions, validates reasons, and appends no reason to audit", () => {
    const fixture = enterFixture(database, "decision");
    const item = fixture.result.review.items.find((candidate) => !candidate.blocking);
    const blocking = fixture.result.review.items.find((candidate) => candidate.blocking);
    expect(item).toBeDefined();
    expect(blocking).toBeDefined();
    const before = createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id).length;

    expect(() => recordReviewItemDecision({
      encounterId: fixture.encounter.id,
      reviewId: fixture.result.review.id,
      itemId: blocking?.id,
      expectedUpdatedAt: fixture.result.encounter.updatedAt,
      decision: "CHECKED",
    }, { database, runtimeMode: "local-research", idFactory: createIds("blocking") })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    expect(() => recordReviewItemDecision({
      encounterId: fixture.encounter.id,
      reviewId: fixture.result.review.id,
      itemId: item?.id,
      expectedUpdatedAt: fixture.result.encounter.updatedAt,
      decision: "NOT_APPLICABLE",
      reason: "姓名：合成患者",
    }, { database, runtimeMode: "local-research", idFactory: createIds("pii-decision") })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.SUSPECTED_PII }),
    );
    expect(createReviewItemDecisionRepository(database).listByReview(fixture.result.review.id)).toHaveLength(0);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id)).toHaveLength(before);

    const accepted = recordReviewItemDecision({
      encounterId: fixture.encounter.id,
      reviewId: fixture.result.review.id,
      itemId: item?.id,
      expectedUpdatedAt: fixture.result.encounter.updatedAt,
      decision: "NOT_APPLICABLE",
      reason: "本次记录未涉及该项",
    }, { database, runtimeMode: "local-research", idFactory: createIds("decision-ok") });
    expect(accepted.decision.decision).toBe("NOT_APPLICABLE");
    const auditJson = JSON.stringify(createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id));
    expect(auditJson).not.toContain("本次记录未涉及该项");
    expect(reviewItemDecisionAuditMetadataSchema.safeParse(createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id).at(-1)?.metadata).success).toBe(true);
  });

  it("records one decision and one audit when the same pending item is submitted twice", () => {
    const fixture = enterFixture(database, "duplicate-decision");
    const item = fixture.result.review.items.find((candidate) => !candidate.blocking);
    if (!item) throw new Error("fixture has no pending review item");
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      idFactory: createIds("duplicate-decision-commit"),
    };
    const request = {
      encounterId: fixture.encounter.id,
      reviewId: fixture.result.review.id,
      itemId: item.id,
      expectedUpdatedAt: fixture.result.encounter.updatedAt,
      decision: "CHECKED" as const,
    };

    recordReviewItemDecision(request, dependencies);
    const decisions = createReviewItemDecisionRepository(database).listByReview(fixture.result.review.id);
    const decisionAudits = createAuditEventRepository(database)
      .listByEntity("ENCOUNTER", fixture.encounter.id)
      .filter((audit) => audit.eventType === "REVIEW_ITEM_DECISION_RECORDED");
    expect(decisions).toHaveLength(1);
    expect(decisionAudits).toHaveLength(1);

    expect(() => recordReviewItemDecision(request, dependencies)).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    expect(createReviewItemDecisionRepository(database).listByReview(fixture.result.review.id)).toHaveLength(1);
    expect(createAuditEventRepository(database)
      .listByEntity("ENCOUNTER", fixture.encounter.id)
      .filter((audit) => audit.eventType === "REVIEW_ITEM_DECISION_RECORDED")).toHaveLength(1);
  });

  it("confirms a ready record atomically and never changes the medical record payload confirmation flag", () => {
    const fixture = enterFixture(database, "confirm", makeReadyRecord());
    expect(fixture.result.review.items).toHaveLength(0);
    const result = confirmPhysicianRecord({
      encounterId: fixture.encounter.id,
      reviewId: fixture.result.review.id,
      expectedUpdatedAt: fixture.result.encounter.updatedAt,
      declarationAccepted: true,
    }, { database, runtimeMode: "local-research", clock: () => times[4], idFactory: createIds("confirm-ok") });
    expect(result.encounter.status).toBe("CONFIRMED");
    expect(createPhysicianConfirmationRepository(database).getByEncounter(fixture.encounter.id)).toEqual(result.confirmation);
    expect(encounterRecordSchema.parse(createEncounterRepository(database).getById(fixture.encounter.id)).status).toBe("CONFIRMED");
    expect(parseEncounterRecordV1(fixture.record).physicianConfirmationStatus).toBe("UNCONFIRMED");
    const audits = createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id);
    expect(audits.some((audit) => audit.eventType === "PHYSICIAN_CONFIRMATION_RECORDED")).toBe(true);
    expect(physicianConfirmationAuditMetadataSchema.safeParse(audits.at(-1)?.metadata).success).toBe(true);
  });

  it("rejects public-demo writes before a transaction and leaves all data unchanged", () => {
    const fixture = createEncounterFixture(database, "public");
    const audits = createAuditEventRepository(database);
    const before = audits.listByEntity("ENCOUNTER", fixture.encounter.id);
    expect(() => enterPreSignReview({
      encounterId: fixture.encounter.id,
      expectedUpdatedAt: fixture.encounter.updatedAt,
      expectedCurrentRecordRevisionId: fixture.first.id,
    }, { database, runtimeMode: "public-demo", idFactory: createIds("public") })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.RUNTIME_READ_ONLY }),
    );
    expect(database.isTransaction).toBe(false);
    expect(audits.listByEntity("ENCOUNTER", fixture.encounter.id)).toEqual(before);
    expect(createPreSignReviewRepository(database).listByEncounter(fixture.encounter.id)).toHaveLength(0);
  });

  it("rolls back confirmation, status and audit when the confirmation audit conflicts", () => {
    const fixture = enterFixture(database, "rollback", makeReadyRecord());
    const duplicateAuditId = "review-audit-confirm-rollback-duplicate";
    createAuditEventRepository(database).append(auditEventRecordSchema.parse({
      schemaVersion: "1.0.0",
      id: duplicateAuditId,
      eventType: "ENCOUNTER_CREATED",
      actorId: "fixture",
      simulatedRole: "SYSTEM",
      entityType: "ENCOUNTER",
      entityId: "other-encounter",
      afterVersion: "DRAFT",
      metadata: {
        encounterId: "other-encounter",
        caseId: "general-first-001",
        caseVersion: "0.4.1-001",
        synthetic: true,
        runtimeMode: "local-research",
      },
      createdAt: times[0],
    }));
    const ids = (kind: PreSignReviewIdKind) => kind === "AUDIT" ? duplicateAuditId : `confirmation-rollback-${kind.toLowerCase()}`;
    expect(() => confirmPhysicianRecord({
      encounterId: fixture.encounter.id,
      reviewId: fixture.result.review.id,
      expectedUpdatedAt: fixture.result.encounter.updatedAt,
      declarationAccepted: true,
    }, { database, runtimeMode: "local-research", clock: () => times[4], idFactory: ids })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    expect(createEncounterRepository(database).getById(fixture.encounter.id)?.status).toBe("REVIEW_PENDING");
    expect(createPhysicianConfirmationRepository(database).getByEncounter(fixture.encounter.id)).toBeUndefined();
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", fixture.encounter.id).some((audit) => audit.eventType === "PHYSICIAN_CONFIRMATION_RECORDED")).toBe(false);
  });

  it("serves public-demo review as a precomputed read-only view without a database", () => {
    const view = getPreSignReviewView("demo", { runtimeMode: "public-demo" });
    expect(view.readOnly).toBe(true);
    expect(view.encounterId).toBe("demo");
    expect(view.status).toBe("REVIEW_PENDING");
  });
});
