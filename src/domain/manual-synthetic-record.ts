import { z } from "zod";

import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import {
  auxiliaryExamsSchema,
  encounterRecordHistorySchema,
  encounterRecordV1Schema,
  medicalDateFieldSchema,
  medicalIntegerFieldSchema,
  medicalListFieldSchema,
  medicalRecordLimits,
  medicalSexFieldSchema,
  medicalTextFieldSchema,
  pendingInformationItemSchema,
  physicalExamSchema,
  type EncounterRecordV1,
} from "./medical-record";
import {
  manualSyntheticIntakeSchema,
  manualSyntheticSpecialtySchema,
  manualSyntheticVisitTypeSchema,
  type ManualSyntheticIntakeV1,
  type ManualSyntheticSource,
  manualSyntheticSourceSchema,
} from "./manual-synthetic-intake";
import {
  MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION,
  type EncounterSource,
} from "./encounter-source";

const MANUAL_SYNTHETIC_RECORD_DATA_VERSION = "1.0.0" as const;
const safeManualRecordIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const manualSyntheticDemographicSnapshotSchema = z.object({
  displayLabel: z.string()
    .min(1)
    .max(80)
    .regex(/^合成手工患者-[A-Za-z0-9][A-Za-z0-9-]*$/u),
  sex: medicalSexFieldSchema,
  age: medicalIntegerFieldSchema,
  occupation: medicalTextFieldSchema,
  ethnicity: medicalTextFieldSchema,
  maritalStatus: medicalTextFieldSchema,
  syntheticRegion: medicalTextFieldSchema,
  visitDate: medicalDateFieldSchema,
  admissionDate: medicalDateFieldSchema,
  recordDate: medicalDateFieldSchema,
}).strict().superRefine((demographics, context) => {
  if (demographics.admissionDate.status !== "NOT_APPLICABLE") {
    context.addIssue({
      code: "custom",
      path: ["admissionDate", "status"],
      message: "Outpatient records must mark admissionDate as NOT_APPLICABLE.",
    });
  }
  if (demographics.visitDate.value !== undefined && demographics.recordDate.value !== undefined
    && demographics.recordDate.value < demographics.visitDate.value) {
    context.addIssue({
      code: "custom",
      path: ["recordDate", "value"],
      message: "Record date cannot precede visit date.",
    });
  }
});

export type ManualSyntheticDemographicSnapshot = z.infer<typeof manualSyntheticDemographicSnapshotSchema>;

export const manualSyntheticRecordV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"),
  synthetic: z.literal(true),
  caseId: safeManualRecordIdSchema,
  caseVersion: z.string().min(1).max(100),
  recordDataVersion: z.literal(MANUAL_SYNTHETIC_RECORD_DATA_VERSION),
  source: manualSyntheticSourceSchema,
  specialty: manualSyntheticSpecialtySchema,
  visitType: manualSyntheticVisitTypeSchema,
  contentReviewStatus: z.literal("PENDING_DOMAIN_REVIEW"),
  sourceDescription: z.string().min(1).max(500).refine(
    (value) => value.includes("合成") && value.includes("手工"),
    "A manual medical record must declare its synthetic manual source.",
  ),
  physicianConfirmationStatus: z.literal("UNCONFIRMED"),
  demographics: manualSyntheticDemographicSnapshotSchema,
  history: encounterRecordHistorySchema,
  physicalExam: physicalExamSchema,
  auxiliaryExams: auxiliaryExamsSchema,
  missingInformation: medicalListFieldSchema,
  pendingInformation: z.array(pendingInformationItemSchema).max(medicalRecordLimits.maxPendingInformationItems),
  patientEducationFacts: medicalListFieldSchema,
}).strict().superRefine((record, context) => {
  if (record.source.intakeSchemaVersion !== MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION) {
    context.addIssue({
      code: "custom",
      path: ["source", "intakeSchemaVersion"],
      message: "Manual records must use the current manual intake schema version.",
    });
  }
  if (JSON.stringify(record).length > medicalRecordLimits.maxTotalCharacters) {
    context.addIssue({
      code: "custom",
      path: [],
      message: "ManualSyntheticRecordV1 exceeds the total character limit.",
    });
  }
});

export type ManualSyntheticRecordV1 = z.infer<typeof manualSyntheticRecordV1Schema>;

export type EncounterRecordPayload = EncounterRecordV1 | ManualSyntheticRecordV1;

export type EncounterRecordBindingErrorCode =
  | "CASE_ID_MISMATCH"
  | "CASE_VERSION_MISMATCH"
  | "DISPLAY_LABEL_MISMATCH"
  | "SOURCE_TYPE_MISMATCH"
  | "MANUAL_INTAKE_ID_MISMATCH"
  | "MANUAL_INTAKE_SCHEMA_VERSION_MISMATCH"
  | "SEEDED_DATASET_VERSION_MISMATCH";

export class EncounterRecordBindingError extends Error {
  readonly code: EncounterRecordBindingErrorCode;

  constructor(code: EncounterRecordBindingErrorCode) {
    super("Encounter record source binding did not match the Encounter.");
    this.name = "EncounterRecordBindingError";
    this.code = code;
  }
}

export function isManualSyntheticRecordPayload(
  record: EncounterRecordPayload,
): record is ManualSyntheticRecordV1 {
  return "source" in record;
}

/**
 * Checks the opaque source relationship without inferring source from a case
 * id prefix. Callers use the fixed error class to map failures to their own
 * controlled persistence boundary.
 */
export function assertEncounterRecordPayloadBinding(input: {
  encounter: {
    caseId: string;
    caseVersion: string;
    demographicSnapshot: { displayLabel: string };
  };
  source: EncounterSource;
  record: EncounterRecordPayload;
}): void {
  if (input.record.caseId !== input.encounter.caseId) {
    throw new EncounterRecordBindingError("CASE_ID_MISMATCH");
  }
  if (input.record.caseVersion !== input.encounter.caseVersion) {
    throw new EncounterRecordBindingError("CASE_VERSION_MISMATCH");
  }
  if (input.record.demographics.displayLabel !== input.encounter.demographicSnapshot.displayLabel) {
    throw new EncounterRecordBindingError("DISPLAY_LABEL_MISMATCH");
  }

  if (input.source.type === "MANUAL_SYNTHETIC") {
    if (!isManualSyntheticRecordPayload(input.record)) {
      throw new EncounterRecordBindingError("SOURCE_TYPE_MISMATCH");
    }
    if (input.record.source.intakeId !== input.source.intakeId) {
      throw new EncounterRecordBindingError("MANUAL_INTAKE_ID_MISMATCH");
    }
    if (input.record.source.intakeSchemaVersion !== input.source.intakeSchemaVersion) {
      throw new EncounterRecordBindingError("MANUAL_INTAKE_SCHEMA_VERSION_MISMATCH");
    }
    return;
  }

  if (isManualSyntheticRecordPayload(input.record)) {
    throw new EncounterRecordBindingError("SOURCE_TYPE_MISMATCH");
  }
  if (input.record.sourceDatasetVersion !== input.source.sourceDatasetVersion) {
    throw new EncounterRecordBindingError("SEEDED_DATASET_VERSION_MISMATCH");
  }
}

export function parseEncounterRecordPayload(input: unknown): EncounterRecordPayload {
  const seededResult = encounterRecordV1Schema.safeParse(input);
  if (seededResult.success) {
    if (scanSuspectedPii(seededResult.data).length > 0) {
      throw new Error("Encounter record payload contains suspected PII.");
    }
    return seededResult.data;
  }

  const manualResult = manualSyntheticRecordV1Schema.safeParse(input);
  if (!manualResult.success) {
    throw new Error("Encounter record payload did not pass a versioned source schema.");
  }
  if (scanSuspectedPii(manualResult.data).length > 0) {
    throw new Error("Encounter record payload contains suspected PII.");
  }
  return manualResult.data;
}

function unknownText(): z.infer<typeof medicalTextFieldSchema> {
  return { status: "UNKNOWN" };
}

function unknownList(): z.infer<typeof medicalListFieldSchema> {
  return { status: "UNKNOWN" };
}

function notApplicableList(): z.infer<typeof medicalListFieldSchema> {
  return { status: "NOT_APPLICABLE" };
}

function buildManualDemographics(intake: ManualSyntheticIntakeV1): ManualSyntheticDemographicSnapshot {
  return manualSyntheticDemographicSnapshotSchema.parse({
    displayLabel: intake.displayLabel,
    sex: { status: "PROVIDED", value: intake.sex },
    age: { status: "PROVIDED", value: intake.age },
    occupation: unknownText(),
    ethnicity: unknownText(),
    maritalStatus: unknownText(),
    syntheticRegion: unknownText(),
    visitDate: { status: "PROVIDED", value: intake.visitDate },
    admissionDate: { status: "NOT_APPLICABLE" },
    recordDate: { status: "PROVIDED", value: intake.recordDate },
  });
}

export function createManualSyntheticInitialRecord(input: {
  intake: ManualSyntheticIntakeV1;
  caseId: string;
  caseVersion: string;
}): ManualSyntheticRecordV1 {
  const intake = manualSyntheticIntakeSchema.parse(input.intake);
  const source: ManualSyntheticSource = manualSyntheticSourceSchema.parse({
    type: "MANUAL_SYNTHETIC",
    intakeId: intake.intakeId,
    intakeSchemaVersion: MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION,
  });

  return manualSyntheticRecordV1Schema.parse({
    schemaVersion: "1.0.0",
    synthetic: true,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    recordDataVersion: MANUAL_SYNTHETIC_RECORD_DATA_VERSION,
    source,
    specialty: intake.specialty,
    visitType: intake.visitType,
    contentReviewStatus: "PENDING_DOMAIN_REVIEW",
    sourceDescription: "合成手工来源；待医生填写",
    physicianConfirmationStatus: "UNCONFIRMED",
    demographics: buildManualDemographics(intake),
    history: {
      chiefComplaint: unknownText(),
      presentIllness: unknownText(),
      problemFacts: unknownList(),
      recentChanges: unknownList(),
      pastHistory: unknownText(),
      personalHistory: unknownText(),
      familyHistory: unknownText(),
      allergyHistory: unknownText(),
      currentMedications: unknownText(),
      redFlags: unknownList(),
    },
    physicalExam: {
      vitalSigns: { status: "UNKNOWN" },
      generalCondition: unknownText(),
      specialtyExam: unknownText(),
      notExaminedOrUnknown: unknownList(),
    },
    auxiliaryExams: {
      laboratory: { status: "UNKNOWN" },
      electrocardiogram: { status: "UNKNOWN" },
      imaging: { status: "UNKNOWN" },
      other: { status: "UNKNOWN" },
    },
    missingInformation: unknownList(),
    pendingInformation: [],
    patientEducationFacts: notApplicableList(),
  });
}
