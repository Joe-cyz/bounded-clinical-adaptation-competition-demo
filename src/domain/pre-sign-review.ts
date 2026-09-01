import { z } from "zod";

import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import {
  encounterStatusSchema,
  type EncounterStatus,
} from "./encounter";
import {
  isoUtcTimestampSchema,
  type AuditEventRecord,
} from "./runtime-records";
import { appRuntimeModeSchema, type AppRuntimeMode } from "./runtime-mode";
import {
  medicalFieldStatusSchema,
  type MedicalFieldStatus,
} from "./medical-record";
import type { EncounterRecordPayload } from "./manual-synthetic-record";

export const PRE_SIGN_REVIEW_SCHEMA_VERSION = "1.0.0" as const;
export const PRE_SIGN_REVIEW_RULESET_VERSION = "1.0.0" as const;
export const PHYSICIAN_CONFIRMATION_DISCLAIMER_VERSION = "1.0.0" as const;

const safeRuntimeIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const safeReviewItemIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-z0-9-]*$/u);

const safeReviewRuleIdSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[A-Z][A-Z0-9_]+$/u);

export const reviewItemCategorySchema = z.enum([
  "REQUIRED",
  "PENDING_INFORMATION",
  "PATIENT_EDUCATION",
]);
export type ReviewItemCategory = z.infer<typeof reviewItemCategorySchema>;

export const reviewItemStatusSchema = z.enum([
  "CHECKED",
  "PENDING",
  "NOT_PROVIDED",
  "NOT_APPLICABLE",
  "BLOCKING",
]);
export type ReviewItemStatus = z.infer<typeof reviewItemStatusSchema>;

export const reviewItemSourceSchema = z.enum(["MEDICAL_RECORD", "PENDING_INFORMATION", "MODEL_REFERENCE"]);
export type ReviewItemSource = z.infer<typeof reviewItemSourceSchema>;

export const reviewItemFieldPathSchema = z.enum([
  "history.chiefComplaint",
  "history.presentIllness",
  "history.allergyHistory",
  "history.currentMedications",
  "history.pastHistory",
  "history.personalHistory",
  "history.familyHistory",
  "history.problemFacts",
  "history.recentChanges",
  "history.redFlags",
  "physicalExam.vitalSigns",
  "physicalExam.generalCondition",
  "physicalExam.specialtyExam",
  "physicalExam.notExaminedOrUnknown",
  "auxiliaryExams",
  "missingInformation",
  "pendingInformation",
  "patientEducationFacts",
  "currentRecordRevisionId",
  "modelReferenceFollowUps",
]);
export type ReviewItemFieldPath = z.infer<typeof reviewItemFieldPathSchema>;

export const reviewEvidenceCodeSchema = z.enum([
  "FIELD_NOT_PROVIDED",
  "FIELD_UNKNOWN",
  "FIELD_PENDING_CONFIRMATION",
  "FIELD_NOT_ASKED",
  "FIELD_LOW_CONFIDENCE",
  "FIELD_FOLLOW_UP",
  "PENDING_CONTRADICTION",
  "CURRENT_REVISION_NOT_LATEST",
  "MODEL_REFERENCE_NEEDS_VERIFICATION",
]);
export type ReviewEvidenceCode = z.infer<typeof reviewEvidenceCodeSchema>;

export const reviewItemSchema = z.object({
  id: safeReviewItemIdSchema,
  ruleId: safeReviewRuleIdSchema,
  category: reviewItemCategorySchema,
  title: z.string().min(1).max(120),
  status: reviewItemStatusSchema,
  blocking: z.boolean(),
  source: reviewItemSourceSchema,
  fieldPath: reviewItemFieldPathSchema,
  evidenceCode: reviewEvidenceCodeSchema,
  observedStatus: medicalFieldStatusSchema.optional(),
}).strict().superRefine((item, context) => {
  if (item.blocking && item.status !== "BLOCKING") {
    context.addIssue({ code: "custom", path: ["status"], message: "Blocking review items must use BLOCKING status." });
  }
  if (!item.blocking && item.status === "BLOCKING") {
    context.addIssue({ code: "custom", path: ["status"], message: "Non-blocking review items cannot use BLOCKING status." });
  }
  if (item.source === "PENDING_INFORMATION" && item.fieldPath !== "pendingInformation") {
    context.addIssue({ code: "custom", path: ["fieldPath"], message: "Pending-information items must use the pendingInformation field path." });
  }
  if (item.source === "MODEL_REFERENCE" && item.fieldPath !== "modelReferenceFollowUps") {
    context.addIssue({ code: "custom", path: ["fieldPath"], message: "Model-reference items must use the modelReferenceFollowUps field path." });
  }
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const preSignReviewSchema = z.object({
  schemaVersion: z.literal(PRE_SIGN_REVIEW_SCHEMA_VERSION),
  id: safeRuntimeIdSchema,
  encounterId: safeRuntimeIdSchema,
  recordRevisionId: safeRuntimeIdSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  rulesetVersion: z.literal(PRE_SIGN_REVIEW_RULESET_VERSION),
  items: z.array(reviewItemSchema).max(100),
  blockingCount: z.number().int().nonnegative().max(100),
  pendingCount: z.number().int().nonnegative().max(100),
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((review, context) => {
  const ids = new Set<string>();
  for (const item of review.items) {
    if (ids.has(item.id)) {
      context.addIssue({ code: "custom", path: ["items"], message: "Review item IDs must be unique." });
      break;
    }
    ids.add(item.id);
  }
  const blockingCount = review.items.filter((item) => item.blocking).length;
  const pendingCount = review.items.filter((item) => !item.blocking && item.status === "PENDING").length;
  if (review.blockingCount !== blockingCount) {
    context.addIssue({ code: "custom", path: ["blockingCount"], message: "Blocking count must match the immutable item snapshot." });
  }
  if (review.pendingCount !== pendingCount) {
    context.addIssue({ code: "custom", path: ["pendingCount"], message: "Pending count must match the immutable item snapshot." });
  }
});
export type PreSignReview = z.infer<typeof preSignReviewSchema>;

export const reviewItemDecisionSchema = z.object({
  schemaVersion: z.literal(PRE_SIGN_REVIEW_SCHEMA_VERSION),
  id: safeRuntimeIdSchema,
  reviewId: safeRuntimeIdSchema,
  itemId: safeReviewItemIdSchema,
  decision: z.enum(["CHECKED", "NOT_APPLICABLE"]),
  reason: z.string().min(1).max(200).optional(),
  actorId: safeRuntimeIdSchema,
  simulatedRole: z.literal("PHYSICIAN"),
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((decision, context) => {
  if (decision.decision === "NOT_APPLICABLE" && decision.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "NOT_APPLICABLE decisions require a reason." });
  }
  if (decision.decision === "CHECKED" && decision.reason !== undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "CHECKED decisions cannot carry a reason." });
  }
  if (decision.reason !== undefined && decision.reason.trim().length === 0) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Decision reasons must contain meaningful text." });
  }
});
export type ReviewItemDecision = z.infer<typeof reviewItemDecisionSchema>;

export const reviewDecisionSummarySchema = z.object({
  checkedCount: z.number().int().nonnegative().max(100),
  notApplicableCount: z.number().int().nonnegative().max(100),
  blockingCount: z.number().int().nonnegative().max(100),
  pendingCount: z.number().int().nonnegative().max(100),
}).strict();
export type ReviewDecisionSummary = z.infer<typeof reviewDecisionSummarySchema>;

export const physicianConfirmationSchema = z.object({
  schemaVersion: z.literal(PRE_SIGN_REVIEW_SCHEMA_VERSION),
  id: safeRuntimeIdSchema,
  encounterId: safeRuntimeIdSchema,
  reviewId: safeRuntimeIdSchema,
  recordRevisionId: safeRuntimeIdSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  decisionSummary: reviewDecisionSummarySchema,
  disclaimerVersion: z.literal(PHYSICIAN_CONFIRMATION_DISCLAIMER_VERSION),
  actorId: safeRuntimeIdSchema,
  simulatedRole: z.literal("PHYSICIAN"),
  confirmedAt: isoUtcTimestampSchema,
}).strict().superRefine((confirmation, context) => {
  if (confirmation.decisionSummary.blockingCount !== 0) {
    context.addIssue({ code: "custom", path: ["decisionSummary", "blockingCount"], message: "A confirmation cannot contain blocking items." });
  }
  if (confirmation.decisionSummary.pendingCount !== 0) {
    context.addIssue({ code: "custom", path: ["decisionSummary", "pendingCount"], message: "A confirmation cannot contain pending decisions." });
  }
});
export type PhysicianConfirmation = z.infer<typeof physicianConfirmationSchema>;

const auditBaseShape = {
  encounterId: safeRuntimeIdSchema,
  synthetic: z.literal(true),
  runtimeMode: appRuntimeModeSchema,
};

export const preSignReviewCreatedAuditMetadataSchema = z.object({
  ...auditBaseShape,
  reviewId: safeRuntimeIdSchema,
  recordRevisionId: safeRuntimeIdSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  rulesetVersion: z.literal(PRE_SIGN_REVIEW_RULESET_VERSION),
  blockingCount: z.number().int().nonnegative().max(100),
  pendingCount: z.number().int().nonnegative().max(100),
}).strict();
export type PreSignReviewCreatedAuditMetadata = z.infer<typeof preSignReviewCreatedAuditMetadataSchema>;

export const reviewItemDecisionAuditMetadataSchema = z.object({
  ...auditBaseShape,
  reviewId: safeRuntimeIdSchema,
  itemId: safeReviewItemIdSchema,
  decision: z.enum(["CHECKED", "NOT_APPLICABLE"]),
}).strict();
export type ReviewItemDecisionAuditMetadata = z.infer<typeof reviewItemDecisionAuditMetadataSchema>;

export const physicianConfirmationAuditMetadataSchema = z.object({
  ...auditBaseShape,
  confirmationId: safeRuntimeIdSchema,
  reviewId: safeRuntimeIdSchema,
  recordRevisionId: safeRuntimeIdSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  blockingCount: z.literal(0),
  pendingCount: z.literal(0),
}).strict();
export type PhysicianConfirmationAuditMetadata = z.infer<typeof physicianConfirmationAuditMetadataSchema>;

export const reviewPageConfirmationSchema = z.object({
  id: safeRuntimeIdSchema,
  confirmedAt: isoUtcTimestampSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  disclaimerVersion: z.literal(PHYSICIAN_CONFIRMATION_DISCLAIMER_VERSION),
}).strict();

export const preSignReviewPageViewSchema = z.object({
  schemaVersion: z.literal(PRE_SIGN_REVIEW_SCHEMA_VERSION),
  mode: appRuntimeModeSchema,
  readOnly: z.boolean(),
  encounterId: safeRuntimeIdSchema,
  encounterLabel: z.string().min(1).max(80),
  status: encounterStatusSchema,
  reviewId: safeRuntimeIdSchema,
  recordRevisionId: safeRuntimeIdSchema,
  reviewRevisionNumber: z.number().int().positive().max(100_000),
  currentRevisionNumber: z.number().int().nonnegative().max(100_000),
  expectedUpdatedAt: isoUtcTimestampSchema,
  rulesetVersion: z.literal(PRE_SIGN_REVIEW_RULESET_VERSION),
  items: z.array(reviewItemSchema).max(100),
  blockingCount: z.number().int().nonnegative().max(100),
  pendingCount: z.number().int().nonnegative().max(100),
  isStale: z.boolean(),
  confirmation: reviewPageConfirmationSchema.optional(),
}).strict();
export type PreSignReviewPageView = z.infer<typeof preSignReviewPageViewSchema>;

export type ReviewRuleDefinition = {
  ruleId: string;
  category: ReviewItemCategory;
  title: string;
  fieldPath: ReviewItemFieldPath;
  blocking: boolean;
  evidenceCode: ReviewEvidenceCode;
};

const reviewDisplayTitleByFieldPath: Partial<Record<ReviewItemFieldPath, string>> = {
  "history.chiefComplaint": "主诉",
  "history.presentIllness": "现病史",
  "history.allergyHistory": "过敏史",
  "history.currentMedications": "当前用药",
  "history.redFlags": "危险信号",
  "history.pastHistory": "既往史未记录",
  "history.personalHistory": "个人史未记录",
  "history.familyHistory": "家族史未记录",
  "history.problemFacts": "问题事实未核对",
  "history.recentChanges": "近期变化未核对",
  "physicalExam.generalCondition": "一般情况未记录",
  "physicalExam.specialtyExam": "专科体格检查未记录",
  "physicalExam.notExaminedOrUnknown": "未检查项目未核对",
  "physicalExam.vitalSigns": "生命体征未记录",
  auxiliaryExams: "辅助检查",
  missingInformation: "待补充信息未核对",
  patientEducationFacts: "患者教育待核对",
  currentRecordRevisionId: "当前病历已有更新修订",
  modelReferenceFollowUps: "模型参考待核实项",
};

const pendingInformationDisplayTitleByEvidenceCode: Partial<Record<ReviewEvidenceCode, string>> = {
  FIELD_NOT_ASKED: "尚未询问的信息",
  FIELD_LOW_CONFIDENCE: "低置信度转写待核对",
  FIELD_FOLLOW_UP: "随访信息待核对",
  PENDING_CONTRADICTION: "存在矛盾信息",
};

export function formatReviewItemTitle(
  item: Pick<ReviewItem, "source" | "fieldPath" | "evidenceCode" | "title">,
  occurrence = 1,
  totalOccurrences = occurrence,
): string {
  const baseTitle = item.source === "PENDING_INFORMATION"
    ? pendingInformationDisplayTitleByEvidenceCode[item.evidenceCode] ?? "待核对信息"
    : item.source === "MODEL_REFERENCE"
      ? item.title
      : reviewDisplayTitleByFieldPath[item.fieldPath] ?? item.title;

  if (item.source === "PENDING_INFORMATION" && totalOccurrences > 1) {
    return `${baseTitle}（${occurrence}）`;
  }
  return baseTitle;
}

export function formatReviewLocalTimestamp(value: string): string {
  const date = new Date(value);
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}

export const PRE_SIGN_REVIEW_RULE_CATALOG: readonly ReviewRuleDefinition[] = [
  { ruleId: "CHIEF_COMPLAINT_REQUIRED", category: "REQUIRED", title: "主诉尚未完成", fieldPath: "history.chiefComplaint", blocking: true, evidenceCode: "FIELD_NOT_PROVIDED" },
  { ruleId: "PRESENT_ILLNESS_REQUIRED", category: "REQUIRED", title: "现病史尚未完成", fieldPath: "history.presentIllness", blocking: true, evidenceCode: "FIELD_NOT_PROVIDED" },
  { ruleId: "ALLERGY_STATUS_REQUIRED", category: "REQUIRED", title: "过敏史仍待核对", fieldPath: "history.allergyHistory", blocking: true, evidenceCode: "FIELD_UNKNOWN" },
  { ruleId: "CURRENT_MEDICATIONS_STATUS_REQUIRED", category: "REQUIRED", title: "当前用药仍待核对", fieldPath: "history.currentMedications", blocking: true, evidenceCode: "FIELD_UNKNOWN" },
  { ruleId: "RED_FLAGS_VERIFICATION_REQUIRED", category: "REQUIRED", title: "危险信号仍待核实", fieldPath: "history.redFlags", blocking: true, evidenceCode: "FIELD_PENDING_CONFIRMATION" },
  { ruleId: "AUXILIARY_EXAMS_STATUS_REQUIRED", category: "REQUIRED", title: "辅助检查仍待核对", fieldPath: "auxiliaryExams", blocking: true, evidenceCode: "FIELD_UNKNOWN" },
  { ruleId: "OPTIONAL_HISTORY_REVIEW", category: "PENDING_INFORMATION", title: "非必填病史仍未记录", fieldPath: "history.pastHistory", blocking: false, evidenceCode: "FIELD_UNKNOWN" },
  { ruleId: "PHYSICAL_EXAM_REVIEW", category: "PENDING_INFORMATION", title: "体格检查仍未记录", fieldPath: "physicalExam.generalCondition", blocking: false, evidenceCode: "FIELD_UNKNOWN" },
  { ruleId: "VITAL_SIGNS_REVIEW", category: "PENDING_INFORMATION", title: "生命体征仍未记录", fieldPath: "physicalExam.vitalSigns", blocking: false, evidenceCode: "FIELD_UNKNOWN" },
  { ruleId: "MISSING_INFORMATION_REVIEW", category: "PENDING_INFORMATION", title: "待补充信息仍未核对", fieldPath: "missingInformation", blocking: false, evidenceCode: "FIELD_UNKNOWN" },
  { ruleId: "PATIENT_EDUCATION_REVIEW", category: "PATIENT_EDUCATION", title: "患者教育信息仍待核对", fieldPath: "patientEducationFacts", blocking: false, evidenceCode: "FIELD_UNKNOWN" },
];

const optionalHistoryFields = [
  ["pastHistory", "history.pastHistory"],
  ["personalHistory", "history.personalHistory"],
  ["familyHistory", "history.familyHistory"],
  ["problemFacts", "history.problemFacts"],
  ["recentChanges", "history.recentChanges"],
] as const;

function needsReview(status: MedicalFieldStatus): boolean {
  return status === "UNKNOWN" || status === "PENDING_PHYSICIAN_CONFIRMATION";
}

function fieldEvidenceCode(status: MedicalFieldStatus): ReviewEvidenceCode {
  return status === "PENDING_PHYSICIAN_CONFIRMATION"
    ? "FIELD_PENDING_CONFIRMATION"
    : "FIELD_UNKNOWN";
}

function itemId(ruleId: string, suffix?: string): string {
  return `review-item-${ruleId.toLowerCase().replace(/_/gu, "-")}${suffix ? `-${suffix.toLowerCase().replace(/[^a-z0-9-]/gu, "-")}` : ""}`;
}

function fieldItem(
  definition: ReviewRuleDefinition,
  status: MedicalFieldStatus,
  idSuffix?: string,
): ReviewItem {
  return reviewItemSchema.parse({
    id: itemId(definition.ruleId, idSuffix),
    ruleId: definition.ruleId,
    category: definition.category,
    title: definition.title,
    status: definition.blocking ? "BLOCKING" : "PENDING",
    blocking: definition.blocking,
    source: "MEDICAL_RECORD",
    fieldPath: definition.fieldPath,
    evidenceCode: definition.blocking ? fieldEvidenceCode(status) : fieldEvidenceCode(status),
    observedStatus: status,
  });
}

function rule(ruleId: string): ReviewRuleDefinition {
  const result = PRE_SIGN_REVIEW_RULE_CATALOG.find((candidate) => candidate.ruleId === ruleId);
  if (!result) throw new Error(`Unknown pre-sign review rule: ${ruleId}`);
  return result;
}

export function evaluatePreSignReview(record: EncounterRecordPayload): ReviewItem[] {
  const items: ReviewItem[] = [];
  const addIf = (definition: ReviewRuleDefinition, status: MedicalFieldStatus, shouldAdd: boolean, idSuffix?: string) => {
    if (shouldAdd) items.push(fieldItem(definition, status, idSuffix));
  };

  addIf(rule("CHIEF_COMPLAINT_REQUIRED"), record.history.chiefComplaint.status, record.history.chiefComplaint.status !== "PROVIDED");
  addIf(rule("PRESENT_ILLNESS_REQUIRED"), record.history.presentIllness.status, record.history.presentIllness.status !== "PROVIDED");
  addIf(rule("ALLERGY_STATUS_REQUIRED"), record.history.allergyHistory.status, needsReview(record.history.allergyHistory.status));
  addIf(rule("CURRENT_MEDICATIONS_STATUS_REQUIRED"), record.history.currentMedications.status, needsReview(record.history.currentMedications.status));
  addIf(rule("RED_FLAGS_VERIFICATION_REQUIRED"), record.history.redFlags.status, needsReview(record.history.redFlags.status));

  const auxiliaryStatuses = Object.values(record.auxiliaryExams).map((field) => field.status);
  const auxiliaryStatus = auxiliaryStatuses.find((status) => needsReview(status));
  if (auxiliaryStatus !== undefined) addIf(rule("AUXILIARY_EXAMS_STATUS_REQUIRED"), auxiliaryStatus, true);

  for (const [fieldName, fieldPath] of optionalHistoryFields) {
    const field = record.history[fieldName];
    if (needsReview(field.status)) {
      const definition = rule("OPTIONAL_HISTORY_REVIEW");
      items.push(reviewItemSchema.parse({
        ...fieldItem(definition, field.status, fieldName),
        title: fieldName === "problemFacts" || fieldName === "recentChanges" ? "病史变化仍未核对" : definition.title,
        fieldPath,
        evidenceCode: fieldEvidenceCode(field.status),
      }));
    }
  }

  const physicalFields = [
    ["generalCondition", record.physicalExam.generalCondition],
    ["specialtyExam", record.physicalExam.specialtyExam],
    ["notExaminedOrUnknown", record.physicalExam.notExaminedOrUnknown],
  ] as const;
  for (const [fieldName, field] of physicalFields) {
    if (needsReview(field.status)) {
      const definition = rule("PHYSICAL_EXAM_REVIEW");
      items.push(reviewItemSchema.parse({
        ...fieldItem(definition, field.status, fieldName),
        title: fieldName === "specialtyExam" ? "专科体格检查仍未记录" : fieldName === "notExaminedOrUnknown" ? "未检查项目仍未核对" : definition.title,
        fieldPath: `physicalExam.${fieldName}` as ReviewItemFieldPath,
        evidenceCode: fieldEvidenceCode(field.status),
      }));
    }
  }

  if (needsReview(record.physicalExam.vitalSigns.status)) {
    items.push(fieldItem(rule("VITAL_SIGNS_REVIEW"), record.physicalExam.vitalSigns.status));
  }
  if (needsReview(record.missingInformation.status)) {
    items.push(fieldItem(rule("MISSING_INFORMATION_REVIEW"), record.missingInformation.status));
  }
  if (needsReview(record.patientEducationFacts.status)) {
    items.push(fieldItem(rule("PATIENT_EDUCATION_REVIEW"), record.patientEducationFacts.status));
  }

  for (const pending of record.pendingInformation) {
    const blocking = pending.category === "CONTRADICTION";
    const definition: ReviewRuleDefinition = {
      ruleId: blocking ? "PENDING_INFORMATION_CONTRADICTION" : "PENDING_INFORMATION_REVIEW",
      category: "PENDING_INFORMATION",
      title: blocking ? "存在待核对的矛盾信息" : "有一项待补充信息",
      fieldPath: "pendingInformation",
      blocking,
      evidenceCode: blocking ? "PENDING_CONTRADICTION" : pending.category === "NOT_ASKED"
        ? "FIELD_NOT_ASKED"
        : pending.category === "LOW_CONFIDENCE_TRANSCRIPT"
          ? "FIELD_LOW_CONFIDENCE"
          : "FIELD_FOLLOW_UP",
    };
    items.push(reviewItemSchema.parse({
      id: itemId(definition.ruleId, pending.id.replace(/^missing-/u, "")),
      ruleId: definition.ruleId,
      category: definition.category,
      title: definition.title,
      status: blocking ? "BLOCKING" : "PENDING",
      blocking,
      source: "PENDING_INFORMATION",
      fieldPath: definition.fieldPath,
      evidenceCode: definition.evidenceCode,
      observedStatus: pending.status,
    }));
  }

  return items;
}

export function createPreSignReview(input: {
  id: string;
  encounterId: string;
  recordRevisionId: string;
  revisionNumber: number;
  record: EncounterRecordPayload;
  additionalItems?: readonly ReviewItem[];
  createdAt: string;
}): PreSignReview {
  const items = [...evaluatePreSignReview(input.record), ...(input.additionalItems ?? [])];
  return preSignReviewSchema.parse({
    schemaVersion: PRE_SIGN_REVIEW_SCHEMA_VERSION,
    id: input.id,
    encounterId: input.encounterId,
    recordRevisionId: input.recordRevisionId,
    revisionNumber: input.revisionNumber,
    rulesetVersion: PRE_SIGN_REVIEW_RULESET_VERSION,
    items,
    blockingCount: items.filter((item) => item.blocking).length,
    pendingCount: items.filter((item) => !item.blocking && item.status === "PENDING").length,
    createdAt: input.createdAt,
  });
}

export function parseReviewItemDecision(value: unknown): ReviewItemDecision {
  const parsed = reviewItemDecisionSchema.parse(value);
  if (parsed.reason !== undefined && scanSuspectedPii(parsed.reason).length > 0) {
    throw new PreSignReviewValidationError("REVIEW_REASON_SUSPECTED_PII", "Decision reason contains disallowed identifying information.");
  }
  return parsed;
}

export function applyReviewDecisions(
  review: PreSignReview,
  decisions: readonly ReviewItemDecision[],
): { items: ReviewItem[]; summary: ReviewDecisionSummary } {
  const decisionByItem = new Map<string, ReviewItemDecision>();
  for (const decision of decisions) {
    if (decision.reviewId !== review.id) {
      throw new PreSignReviewValidationError("REVIEW_DECISION_MISMATCH", "Review decision does not belong to the review.");
    }
    if (decisionByItem.has(decision.itemId)) {
      throw new PreSignReviewValidationError("REVIEW_DECISION_DUPLICATE", "A review item has more than one decision.");
    }
    decisionByItem.set(decision.itemId, decision);
  }

  const items = review.items.map((item) => {
    const decision = decisionByItem.get(item.id);
    if (!decision) return item;
    if (item.blocking) {
      throw new PreSignReviewValidationError("BLOCKING_ITEM_CANNOT_BE_DECIDED", "Blocking review items cannot be cleared by a decision.");
    }
    return reviewItemSchema.parse({
      ...item,
      status: decision.decision === "CHECKED" ? "CHECKED" : "NOT_APPLICABLE",
    });
  });

  return {
    items,
    summary: reviewDecisionSummarySchema.parse({
      checkedCount: items.filter((item) => item.status === "CHECKED").length,
      notApplicableCount: items.filter((item) => item.status === "NOT_APPLICABLE").length,
      blockingCount: items.filter((item) => item.blocking).length,
      pendingCount: items.filter((item) => !item.blocking && item.status === "PENDING").length,
    }),
  };
}

export class PreSignReviewValidationError extends Error {
  readonly code:
    | "REVIEW_REASON_SUSPECTED_PII"
    | "REVIEW_DECISION_MISMATCH"
    | "REVIEW_DECISION_DUPLICATE"
    | "BLOCKING_ITEM_CANNOT_BE_DECIDED";

  constructor(code: PreSignReviewValidationError["code"], message: string) {
    super(message);
    this.name = "PreSignReviewValidationError";
    this.code = code;
  }
}

export type ReviewAuditEventType =
  | "PRE_SIGN_REVIEW_CREATED"
  | "REVIEW_ITEM_DECISION_RECORDED"
  | "PHYSICIAN_CONFIRMATION_RECORDED";

export type ReviewAuditEvent = AuditEventRecord & { eventType: ReviewAuditEventType };
export type ReviewPageStatus = Extract<EncounterStatus, "REVIEW_PENDING" | "CONFIRMED">;
export type ReviewRuntimeMode = AppRuntimeMode;
