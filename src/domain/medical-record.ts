import { z } from "zod";

import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { sectionKeySchema, type SectionKey } from "./schemas";

export const MEDICAL_RECORD_SCHEMA_VERSION = "1.0.0" as const;
export const MEDICAL_RECORD_DATA_VERSION = "1.0.0" as const;
export const MEDICAL_RECORD_SOURCE_DATASET_VERSION = "0.4.1" as const;

export const medicalRecordLimits = {
  maxTotalCharacters: 80_000,
  maxPendingInformationItems: 20,
} as const;

const safeCaseIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/u);
const safeRunIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export const medicalCalendarDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .superRefine((value, context) => {
    const [yearText, monthText, dayText] = value.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      context.addIssue({
        code: "custom",
        message: "The value must be a real calendar date.",
      });
    }
  });

export const medicalDateSchema = medicalCalendarDateSchema;
const nonBlankTextSchema = z.string().min(1).max(2_000).refine(
  (value) => value.trim().length > 0 && value.trim() !== "暂无",
  "Clinical record text must contain meaningful content.",
);
const shortNonBlankTextSchema = z.string().min(1).max(500).refine(
  (value) => value.trim().length > 0 && value.trim() !== "暂无",
  "Clinical record text must contain meaningful content.",
);

export const medicalFieldStatusSchema = z.enum([
  "PROVIDED",
  "UNKNOWN",
  "NOT_APPLICABLE",
  "PENDING_PHYSICIAN_CONFIRMATION",
]);

export type MedicalFieldStatus = z.infer<typeof medicalFieldStatusSchema>;

function addContentStateIssues(
  value: {
    status: MedicalFieldStatus;
    hasContent: boolean;
  },
  context: z.RefinementCtx,
  fieldName: string,
): void {
  const requiresContent = value.status === "PROVIDED" || value.status === "PENDING_PHYSICIAN_CONFIRMATION";
  const forbidsContent = value.status === "UNKNOWN" || value.status === "NOT_APPLICABLE";

  if (requiresContent && !value.hasContent) {
    context.addIssue({
      code: "custom",
      path: [fieldName],
      message: `${value.status} fields must contain non-empty content.`,
    });
  }
  if (forbidsContent && value.hasContent) {
    context.addIssue({
      code: "custom",
      path: [fieldName],
      message: `${value.status} fields cannot contain content.`,
    });
  }
}

export const medicalTextFieldSchema = z.object({
  status: medicalFieldStatusSchema,
  value: nonBlankTextSchema.optional(),
}).strict().superRefine((field, context) => {
  addContentStateIssues(
    { status: field.status, hasContent: field.value !== undefined },
    context,
    "value",
  );
});

export type MedicalTextField = z.infer<typeof medicalTextFieldSchema>;

const textItemSchema = z.string().min(1).max(1_000).refine(
  (value) => value.trim().length > 0 && value.trim() !== "暂无",
  "Clinical record list items must contain meaningful content.",
);

export const medicalListFieldSchema = z.object({
  status: medicalFieldStatusSchema,
  items: z.array(textItemSchema).max(20).optional(),
}).strict().superRefine((field, context) => {
  addContentStateIssues(
    { status: field.status, hasContent: field.items !== undefined && field.items.length > 0 },
    context,
    "items",
  );
  if (field.items !== undefined && field.items.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "A medical record list cannot use an empty array as a field value.",
    });
  }
});

export type MedicalListField = z.infer<typeof medicalListFieldSchema>;

export const medicalIntegerFieldSchema = z.object({
  status: medicalFieldStatusSchema,
  value: z.number().int().min(0).max(150).optional(),
}).strict().superRefine((field, context) => {
  addContentStateIssues(
    { status: field.status, hasContent: field.value !== undefined },
    context,
    "value",
  );
});

export const medicalDateFieldSchema = z.object({
  status: medicalFieldStatusSchema,
  value: medicalCalendarDateSchema.optional(),
}).strict().superRefine((field, context) => {
  addContentStateIssues(
    { status: field.status, hasContent: field.value !== undefined },
    context,
    "value",
  );
});

export const medicalSexFieldSchema = medicalTextFieldSchema.superRefine((field, context) => {
  if (field.value !== undefined && !["FEMALE", "MALE", "INTERSEX"].includes(field.value)) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: "Sex values must use the controlled synthetic vocabulary.",
    });
  }
});

export const demographicSnapshotSchema = z.object({
  displayLabel: z.string().regex(/^合成患者-\d{2}$/u),
  sex: medicalSexFieldSchema,
  age: medicalIntegerFieldSchema,
  occupation: medicalTextFieldSchema,
  ethnicity: medicalTextFieldSchema,
  maritalStatus: medicalTextFieldSchema,
  syntheticRegion: medicalTextFieldSchema.superRefine((field, context) => {
    if (field.value !== undefined && !/^合成区域-[A-Z0-9]+$/u.test(field.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Only controlled synthetic regions are allowed.",
      });
    }
  }),
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

export type DemographicSnapshot = z.infer<typeof demographicSnapshotSchema>;

export const encounterRecordHistorySchema = z.object({
  chiefComplaint: medicalTextFieldSchema,
  presentIllness: medicalTextFieldSchema,
  problemFacts: medicalListFieldSchema,
  recentChanges: medicalListFieldSchema,
  pastHistory: medicalTextFieldSchema,
  personalHistory: medicalTextFieldSchema,
  familyHistory: medicalTextFieldSchema,
  allergyHistory: medicalTextFieldSchema,
  currentMedications: medicalTextFieldSchema,
  redFlags: medicalListFieldSchema,
}).strict();

export type EncounterRecordHistory = z.infer<typeof encounterRecordHistorySchema>;

const vitalValueSchema = z.object({
  measuredAt: medicalCalendarDateSchema.optional(),
  temperatureC: z.number().finite().min(20).max(45).optional(),
  systolicBpMmhg: z.number().finite().min(40).max(300).optional(),
  diastolicBpMmhg: z.number().finite().min(20).max(200).optional(),
  pulseBpm: z.number().finite().min(20).max(250).optional(),
  respiratoryRatePerMin: z.number().finite().min(5).max(80).optional(),
}).strict().superRefine((value, context) => {
  const hasReading = [
    value.temperatureC,
    value.systolicBpMmhg,
    value.diastolicBpMmhg,
    value.pulseBpm,
    value.respiratoryRatePerMin,
  ].some((reading) => reading !== undefined);
  if (!hasReading) {
    context.addIssue({ code: "custom", path: [], message: "A vital-sign field needs at least one numeric reading." });
  }
});

type VitalValue = z.infer<typeof vitalValueSchema>;

function hasVitalReading(value: VitalValue | undefined): boolean {
  return value !== undefined && [
    value.temperatureC,
    value.systolicBpMmhg,
    value.diastolicBpMmhg,
    value.pulseBpm,
    value.respiratoryRatePerMin,
  ].some((reading) => reading !== undefined);
}

export const vitalSignsFieldSchema = z.object({
  status: medicalFieldStatusSchema,
  value: vitalValueSchema.optional(),
}).strict().superRefine((field, context) => {
  addContentStateIssues(
    { status: field.status, hasContent: hasVitalReading(field.value) },
    context,
    "value",
  );
  if ((field.status === "UNKNOWN" || field.status === "NOT_APPLICABLE") && field.value !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: `${field.status} vital-sign fields cannot contain a date or reading.`,
    });
  }
});

export const physicalExamSchema = z.object({
  vitalSigns: vitalSignsFieldSchema,
  generalCondition: medicalTextFieldSchema,
  specialtyExam: medicalTextFieldSchema,
  notExaminedOrUnknown: medicalListFieldSchema,
}).strict();

export const examinationResultSchema = z.object({
  status: medicalFieldStatusSchema,
  examinationDate: medicalCalendarDateSchema.optional(),
  result: shortNonBlankTextSchema.optional(),
}).strict().superRefine((field, context) => {
  const hasContent = field.result !== undefined;
  addContentStateIssues({ status: field.status, hasContent }, context, "result");
  if ((field.status === "UNKNOWN" || field.status === "NOT_APPLICABLE") && field.examinationDate !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["examinationDate"],
      message: `${field.status} examination fields cannot contain a date.`,
    });
  }
});

export const auxiliaryExamsSchema = z.object({
  laboratory: examinationResultSchema,
  electrocardiogram: examinationResultSchema,
  imaging: examinationResultSchema,
  other: examinationResultSchema,
}).strict();

export type AuxiliaryExams = z.infer<typeof auxiliaryExamsSchema>;

export const missingInformationCategorySchema = z.enum([
  "NOT_ASKED",
  "LOW_CONFIDENCE_TRANSCRIPT",
  "CONTRADICTION",
  "PHYSICIAN_FOLLOW_UP",
]);

export type MissingInformationCategory = z.infer<typeof missingInformationCategorySchema>;

export const pendingInformationItemSchema = z.object({
  id: z.string().min(1).max(160).regex(/^missing-[a-z0-9-]+-\d{2}$/u),
  category: missingInformationCategorySchema,
  status: z.literal("PENDING_PHYSICIAN_CONFIRMATION"),
  description: shortNonBlankTextSchema,
}).strict();

export type PendingInformationItem = z.infer<typeof pendingInformationItemSchema>;

const projectedDraftContentSchema = z.array(z.string().max(500).refine(
  (value) => value.trim().length > 0 && value.trim() !== "暂无",
  "Projected draft lines must contain meaningful content.",
)).max(40).min(1);

export const medicalRecordDraftProjectionSchema = z.object({
  source: z.literal("BOUNDED_GENERATED_DRAFT"),
  runId: safeRunIdSchema,
  mode: z.literal("BOUNDED"),
  caseId: safeCaseIdSchema,
  caseVersion: z.string().min(1).max(100),
  sections: z.array(z.object({
    key: sectionKeySchema,
    title: z.string().min(1).max(120),
    status: z.literal("PENDING_PHYSICIAN_CONFIRMATION"),
    content: projectedDraftContentSchema,
    mandatory: z.boolean(),
  }).strict()).min(1).max(12),
}).strict().superRefine((projection, context) => {
  const keys = projection.sections.map((section) => section.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["sections"], message: "Projected draft sections must be unique." });
  }
  if (projection.sections.some((section) => section.content.some((line) => line.trim() === "暂无"))) {
    context.addIssue({ code: "custom", path: ["sections"], message: "Projected draft cannot use fake empty-state text." });
  }
});

export type MedicalRecordDraftProjection = z.infer<typeof medicalRecordDraftProjectionSchema>;

export const encounterRecordV1Schema = z.object({
  schemaVersion: z.literal(MEDICAL_RECORD_SCHEMA_VERSION),
  synthetic: z.literal(true),
  caseId: safeCaseIdSchema,
  caseVersion: z.string().min(1).max(100),
  recordDataVersion: z.literal(MEDICAL_RECORD_DATA_VERSION),
  sourceDatasetVersion: z.literal(MEDICAL_RECORD_SOURCE_DATASET_VERSION),
  specialty: z.string().min(1).max(100),
  visitType: z.string().min(1).max(100),
  contentReviewStatus: z.literal("PENDING_DOMAIN_REVIEW"),
  sourceDescription: z.string().min(1).max(500).refine(
    (value) => value.includes("合成"),
    "A medical record must declare its synthetic source.",
  ),
  physicianConfirmationStatus: z.literal("UNCONFIRMED"),
  demographics: demographicSnapshotSchema,
  history: encounterRecordHistorySchema,
  physicalExam: physicalExamSchema,
  auxiliaryExams: auxiliaryExamsSchema,
  missingInformation: medicalListFieldSchema,
  pendingInformation: z.array(pendingInformationItemSchema).max(medicalRecordLimits.maxPendingInformationItems),
  patientEducationFacts: medicalListFieldSchema,
  draftProjection: medicalRecordDraftProjectionSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.draftProjection !== undefined) {
    if (record.draftProjection.caseId !== record.caseId || record.draftProjection.caseVersion !== record.caseVersion) {
      context.addIssue({
        code: "custom",
        path: ["draftProjection"],
        message: "A draft projection must reference the same case and version as its record.",
      });
    }
  }
  if (JSON.stringify(record).length > medicalRecordLimits.maxTotalCharacters) {
    context.addIssue({
      code: "custom",
      path: [],
      message: "EncounterRecordV1 exceeds the total character limit.",
    });
  }
});

export type EncounterRecordV1 = z.infer<typeof encounterRecordV1Schema>;

export const medicalRecordSchema = encounterRecordV1Schema;

export const medicalRecordCaseMatrixSchema = z.object({
  generalMedicine: z.object({ firstVisit: z.literal(6), chronicFollowUp: z.literal(6) }).strict(),
  endocrinology: z.object({ firstVisit: z.literal(6), chronicFollowUp: z.literal(6) }).strict(),
}).strict();

export const medicalRecordManifestSchema = z.object({
  schemaVersion: z.literal(MEDICAL_RECORD_SCHEMA_VERSION),
  recordDataVersion: z.literal(MEDICAL_RECORD_DATA_VERSION),
  sourceDatasetVersion: z.literal(MEDICAL_RECORD_SOURCE_DATASET_VERSION),
  expectedCount: z.literal(24),
  syntheticOnly: z.literal(true),
  contentReviewStatus: z.literal("PENDING_DOMAIN_REVIEW"),
  sourceDescription: z.string().min(1).max(500),
  demoDateWindow: z.object({
    startDate: medicalCalendarDateSchema,
    endDate: medicalCalendarDateSchema,
  }).strict(),
  caseMatrix: medicalRecordCaseMatrixSchema,
}).strict().superRefine((manifest, context) => {
  if (manifest.demoDateWindow.endDate < manifest.demoDateWindow.startDate) {
    context.addIssue({
      code: "custom",
      path: ["demoDateWindow"],
      message: "The synthetic demo date window must be ordered.",
    });
  }
});

export type MedicalRecordManifest = z.infer<typeof medicalRecordManifestSchema>;

export const medicalRecordErrorCodes = {
  SCHEMA_INVALID: "MEDICAL_RECORD_SCHEMA_INVALID",
  SUSPECTED_PII: "MEDICAL_RECORD_SUSPECTED_PII",
  PROJECTION_INVALID: "MEDICAL_RECORD_PROJECTION_INVALID",
  PROJECTION_MODE_UNSUPPORTED: "MEDICAL_RECORD_PROJECTION_MODE_UNSUPPORTED",
  PROJECTION_CASE_MISMATCH: "MEDICAL_RECORD_PROJECTION_CASE_MISMATCH",
  PROJECTION_SUSPECTED_PII: "MEDICAL_RECORD_PROJECTION_SUSPECTED_PII",
} as const;

export type MedicalRecordErrorCode = (typeof medicalRecordErrorCodes)[keyof typeof medicalRecordErrorCodes];

export class MedicalRecordValidationError extends Error {
  readonly code: MedicalRecordErrorCode;

  constructor(code: MedicalRecordErrorCode, message: string) {
    super(message);
    this.name = "MedicalRecordValidationError";
    this.code = code;
  }
}

export function parseEncounterRecordV1(input: unknown): EncounterRecordV1 {
  const result = encounterRecordV1Schema.safeParse(input);
  if (!result.success) {
    throw new MedicalRecordValidationError(
      medicalRecordErrorCodes.SCHEMA_INVALID,
      "EncounterRecordV1 did not pass the versioned medical record schema.",
    );
  }
  if (scanSuspectedPii(result.data).length > 0) {
    throw new MedicalRecordValidationError(
      medicalRecordErrorCodes.SUSPECTED_PII,
      "EncounterRecordV1 contains suspected PII and was rejected.",
    );
  }
  return result.data;
}

export function sectionKeysOfProjection(projection: MedicalRecordDraftProjection): SectionKey[] {
  return projection.sections.map((section) => section.key);
}
