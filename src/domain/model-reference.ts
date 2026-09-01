import { z } from "zod";

export const MODEL_REFERENCE_SCHEMA_VERSION = "1.0.0" as const;
export const GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION = "general-clinical-reference-v1" as const;
export const LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION = "literature-grounded-reference-v1" as const;
/**
 * The application request port remains v1 for compatibility with the existing
 * local workflow. Real-provider transport prompts use this independently
 * versioned, stricter output contract.
 */
export const REAL_GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION = "general-clinical-reference-v3" as const;
export const REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION = "literature-grounded-reference-v4" as const;
export type GeneralClinicalReferencePromptVersion =
  | typeof GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION
  | typeof REAL_GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION;
export type LiteratureGroundedReferencePromptVersion =
  | typeof LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION
  | typeof REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION;
export type RealModelReferencePromptVersion =
  | typeof REAL_GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION
  | typeof REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION;
export const MODEL_REFERENCE_MAX_ITEMS = 8;
export const REAL_MODEL_REFERENCE_ITEM_COUNT = 4 as const;
export const REAL_MODEL_REFERENCE_MIN_ITEMS = REAL_MODEL_REFERENCE_ITEM_COUNT;
export const REAL_MODEL_REFERENCE_MAX_ITEMS = REAL_MODEL_REFERENCE_ITEM_COUNT;
export const REAL_MODEL_REFERENCE_MAX_TEXT = 160;
export const REAL_MODEL_REFERENCE_MAX_SUPPORTS = 2;

export const REAL_TREATMENT_DIRECTION_ALLOWLIST = [
  "可评估支持性处理方向，由医生结合病情和检查结果决定。",
  "可评估非药物处理方向，由医生结合病情和检查结果决定。",
  "可评估抗感染治疗类别是否适用，由医生结合禁忌证和检查结果决定。",
  "可评估症状控制治疗类别是否适用，由医生结合禁忌证和检查结果决定。",
  "可评估是否需要转诊或升级处理，由医生结合病情决定。",
  "现有信息不足，暂不能形成治疗方向。",
] as const;
export type RealTreatmentDirection = typeof REAL_TREATMENT_DIRECTION_ALLOWLIST[number];

export const REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST = [
  "可考虑感染性与非感染性原因，由医生结合病程及检查判断。",
  "可考虑药物相关不良反应可能性，由医生结合用药史判断。",
  "可从其他可能原因进行鉴别，由医生结合病史和检查判断。",
  "需进一步明确诊断，由医生结合完整资料综合判断。",
  "目前资料不足，不能形成确定结论。",
] as const;
export type RealDiagnosticDirection = typeof REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST[number];

export const REAL_VERIFICATION_DIRECTION_ALLOWLIST = [
  "需核对症状时间线、既往史和用药史。",
  "需确认现有检查和检验结果是否完整。",
  "需核对过敏史、禁忌证和既往治疗情况。",
  "需补充核对当前病情变化和已有记录。",
  "现有信息不足，需由医生补充核对关键病史。",
] as const;
export type RealVerificationDirection = typeof REAL_VERIFICATION_DIRECTION_ALLOWLIST[number];

export const REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST = [
  "建议医生评估是否需要补充检查或资料。",
  "可考虑补充检验或影像资料。",
  "建议查阅相关资料来源。",
  "可考虑是否需要转诊或升级处理。",
  "现有信息不足，暂不能提出补充检查或资料方向。",
] as const;
export type RealAdditionalCheckOrSourceDirection = typeof REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST[number];

export type ReferenceLanguageSafetyStage =
  | "OUTPUT_DEFINITIVE_DIAGNOSIS_UNSAFE"
  | "OUTPUT_PRESCRIPTION_OR_DOSE_UNSAFE"
  | "OUTPUT_DIRECT_PATIENT_INSTRUCTION_UNSAFE"
  | "OUTPUT_CLINICAL_CLAIM_UNSAFE"
  | "OUTPUT_PROMPT_INJECTION_UNSAFE";

export type ReferenceLanguageSafetyResult =
  | { ok: true }
  | { ok: false; stage: ReferenceLanguageSafetyStage };

export const REFERENCE_LANGUAGE_RULE_IDS = {
  ITEM_COUNT_INVALID: "ITEM_COUNT_INVALID",
  ITEM_ID_SEQUENCE_INVALID: "ITEM_ID_SEQUENCE_INVALID",
  ITEM_KIND_ORDER_INVALID: "ITEM_KIND_ORDER_INVALID",
  DIAGNOSTIC_DIRECTION_INVALID: "DIAGNOSTIC_DIRECTION_INVALID",
  TREATMENT_DIRECTION_NOT_ALLOWLISTED: "TREATMENT_DIRECTION_NOT_ALLOWLISTED",
  VERIFICATION_ITEM_INVALID: "VERIFICATION_ITEM_INVALID",
  ADDITIONAL_CHECK_ITEM_INVALID: "ADDITIONAL_CHECK_ITEM_INVALID",
  DEFINITIVE_DIAGNOSIS: "DEFINITIVE_DIAGNOSIS",
  MEDICATION_EXECUTION_ACTION: "MEDICATION_EXECUTION_ACTION",
  DOSE_FREQUENCY_OR_COURSE: "DOSE_FREQUENCY_OR_COURSE",
  DIRECT_PATIENT_INSTRUCTION: "DIRECT_PATIENT_INSTRUCTION",
  CLINICAL_CAPABILITY_CLAIM: "CLINICAL_CAPABILITY_CLAIM",
  PROMPT_INJECTION: "PROMPT_INJECTION",
} as const;
export type ReferenceLanguageRuleId = typeof REFERENCE_LANGUAGE_RULE_IDS[keyof typeof REFERENCE_LANGUAGE_RULE_IDS];

export const REAL_OUTPUT_SCHEMA_RULE_IDS = {
  OUTPUT_ROOT_OBJECT_INVALID: "OUTPUT_ROOT_OBJECT_INVALID",
  OUTPUT_TOP_LEVEL_FIELDS_INVALID: "OUTPUT_TOP_LEVEL_FIELDS_INVALID",
  OUTPUT_SCHEMA_VERSION_INVALID: "OUTPUT_SCHEMA_VERSION_INVALID",
  OUTPUT_RECORD_FACT_IDS_SHAPE_INVALID: "OUTPUT_RECORD_FACT_IDS_SHAPE_INVALID",
  OUTPUT_ITEMS_ARRAY_INVALID: "OUTPUT_ITEMS_ARRAY_INVALID",
  ITEM_COUNT_INVALID: "ITEM_COUNT_INVALID",
  OUTPUT_ITEM_OBJECT_INVALID: "OUTPUT_ITEM_OBJECT_INVALID",
  OUTPUT_ITEM_FIELDS_INVALID: "OUTPUT_ITEM_FIELDS_INVALID",
  OUTPUT_ITEM_TEXT_SHAPE_INVALID: "OUTPUT_ITEM_TEXT_SHAPE_INVALID",
  OUTPUT_SUPPORTS_ARRAY_INVALID: "OUTPUT_SUPPORTS_ARRAY_INVALID",
  OUTPUT_SUPPORT_OBJECT_INVALID: "OUTPUT_SUPPORT_OBJECT_INVALID",
  OUTPUT_SUPPORT_FIELDS_INVALID: "OUTPUT_SUPPORT_FIELDS_INVALID",
  OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID: "OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID",
  OUTPUT_SUPPORT_QUOTE_SHAPE_INVALID: "OUTPUT_SUPPORT_QUOTE_SHAPE_INVALID",
} as const;
export type RealOutputSchemaRuleId = typeof REAL_OUTPUT_SCHEMA_RULE_IDS[keyof typeof REAL_OUTPUT_SCHEMA_RULE_IDS];

export type SafeRealProviderFailureStage =
  | "INPUT_INVALID"
  | "BUDGET_EXHAUSTED"
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "HTTP_FAILED"
  | "RESPONSE_JSON_INVALID"
  | "RESPONSE_ENVELOPE_INVALID"
  | "CHOICE_COUNT_INVALID"
  | "CHOICE_INVALID"
  | "FINISH_REASON_INVALID"
  | "REFUSAL_PRESENT"
  | "MODEL_ID_INVALID"
  | "CONTENT_INVALID"
  | "REASONING_CONTENT_INVALID"
  | "USAGE_INVALID"
  | "METADATA_INVALID"
  | "CONTENT_JSON_INVALID"
  | "OUTPUT_SCHEMA_INVALID"
  | "OUTPUT_ITEM_IDS_INVALID"
  | "OUTPUT_ITEM_KINDS_INVALID"
  | "OUTPUT_FACT_IDS_INVALID"
  | "OUTPUT_LANGUAGE_UNSAFE"
  | "OUTPUT_DEFINITIVE_DIAGNOSIS_UNSAFE"
  | "OUTPUT_PRESCRIPTION_OR_DOSE_UNSAFE"
  | "OUTPUT_DIRECT_PATIENT_INSTRUCTION_UNSAFE"
  | "OUTPUT_CLINICAL_CLAIM_UNSAFE"
  | "OUTPUT_PROMPT_INJECTION_UNSAFE"
  | "OUTPUT_GENERAL_SOURCE_CLAIM_UNSAFE"
  | "OUTPUT_EVIDENCE_SET_INVALID"
  | "OUTPUT_EVIDENCE_ID_INVALID"
  | "OUTPUT_QUOTE_NOT_SOURCE_SUBSTRING"
  | "OUTPUT_PII_REJECTED";

export type RealOutputItemIndex = 1 | 2 | 3 | 4;
export type ModelReferenceOutputDiagnostic = Readonly<{
  stage: SafeRealProviderFailureStage;
  ruleId?: ReferenceLanguageRuleId | RealOutputSchemaRuleId;
  itemIndex?: RealOutputItemIndex;
  itemKind?: ModelReferenceItemKind;
}>;

export type RealOutputValidationResult<T> =
  | { ok: true; output: T }
  | ({ ok: false; stage: SafeRealProviderFailureStage } & Omit<ModelReferenceOutputDiagnostic, "stage">);

const safeId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const safeRequestId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const sha256 = z.string().length(64).regex(/^[a-f0-9]{64}$/u);

function codePointString(maximum: number, minimum = 0) {
  return z.string().refine((value) => {
    const length = Array.from(value).length;
    return length >= minimum
      && length <= maximum
      // Control and bidi-override characters make bounded JSON displays and
      // copy/paste review unsafe; no PWR-08C contract needs them.
      && !/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value);
  }, `Expected ${minimum}-${maximum} safe code points.`);
}

export const modelReferenceKindSchema = z.enum(["GENERAL", "LITERATURE_GROUNDED"]);
export type ModelReferenceKind = z.infer<typeof modelReferenceKindSchema>;

export const modelReferenceEvidenceLevelSchema = z.enum([
  "GENERAL_MODEL_NO_LOCAL_EVIDENCE",
  "SELECTED_LOCAL_LITERATURE",
]);
export type ModelReferenceEvidenceLevel = z.infer<typeof modelReferenceEvidenceLevelSchema>;

export const modelReferenceItemKindSchema = z.enum([
  "NEEDS_VERIFICATION",
  "CONSIDERATION_DIRECTION",
  "ADDITIONAL_CHECK_OR_SOURCE",
]);
export type ModelReferenceItemKind = z.infer<typeof modelReferenceItemKindSchema>;

export const modelReferenceFactIdSchema = z.enum([
  "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11", "M12",
]);
export type ModelReferenceFactId = z.infer<typeof modelReferenceFactIdSchema>;

export const modelReferenceEvidenceIdSchema = z.enum(["E1", "E2", "E3", "E4", "E5"]);
export type ModelReferenceEvidenceId = z.infer<typeof modelReferenceEvidenceIdSchema>;

export const modelReferenceRequestSchema = z.object({
  referenceRequestId: safeRequestId,
  encounterId: safeId,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  expectedCurrentRecordRevisionId: safeId,
  kind: modelReferenceKindSchema,
  question: codePointString(200, 1),
  documentIds: z.array(safeId).max(3).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "GENERAL" && value.documentIds !== undefined) {
    context.addIssue({ code: "custom", path: ["documentIds"], message: "General references cannot carry documents." });
  }
  if (value.kind === "LITERATURE_GROUNDED" && (value.documentIds === undefined || value.documentIds.length === 0)) {
    context.addIssue({ code: "custom", path: ["documentIds"], message: "Grounded references require selected documents." });
  }
  if (value.documentIds !== undefined && new Set(value.documentIds).size !== value.documentIds.length) {
    context.addIssue({ code: "custom", path: ["documentIds"], message: "Documents must be unique." });
  }
});
export type ModelReferenceRequest = z.infer<typeof modelReferenceRequestSchema>;

export const modelReferenceSupportSchema = z.object({
  evidenceId: modelReferenceEvidenceIdSchema,
  quote: codePointString(160, 12),
}).strict();
export type ModelReferenceSupport = z.infer<typeof modelReferenceSupportSchema>;

const outputItemBaseSchema = z.object({
  itemId: z.string().regex(/^I[1-8]$/u),
  kind: modelReferenceItemKindSchema,
  text: codePointString(240, 1),
}).strict();

export const generalModelReferenceOutputSchema = z.object({
  schemaVersion: z.literal(MODEL_REFERENCE_SCHEMA_VERSION),
  recordFactIds: z.array(modelReferenceFactIdSchema).min(1).max(12),
  items: z.array(outputItemBaseSchema).min(1).max(MODEL_REFERENCE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (new Set(value.recordFactIds).size !== value.recordFactIds.length) {
    context.addIssue({ code: "custom", path: ["recordFactIds"], message: "Fact ids must be unique." });
  }
  if (new Set(value.items.map((item) => item.itemId)).size !== value.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Item ids must be unique." });
  }
});
export type GeneralModelReferenceOutput = z.infer<typeof generalModelReferenceOutputSchema>;

export const literatureGroundedModelReferenceOutputSchema = z.object({
  schemaVersion: z.literal(MODEL_REFERENCE_SCHEMA_VERSION),
  recordFactIds: z.array(modelReferenceFactIdSchema).min(1).max(12),
  items: z.array(outputItemBaseSchema.extend({
    supports: z.array(modelReferenceSupportSchema).min(1).max(3),
  }).strict().superRefine((item, context) => {
    if (new Set(item.supports.map((support) => support.evidenceId)).size !== item.supports.length) {
      context.addIssue({ code: "custom", path: ["supports"], message: "Evidence ids must be unique per item." });
    }
  })).min(1).max(MODEL_REFERENCE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (new Set(value.recordFactIds).size !== value.recordFactIds.length) {
    context.addIssue({ code: "custom", path: ["recordFactIds"], message: "Fact ids must be unique." });
  }
  if (new Set(value.items.map((item) => item.itemId)).size !== value.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Item ids must be unique." });
  }
});
export type LiteratureGroundedModelReferenceOutput = z.infer<typeof literatureGroundedModelReferenceOutputSchema>;

const realOutputItemBaseSchema = z.object({
  itemId: z.string().regex(/^I[1-4]$/u),
  kind: modelReferenceItemKindSchema,
  text: codePointString(REAL_MODEL_REFERENCE_MAX_TEXT, 1),
}).strict();

export const realGeneralModelReferenceOutputSchema = z.object({
  schemaVersion: z.literal(MODEL_REFERENCE_SCHEMA_VERSION),
  recordFactIds: z.array(modelReferenceFactIdSchema).min(1).max(12),
  items: z.array(realOutputItemBaseSchema).min(REAL_MODEL_REFERENCE_MIN_ITEMS).max(REAL_MODEL_REFERENCE_MAX_ITEMS),
}).strict();
export type RealGeneralModelReferenceOutput = z.infer<typeof realGeneralModelReferenceOutputSchema>;

export const realLiteratureGroundedModelReferenceOutputSchema = z.object({
  schemaVersion: z.literal(MODEL_REFERENCE_SCHEMA_VERSION),
  recordFactIds: z.array(modelReferenceFactIdSchema).min(1).max(12),
  items: z.array(realOutputItemBaseSchema.extend({
    supports: z.array(modelReferenceSupportSchema).min(1).max(REAL_MODEL_REFERENCE_MAX_SUPPORTS),
  }).strict()).min(REAL_MODEL_REFERENCE_MIN_ITEMS).max(REAL_MODEL_REFERENCE_MAX_ITEMS),
}).strict();
export type RealLiteratureGroundedModelReferenceOutput = z.infer<typeof realLiteratureGroundedModelReferenceOutputSchema>;

const realLiteratureGroundedWireOutputItemSchema = realOutputItemBaseSchema.extend({
  supportEvidenceIds: z.array(modelReferenceEvidenceIdSchema).min(1).max(REAL_MODEL_REFERENCE_MAX_SUPPORTS),
}).strict().superRefine((item, context) => {
  if (new Set(item.supportEvidenceIds).size !== item.supportEvidenceIds.length) {
    context.addIssue({ code: "custom", path: ["supportEvidenceIds"], message: "Evidence ids must be unique." });
  }
});

export const realLiteratureGroundedWireOutputSchema = z.object({
  schemaVersion: z.literal(MODEL_REFERENCE_SCHEMA_VERSION),
  recordFactIds: z.array(modelReferenceFactIdSchema).min(1).max(12),
  items: z.array(realLiteratureGroundedWireOutputItemSchema)
    .min(REAL_MODEL_REFERENCE_MIN_ITEMS)
    .max(REAL_MODEL_REFERENCE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (new Set(value.recordFactIds).size !== value.recordFactIds.length) {
    context.addIssue({ code: "custom", path: ["recordFactIds"], message: "Fact ids must be unique." });
  }
  if (new Set(value.items.map((item) => item.itemId)).size !== value.items.length) {
    context.addIssue({ code: "custom", path: ["items"], message: "Item ids must be unique." });
  }
});
export type RealLiteratureGroundedWireOutput = z.infer<typeof realLiteratureGroundedWireOutputSchema>;

export const controlledModelReferenceFactSchema = z.object({
  id: modelReferenceFactIdSchema,
  label: z.string().min(1).max(80),
  text: codePointString(300, 1),
}).strict();
export type ControlledModelReferenceFact = z.infer<typeof controlledModelReferenceFactSchema>;

export const controlledModelReferenceEvidenceSchema = z.object({
  id: modelReferenceEvidenceIdSchema,
  documentId: safeId,
  versionId: safeId,
  fragmentId: safeId,
  displayName: z.string().min(1).max(240),
  version: z.number().int().positive().max(1_000_000),
  excerpt: codePointString(600, 12),
  locationLabel: z.string().min(1).max(200),
}).strict();
export type ControlledModelReferenceEvidence = z.infer<typeof controlledModelReferenceEvidenceSchema>;

export const modelReferenceProviderRequestSchema = z.object({
  kind: modelReferenceKindSchema,
  promptVersion: z.enum([
    GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
    LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
    REAL_GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
    REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
  ]),
  question: codePointString(200, 1),
  facts: z.array(z.object({ id: modelReferenceFactIdSchema, text: codePointString(300, 1) }).strict()).min(1).max(12),
  evidence: z.array(z.object({ id: modelReferenceEvidenceIdSchema, excerpt: codePointString(600, 12) }).strict()).max(5),
}).strict().superRefine((value, context) => {
  const validPromptVersion = value.kind === "GENERAL"
    ? value.promptVersion === GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION
      || value.promptVersion === REAL_GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION
    : value.promptVersion === LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION
      || value.promptVersion === REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION;
  if (!validPromptVersion) {
    context.addIssue({ code: "custom", path: ["promptVersion"], message: "Prompt version must match the provider kind." });
  }
  if (value.kind === "GENERAL" && value.evidence.length !== 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "General model calls cannot include evidence." });
  }
  if (value.kind === "LITERATURE_GROUNDED" && value.evidence.length === 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Grounded model calls require evidence." });
  }
});
export type ModelReferenceProviderRequest = z.infer<typeof modelReferenceProviderRequestSchema>;

export const modelReferenceStoredResultSchema = z.object({
  referenceId: safeId,
  requestId: safeRequestId,
  encounterId: safeId,
  recordRevisionId: safeId,
  revisionNumber: z.number().int().positive().max(100_000),
  kind: modelReferenceKindSchema,
  evidenceLevel: modelReferenceEvidenceLevelSchema,
  question: codePointString(200, 1),
  providerId: z.string().min(1).max(100),
  modelId: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  promptDigest: sha256,
  createdAt: z.string().datetime({ offset: true }),
  items: z.array(z.object({
    id: safeId,
    kind: modelReferenceItemKindSchema,
    text: codePointString(240, 1),
    factIds: z.array(modelReferenceFactIdSchema).min(1).max(12),
    supports: z.array(modelReferenceSupportSchema).max(3),
  }).strict()).min(1).max(MODEL_REFERENCE_MAX_ITEMS),
}).strict();
export type ModelReferenceStoredResult = z.infer<typeof modelReferenceStoredResultSchema>;

export const modelReferenceFollowUpRequestSchema = z.object({
  followUpRequestId: safeRequestId,
  encounterId: safeId,
  referenceId: safeId,
  itemId: safeId,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ModelReferenceFollowUpRequest = z.infer<typeof modelReferenceFollowUpRequestSchema>;

const referencePromptInjectionPattern = /(?:忽略(?:以上|此前|先前)?(?:的)?(?:指令|要求|规则)|(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|earlier)?\s*(?:instructions?|prompts?)|(?:system|developer)\s+(?:prompt|message)|系统提示词|开发者消息)/iu;
const definitiveDiagnosisPattern = /(?:诊断\s*(?:为|是)|已(?:经)?\s*确诊|确定(?!\s*是否)\s*(?:是(?!\s*否)|为)|就是.{0,12}(?:疾病|病|症|癌|炎|综合征)|可排除|(?:已|已经)\s*排除|无需(?:再|进一步)?(?:检查|检验|评估)|不需要(?:再|进一步)?(?:检查|检验|评估)|diagnosed\s+(?:with|as)|confirmed\s+diagnosis|definitely\s+(?:has|is)|can\s+rule\s+out|rule\s+out|no\s+further\s+(?:tests?|examination))/iu;
const medicationActionPattern = /(?:服用|口服|服药|给予|用药(?!史|情况|记录|风险)|使用|\b(?:take|taking|use|using|start|starting|prescribe|prescribing)\b)/giu;
const medicationVerificationCueGlobalPattern = /(?:核对|确认|询问|了解|记录|是否|既往|曾经|目前|正在|给予过|(?:verify|confirm|ask|record|whether|previous(?:ly)?|formerly|currently|history)\b)/giu;
const medicationSequencePattern = /(?:无误后|完成后|之后|然后|后|再|\b(?:after|afterwards|then)\b)/iu;
const medicationDirectivePattern = /(?:建议|请|需要|需|必须|应|务必|可考虑|\b(?:recommend(?:ed)?|should|must|need(?:s)?\s+to|please|consider)\b)/iu;
const englishPrescriptionPattern = /(?:prescribe|prescription)\b|stop\s+(?:taking|using)\s+\S+|(?:consider\s+using|start|take|use)\s+(?:the\s+)?\S+|(?:increase|decrease)\s+(?:the\s+)?(?:(?:medication|drug)\s+)?(?:dose|dosage)\b/iu;
const chinesePrescriptionPattern = /(?:开(?:具|立)?\s*.{0,20}处方|处方\s*(?:为|是)|立即\s*(?:服药|服用|口服|使用|用药)|停药|加量|减量|自行\s*(?:调整|增减|停用).{0,12}(?:药物|用药|剂量)?|(?:建议|请|需要|需|必须|应|务必|可考虑|可|开始)?\s*(?<!是否)(?:服用|口服)\s*(?!过)\S+|开始\s*用药|给予\s*(?!过)\S+|(?:具体\s*)?(?:剂量|频次|疗程)\s*(?:为|是|[:：])\s*\S+|(?:每(?:日|天|次)|每日|每天|一日|早晚|疗程)\s*(?:服用|口服|使用)?\s*\d+(?:\.\d+)?\s*(?:mg|g|毫克|克|片|粒|袋|次|天|周|小时)|(?<!是否)(?<!既往)(?:服用|口服|给予)(?!过).{0,24}\d+(?:\.\d+)?\s*(?:mg|g|毫克|克|片|粒|袋|次|天|周|小时))/iu;
const nonMedicationUseTargetPattern = /^(?:评分量表|检查结果|检验结果|影像学结果|现有资料|参考资料|诊断工具|评估工具|方法|模型)(?=$|辅助|进行|作为|用于|来|以|并|和)/u;
const doseFrequencyCoursePattern = /(?:剂量|频次|疗程|每(?:日|天|次)|每日|每天|一日|早晚|\b(?:dose|dosage|frequency|course)\b|\d+(?:\.\d+)?\s*(?:mg|g|毫克|克|片|粒|袋|次|天|周|小时))/iu;
const directPatientInstructionPattern = /(?:(?:患者|病人)\s*(?:(?:应当?|应该|必须|务必|请|要|需要|需)\s*(?:立即|马上|立刻|自行)?\s*(?:服药|服用|口服|停药|加量|减量|调整剂量|调整用药|就医|去医院|就诊|开始用药)|自行\s*(?:服药|服用|口服|停药|加量|减量|调整剂量|调整用药|就医|去医院|就诊))|(?:the\s+)?patient\s+(?:(?:should|must|needs?\s+to|is\s+instructed\s+to)\s*(?:immediately\s+|right\s+away\s+|on\s+their\s+own\s+)?(?:take|stop|adjust|increase|decrease|go\s+to|seek)\b)|(?:你|您)\s*(?:应当?|应该|需|需要|必须|务必|请|要|should|must|need\s+to|have\s+to))/iu;
const clinicalClaimPattern = /(?:临床有效|(?:已经|已)\s*临床验证|可避免漏诊|不会漏诊|保证(?:诊断正确|安全|不漏诊)|可替代医生(?:判断)?|替代医生判断|clinically\s+(?:effective|validated|proven)|(?:guarantee|ensure)\s+(?:safety|a\s+correct\s+diagnosis|no\s+missed\s+diagnosis)|replace\s+(?:a|the)\s+doctor|prevent\s+missed\s+diagnos(?:is|es)|no\s+missed\s+diagnos(?:is|es))/iu;
const referenceLanguageUnsafeStages = new Set<SafeRealProviderFailureStage>([
  "OUTPUT_LANGUAGE_UNSAFE",
  "OUTPUT_DEFINITIVE_DIAGNOSIS_UNSAFE",
  "OUTPUT_PRESCRIPTION_OR_DOSE_UNSAFE",
  "OUTPUT_DIRECT_PATIENT_INSTRUCTION_UNSAFE",
  "OUTPUT_CLINICAL_CLAIM_UNSAFE",
  "OUTPUT_PROMPT_INJECTION_UNSAFE",
]);

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Derive the only quote the real grounded path may expose from controlled
 * evidence. The model supplies an evidence id, never quote text.
 */
export function canonicalEvidenceQuote(excerpt: string): string | undefined {
  if (typeof excerpt !== "string") return undefined;
  const characters = Array.from(excerpt);
  if (characters.length < 12 || characters.length > 600) return undefined;
  if (/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(excerpt)) return undefined;
  return characters.slice(0, REAL_MODEL_REFERENCE_MAX_TEXT).join("");
}

type MedicationActionContext = {
  action: string;
  before: string;
  after: string;
};

function splitReferenceClauses(value: string): string[] {
  return value.split(/[。！？!?；;，,.:：]/u).map((clause) => clause.trim()).filter(Boolean);
}

function medicationActionContexts(clause: string): MedicationActionContext[] {
  const actions = Array.from(clause.matchAll(medicationActionPattern));
  let previousEnd = 0;
  return actions.map((match, index) => {
    const start = match.index ?? 0;
    const action = match[0] ?? "";
    const end = start + action.length;
    const nextStart = actions[index + 1]?.index ?? clause.length;
    const context = {
      action,
      before: clause.slice(previousEnd, start),
      after: clause.slice(end, nextStart),
    };
    previousEnd = end;
    return context;
  });
}

function isAllowedNonMedicationTarget(value: string): boolean {
  return nonMedicationUseTargetPattern.test(value.trim());
}

function isMedicationVerificationActionContext(before: string, after: string): boolean {
  const cueMatches = Array.from(before.matchAll(medicationVerificationCueGlobalPattern));
  const hasPastFact = /^(?:过|过的|过哪些|过何种)/u.test(after.trim());
  if (cueMatches.length === 0 && !hasPastFact) return false;
  const lastCue = cueMatches.at(-1);
  const lastCueEnd = lastCue === undefined
    ? 0
    : (lastCue.index ?? 0) + lastCue[0].length;
  const afterLastCue = before.slice(lastCueEnd);
  if (medicationSequencePattern.test(before)) return false;
  if (medicationSequencePattern.test(afterLastCue)) return false;
  if (medicationDirectivePattern.test(afterLastCue)) return false;
  return true;
}

export function isDiagnosticDirectionRole(value: string): boolean {
  return REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST.includes(value as RealDiagnosticDirection);
}

export function isNeedsVerificationRole(value: string): boolean {
  return REAL_VERIFICATION_DIRECTION_ALLOWLIST.includes(value as RealVerificationDirection);
}

export function isAdditionalCheckOrSourceRole(value: string): boolean {
  return REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST.includes(value as RealAdditionalCheckOrSourceDirection);
}

export function isMedicationVerificationContext(value: string): boolean {
  const clauses = splitReferenceClauses(value);
  if (clauses.length !== 1) return false;
  const contexts = medicationActionContexts(clauses[0]!);
  return contexts.length === 1
    && isMedicationVerificationActionContext(contexts[0]!.before, contexts[0]!.after);
}

export function isAllowedNonMedicationUse(value: string): boolean {
  let foundUse = false;
  for (const clause of splitReferenceClauses(value)) {
    for (const context of medicationActionContexts(clause)) {
      if (context.action !== "使用") continue;
      foundUse = true;
      if (!isAllowedNonMedicationTarget(context.after)) return false;
    }
  }
  return foundUse;
}

export function hasUnsafeMedicationInstruction(value: string): boolean {
  let foundMedicationAction = false;
  for (const clause of splitReferenceClauses(value)) {
    for (const context of medicationActionContexts(clause)) {
      foundMedicationAction = true;
      if (isMedicationVerificationActionContext(context.before, context.after)) continue;
      if (context.action === "使用" && isAllowedNonMedicationTarget(context.after)) continue;
      return true;
    }
  }
  if (foundMedicationAction) return false;
  return chinesePrescriptionPattern.test(value) || englishPrescriptionPattern.test(value);
}

export function classifyReferenceItemLanguage(value: string): ReferenceLanguageSafetyResult {
  if (referencePromptInjectionPattern.test(value)) {
    return { ok: false, stage: "OUTPUT_PROMPT_INJECTION_UNSAFE" };
  }
  if (definitiveDiagnosisPattern.test(value)) {
    return { ok: false, stage: "OUTPUT_DEFINITIVE_DIAGNOSIS_UNSAFE" };
  }
  if (directPatientInstructionPattern.test(value)) {
    return { ok: false, stage: "OUTPUT_DIRECT_PATIENT_INSTRUCTION_UNSAFE" };
  }
  if (hasUnsafeMedicationInstruction(value)) {
    return { ok: false, stage: "OUTPUT_PRESCRIPTION_OR_DOSE_UNSAFE" };
  }
  if (clinicalClaimPattern.test(value)) {
    return { ok: false, stage: "OUTPUT_CLINICAL_CLAIM_UNSAFE" };
  }
  return { ok: true };
}

export function validateReferenceItemLanguage(value: string): boolean {
  return classifyReferenceItemLanguage(value).ok;
}

export function validateOutputShape(
  kind: ModelReferenceKind,
  raw: unknown,
): GeneralModelReferenceOutput | LiteratureGroundedModelReferenceOutput {
  const parsed = kind === "GENERAL"
    ? generalModelReferenceOutputSchema.safeParse(raw)
    : literatureGroundedModelReferenceOutputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("MODEL_REFERENCE_OUTPUT_INVALID");
  const counts = new Map<ModelReferenceItemKind, number>();
  for (const item of parsed.data.items) {
    if (!validateReferenceItemLanguage(item.text)) throw new Error("MODEL_REFERENCE_OUTPUT_UNSAFE");
    const next = (counts.get(item.kind) ?? 0) + 1;
    if (next > 4) throw new Error("MODEL_REFERENCE_OUTPUT_INVALID");
    counts.set(item.kind, next);
  }
  if (kind === "GENERAL" && parsed.data.items.some((item) => /(?:指南|文献|研究|证据显示|guideline|literature|study)/iu.test(item.text))) {
    throw new Error("MODEL_REFERENCE_OUTPUT_UNSAFE");
  }
  return parsed.data;
}

const realItemKindOrder = [
  "CONSIDERATION_DIRECTION",
  "CONSIDERATION_DIRECTION",
  "NEEDS_VERIFICATION",
  "ADDITIONAL_CHECK_OR_SOURCE",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeItemKind(value: unknown): ModelReferenceItemKind | undefined {
  return value === "NEEDS_VERIFICATION"
    || value === "CONSIDERATION_DIRECTION"
    || value === "ADDITIONAL_CHECK_OR_SOURCE"
    ? value
    : undefined;
}

function safeItemIndex(index: number): RealOutputItemIndex | undefined {
  return index >= 0 && index < 4 ? (index + 1) as RealOutputItemIndex : undefined;
}

const realOutputTopLevelKeys = ["schemaVersion", "recordFactIds", "items"] as const;
const realGeneralOutputItemKeys = ["itemId", "kind", "text"] as const;
const realGroundedFinalOutputItemKeys = ["itemId", "kind", "text", "supports"] as const;
const realGroundedWireOutputItemKeys = ["itemId", "kind", "text", "supportEvidenceIds"] as const;
const realOutputSupportKeys = ["evidenceId", "quote"] as const;
const realFactIdPattern = /^M(?:[1-9]|1[0-2])$/u;
const realEvidenceIdPattern = /^E[1-5]$/u;
const realItemIdPattern = /^I[1-4]$/u;
const realOutputUnsafeCharacterPattern = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;

function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === requiredKeys.length
    && requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSafeRealOutputString(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum && !realOutputUnsafeCharacterPattern.test(value);
}

function realSchemaFailure(
  ruleId: RealOutputSchemaRuleId,
  itemIndex?: RealOutputItemIndex,
  itemKind?: ModelReferenceItemKind,
): RealOutputValidationResult<never> {
  return realOutputFailure("OUTPUT_SCHEMA_INVALID", {
    ruleId,
    ...(itemIndex === undefined ? {} : { itemIndex }),
    ...(itemKind === undefined ? {} : { itemKind }),
  });
}

function realOutputSchemaFailure(
  kind: ModelReferenceKind,
  raw: unknown,
): RealOutputValidationResult<never> | undefined {
  if (!isRecord(raw)) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ROOT_OBJECT_INVALID);
  }
  if (!hasExactKeys(raw, realOutputTopLevelKeys)) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_TOP_LEVEL_FIELDS_INVALID);
  }
  if (raw.schemaVersion !== MODEL_REFERENCE_SCHEMA_VERSION) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SCHEMA_VERSION_INVALID);
  }
  if (!Array.isArray(raw.recordFactIds)
    || raw.recordFactIds.length < 1
    || raw.recordFactIds.length > 12
    || raw.recordFactIds.some((value) => typeof value !== "string" || !realFactIdPattern.test(value))) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_RECORD_FACT_IDS_SHAPE_INVALID);
  }
  if (!Array.isArray(raw.items)) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEMS_ARRAY_INVALID);
  }
  if (raw.items.length !== REAL_MODEL_REFERENCE_ITEM_COUNT) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.ITEM_COUNT_INVALID);
  }

  const expectedItemKeys = kind === "GENERAL"
    ? realGeneralOutputItemKeys
    : realGroundedFinalOutputItemKeys;
  for (const [index, rawItem] of raw.items.entries()) {
    const itemIndex = safeItemIndex(index);
    if (!isRecord(rawItem)) {
      return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_OBJECT_INVALID, itemIndex);
    }
    const itemKind = safeItemKind(rawItem.kind);
    if (!hasExactKeys(rawItem, expectedItemKeys)
      || typeof rawItem.itemId !== "string"
      || !realItemIdPattern.test(rawItem.itemId)
      || typeof rawItem.kind !== "string"
      || itemKind === undefined) {
      return realSchemaFailure(
        REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
        itemIndex,
        itemKind,
      );
    }
    if (!isSafeRealOutputString(rawItem.text, 1, REAL_MODEL_REFERENCE_MAX_TEXT)) {
      return realSchemaFailure(
        REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_TEXT_SHAPE_INVALID,
        itemIndex,
        itemKind,
      );
    }
    if (kind === "GENERAL") continue;

    if (!Array.isArray(rawItem.supports)
      || rawItem.supports.length < 1
      || rawItem.supports.length > REAL_MODEL_REFERENCE_MAX_SUPPORTS) {
      return realSchemaFailure(
        REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORTS_ARRAY_INVALID,
        itemIndex,
        itemKind,
      );
    }
    for (const rawSupport of rawItem.supports) {
      if (!isRecord(rawSupport)) {
        return realSchemaFailure(
          REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_OBJECT_INVALID,
          itemIndex,
          itemKind,
        );
      }
      if (!hasExactKeys(rawSupport, realOutputSupportKeys)) {
        return realSchemaFailure(
          REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_FIELDS_INVALID,
          itemIndex,
          itemKind,
        );
      }
      if (typeof rawSupport.evidenceId !== "string" || !realEvidenceIdPattern.test(rawSupport.evidenceId)) {
        return realSchemaFailure(
          REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID,
          itemIndex,
          itemKind,
        );
      }
      if (!isSafeRealOutputString(rawSupport.quote, 12, REAL_MODEL_REFERENCE_MAX_TEXT)) {
        return realSchemaFailure(
          REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_QUOTE_SHAPE_INVALID,
          itemIndex,
          itemKind,
        );
      }
    }
  }
  return undefined;
}

function realOutputFailure(
  stage: SafeRealProviderFailureStage,
  metadata: Omit<ModelReferenceOutputDiagnostic, "stage"> = {},
): RealOutputValidationResult<never> {
  return {
    ok: false,
    stage,
    ...(metadata.ruleId === undefined ? {} : { ruleId: metadata.ruleId }),
    ...(metadata.itemIndex === undefined ? {} : { itemIndex: metadata.itemIndex }),
    ...(metadata.itemKind === undefined ? {} : { itemKind: metadata.itemKind }),
  };
}

function rawRoleContractFailure(raw: unknown): RealOutputValidationResult<never> | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  for (const [index, item] of raw.items.entries()) {
    if (!isRecord(item)) continue;
    const itemIndex = safeItemIndex(index);
    const itemKind = safeItemKind(item.kind);
    if (typeof item.itemId === "string" && item.itemId !== `I${index + 1}`) {
      return realOutputFailure("OUTPUT_ITEM_IDS_INVALID", {
        ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_ID_SEQUENCE_INVALID,
        ...(itemIndex === undefined ? {} : { itemIndex }),
        ...(itemKind === undefined ? {} : { itemKind }),
      });
    }
    if (itemKind !== undefined && itemKind !== realItemKindOrder[index]) {
      return realOutputFailure("OUTPUT_ITEM_KINDS_INVALID", {
        ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_KIND_ORDER_INVALID,
        ...(itemIndex === undefined ? {} : { itemIndex }),
        itemKind,
      });
    }
  }
  return undefined;
}

function realGroundedWireSchemaFailure(raw: unknown): RealOutputValidationResult<never> | undefined {
  if (!isRecord(raw)) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ROOT_OBJECT_INVALID);
  }
  if (!hasExactKeys(raw, realOutputTopLevelKeys)) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_TOP_LEVEL_FIELDS_INVALID);
  }
  if (raw.schemaVersion !== MODEL_REFERENCE_SCHEMA_VERSION) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SCHEMA_VERSION_INVALID);
  }
  if (!Array.isArray(raw.recordFactIds)
    || raw.recordFactIds.length < 1
    || raw.recordFactIds.length > 12
    || raw.recordFactIds.some((value) => typeof value !== "string" || !realFactIdPattern.test(value))) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_RECORD_FACT_IDS_SHAPE_INVALID);
  }
  if (!Array.isArray(raw.items)) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEMS_ARRAY_INVALID);
  }
  if (raw.items.length !== REAL_MODEL_REFERENCE_ITEM_COUNT) {
    return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.ITEM_COUNT_INVALID);
  }
  for (const [index, rawItem] of raw.items.entries()) {
    const itemIndex = safeItemIndex(index);
    if (!isRecord(rawItem)) {
      return realSchemaFailure(REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_OBJECT_INVALID, itemIndex);
    }
    const itemKind = safeItemKind(rawItem.kind);
    if (!hasExactKeys(rawItem, realGroundedWireOutputItemKeys)
      || typeof rawItem.itemId !== "string"
      || !realItemIdPattern.test(rawItem.itemId)
      || typeof rawItem.kind !== "string"
      || itemKind === undefined) {
      return realSchemaFailure(
        REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
        itemIndex,
        itemKind,
      );
    }
    if (!isSafeRealOutputString(rawItem.text, 1, REAL_MODEL_REFERENCE_MAX_TEXT)) {
      return realSchemaFailure(
        REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_TEXT_SHAPE_INVALID,
        itemIndex,
        itemKind,
      );
    }
    if (!Array.isArray(rawItem.supportEvidenceIds)
      || rawItem.supportEvidenceIds.length < 1
      || rawItem.supportEvidenceIds.length > REAL_MODEL_REFERENCE_MAX_SUPPORTS
      || new Set(rawItem.supportEvidenceIds).size !== rawItem.supportEvidenceIds.length) {
      return realSchemaFailure(
        REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORTS_ARRAY_INVALID,
        itemIndex,
        itemKind,
      );
    }
    if (rawItem.supportEvidenceIds.some((value) => typeof value !== "string" || !realEvidenceIdPattern.test(value))) {
      return realSchemaFailure(
        REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID,
        itemIndex,
        itemKind,
      );
    }
  }
  return undefined;
}

function validateRealItemKinds(items: readonly { kind: ModelReferenceItemKind }[]): boolean {
  return items.length === realItemKindOrder.length
    && items.every((item, index) => item.kind === realItemKindOrder[index]);
}

function validateRealItemIds(items: readonly { itemId: string }[]): boolean {
  return items.length === REAL_MODEL_REFERENCE_ITEM_COUNT
    && !items.some((item, index) => item.itemId !== `I${index + 1}`);
}

function validateRealFactIds(
  recordFactIds: readonly ModelReferenceFactId[],
  facts: readonly { id: ModelReferenceFactId }[],
): boolean {
  if (recordFactIds.length !== facts.length) return false;
  if (new Set(recordFactIds).size !== recordFactIds.length) return false;
  const allowed = facts.map((fact) => fact.id);
  return recordFactIds.every((id, index) => id === allowed[index]);
}

function languageRuleId(stage: ReferenceLanguageSafetyStage, text: string): ReferenceLanguageRuleId | undefined {
  if (stage === "OUTPUT_DEFINITIVE_DIAGNOSIS_UNSAFE") return REFERENCE_LANGUAGE_RULE_IDS.DEFINITIVE_DIAGNOSIS;
  if (stage === "OUTPUT_PRESCRIPTION_OR_DOSE_UNSAFE") {
    return doseFrequencyCoursePattern.test(text)
      ? REFERENCE_LANGUAGE_RULE_IDS.DOSE_FREQUENCY_OR_COURSE
      : REFERENCE_LANGUAGE_RULE_IDS.MEDICATION_EXECUTION_ACTION;
  }
  if (stage === "OUTPUT_DIRECT_PATIENT_INSTRUCTION_UNSAFE") return REFERENCE_LANGUAGE_RULE_IDS.DIRECT_PATIENT_INSTRUCTION;
  if (stage === "OUTPUT_CLINICAL_CLAIM_UNSAFE") return REFERENCE_LANGUAGE_RULE_IDS.CLINICAL_CAPABILITY_CLAIM;
  if (stage === "OUTPUT_PROMPT_INJECTION_UNSAFE") return REFERENCE_LANGUAGE_RULE_IDS.PROMPT_INJECTION;
  return undefined;
}

function roleOutputFailure(
  items: readonly { kind: ModelReferenceItemKind; text: string }[],
  allowGeneralSourceClaims: boolean,
): RealOutputValidationResult<never> | undefined {
  for (const [index, item] of items.entries()) {
    const itemIndex = safeItemIndex(index);
    const language = classifyReferenceItemLanguage(item.text);
    if (!language.ok) {
      const ruleId = languageRuleId(language.stage, item.text);
      return realOutputFailure(language.stage, {
        ...(ruleId === undefined ? {} : { ruleId }),
        ...(itemIndex === undefined ? {} : { itemIndex }),
        itemKind: item.kind,
      });
    }
  }
  if (allowGeneralSourceClaims && items.some((item) => /(?:指南|文献|研究|证据显示|guideline|literature|study)/iu.test(item.text))) {
    return realOutputFailure("OUTPUT_GENERAL_SOURCE_CLAIM_UNSAFE");
  }

  const [diagnostic, treatment, verification, additional] = items;
  if (diagnostic === undefined || !isDiagnosticDirectionRole(diagnostic.text)) {
    return realOutputFailure("OUTPUT_LANGUAGE_UNSAFE", {
      ruleId: REFERENCE_LANGUAGE_RULE_IDS.DIAGNOSTIC_DIRECTION_INVALID,
      itemIndex: 1,
      ...(diagnostic === undefined ? {} : { itemKind: diagnostic.kind }),
    });
  }
  if (treatment === undefined || !REAL_TREATMENT_DIRECTION_ALLOWLIST.includes(treatment.text as RealTreatmentDirection)) {
    return realOutputFailure("OUTPUT_LANGUAGE_UNSAFE", {
      ruleId: REFERENCE_LANGUAGE_RULE_IDS.TREATMENT_DIRECTION_NOT_ALLOWLISTED,
      itemIndex: 2,
      ...(treatment === undefined ? {} : { itemKind: treatment.kind }),
    });
  }
  if (verification === undefined || !isNeedsVerificationRole(verification.text)) {
    return realOutputFailure("OUTPUT_LANGUAGE_UNSAFE", {
      ruleId: REFERENCE_LANGUAGE_RULE_IDS.VERIFICATION_ITEM_INVALID,
      itemIndex: 3,
      ...(verification === undefined ? {} : { itemKind: verification.kind }),
    });
  }
  if (additional === undefined || !isAdditionalCheckOrSourceRole(additional.text)) {
    return realOutputFailure("OUTPUT_LANGUAGE_UNSAFE", {
      ruleId: REFERENCE_LANGUAGE_RULE_IDS.ADDITIONAL_CHECK_ITEM_INVALID,
      itemIndex: 4,
      ...(additional === undefined ? {} : { itemKind: additional.kind }),
    });
  }
  return undefined;
}

export function validateRealOutputShapeResult(
  kind: ModelReferenceKind,
  raw: unknown,
  facts: readonly { id: ModelReferenceFactId }[],
  evidence: readonly { id: ModelReferenceEvidenceId; excerpt: string }[],
): RealOutputValidationResult<RealGeneralModelReferenceOutput | RealLiteratureGroundedModelReferenceOutput> {
  const rawSchemaFailure = realOutputSchemaFailure(kind, raw);
  if (rawSchemaFailure !== undefined) return rawSchemaFailure;
  const rawRoleFailure = rawRoleContractFailure(raw);
  if (rawRoleFailure !== undefined) return rawRoleFailure;
  if (kind === "GENERAL") {
    const parsed = realGeneralModelReferenceOutputSchema.safeParse(raw);
    if (!parsed.success) return realOutputFailure("OUTPUT_SCHEMA_INVALID");
    if (!validateRealItemIds(parsed.data.items)) return realOutputFailure("OUTPUT_ITEM_IDS_INVALID", { ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_ID_SEQUENCE_INVALID });
    if (!validateRealItemKinds(parsed.data.items)) return realOutputFailure("OUTPUT_ITEM_KINDS_INVALID", { ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_KIND_ORDER_INVALID });
    if (!validateRealFactIds(parsed.data.recordFactIds, facts)) return realOutputFailure("OUTPUT_FACT_IDS_INVALID");
    const roleFailure = roleOutputFailure(parsed.data.items, true);
    if (roleFailure !== undefined) return roleFailure;
    return { ok: true, output: parsed.data };
  }

  const parsed = realLiteratureGroundedModelReferenceOutputSchema.safeParse(raw);
  if (!parsed.success) return realOutputFailure("OUTPUT_SCHEMA_INVALID");
  if (!validateRealItemIds(parsed.data.items)) return realOutputFailure("OUTPUT_ITEM_IDS_INVALID", { ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_ID_SEQUENCE_INVALID });
  if (!validateRealItemKinds(parsed.data.items)) return realOutputFailure("OUTPUT_ITEM_KINDS_INVALID", { ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_KIND_ORDER_INVALID });
  if (!validateRealFactIds(parsed.data.recordFactIds, facts)) return realOutputFailure("OUTPUT_FACT_IDS_INVALID");
  const roleFailure = roleOutputFailure(parsed.data.items, false);
  if (roleFailure !== undefined) return roleFailure;
  const allowedEvidence = new Map(evidence.map((item) => [item.id, item.excerpt]));
  if (allowedEvidence.size !== evidence.length || allowedEvidence.size === 0) {
    return realOutputFailure("OUTPUT_EVIDENCE_SET_INVALID");
  }
  for (const item of parsed.data.items) {
    for (const support of item.supports) {
      const excerpt = allowedEvidence.get(support.evidenceId);
      if (excerpt === undefined) return realOutputFailure("OUTPUT_EVIDENCE_ID_INVALID");
      if (!excerpt.includes(support.quote)) return realOutputFailure("OUTPUT_QUOTE_NOT_SOURCE_SUBSTRING");
    }
  }
  return { ok: true, output: parsed.data };
}

export function validateRealLiteratureGroundedWireOutputResult(
  raw: unknown,
  facts: readonly { id: ModelReferenceFactId }[],
  evidence: readonly { id: ModelReferenceEvidenceId; excerpt: string }[],
): RealOutputValidationResult<RealLiteratureGroundedWireOutput> {
  const rawSchemaFailure = realGroundedWireSchemaFailure(raw);
  if (rawSchemaFailure !== undefined) return rawSchemaFailure;
  const rawRoleFailure = rawRoleContractFailure(raw);
  if (rawRoleFailure !== undefined) return rawRoleFailure;
  const parsed = realLiteratureGroundedWireOutputSchema.safeParse(raw);
  if (!parsed.success) return realOutputFailure("OUTPUT_SCHEMA_INVALID");
  if (!validateRealItemIds(parsed.data.items)) {
    return realOutputFailure("OUTPUT_ITEM_IDS_INVALID", { ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_ID_SEQUENCE_INVALID });
  }
  if (!validateRealItemKinds(parsed.data.items)) {
    return realOutputFailure("OUTPUT_ITEM_KINDS_INVALID", { ruleId: REFERENCE_LANGUAGE_RULE_IDS.ITEM_KIND_ORDER_INVALID });
  }
  if (!validateRealFactIds(parsed.data.recordFactIds, facts)) {
    return realOutputFailure("OUTPUT_FACT_IDS_INVALID");
  }
  const roleFailure = roleOutputFailure(parsed.data.items, false);
  if (roleFailure !== undefined) return roleFailure;
  const allowedEvidence = new Map(evidence.map((item) => [item.id, item.excerpt]));
  if (allowedEvidence.size !== evidence.length || allowedEvidence.size === 0) {
    return realOutputFailure("OUTPUT_EVIDENCE_SET_INVALID");
  }
  for (const item of parsed.data.items) {
    for (const evidenceId of item.supportEvidenceIds) {
      if (!allowedEvidence.has(evidenceId)) return realOutputFailure("OUTPUT_EVIDENCE_ID_INVALID");
    }
  }
  return { ok: true, output: parsed.data };
}

export function hydrateRealLiteratureGroundedWireOutput(
  wire: RealLiteratureGroundedWireOutput,
  facts: readonly { id: ModelReferenceFactId }[],
  evidence: readonly { id: ModelReferenceEvidenceId; excerpt: string }[],
): RealOutputValidationResult<LiteratureGroundedModelReferenceOutput> {
  const evidenceById = new Map(evidence.map((item) => [item.id, item.excerpt]));
  if (evidenceById.size !== evidence.length || evidenceById.size === 0) {
    return realOutputFailure("OUTPUT_EVIDENCE_SET_INVALID");
  }
  const items: LiteratureGroundedModelReferenceOutput["items"] = [];
  for (const [index, item] of wire.items.entries()) {
    const supports: LiteratureGroundedModelReferenceOutput["items"][number]["supports"] = [];
    for (const evidenceId of item.supportEvidenceIds) {
      const excerpt = evidenceById.get(evidenceId);
      if (excerpt === undefined) {
        return realOutputFailure("OUTPUT_EVIDENCE_ID_INVALID", {
          itemIndex: safeItemIndex(index),
          itemKind: item.kind,
        });
      }
      const quote = canonicalEvidenceQuote(excerpt);
      if (quote === undefined) {
        return realOutputFailure("OUTPUT_SCHEMA_INVALID", {
          ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_QUOTE_SHAPE_INVALID,
          itemIndex: safeItemIndex(index),
          itemKind: item.kind,
        });
      }
      supports.push({ evidenceId, quote });
    }
    items.push({
      itemId: item.itemId,
      kind: item.kind,
      text: item.text,
      supports,
    });
  }
  const hydrated: LiteratureGroundedModelReferenceOutput = {
    schemaVersion: wire.schemaVersion,
    recordFactIds: [...wire.recordFactIds],
    items,
  };
  const finalValidation = validateRealOutputShapeResult("LITERATURE_GROUNDED", hydrated, facts, evidence);
  if (!finalValidation.ok) return finalValidation;
  return { ok: true, output: finalValidation.output as LiteratureGroundedModelReferenceOutput };
}

export function validateRealOutputShape(
  kind: ModelReferenceKind,
  raw: unknown,
  facts: readonly { id: ModelReferenceFactId }[],
  evidence: readonly { id: ModelReferenceEvidenceId; excerpt: string }[],
): RealGeneralModelReferenceOutput | RealLiteratureGroundedModelReferenceOutput {
  const result = validateRealOutputShapeResult(kind, raw, facts, evidence);
  if (!result.ok) {
    throw new Error(referenceLanguageUnsafeStages.has(result.stage) || result.stage === "OUTPUT_GENERAL_SOURCE_CLAIM_UNSAFE"
      ? "MODEL_REFERENCE_OUTPUT_UNSAFE"
      : "MODEL_REFERENCE_OUTPUT_INVALID");
  }
  return result.output;
}
