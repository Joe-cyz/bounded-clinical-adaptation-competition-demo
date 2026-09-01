"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { createEncounter } from "@/application/encounter-service";
import {
  saveMedicalRecord,
  getMedicalRecordView,
  type MedicalRecordSaveResult,
} from "@/application/medical-record-service";
import {
  createManualSyntheticEncounter,
  MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS,
} from "@/application/manual-synthetic-encounter-service";
import { syntheticCases, findSyntheticMedicalRecord } from "@/data/seed-loader";
import {
  manualSyntheticIntakeCreateRequestSchema,
  type ManualSyntheticIntakeCreateRequest,
} from "@/domain/manual-synthetic-intake";
import type { EncounterRecordV1 } from "@/domain/medical-record";
import type { EncounterRecordPayload } from "@/domain/manual-synthetic-record";
import { getDatabase } from "@/server/database";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import {
  isPersistenceError,
  persistenceErrorCodes,
  PersistenceError,
} from "@/infrastructure/sqlite/errors";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { transitionEncounter } from "@/application/encounter-service";
import {
  actionErrorMessage,
  confirmPhysicianRecord,
  enterPreSignReview,
  recordReviewItemDecision,
} from "@/application/pre-sign-review-service";

const safeCaseIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/u);
const safeCaseVersionSchema = z.string().min(1).max(100);
const safeEncounterIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export type EncounterActionState = {
  status: "idle" | "error";
  message?: string;
  code?: string;
};

export type SaveMedicalRecordActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  code?: string;
  revisionId?: string;
  revisionNumber?: number;
  updatedAt?: string;
  encounterId?: string;
  record?: EncounterRecordPayload;
};

export type ManualSyntheticEncounterActionState = {
  status: "idle" | "error";
  message?: string;
  code?: string;
};

export type TransitionReferenceActionState = {
  status: "idle" | "error";
  message?: string;
  code?: string;
};

export type ReviewActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  code?: string;
  reviewId?: string;
};

function readFormText(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function controlledMessage(error: unknown, fallback: string): { message: string; code?: string } {
  if (!isPersistenceError(error)) return { message: fallback };
  switch (error.code) {
    case persistenceErrorCodes.RUNTIME_READ_ONLY:
      return { message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
    case persistenceErrorCodes.SUSPECTED_PII:
      return { message: "仅支持合成病例，请移除身份信息后再保存。", code: "MEDICAL_RECORD_SUSPECTED_PII" };
    case persistenceErrorCodes.CONFLICT:
      return { message: error.message, code: "CONFLICT" };
    case persistenceErrorCodes.NOT_FOUND:
      return { message: "请求的合成病例或接诊不存在。", code: "NOT_FOUND" };
    case persistenceErrorCodes.DATA_CORRUPTION:
      return { message: "当前接诊数据无法安全读取，请重新载入。", code: "DATA_CORRUPTION" };
    case persistenceErrorCodes.VALIDATION_FAILED:
      return { message: "病历内容未通过校验，请检查标记为必填的栏目。", code: "VALIDATION_FAILED" };
    default:
      return { message: fallback, code: error.code };
  }
}

const manualSyntheticFormFields = new Set([
  "creationRequestId",
  "specialty",
  "visitType",
  "sex",
  "age",
]);

function parseManualSyntheticFormData(formData: FormData):
  | { ok: true; value: ManualSyntheticIntakeCreateRequest }
  | { ok: false } {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    // React/Next may add its own action fields. They are transport metadata,
    // not part of the closed manual intake contract.
    if (name.startsWith("$ACTION_")) continue;
    if (!manualSyntheticFormFields.has(name) || values.has(name) || typeof value !== "string") {
      return { ok: false };
    }
    values.set(name, value);
  }

  if (values.size !== manualSyntheticFormFields.size) return { ok: false };
  const ageText = values.get("age");
  if (ageText === undefined || !/^\d+$/u.test(ageText)) return { ok: false };

  const parsed = manualSyntheticIntakeCreateRequestSchema.safeParse({
    creationRequestId: values.get("creationRequestId"),
    specialty: values.get("specialty"),
    visitType: values.get("visitType"),
    sex: values.get("sex"),
    age: Number(ageText),
  });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export async function createManualSyntheticEncounterAction(
  _previousState: ManualSyntheticEncounterActionState,
  formData: FormData,
): Promise<ManualSyntheticEncounterActionState> {
  const gate = assertRuntimeWriteAllowed();
  if (!gate.ok || gate.runtimeMode !== "local-research") {
    return { status: "error", message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
  }

  const parsed = parseManualSyntheticFormData(formData);
  if (!parsed.ok) {
    return {
      status: "error",
      message: "新建请求已失效，请重新打开手工病例表单。",
      code: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.INPUT_INVALID,
    };
  }

  let created: ReturnType<typeof createManualSyntheticEncounter>;
  try {
    created = createManualSyntheticEncounter(parsed.value, {
      // Pass the factory itself. The service performs the trusted gate before
      // this function is invoked and only then obtains a database connection.
      databaseFactory: getDatabase,
      runtimeMode: gate.runtimeMode,
    });
  } catch (error) {
    if (isPersistenceError(error) && error.ruleId === MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.CREATION_REQUEST_ID_INVALID) {
      return {
        status: "error",
        message: "新建请求已失效，请刷新页面后重试。",
        code: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.CREATION_REQUEST_ID_INVALID,
      };
    }
    const controlled = controlledMessage(error, "手工模拟病例未创建，请稍后重试。");
    return { status: "error", ...controlled };
  }

  redirect(`/encounters/${created.encounter.id}/record`);
}

function ageBand(age: number | undefined): "CHILD" | "ADULT" | "OLDER_ADULT" | "UNKNOWN" {
  if (age === undefined) return "UNKNOWN";
  if (age < 18) return "CHILD";
  if (age < 65) return "ADULT";
  return "OLDER_ADULT";
}

function encounterSex(record: EncounterRecordV1): "FEMALE" | "MALE" | "UNKNOWN" | "NOT_STATED" {
  if (record.demographics.sex.status !== "PROVIDED" || record.demographics.sex.value === undefined) {
    return "UNKNOWN";
  }
  if (record.demographics.sex.value === "FEMALE" || record.demographics.sex.value === "MALE") {
    return record.demographics.sex.value;
  }
  return "NOT_STATED";
}

function buildEncounterRequest(record: EncounterRecordV1): {
  caseId: string;
  caseVersion: string;
  demographicSnapshot: {
    displayLabel: string;
    sex: "FEMALE" | "MALE" | "UNKNOWN" | "NOT_STATED";
    ageBand: "CHILD" | "ADULT" | "OLDER_ADULT" | "UNKNOWN";
  };
} {
  return {
    caseId: record.caseId,
    caseVersion: record.caseVersion,
    demographicSnapshot: {
      displayLabel: record.demographics.displayLabel,
      sex: encounterSex(record),
      ageBand: record.demographics.age.status === "PROVIDED"
        ? ageBand(record.demographics.age.value)
        : "UNKNOWN",
    },
  };
}

export async function createEncounterAction(
  _previousState: EncounterActionState,
  formData: FormData,
): Promise<EncounterActionState> {
  const gate = assertRuntimeWriteAllowed();
  if (!gate.ok) {
    return { status: "error", message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
  }

  const caseId = readFormText(formData, "caseId");
  const caseVersion = readFormText(formData, "caseVersion");
  const parsedCaseId = safeCaseIdSchema.safeParse(caseId);
  const parsedCaseVersion = safeCaseVersionSchema.safeParse(caseVersion);
  if (!parsedCaseId.success || !parsedCaseVersion.success) {
    return { status: "error", message: "请选择一个有效的合成病例。", code: "ENCOUNTER_INPUT_INVALID" };
  }

  const record = findSyntheticMedicalRecord(parsedCaseId.data, parsedCaseVersion.data);
  const oldCase = syntheticCases.find(
    (candidate) => candidate.id === parsedCaseId.data && candidate.version === parsedCaseVersion.data,
  );
  if (!record || !oldCase) {
    return { status: "error", message: "请求的合成病例不存在。", code: "ENCOUNTER_SYNTHETIC_CASE_REQUIRED" };
  }

  let created: ReturnType<typeof createEncounter>;
  try {
    // The database is opened only after the trusted runtime write gate passes.
    created = createEncounter(buildEncounterRequest(record), {
      database: getDatabase(),
      runtimeMode: gate.runtimeMode,
      caseResolver: (requestedId, requestedVersion) => {
        const candidate = syntheticCases.find(
          (item) => item.id === requestedId && item.version === requestedVersion,
        );
        return candidate?.synthetic === true
          ? { id: candidate.id, version: candidate.version, synthetic: true }
          : undefined;
      },
    });
  } catch (error) {
    const result = controlledMessage(error, "接诊暂时无法创建，请稍后重试。");
    return { status: "error", ...result };
  }

  redirect(`/encounters/${created.id}/record`);
}

function parseEditableRecord(formData: FormData): unknown {
  const raw = readFormText(formData, "editableRecord");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export async function saveMedicalRecordAction(
  previousState: SaveMedicalRecordActionState,
  formData: FormData,
): Promise<SaveMedicalRecordActionState> {
  const gate = assertRuntimeWriteAllowed();
  if (!gate.ok) {
    return {
      status: "error",
      message: PUBLIC_DEMO_READ_ONLY_MESSAGE,
      code: PUBLIC_DEMO_READ_ONLY,
      revisionId: previousState.revisionId,
      revisionNumber: previousState.revisionNumber,
      updatedAt: previousState.updatedAt,
    };
  }

  const encounterId = readFormText(formData, "encounterId");
  const expectedUpdatedAt = readFormText(formData, "expectedUpdatedAt");
  const expectedCurrentRecordRevisionId = readFormText(formData, "expectedCurrentRecordRevisionId");
  const expectedRevisionNumberText = readFormText(formData, "expectedRevisionNumber");
  const parsedEncounterId = safeEncounterIdSchema.safeParse(encounterId);
  const expectedRevisionNumber = Number(expectedRevisionNumberText);
  if (!parsedEncounterId.success
    || !expectedUpdatedAt
    || !Number.isInteger(expectedRevisionNumber)
    || expectedRevisionNumber < 0
    || expectedRevisionNumber > 100_000) {
    return {
      status: "error",
      message: "保存请求已失效，请重新载入病历。",
      code: "MEDICAL_RECORD_INPUT_INVALID",
      revisionId: previousState.revisionId,
      revisionNumber: previousState.revisionNumber,
      updatedAt: previousState.updatedAt,
    };
  }

  const editableRecord = parseEditableRecord(formData);
  if (editableRecord === undefined) {
    return {
      status: "error",
      message: "病历内容未通过校验，请检查后再保存。",
      code: "MEDICAL_RECORD_SCHEMA_INVALID",
      revisionId: previousState.revisionId,
      revisionNumber: previousState.revisionNumber,
      updatedAt: previousState.updatedAt,
    };
  }

  let result: MedicalRecordSaveResult;
  try {
    result = saveMedicalRecord({
      encounterId: parsedEncounterId.data,
      expectedUpdatedAt,
      ...(expectedCurrentRecordRevisionId ? { expectedCurrentRecordRevisionId } : {}),
      expectedRevisionNumber,
      editableRecord,
    }, {
      database: getDatabase(),
      runtimeMode: gate.runtimeMode,
    });
  } catch (error) {
    const controlled = controlledMessage(error, "病历未保存，请检查内容后重试。");
    return {
      status: "error",
      ...controlled,
      revisionId: previousState.revisionId,
      revisionNumber: previousState.revisionNumber,
      updatedAt: previousState.updatedAt,
    };
  }

  return {
    status: "success",
    message: `修订 #${result.revision.revisionNumber} 已保存。`,
    revisionId: result.revision.id,
    revisionNumber: result.revision.revisionNumber,
    updatedAt: result.encounter.updatedAt,
    encounterId: result.encounter.id,
    record: result.record,
  };
}

export async function transitionToReferenceAction(
  _previousState: TransitionReferenceActionState,
  formData: FormData,
): Promise<TransitionReferenceActionState> {
  const gate = assertRuntimeWriteAllowed();
  if (!gate.ok) {
    return { status: "error", message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
  }

  const encounterId = readFormText(formData, "encounterId");
  const expectedStatus = readFormText(formData, "expectedStatus");
  const expectedUpdatedAt = readFormText(formData, "expectedUpdatedAt");
  const currentRecordRevisionId = readFormText(formData, "currentRecordRevisionId");
  const parsedEncounterId = safeEncounterIdSchema.safeParse(encounterId);
  if (!parsedEncounterId.success || !expectedStatus || !expectedUpdatedAt
    || !safeEncounterIdSchema.safeParse(currentRecordRevisionId).success) {
    return { status: "error", message: "进入诊疗参考前的接诊状态已失效，请重新载入。", code: "ENCOUNTER_INPUT_INVALID" };
  }

  try {
    const database = getDatabase();
    const current = createEncounterRepository(database).getById(parsedEncounterId.data);
    if (!current) {
      throw new PersistenceError(
        persistenceErrorCodes.NOT_FOUND,
        "当前接诊不存在。",
        { fieldPath: "encounterId" },
      );
    }
    if (current.status !== expectedStatus || current.updatedAt !== expectedUpdatedAt) {
      throw new PersistenceError(
        persistenceErrorCodes.CONFLICT,
        "当前接诊状态已变化，请重新载入。",
        { fieldPath: "expectedUpdatedAt" },
      );
    }
    const medicalRecord = getMedicalRecordView(parsedEncounterId.data, {
      database,
      runtimeMode: gate.runtimeMode,
    });
    if (medicalRecord.revisionId !== currentRecordRevisionId) {
      throw new PersistenceError(
        persistenceErrorCodes.CONFLICT,
        "当前病历修订已变化，请重新载入。",
        { fieldPath: "currentRecordRevisionId" },
      );
    }
    transitionEncounter({
      encounterId: parsedEncounterId.data,
      expectedStatus,
      expectedUpdatedAt,
      targetStatus: "REFERENCE_VIEWED",
      currentRecordRevisionId,
    }, {
      database,
      runtimeMode: gate.runtimeMode,
    });
  } catch (error) {
    const controlled = controlledMessage(error, "当前接诊状态无法进入诊疗参考，请重新载入。");
    return { status: "error", ...controlled };
  }

  redirect(`/encounters/${encounterId}/reference`);
}

export async function enterPreSignReviewAction(
  _previousState: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const gate = assertRuntimeWriteAllowed();
  if (!gate.ok) {
    return { status: "error", message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
  }

  const encounterId = readFormText(formData, "encounterId");
  const expectedUpdatedAt = readFormText(formData, "expectedUpdatedAt");
  const expectedCurrentRecordRevisionId = readFormText(formData, "expectedCurrentRecordRevisionId");
  if (!encounterId || !expectedUpdatedAt || !expectedCurrentRecordRevisionId) {
    return { status: "error", message: "当前接诊页面已过期，请重新载入后再进入复核。", code: "REVIEW_INPUT_INVALID" };
  }

  let result: ReturnType<typeof enterPreSignReview>;
  try {
    result = enterPreSignReview({
      encounterId,
      expectedUpdatedAt,
      expectedCurrentRecordRevisionId,
    }, {
      database: getDatabase(),
      runtimeMode: gate.runtimeMode,
    });
  } catch (error) {
    return { status: "error", ...actionErrorMessage(error) };
  }
  redirect(`/encounters/${result.encounter.id}/review`);
}

export async function recordReviewItemDecisionAction(
  _previousState: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const gate = assertRuntimeWriteAllowed();
  if (!gate.ok) {
    return { status: "error", message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
  }
  const encounterId = readFormText(formData, "encounterId");
  const reviewId = readFormText(formData, "reviewId");
  const itemId = readFormText(formData, "itemId");
  const expectedUpdatedAt = readFormText(formData, "expectedUpdatedAt");
  const decision = readFormText(formData, "decision");
  const reasonValue = formData.get("reason");
  const reason = typeof reasonValue === "string" && reasonValue.length > 0 ? reasonValue : undefined;
  if (!encounterId || !reviewId || !itemId || !expectedUpdatedAt || !decision) {
    return { status: "error", message: "待核对项请求已失效，请重新载入。", code: "REVIEW_INPUT_INVALID" };
  }
  try {
    const result = recordReviewItemDecision({
      encounterId,
      reviewId,
      itemId,
      expectedUpdatedAt,
      decision,
      ...(reason === undefined ? {} : { reason }),
    }, {
      database: getDatabase(),
      runtimeMode: gate.runtimeMode,
    });
    return {
      status: "success",
      message: result.decision.decision === "NOT_APPLICABLE" ? "已标记为不适用。" : "已标记为已核对。",
      reviewId,
    };
  } catch (error) {
    return { status: "error", ...actionErrorMessage(error), reviewId };
  }
}

export async function confirmPhysicianRecordAction(
  _previousState: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  const gate = assertRuntimeWriteAllowed();
  if (!gate.ok) {
    return { status: "error", message: PUBLIC_DEMO_READ_ONLY_MESSAGE, code: PUBLIC_DEMO_READ_ONLY };
  }
  const encounterId = readFormText(formData, "encounterId");
  const reviewId = readFormText(formData, "reviewId");
  const expectedUpdatedAt = readFormText(formData, "expectedUpdatedAt");
  const declarationAccepted = formData.get("declarationAccepted") === "on";
  if (!encounterId || !reviewId || !expectedUpdatedAt || !declarationAccepted) {
    return { status: "error", message: "请先勾选最终确认声明。", code: "DECLARATION_REQUIRED", reviewId };
  }
  let result: ReturnType<typeof confirmPhysicianRecord>;
  try {
    result = confirmPhysicianRecord({
      encounterId,
      reviewId,
      expectedUpdatedAt,
      declarationAccepted: true,
    }, {
      database: getDatabase(),
      runtimeMode: gate.runtimeMode,
    });
  } catch (error) {
    return { status: "error", ...actionErrorMessage(error), reviewId };
  }
  redirect(`/encounters/${result.encounter.id}/review`);
}
