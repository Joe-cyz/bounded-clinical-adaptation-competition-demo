import "server-only";

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { findSyntheticMedicalRecord } from "@/data/seed-loader";
import {
  advanceEncounterStatus,
  encounterRecordRevisionSchema,
  encounterRecordSchema,
  encounterStatusChangedAuditMetadataSchema,
  encounterStatusSchema,
  encounterSourceOf,
  type EncounterRecord,
  type EncounterStatus,
} from "@/domain/encounter";
import {
  MEDICAL_RECORD_DATA_VERSION,
  MEDICAL_RECORD_SCHEMA_VERSION,
  MEDICAL_RECORD_SOURCE_DATASET_VERSION,
  medicalRecordErrorCodes,
  MedicalRecordValidationError,
  parseEncounterRecordV1,
  type EncounterRecordV1,
} from "@/domain/medical-record";
import {
  createManualSyntheticInitialRecord,
  parseEncounterRecordPayload,
  type EncounterRecordPayload,
  type ManualSyntheticRecordV1,
} from "@/domain/manual-synthetic-record";
import {
  medicalRecordEditablePayloadSchema,
  type MedicalRecordEditablePayload,
} from "@/domain/medical-record-editing";
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";
import {
  auditEventRecordSchema,
  isoUtcTimestampSchema,
  type AuditEventRecord,
  type JsonObject,
} from "@/domain/runtime-records";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import {
  isPersistenceError,
  persistenceErrorCodes,
  PersistenceError,
  validationError,
} from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { createManualSyntheticIntakeRepository } from "@/infrastructure/sqlite/repositories/manual-synthetic-intake-repository";
import { projectPhysicianPatientDisplayName } from "./physician-patient-display-name";
import { validateRuntimeRecord } from "@/infrastructure/sqlite/record-validation";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { createRandomSystemId } from "./system-id";

const safeRuntimeIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const fieldStatusCountSchema = z.object({
  PROVIDED: z.number().int().nonnegative().max(10_000),
  UNKNOWN: z.number().int().nonnegative().max(10_000),
  NOT_APPLICABLE: z.number().int().nonnegative().max(10_000),
  PENDING_PHYSICIAN_CONFIRMATION: z.number().int().nonnegative().max(10_000),
}).strict();

/**
 * A deliberately closed audit shape. It records workflow and aggregate
 * facts only; it cannot carry a demographic value or any record正文.
 */
export const medicalRecordRevisionSavedAuditMetadataSchema = z.object({
  encounterId: safeRuntimeIdSchema,
  revisionId: safeRuntimeIdSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  previousRevisionNumber: z.number().int().nonnegative().max(100_000),
  fromStatus: encounterStatusSchema,
  toStatus: encounterStatusSchema,
  fieldStatusCounts: fieldStatusCountSchema,
  savedAt: isoUtcTimestampSchema,
  synthetic: z.literal(true),
  runtimeMode: appRuntimeModeSchema,
}).strict();

export type MedicalRecordRevisionSavedAuditMetadata = z.infer<
  typeof medicalRecordRevisionSavedAuditMetadataSchema
>;

export const saveMedicalRecordRequestSchema = z.object({
  encounterId: safeRuntimeIdSchema,
  expectedUpdatedAt: isoUtcTimestampSchema,
  expectedCurrentRecordRevisionId: safeRuntimeIdSchema.optional(),
  expectedRevisionNumber: z.number().int().nonnegative().max(100_000),
  editableRecord: medicalRecordEditablePayloadSchema,
}).strict();

export type SaveMedicalRecordRequest = z.infer<typeof saveMedicalRecordRequestSchema>;

export type MedicalRecordIdKind = "RECORD_REVISION" | "AUDIT";
export type MedicalRecordIdFactory = (kind: MedicalRecordIdKind) => string;
export type MedicalRecordClock = () => string;
export type MedicalRecordResolver = (
  caseId: string,
  caseVersion: string,
) => EncounterRecordV1 | undefined;

export type MedicalRecordServiceDependencies = {
  database: DatabaseSync;
  clock?: MedicalRecordClock;
  idFactory?: MedicalRecordIdFactory;
  /** Runtime mode is resolved by trusted server composition, never request input. */
  runtimeMode?: AppRuntimeMode;
  env?: NodeJS.ProcessEnv;
  recordResolver?: MedicalRecordResolver;
  actorId?: string;
  simulatedRole?: AuditEventRecord["simulatedRole"];
};

const defaultClock: MedicalRecordClock = () => new Date().toISOString();
const defaultIdFactory: MedicalRecordIdFactory = (kind) => createRandomSystemId(
  kind === "AUDIT" ? "medical-record-audit" : "record-revision",
);
const defaultRecordResolver: MedicalRecordResolver = (caseId, caseVersion) =>
  findSyntheticMedicalRecord(caseId, caseVersion);

export type MedicalRecordView = {
  mode: AppRuntimeMode;
  encounterId: string;
  patientDisplayName: string;
  encounter?: EncounterRecord;
  record: EncounterRecordPayload;
  revisionId?: string;
  revisionNumber: number;
  expectedUpdatedAt: string;
  readOnly: boolean;
};

export type MedicalRecordSaveResult = {
  encounter: EncounterRecord;
  revision: ReturnType<typeof encounterRecordRevisionSchema.parse>;
  record: EncounterRecordPayload;
};

function nowIso(clock: MedicalRecordClock): string {
  const value = clock();
  if (!isoUtcTimestampSchema.safeParse(value).success) throw validationError("clock");
  return value;
}

function trustedRuntimeMode(dependencies: MedicalRecordServiceDependencies): AppRuntimeMode {
  if (dependencies.runtimeMode !== undefined) return dependencies.runtimeMode;
  const gate = assertRuntimeWriteAllowed(dependencies.env);
  if (!gate.ok) {
    throw new PersistenceError(
      persistenceErrorCodes.RUNTIME_READ_ONLY,
      PUBLIC_DEMO_READ_ONLY_MESSAGE,
      { ruleId: PUBLIC_DEMO_READ_ONLY },
    );
  }
  return gate.runtimeMode;
}

function assertWriteAllowed(dependencies: MedicalRecordServiceDependencies): AppRuntimeMode {
  const runtimeMode = trustedRuntimeMode(dependencies);
  if (runtimeMode === "public-demo") {
    throw new PersistenceError(
      persistenceErrorCodes.RUNTIME_READ_ONLY,
      PUBLIC_DEMO_READ_ONLY_MESSAGE,
      { ruleId: PUBLIC_DEMO_READ_ONLY },
    );
  }
  return runtimeMode;
}

function parseSaveRequest(value: unknown): SaveMedicalRecordRequest {
  return validateRuntimeRecord(saveMedicalRecordRequestSchema, value);
}

function mapMedicalRecordValidationError(error: unknown): never {
  if (isPersistenceError(error)) throw error;
  if (error instanceof MedicalRecordValidationError) {
    if (error.code === medicalRecordErrorCodes.SUSPECTED_PII) {
      throw new PersistenceError(
        persistenceErrorCodes.SUSPECTED_PII,
        "仅支持合成病例，请移除身份信息后再保存。",
        { ruleId: medicalRecordErrorCodes.SUSPECTED_PII },
      );
    }
    throw validationError("medicalRecord");
  }
  throw error;
}

function recordDataError(message: string, fieldPath = "recordPayload"): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.DATA_CORRUPTION,
    message,
    { fieldPath },
  );
}

function recordConflict(message: string, fieldPath = "recordPayload"): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.CONFLICT,
    message,
    { fieldPath },
  );
}

function statusAuditMetadata(
  encounter: EncounterRecord,
  fromStatus: EncounterStatus,
  toStatus: EncounterStatus,
): JsonObject {
  return {
    encounterId: encounter.id,
    caseId: encounter.caseId,
    caseVersion: encounter.caseVersion,
    synthetic: true,
    runtimeMode: encounter.runtimeMode,
    fromStatus,
    toStatus,
  };
}

function createAuditEvent(
  dependencies: MedicalRecordServiceDependencies,
  event: {
    eventType: "MEDICAL_RECORD_REVISION_SAVED";
    entityId: string;
    beforeVersion: string;
    afterVersion: string;
    metadata: MedicalRecordRevisionSavedAuditMetadata;
    createdAt: string;
  } | {
    eventType: "ENCOUNTER_STATUS_CHANGED";
    entityId: string;
    beforeVersion: string;
    afterVersion: string;
    metadata: JsonObject;
    createdAt: string;
  },
): AuditEventRecord {
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const metadata = event.eventType === "MEDICAL_RECORD_REVISION_SAVED"
    ? validateRuntimeRecord(medicalRecordRevisionSavedAuditMetadataSchema, event.metadata)
    : validateRuntimeRecord(encounterStatusChangedAuditMetadataSchema, event.metadata);

  return validateRuntimeRecord(auditEventRecordSchema, {
    schemaVersion: "1.0.0",
    id: idFactory("AUDIT"),
    eventType: event.eventType,
    actorId: dependencies.actorId ?? "medical-record-service",
    simulatedRole: dependencies.simulatedRole ?? "PHYSICIAN",
    entityType: "ENCOUNTER",
    entityId: event.entityId,
    beforeVersion: event.beforeVersion,
    afterVersion: event.afterVersion,
    metadata,
    createdAt: event.createdAt,
  });
}

function emptyFieldStatusCounts(): MedicalRecordRevisionSavedAuditMetadata["fieldStatusCounts"] {
  return {
    PROVIDED: 0,
    UNKNOWN: 0,
    NOT_APPLICABLE: 0,
    PENDING_PHYSICIAN_CONFIRMATION: 0,
  };
}

function countFieldStatuses(value: unknown): MedicalRecordRevisionSavedAuditMetadata["fieldStatusCounts"] {
  const counts = emptyFieldStatusCounts();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current === null || typeof current !== "object") return;
    const status = (current as { status?: unknown }).status;
    if (status === "PROVIDED"
      || status === "UNKNOWN"
      || status === "NOT_APPLICABLE"
      || status === "PENDING_PHYSICIAN_CONFIRMATION") {
      counts[status] += 1;
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return counts;
}

function parseStoredMedicalRecord(payload: unknown): EncounterRecordPayload {
  try {
    return parseEncounterRecordV1(payload);
  } catch (error) {
    if (error instanceof MedicalRecordValidationError
      && error.code === medicalRecordErrorCodes.SUSPECTED_PII) {
      return mapMedicalRecordValidationError(error);
    }
    try {
      return parseEncounterRecordPayload(payload);
    } catch {
      throw recordDataError("Stored medical record payload failed source validation.");
    }
  }
}

function isManualSyntheticRecord(record: EncounterRecordPayload): record is ManualSyntheticRecordV1 {
  return "source" in record;
}

function manualInitialRecordForEncounter(
  encounter: EncounterRecord,
  database: DatabaseSync,
): ManualSyntheticRecordV1 {
  const source = encounterSourceOf(encounter);
  if (source.type !== "MANUAL_SYNTHETIC") {
    throw recordDataError("Encounter source is not a manual synthetic source.", "source");
  }
  const stored = createManualSyntheticIntakeRepository(database).getByIntakeId(source.intakeId);
  if (!stored) {
    throw recordDataError("Manual synthetic intake is missing for the Encounter.", "source.intakeId");
  }
  try {
    return createManualSyntheticInitialRecord({
      intake: stored.intake,
      caseId: encounter.caseId,
      caseVersion: encounter.caseVersion,
    });
  } catch {
    throw recordDataError("Manual synthetic intake could not be reconstructed safely.", "source");
  }
}

function assertTrustedSourceBinding(
  encounter: EncounterRecord,
  record: EncounterRecordPayload,
): void {
  const source = encounterSourceOf(encounter);
  if (record.caseId !== encounter.caseId || record.caseVersion !== encounter.caseVersion) {
    throw recordConflict("Stored medical record case reference does not match the Encounter.", "caseId");
  }
  if (source.type === "MANUAL_SYNTHETIC") {
    if (!isManualSyntheticRecord(record) || record.source.intakeId !== source.intakeId) {
      throw recordConflict("Stored manual medical record source does not match the Encounter.", "source");
    }
  } else if (isManualSyntheticRecord(record)) {
    throw recordConflict("Stored medical record source does not match the Encounter.", "source");
  }
  if (record.demographics.displayLabel !== encounter.demographicSnapshot.displayLabel) {
    throw recordConflict("Stored medical record patient label does not match the Encounter.", "demographics");
  }
}

function trustedRecordForEncounter(
  encounter: EncounterRecord,
  latest: ReturnType<ReturnType<typeof createEncounterRecordRevisionRepository>["getLatestByEncounter"]>,
  resolver: MedicalRecordResolver,
  database: DatabaseSync,
): { record: EncounterRecordPayload; revisionId?: string; revisionNumber: number } {
  if (encounter.currentRecordRevisionId !== undefined) {
    if (!latest) {
      throw recordDataError("Encounter current record revision is missing from persistence.", "currentRecordRevisionId");
    }
    if (latest.id !== encounter.currentRecordRevisionId) {
      throw recordDataError("Encounter current record revision does not point to the latest revision.", "currentRecordRevisionId");
    }
    if (latest.encounterId !== encounter.id) {
      throw recordDataError("Stored Encounter record revision belongs to another Encounter.", "currentRecordRevisionId");
    }
    const record = parseStoredMedicalRecord(latest.recordPayload);
    assertTrustedSourceBinding(encounter, record);
    return { record, revisionId: latest.id, revisionNumber: latest.revisionNumber };
  }

  if (latest) {
    throw recordDataError("Encounter has an unbound persisted record revision.", "currentRecordRevisionId");
  }

  const source = encounterSourceOf(encounter);
  const record = source.type === "MANUAL_SYNTHETIC"
    ? manualInitialRecordForEncounter(encounter, database)
    : (() => {
      const sidecar = resolver(encounter.caseId, encounter.caseVersion);
      if (!sidecar) {
        throw new PersistenceError(
          persistenceErrorCodes.NOT_FOUND,
          "The synthetic medical record sidecar was not found.",
          { fieldPath: "caseId" },
        );
      }
      return parseStoredMedicalRecord(sidecar);
    })();
  assertTrustedSourceBinding(encounter, record);
  return { record, revisionNumber: 0 };
}

function assertExpectedRevision(
  encounter: EncounterRecord,
  expectedRevisionId: string | undefined,
  expectedRevisionNumber: number,
  actualRevisionId: string | undefined,
  actualRevisionNumber: number,
): void {
  if (expectedRevisionId !== actualRevisionId || expectedRevisionNumber !== actualRevisionNumber) {
    throw recordConflict(
      "病历页面已过期，请重新载入后再保存。",
      "expectedCurrentRecordRevisionId",
    );
  }
  if (encounter.currentRecordRevisionId !== actualRevisionId) {
    throw recordConflict(
      "Encounter 当前病历修订已变化，请重新载入后再保存。",
      "currentRecordRevisionId",
    );
  }
}

function assembleTrustedRecord(
  base: EncounterRecordPayload,
  encounter: EncounterRecord,
  editable: MedicalRecordEditablePayload,
): EncounterRecordPayload {
  const source = encounterSourceOf(encounter);
  if (source.type === "MANUAL_SYNTHETIC") {
    if (!isManualSyntheticRecord(base) || base.source.intakeId !== source.intakeId) {
      throw recordConflict("手工病例来源已变化，请重新载入后再保存。", "source");
    }
    return parseStoredMedicalRecord({
      schemaVersion: base.schemaVersion,
      synthetic: true,
      caseId: encounter.caseId,
      caseVersion: encounter.caseVersion,
      recordDataVersion: base.recordDataVersion,
      source,
      specialty: base.specialty,
      visitType: base.visitType,
      contentReviewStatus: base.contentReviewStatus,
      sourceDescription: base.sourceDescription,
      physicianConfirmationStatus: base.physicianConfirmationStatus,
      demographics: base.demographics,
      history: editable.history,
      physicalExam: editable.physicalExam,
      auxiliaryExams: editable.auxiliaryExams,
      missingInformation: editable.missingInformation,
      pendingInformation: editable.pendingInformation,
      patientEducationFacts: editable.patientEducationFacts,
    });
  }

  if (isManualSyntheticRecord(base)) {
    throw recordConflict("病历来源已变化，请重新载入后再保存。", "source");
  }

  return parseStoredMedicalRecord({
    schemaVersion: MEDICAL_RECORD_SCHEMA_VERSION,
    synthetic: true,
    caseId: encounter.caseId,
    caseVersion: encounter.caseVersion,
    recordDataVersion: MEDICAL_RECORD_DATA_VERSION,
    sourceDatasetVersion: MEDICAL_RECORD_SOURCE_DATASET_VERSION,
    specialty: base.specialty,
    visitType: base.visitType,
    contentReviewStatus: base.contentReviewStatus,
    sourceDescription: base.sourceDescription,
    physicianConfirmationStatus: "UNCONFIRMED",
    demographics: base.demographics,
    history: editable.history,
    physicalExam: editable.physicalExam,
    auxiliaryExams: editable.auxiliaryExams,
    missingInformation: editable.missingInformation,
    pendingInformation: editable.pendingInformation,
    patientEducationFacts: editable.patientEducationFacts,
    ...(base.draftProjection === undefined ? {} : { draftProjection: base.draftProjection }),
  });
}

function nextEncounterForSavedRecord(
  current: EncounterRecord,
  revisionId: string,
  updatedAt: string,
): EncounterRecord {
  if (current.status === "DRAFT") {
    try {
      return advanceEncounterStatus(current, "RECORD_SAVED", updatedAt, {
        currentRecordRevisionId: revisionId,
      });
    } catch {
      throw recordConflict("病历保存后的接诊状态转换未通过校验。", "status");
    }
  }
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw recordConflict("保存时间不能早于 Encounter 最近更新时间。", "expectedUpdatedAt");
  }
  try {
    return encounterRecordSchema.parse({
      ...current,
      currentRecordRevisionId: revisionId,
      updatedAt,
    });
  } catch {
    throw validationError("encounter");
  }
}

export function getPublicDemoMedicalRecord(): Omit<MedicalRecordView, "record"> & { record: EncounterRecordV1 } {
  const record = findSyntheticMedicalRecord("general-first-001", "0.4.1-001");
  if (!record) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "The public synthetic medical record is unavailable.",
      { fieldPath: "caseId" },
    );
  }
  return {
    mode: "public-demo",
    encounterId: "demo",
    patientDisplayName: "患者1",
    record: parseEncounterRecordV1(record),
    revisionNumber: 0,
    expectedUpdatedAt: "2026-08-21T00:00:00.000Z",
    readOnly: true,
  };
}

export function getMedicalRecordView(
  encounterId: string,
  dependencies: MedicalRecordServiceDependencies,
): MedicalRecordView {
  const runtimeMode = trustedRuntimeMode(dependencies);
  if (runtimeMode === "public-demo") {
    throw new PersistenceError(
      persistenceErrorCodes.RUNTIME_READ_ONLY,
      PUBLIC_DEMO_READ_ONLY_MESSAGE,
      { ruleId: PUBLIC_DEMO_READ_ONLY },
    );
  }

  const encounter = createEncounterRepository(dependencies.database).getById(encounterId);
  if (!encounter) {
    throw new PersistenceError(
      persistenceErrorCodes.NOT_FOUND,
      "The requested Encounter was not found.",
      { fieldPath: "encounterId" },
    );
  }
  if (encounter.synthetic !== true || encounter.runtimeMode !== runtimeMode) {
    throw recordConflict("Encounter 不是当前本地研究运行模式下的合成接诊。", "encounterId");
  }

  const revisions = createEncounterRecordRevisionRepository(dependencies.database);
  const trusted = trustedRecordForEncounter(
    encounter,
    revisions.getLatestByEncounter(encounter.id),
    dependencies.recordResolver ?? defaultRecordResolver,
    dependencies.database,
  );
  return {
    mode: runtimeMode,
    encounterId: encounter.id,
    patientDisplayName: projectPhysicianPatientDisplayName(encounter, dependencies.database),
    encounter,
    record: trusted.record,
    ...(trusted.revisionId === undefined ? {} : { revisionId: trusted.revisionId }),
    revisionNumber: trusted.revisionNumber,
    expectedUpdatedAt: encounter.updatedAt,
    readOnly: encounter.status === "CONFIRMED",
  };
}

export function saveMedicalRecord(
  value: unknown,
  dependencies: MedicalRecordServiceDependencies,
): MedicalRecordSaveResult {
  const runtimeMode = assertWriteAllowed(dependencies);
  const input = parseSaveRequest(value);
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const encounters = createEncounterRepository(dependencies.database);
  const revisions = createEncounterRecordRevisionRepository(dependencies.database);
  const audits = createAuditEventRepository(dependencies.database);

  return withTransaction(dependencies.database, () => {
    const current = encounters.getById(input.encounterId);
    if (!current) {
      throw new PersistenceError(
        persistenceErrorCodes.NOT_FOUND,
        "The requested Encounter was not found.",
        { fieldPath: "encounterId" },
      );
    }
    if (current.synthetic !== true || current.runtimeMode !== runtimeMode) {
      throw recordConflict("Encounter 不是当前本地研究运行模式下的合成接诊。", "encounterId");
    }
    if (current.status === "CONFIRMED") {
      throw recordConflict("已确认的 Encounter 不能再次保存病历。", "status");
    }
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw recordConflict("病历页面已过期，请重新载入后再保存。", "expectedUpdatedAt");
    }

    const latest = revisions.getLatestByEncounter(current.id);
    const trusted = trustedRecordForEncounter(
      current,
      latest,
      dependencies.recordResolver ?? defaultRecordResolver,
      dependencies.database,
    );
    assertExpectedRevision(
      current,
      input.expectedCurrentRecordRevisionId,
      input.expectedRevisionNumber,
      trusted.revisionId,
      trusted.revisionNumber,
    );

    const record = assembleTrustedRecord(trusted.record, current, input.editableRecord);
    const createdAt = nowIso(clock);
    const revisionNumber = trusted.revisionNumber + 1;
    const revision = validateRuntimeRecord(encounterRecordRevisionSchema, {
      schemaVersion: "1.0.0",
      id: idFactory("RECORD_REVISION"),
      encounterId: current.id,
      revisionNumber,
      recordPayload: record as unknown as JsonObject,
      createdAt,
    });
    const next = nextEncounterForSavedRecord(current, revision.id, createdAt);
    const statusChanged = current.status !== next.status;
    const revisionAudit = createAuditEvent(dependencies, {
      eventType: "MEDICAL_RECORD_REVISION_SAVED",
      entityId: current.id,
      beforeVersion: String(trusted.revisionNumber),
      afterVersion: String(revision.revisionNumber),
      metadata: {
        encounterId: current.id,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        previousRevisionNumber: trusted.revisionNumber,
        fromStatus: current.status,
        toStatus: next.status,
        fieldStatusCounts: countFieldStatuses(record),
        savedAt: createdAt,
        synthetic: true,
        runtimeMode: current.runtimeMode,
      },
      createdAt,
    });

    const statusAudit = statusChanged
      ? createAuditEvent(dependencies, {
        eventType: "ENCOUNTER_STATUS_CHANGED",
        entityId: current.id,
        beforeVersion: current.status,
        afterVersion: next.status,
        metadata: statusAuditMetadata(current, current.status, next.status),
        createdAt,
      })
      : undefined;

    revisions.append(revision, trusted.revisionNumber);
    encounters.updateStatus(next, {
      status: current.status,
      updatedAt: input.expectedUpdatedAt,
    });
    if (statusAudit) audits.append(statusAudit);
    audits.append(revisionAudit);

    return { encounter: next, revision, record };
  });
}

export const saveMedicalRecordRevision = saveMedicalRecord;
