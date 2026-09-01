import { z } from "zod";

import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import {
  encounterStatusSchema,
} from "./encounter";
import {
  literatureFormatSchema,
  literatureOriginalFilenameSchema,
  literatureSha256Schema,
} from "./literature";
import { isoUtcTimestampSchema } from "./runtime-records";
import {
  appRuntimeModeSchema,
  type AppRuntimeMode,
} from "./runtime-mode";
import type {
  MedicalFieldStatus,
  MedicalListField,
  MedicalTextField,
} from "./medical-record";
import type { EncounterRecordPayload } from "./manual-synthetic-record";

export const REFERENCE_VIEW_SCHEMA_VERSION = "1.0.0" as const;

const safeRuntimeIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const syntheticDisplayLabelSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^(?:合成患者|合成病例|合成手工患者|Synthetic(?:[-_ ]?Patient)?)(?:[-_ ]?[A-Za-z0-9][A-Za-z0-9-]*)?$/u);

export const medicalRecordSummarySchema = z.object({
  previewText: z.string().min(1).max(1_000),
  fullText: z.string().min(1).max(40_000),
  isExpandable: z.boolean(),
}).strict();

export type MedicalRecordSummary = z.infer<typeof medicalRecordSummarySchema>;

export const literatureDisabledReasonsSchema = z.object({
  importSources: z.literal("尚未开放"),
  askQuestion: z.literal("需先导入资料"),
  viewCitations: z.literal("暂无引用"),
}).strict();

export type LiteratureDisabledReasons = z.infer<typeof literatureDisabledReasonsSchema>;

export const literatureEntryStateSchema = z.object({
  hasImportedSources: z.literal(false),
  questionAnsweringEnabled: z.literal(false),
  citationCount: z.literal(0),
  disabledReasons: literatureDisabledReasonsSchema,
}).strict();

export type LiteratureEntryState = z.infer<typeof literatureEntryStateSchema>;

export const LITERATURE_DOCUMENT_SOURCE_LABEL = "负责人提供的本地资料" as const;
export const LITERATURE_DOCUMENT_SCOPE_LABEL = "仅限本地比赛原型" as const;
export const LITERATURE_DOCUMENT_PENDING_STATUS = "已安全导入 · 待解析" as const;

/**
 * A deliberately narrow server-to-page projection. It excludes raw content,
 * object keys, local paths, import item identifiers, and any storage details.
 */
export const literatureDocumentWorkspaceItemSchema = z.object({
  documentId: safeRuntimeIdSchema,
  displayName: literatureOriginalFilenameSchema,
  version: z.number().int().positive().max(1_000_000),
  format: literatureFormatSchema,
  sizeBytes: z.number().int().positive().max(104_857_600),
  sha256: literatureSha256Schema,
  importedAt: isoUtcTimestampSchema,
  source: z.literal(LITERATURE_DOCUMENT_SOURCE_LABEL),
  scope: z.literal(LITERATURE_DOCUMENT_SCOPE_LABEL),
  pendingStatus: z.literal(LITERATURE_DOCUMENT_PENDING_STATUS),
}).strict();

export type LiteratureDocumentWorkspaceItem = z.infer<typeof literatureDocumentWorkspaceItemSchema>;

export const referenceEncounterContextSchema = z.object({
  displayLabel: syntheticDisplayLabelSchema,
  caseId: safeRuntimeIdSchema,
  caseVersion: z.string().min(1).max(100),
  specialty: z.string().min(1).max(100),
  visitType: z.string().min(1).max(100),
  revisionNumber: z.number().int().nonnegative().max(100_000),
  status: encounterStatusSchema.optional(),
}).strict();

export type ReferenceEncounterContext = z.infer<typeof referenceEncounterContextSchema>;

export const referenceViewSchema = z.object({
  schemaVersion: z.literal(REFERENCE_VIEW_SCHEMA_VERSION),
  mode: appRuntimeModeSchema,
  readOnly: z.literal(true),
  encounterId: safeRuntimeIdSchema,
  currentRecordRevisionId: safeRuntimeIdSchema,
  expectedUpdatedAt: isoUtcTimestampSchema,
  encounter: referenceEncounterContextSchema,
  summary: medicalRecordSummarySchema,
  literature: literatureEntryStateSchema,
}).strict();

export type ReferenceView = z.infer<typeof referenceViewSchema>;

export const literatureWorkspaceViewSchema = z.object({
  schemaVersion: z.literal(REFERENCE_VIEW_SCHEMA_VERSION),
  mode: appRuntimeModeSchema,
  readOnly: z.literal(true),
  encounterId: safeRuntimeIdSchema,
  currentRecordRevisionId: safeRuntimeIdSchema,
  expectedUpdatedAt: isoUtcTimestampSchema,
  encounterLabel: syntheticDisplayLabelSchema,
  entryState: literatureEntryStateSchema,
}).strict();

export type LiteratureWorkspaceView = z.infer<typeof literatureWorkspaceViewSchema>;

export class ReferenceProjectionError extends Error {
  readonly code = "REFERENCE_PROJECTION_INVALID" as const;

  constructor(message = "The read-only reference projection was rejected.") {
    super(message);
    this.name = "ReferenceProjectionError";
  }
}

function statusText(status: MedicalFieldStatus): string {
  if (status === "UNKNOWN") return "未记录";
  if (status === "NOT_APPLICABLE") return "不适用";
  return "待医生确认";
}

function textFact(field: MedicalTextField): string {
  if ((field.status === "PROVIDED" || field.status === "PENDING_PHYSICIAN_CONFIRMATION")
    && field.value !== undefined) {
    return field.value;
  }
  return statusText(field.status);
}

function listFact(field: MedicalListField): string {
  if ((field.status === "PROVIDED" || field.status === "PENDING_PHYSICIAN_CONFIRMATION")
    && field.items !== undefined
    && field.items.length > 0) {
    return field.items.join("、");
  }
  return statusText(field.status);
}

function vitalFact(record: EncounterRecordPayload): string {
  const field = record.physicalExam.vitalSigns;
  if (field.value === undefined) return statusText(field.status);

  const readings: string[] = [];
  if (field.value.temperatureC !== undefined) readings.push(`体温${field.value.temperatureC}℃`);
  if (field.value.systolicBpMmhg !== undefined) readings.push(`收缩压${field.value.systolicBpMmhg}mmHg`);
  if (field.value.diastolicBpMmhg !== undefined) readings.push(`舒张压${field.value.diastolicBpMmhg}mmHg`);
  if (field.value.pulseBpm !== undefined) readings.push(`脉搏${field.value.pulseBpm}次/分`);
  if (field.value.respiratoryRatePerMin !== undefined) readings.push(`呼吸${field.value.respiratoryRatePerMin}次/分`);
  if (field.value.measuredAt !== undefined) readings.push(`测量于${field.value.measuredAt}`);
  return readings.length > 0 ? readings.join("，") : statusText(field.status);
}

function auxiliaryFact(
  label: string,
  field: EncounterRecordPayload["auxiliaryExams"][keyof EncounterRecordPayload["auxiliaryExams"]],
): string {
  if ((field.status !== "PROVIDED" && field.status !== "PENDING_PHYSICIAN_CONFIRMATION")
    || field.result === undefined) {
    return `${label}${statusText(field.status)}`;
  }
  const date = field.examinationDate === undefined ? "" : `（${field.examinationDate}）`;
  return `${label}${field.result}${date}`;
}

function truncateForPreview(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, maximum).join("")}…`;
}

export function buildMedicalRecordSummary(record: EncounterRecordPayload): MedicalRecordSummary {
  const facts = [
    `主诉：${textFact(record.history.chiefComplaint)}`,
    `现病史：${textFact(record.history.presentIllness)}`,
    `既往史：${textFact(record.history.pastHistory)}`,
    `个人史：${textFact(record.history.personalHistory)}`,
    `家族史：${textFact(record.history.familyHistory)}`,
    `过敏史：${textFact(record.history.allergyHistory)}`,
    `当前用药：${textFact(record.history.currentMedications)}`,
    `问题事实：${listFact(record.history.problemFacts)}`,
    `近期变化：${listFact(record.history.recentChanges)}`,
    `危险信号：${listFact(record.history.redFlags)}`,
    `一般情况：${textFact(record.physicalExam.generalCondition)}`,
    `专科检查：${textFact(record.physicalExam.specialtyExam)}`,
    `生命体征：${vitalFact(record)}`,
    `辅助检查：${[
      auxiliaryFact("实验室", record.auxiliaryExams.laboratory),
      auxiliaryFact("心电", record.auxiliaryExams.electrocardiogram),
      auxiliaryFact("影像", record.auxiliaryExams.imaging),
      auxiliaryFact("其他", record.auxiliaryExams.other),
    ].join("；")}`,
  ];
  const fullText = facts.join("；");
  const piiMatches = scanSuspectedPii(fullText);
  if (piiMatches.length > 0) throw new ReferenceProjectionError();

  const previewText = truncateForPreview(fullText, 260);
  return medicalRecordSummarySchema.parse({
    previewText,
    fullText,
    isExpandable: previewText !== fullText,
  });
}

export function emptyLiteratureEntryState(): LiteratureEntryState {
  return literatureEntryStateSchema.parse({
    hasImportedSources: false,
    questionAnsweringEnabled: false,
    citationCount: 0,
    disabledReasons: {
      importSources: "尚未开放",
      askQuestion: "需先导入资料",
      viewCitations: "暂无引用",
    },
  });
}

export function createReferenceView(input: {
  mode: AppRuntimeMode;
  encounterId: string;
  encounter: ReferenceEncounterContext;
  record: EncounterRecordPayload;
  currentRecordRevisionId?: string;
  expectedUpdatedAt?: string;
}): ReferenceView {
  return referenceViewSchema.parse({
    schemaVersion: REFERENCE_VIEW_SCHEMA_VERSION,
    mode: input.mode,
    readOnly: true,
    encounterId: input.encounterId,
    currentRecordRevisionId: input.currentRecordRevisionId ?? "reference-demo-revision",
    expectedUpdatedAt: input.expectedUpdatedAt ?? "2026-08-21T00:00:00.000Z",
    encounter: input.encounter,
    summary: buildMedicalRecordSummary(input.record),
    literature: emptyLiteratureEntryState(),
  });
}

export function createLiteratureWorkspaceView(input: {
  mode: AppRuntimeMode;
  encounterId: string;
  encounterLabel: string;
  currentRecordRevisionId?: string;
  expectedUpdatedAt?: string;
}): LiteratureWorkspaceView {
  return literatureWorkspaceViewSchema.parse({
    schemaVersion: REFERENCE_VIEW_SCHEMA_VERSION,
    mode: input.mode,
    readOnly: true,
    encounterId: input.encounterId,
    currentRecordRevisionId: input.currentRecordRevisionId ?? "reference-demo-revision",
    expectedUpdatedAt: input.expectedUpdatedAt ?? "2026-08-21T00:00:00.000Z",
    encounterLabel: input.encounterLabel,
    entryState: emptyLiteratureEntryState(),
  });
}
