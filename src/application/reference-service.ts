import "server-only";

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { getPublicDemoMedicalRecord } from "./medical-record-service";
import {
  LITERATURE_DOCUMENT_PENDING_STATUS,
  LITERATURE_DOCUMENT_SCOPE_LABEL,
  LITERATURE_DOCUMENT_SOURCE_LABEL,
  createLiteratureWorkspaceView,
  createReferenceView,
  literatureDocumentWorkspaceItemSchema,
  literatureWorkspaceViewSchema,
  ReferenceProjectionError,
  referenceViewSchema,
  type LiteratureDocumentWorkspaceItem,
  type LiteratureWorkspaceView,
  type ReferenceView,
} from "@/domain/reference";
import {
  encounterStatusSchema,
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
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";
import { readRuntimeConfig } from "@/server/runtime-config";
import {
  isPersistenceError,
  persistenceErrorCodes,
  PersistenceError,
  validationError,
} from "@/infrastructure/sqlite/errors";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { createLiteratureRepository } from "@/infrastructure/sqlite/repositories/literature-repository";
import { validateRuntimeRecord } from "@/infrastructure/sqlite/record-validation";
import { createLiteratureParsingRepository } from "@/infrastructure/sqlite/repositories/literature-parsing-repository";
import type { LiteratureParseStatus } from "@/domain/literature-parsing";

const safeRuntimeIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const REFERENCE_SERVICE_RULE_IDS = {
  ENCOUNTER_NOT_FOUND: "REFERENCE_ENCOUNTER_NOT_FOUND",
  SYNTHETIC_ONLY: "REFERENCE_SYNTHETIC_ONLY",
  STATUS_INSUFFICIENT: "REFERENCE_STATUS_INSUFFICIENT",
  REVISION_MISSING: "REFERENCE_REVISION_MISSING",
  REVISION_NOT_LATEST: "REFERENCE_REVISION_NOT_LATEST",
  REVISION_ENCOUNTER_MISMATCH: "REFERENCE_REVISION_ENCOUNTER_MISMATCH",
  RECORD_INVALID: "REFERENCE_RECORD_INVALID",
  PROJECTION_INVALID: "REFERENCE_PROJECTION_INVALID",
} as const;

export type ReferenceServiceDependencies = {
  /** Public-demo deliberately does not need a database connection. */
  database?: DatabaseSync;
  /** Runtime mode is trusted server composition, never request input. */
  runtimeMode?: AppRuntimeMode;
  env?: NodeJS.ProcessEnv;
};

function trustedRuntimeMode(dependencies: ReferenceServiceDependencies): AppRuntimeMode {
  if (dependencies.runtimeMode !== undefined) return dependencies.runtimeMode;
  return readRuntimeConfig(dependencies.env).runtimeMode;
}

function notFoundError(): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.NOT_FOUND,
    "当前接诊不存在。",
    { fieldPath: "encounterId", ruleId: REFERENCE_SERVICE_RULE_IDS.ENCOUNTER_NOT_FOUND },
  );
}

function recordDataError(ruleId: string, fieldPath: string): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.DATA_CORRUPTION,
    "当前病历无法安全读取。",
    { fieldPath, ruleId },
  );
}

function recordConflict(ruleId: string, fieldPath: string, message: string): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.CONFLICT,
    message,
    { fieldPath, ruleId },
  );
}

function parseStoredRecord(payload: unknown): EncounterRecordPayload {
  try {
    return parseEncounterRecordV1(payload);
  } catch (error) {
    if (error instanceof MedicalRecordValidationError
      && error.code === medicalRecordErrorCodes.SUSPECTED_PII) {
      throw new PersistenceError(
        persistenceErrorCodes.SUSPECTED_PII,
        "当前病历无法安全读取。",
        { fieldPath: "recordPayload", ruleId: medicalRecordErrorCodes.SUSPECTED_PII },
      );
    }
    try {
      return parseEncounterRecordPayload(payload);
    } catch {
      throw recordDataError(REFERENCE_SERVICE_RULE_IDS.RECORD_INVALID, "recordPayload");
    }
  }
}

function projectReferenceView(
  mode: AppRuntimeMode,
  encounterId: string,
  record: EncounterRecordPayload,
  revisionNumber: number,
  encounter?: EncounterRecord,
): ReferenceView {
  try {
    const view = createReferenceView({
      mode,
      encounterId,
      currentRecordRevisionId: encounter?.currentRecordRevisionId,
      expectedUpdatedAt: encounter?.updatedAt,
      encounter: {
        displayLabel: encounter?.demographicSnapshot.displayLabel ?? record.demographics.displayLabel,
        caseId: record.caseId,
        caseVersion: record.caseVersion,
        specialty: record.specialty,
        visitType: record.visitType,
        revisionNumber,
        ...(encounter === undefined ? {} : {
          status: encounterStatusSchema.parse(encounter.status),
        }),
      },
      record,
    });
    return validateRuntimeRecord(referenceViewSchema, view);
  } catch (error) {
    if (error instanceof ReferenceProjectionError) {
      throw new PersistenceError(
        persistenceErrorCodes.SUSPECTED_PII,
        "当前病历摘要无法安全显示。",
        { fieldPath: "summary", ruleId: REFERENCE_SERVICE_RULE_IDS.PROJECTION_INVALID },
      );
    }
    if (isPersistenceError(error)) throw error;
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.PROJECTION_INVALID, "summary");
  }
}

function projectLocalReferenceView(
  encounterId: string,
  dependencies: ReferenceServiceDependencies,
  mode: "local-research",
): ReferenceView {
  if (dependencies.database === undefined) {
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.RECORD_INVALID, "database");
  }

  const encounter = createEncounterRepository(dependencies.database).getById(encounterId);
  if (!encounter) throw notFoundError();
  if (encounter.synthetic !== true || encounter.runtimeMode !== mode) {
    throw recordConflict(
      REFERENCE_SERVICE_RULE_IDS.SYNTHETIC_ONLY,
      "encounterId",
      "当前页面只支持本地研究运行模式下的合成接诊。",
    );
  }
  if (encounter.status === "DRAFT") {
    throw recordConflict(
      REFERENCE_SERVICE_RULE_IDS.STATUS_INSUFFICIENT,
      "status",
      "请先保存病历，再进入诊疗参考。",
    );
  }
  if (encounter.currentRecordRevisionId === undefined) {
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.REVISION_MISSING, "currentRecordRevisionId");
  }

  const latest = createEncounterRecordRevisionRepository(dependencies.database)
    .getLatestByEncounter(encounter.id);
  if (!latest) {
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.REVISION_MISSING, "currentRecordRevisionId");
  }
  if (latest.id !== encounter.currentRecordRevisionId) {
    throw recordConflict(
      REFERENCE_SERVICE_RULE_IDS.REVISION_NOT_LATEST,
      "currentRecordRevisionId",
      "当前病历修订已变化，请重新打开病历。",
    );
  }
  if (latest.encounterId !== encounter.id) {
    throw recordConflict(
      REFERENCE_SERVICE_RULE_IDS.REVISION_ENCOUNTER_MISMATCH,
      "currentRecordRevisionId",
      "当前病历修订与接诊不匹配。",
    );
  }

  const record = parseStoredRecord(latest.recordPayload);
  try {
    assertEncounterRecordPayloadBinding({
      encounter,
      source: encounterSourceOf(encounter),
      record,
    });
  } catch (error) {
    if (error instanceof EncounterRecordBindingError) {
      throw recordConflict(
        REFERENCE_SERVICE_RULE_IDS.RECORD_INVALID,
        error.code === "DISPLAY_LABEL_MISMATCH" ? "demographicSnapshot" : "source",
        "当前病历修订与接诊来源不匹配。",
      );
    }
    throw error;
  }

  return projectReferenceView(mode, encounter.id, record, latest.revisionNumber, encounter);
}

export function getReferenceView(
  encounterId: string,
  dependencies: ReferenceServiceDependencies = {},
): ReferenceView {
  const parsedId = safeRuntimeIdSchema.safeParse(encounterId);
  if (!parsedId.success) throw validationError("encounterId");

  const mode = appRuntimeModeSchema.parse(trustedRuntimeMode(dependencies));
  if (mode === "public-demo") {
    if (parsedId.data !== "demo") throw notFoundError();
    try {
      const view = getPublicDemoMedicalRecord();
      return projectReferenceView(mode, parsedId.data, view.record, view.revisionNumber);
    } catch (error) {
      if (isPersistenceError(error)) throw error;
      throw recordDataError(REFERENCE_SERVICE_RULE_IDS.RECORD_INVALID, "recordPayload");
    }
  }

  return projectLocalReferenceView(parsedId.data, dependencies, mode);
}

export function getLiteratureWorkspaceView(
  encounterId: string,
  dependencies: ReferenceServiceDependencies = {},
): LiteratureWorkspaceView {
  const reference = getReferenceView(encounterId, dependencies);
  try {
    return validateRuntimeRecord(literatureWorkspaceViewSchema, createLiteratureWorkspaceView({
      mode: reference.mode,
      encounterId: reference.encounterId,
      encounterLabel: reference.encounter.displayLabel,
      currentRecordRevisionId: reference.currentRecordRevisionId,
      expectedUpdatedAt: reference.expectedUpdatedAt,
    }));
  } catch {
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.PROJECTION_INVALID, "literature");
  }
}

/**
 * Returns only metadata that is safe to render in the physician workspace.
 * In particular, it never returns stored body bytes, object keys, or paths.
 */
export function getAvailableLiteratureDocumentWorkspaceItems(
  dependencies: ReferenceServiceDependencies = {},
): LiteratureDocumentWorkspaceItem[] {
  const mode = appRuntimeModeSchema.parse(trustedRuntimeMode(dependencies));
  if (mode === "public-demo") return [];
  if (dependencies.database === undefined) {
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.RECORD_INVALID, "database");
  }

  try {
    const repository = createLiteratureRepository(dependencies.database);
    return repository.listAvailableCurrentDocumentIds().map((documentId) => {
      const document = repository.getDocumentById(documentId);
      if (!document || document.status !== "ACTIVE") {
        throw recordDataError(REFERENCE_SERVICE_RULE_IDS.PROJECTION_INVALID, "literature");
      }
      const version = repository.getAvailableVersion(documentId, document.currentVersion);
      if (!version || version.versionId !== document.currentVersionId) {
        throw recordDataError(REFERENCE_SERVICE_RULE_IDS.PROJECTION_INVALID, "literature");
      }
      return validateRuntimeRecord(literatureDocumentWorkspaceItemSchema, {
        documentId: document.documentId,
        displayName: document.displayName,
        version: version.versionNumber,
        format: version.format,
        sizeBytes: version.sizeBytes,
        sha256: version.sha256,
        importedAt: version.createdAt,
        source: LITERATURE_DOCUMENT_SOURCE_LABEL,
        scope: LITERATURE_DOCUMENT_SCOPE_LABEL,
        pendingStatus: LITERATURE_DOCUMENT_PENDING_STATUS,
      });
    });
  } catch (error) {
    if (isPersistenceError(error)) throw error;
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.PROJECTION_INVALID, "literature");
  }
}

/**
 * Parse status is an additive page projection. The original PWR-08A metadata
 * projection stays byte-for-byte compatible; this map is only used by the
 * PWR-08B local parsing workspace.
 */
export function getLiteratureDocumentParseStatuses(
  dependencies: ReferenceServiceDependencies = {},
): Record<string, LiteratureParseStatus> {
  const mode = appRuntimeModeSchema.parse(trustedRuntimeMode(dependencies));
  if (mode === "public-demo") return {};
  if (dependencies.database === undefined) {
    throw recordDataError(REFERENCE_SERVICE_RULE_IDS.RECORD_INVALID, "database");
  }
  const literatureRepository = createLiteratureRepository(dependencies.database);
  const parsingRepository = createLiteratureParsingRepository(dependencies.database);
  const result: Record<string, LiteratureParseStatus> = {};
  for (const documentId of literatureRepository.listAvailableCurrentDocumentIds()) {
    const document = literatureRepository.getDocumentById(documentId);
    if (!document || document.status !== "ACTIVE") continue;
    const version = literatureRepository.getAvailableVersion(documentId, document.currentVersion);
    if (!version || version.versionId !== document.currentVersionId) continue;
    const ready = parsingRepository.getReadyParseRunByVersion(version.versionId);
    const latest = parsingRepository.getLatestParseRunByVersion(version.versionId);
    result[documentId] = ready?.status === "READY"
      ? "READY"
      : latest?.status === "PARSING" || latest?.status === "FAILED"
        ? latest.status
        : "PENDING";
  }
  return result;
}

export function referenceAccessMessage(
  error: unknown,
  mode: AppRuntimeMode,
): string {
  if (isPersistenceError(error)) {
    if (error.code === persistenceErrorCodes.CONFLICT && error.fieldPath === "status") {
      return "请先保存病历，再进入诊疗参考。";
    }
    if (error.code === persistenceErrorCodes.NOT_FOUND) {
      return "当前接诊不存在，请返回接诊入口。";
    }
    if (error.code === persistenceErrorCodes.RUNTIME_READ_ONLY || mode === "public-demo") {
      return "公开演示仅提供预置合成接诊。";
    }
  }
  return mode === "public-demo"
    ? "只读演示资料暂时不可用。"
    : "当前接诊暂时无法安全读取，请返回病历后重试。";
}
