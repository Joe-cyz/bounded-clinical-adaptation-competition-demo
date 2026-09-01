import { z } from "zod";

import {
  generatedDraftSchema,
  institutionalSafetyCoreSchema,
  mandatoryFieldSchema,
  physicianPreferenceSchema,
  sectionKeySchema,
  syntheticCaseSchema,
} from "./schemas";
import { providerMetadataSchema } from "./provider";

export const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export type JsonPrimitive = z.infer<typeof jsonPrimitiveSchema>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  jsonPrimitiveSchema,
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const isoUtcTimestampSchema = z.string().regex(utcTimestampPattern).superRefine((value, context) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/);
  if (!match) return;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year >= 0 && year <= 99) candidate.setUTCFullYear(year);

  if (
    Number.isNaN(candidate.getTime())
    || candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
    || candidate.getUTCHours() !== hour
    || candidate.getUTCMinutes() !== minute
    || candidate.getUTCSeconds() !== second
  ) {
    context.addIssue({ code: "custom", message: "Timestamp must be a valid UTC instant." });
  }
});

const schemaVersionSchema = z.literal("1.0.0");
const versionedReferenceSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
}).strict();
const caseReferenceSchema = versionedReferenceSchema.extend({
  specialty: z.string().min(1).max(200),
  visitType: z.string().min(1).max(200),
}).strict();
const policyReferenceSchema = versionedReferenceSchema.extend({
  specialty: z.string().min(1).max(200),
  visitType: z.string().min(1).max(200),
  approvalScope: z.literal("DEMO_ONLY"),
}).strict();
const profileReferenceSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.number().int().positive(),
}).strict();
const effectiveSafetyRulesSchema = z.object({
  mandatoryFields: z.array(mandatoryFieldSchema).min(1),
  prohibitedActions: z.array(z.string().min(1).max(200)).min(1),
  draftDisclaimer: z.string().min(1).max(1000),
  allowedEvidenceSources: institutionalSafetyCoreSchema.shape.allowedEvidenceSources,
  approvalRequirements: z.array(z.string().min(1).max(200)).min(1),
}).strict();
const effectivePresentationSchema = physicianPreferenceSchema.omit({ sectionOrder: true });
const effectiveConfigProvenanceSchema = z.object({
  dataset: z.literal("VERSIONED_SYNTHETIC_SEED"),
  case: z.literal("VERSIONED_SYNTHETIC_CASE"),
  safetyCore: z.literal("INSTITUTIONAL_SAFETY_CORE"),
  policy: z.literal("APPROVED_DEMO_ONLY_SPECIALTY_VISIT_POLICY"),
  profile: z.enum(["SYNTHETIC_PHYSICIAN_PROFILE", "NOT_USED"]),
  sectionOrder: z.enum(["SPECIALTY_POLICY", "PHYSICIAN_PROFILE"]),
  requiredSections: z.literal("SAFETY_CORE_AND_SPECIALTY_POLICY"),
  terminologyRules: z.literal("SPECIALTY_POLICY"),
  presentation: z.enum(["GENERIC_DEFAULTS", "PHYSICIAN_PROFILE"]),
}).strict();
const effectiveVersionSummarySchema = z.object({
  datasetVersion: z.string().min(1).max(100),
  caseVersion: z.string().min(1).max(100),
  safetyCoreVersion: z.string().min(1).max(100),
  policyVersion: z.string().min(1).max(100),
  profileVersion: z.number().int().positive().optional(),
}).strict();

export const effectiveGenerationConfigSchema = z.object({
  schemaVersion: schemaVersionSchema,
  mode: z.enum(["GENERIC", "BOUNDED"]),
  caseRef: caseReferenceSchema,
  safetyCoreRef: versionedReferenceSchema,
  policyRef: policyReferenceSchema,
  profileRef: profileReferenceSchema.optional(),
  requiredSections: z.array(sectionKeySchema).min(1),
  sectionOrder: z.array(sectionKeySchema).min(1),
  presentation: effectivePresentationSchema,
  terminologyRules: z.record(z.string(), z.string()),
  safety: effectiveSafetyRulesSchema,
  provenance: effectiveConfigProvenanceSchema,
  versionSummary: effectiveVersionSummarySchema,
  configurationKey: z.string().min(1).max(1000),
}).strict().superRefine((config, context) => {
  if (!config.requiredSections.includes("draftDisclaimer")) {
    context.addIssue({
      code: "custom",
      path: ["requiredSections"],
      message: "Effective configuration must require draftDisclaimer.",
    });
  }

  for (const field of config.safety.mandatoryFields) {
    if (!config.requiredSections.includes(field)) {
      context.addIssue({
        code: "custom",
        path: ["requiredSections"],
        message: "Effective configuration dropped an institutional mandatory field.",
      });
      break;
    }
  }

  if (!config.sectionOrder.includes("draftDisclaimer")) {
    context.addIssue({
      code: "custom",
      path: ["sectionOrder"],
      message: "Effective configuration must include draftDisclaimer in sectionOrder.",
    });
  }

  if (config.policyRef.specialty !== config.caseRef.specialty || config.policyRef.visitType !== config.caseRef.visitType) {
    context.addIssue({
      code: "custom",
      path: ["policyRef"],
      message: "Policy reference must match the case reference.",
    });
  }

  if (config.mode === "GENERIC" && (config.profileRef || config.versionSummary.profileVersion !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["profileRef"],
      message: "Generic configuration cannot contain a physician profile reference.",
    });
  }

  if (config.mode === "BOUNDED" && !config.profileRef) {
    context.addIssue({
      code: "custom",
      path: ["profileRef"],
      message: "Bounded configuration requires a physician profile reference.",
    });
  }

  if (config.profileRef && config.versionSummary.profileVersion !== config.profileRef.version) {
    context.addIssue({
      code: "custom",
      path: ["versionSummary", "profileVersion"],
      message: "Profile version summary must match profileRef.",
    });
  }

  const referenceChecks: Array<[string, string, string]> = [
    ["caseRef", config.caseRef.version, config.versionSummary.caseVersion],
    ["safetyCoreRef", config.safetyCoreRef.version, config.versionSummary.safetyCoreVersion],
    ["policyRef", config.policyRef.version, config.versionSummary.policyVersion],
  ];
  for (const [field, referenceVersion, summaryVersion] of referenceChecks) {
    if (referenceVersion !== summaryVersion) {
      context.addIssue({
        code: "custom",
        path: ["versionSummary", field],
        message: "Version summary must match the corresponding reference.",
      });
    }
  }
});

export type EffectiveGenerationConfig = z.infer<typeof effectiveGenerationConfigSchema>;
export type EffectiveSafetyRules = z.infer<typeof effectiveSafetyRulesSchema>;
export type EffectivePresentation = z.infer<typeof effectivePresentationSchema>;
export type EffectiveConfigProvenance = z.infer<typeof effectiveConfigProvenanceSchema>;
export type EffectiveVersionSummary = z.infer<typeof effectiveVersionSummarySchema>;
export type VersionedReference = z.infer<typeof versionedReferenceSchema>;
export type CaseReference = z.infer<typeof caseReferenceSchema>;
export type PolicyReference = z.infer<typeof policyReferenceSchema>;
export type ProfileReference = z.infer<typeof profileReferenceSchema>;

export const generationRunStatusSchema = z.enum(["SUCCEEDED", "FAILED"]);
export const generationErrorTypeSchema = z.enum([
  "INPUT_VALIDATION",
  "CONFIGURATION_INVALID",
  "OUTPUT_VALIDATION",
  "PROVIDER",
  "PERSISTENCE",
  "UNKNOWN",
]);

export const generationRunRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(200),
  status: generationRunStatusSchema,
  mode: z.enum(["GENERIC", "BOUNDED"]),
  caseId: z.string().min(1).max(200),
  caseVersion: z.string().min(1).max(100),
  datasetVersion: z.string().min(1).max(100),
  safetyCoreId: z.string().min(1).max(200),
  safetyCoreVersion: z.string().min(1).max(100),
  policyId: z.string().min(1).max(200),
  policyVersion: z.string().min(1).max(100),
  profileId: z.string().min(1).max(200).optional(),
  profileVersion: z.number().int().positive().optional(),
  configurationKey: z.string().min(1).max(1000),
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(200),
  providerMetadata: providerMetadataSchema.optional(),
  inputCaseSnapshot: syntheticCaseSchema,
  effectiveConfigSnapshot: effectiveGenerationConfigSchema,
  outputDraftSnapshot: generatedDraftSchema.optional(),
  inputValidationSummary: jsonObjectSchema,
  outputValidationSummary: jsonObjectSchema,
  errorType: generationErrorTypeSchema.optional(),
  errorMessage: z.string().min(1).max(240).optional(),
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((record, context) => {
  const addIssue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });

  if (record.status === "SUCCEEDED") {
    if (!record.outputDraftSnapshot) addIssue(["outputDraftSnapshot"], "Successful run must contain an output snapshot.");
    if (record.errorType || record.errorMessage) addIssue(["errorType"], "Successful run cannot contain an error.");
  }

  if (record.status === "FAILED") {
    if (record.outputDraftSnapshot) addIssue(["outputDraftSnapshot"], "Failed run cannot contain an output snapshot.");
    if (!record.errorType || !record.errorMessage) addIssue(["errorType"], "Failed run must contain a controlled error.");
  }

  const config = record.effectiveConfigSnapshot;
  if (record.caseId !== record.inputCaseSnapshot.id || record.caseVersion !== record.inputCaseSnapshot.version) {
    addIssue(["caseId"], "Run case reference must match the input case snapshot.");
  }
  if (record.caseId !== config.caseRef.id || record.caseVersion !== config.caseRef.version) {
    addIssue(["caseId"], "Run case reference must match the effective configuration.");
  }
  if (record.mode !== config.mode) addIssue(["mode"], "Run mode must match the effective configuration.");
  if (record.datasetVersion !== config.versionSummary.datasetVersion) {
    addIssue(["datasetVersion"], "Run dataset version must match the effective configuration.");
  }
  if (record.safetyCoreId !== config.safetyCoreRef.id || record.safetyCoreVersion !== config.safetyCoreRef.version) {
    addIssue(["safetyCoreId"], "Run safety core reference must match the effective configuration.");
  }
  if (record.policyId !== config.policyRef.id || record.policyVersion !== config.policyRef.version) {
    addIssue(["policyId"], "Run policy reference must match the effective configuration.");
  }
  if (record.configurationKey !== config.configurationKey) {
    addIssue(["configurationKey"], "Run configuration key must match the effective configuration.");
  }

  if (config.mode === "BOUNDED") {
    if (!record.profileId || record.profileVersion === undefined) {
      addIssue(["profileId"], "Bounded run must contain a physician profile reference.");
    } else if (config.profileRef && (record.profileId !== config.profileRef.id || record.profileVersion !== config.profileRef.version)) {
      addIssue(["profileId"], "Run profile reference must match the effective configuration.");
    }
  } else if (record.profileId || record.profileVersion !== undefined) {
    addIssue(["profileId"], "Generic run cannot contain a physician profile reference.");
  }

  if (record.outputDraftSnapshot) {
    const output = record.outputDraftSnapshot;
    if (output.caseId !== record.caseId || output.caseVersion !== record.caseVersion || output.mode !== record.mode) {
      addIssue(["outputDraftSnapshot"], "Output snapshot must match the generation run.");
    }
    if (output.configurationKey !== record.configurationKey) {
      addIssue(["outputDraftSnapshot"], "Output configuration key must match the generation run.");
    }
    if (output.runId !== record.id) {
      addIssue(["outputDraftSnapshot"], "Output run ID must match the generation run.");
    }
  }
});

export type GenerationRunRecord = z.infer<typeof generationRunRecordSchema>;

export const profileVersionStatusSchema = z.enum(["ACTIVE", "FROZEN", "ARCHIVED"]);
export const profileVersionSourceTypeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

export const physicianProfileVersionRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  profileId: z.string().min(1).max(200),
  version: z.number().int().positive(),
  status: profileVersionStatusSchema,
  synthetic: z.literal(true),
  preferences: physicianPreferenceSchema,
  previousVersion: z.number().int().positive().optional(),
  sourceType: profileVersionSourceTypeSchema,
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((record, context) => {
  if (record.version === 1 && record.previousVersion !== undefined) {
    context.addIssue({ code: "custom", path: ["previousVersion"], message: "Initial profile version cannot have a previous version." });
  }
  if (record.version > 1 && record.previousVersion === undefined) {
    context.addIssue({ code: "custom", path: ["previousVersion"], message: "Subsequent profile versions require a previous version." });
  }
});

export type PhysicianProfileVersionRecord = z.infer<typeof physicianProfileVersionRecordSchema>;

export const feedbackChangeTypeSchema = z.enum(["FORMAT", "REORDER", "ADD", "DELETE", "REWRITE"]);
export type FeedbackChangeType = z.infer<typeof feedbackChangeTypeSchema>;

export const feedbackRiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "UNCERTAIN"]);
export type FeedbackRiskLevel = z.infer<typeof feedbackRiskLevelSchema>;

export const feedbackStatusSchema = z.enum(["CANDIDATE", "HELD_FOR_REVIEW", "REJECTED"]);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

export const feedbackDecisionSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "DISMISSED",
  "APPROVED",
  "REJECTED",
]);
export type FeedbackDecision = z.infer<typeof feedbackDecisionSchema>;

export const feedbackRulesVersionSchema = z.literal("feedback-rules-v1");
export const feedbackAffectedFieldSchema = z.union([sectionKeySchema, z.literal("sectionOrder"), z.literal("unknown")]);

const feedbackRuleIdSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/);
export const feedbackActionSchema = z.enum([
  "CONFIRM_CANDIDATE",
  "DISMISS_CANDIDATE",
  "REVIEW_APPROVE",
  "REVIEW_REJECT",
]);
export const feedbackEvidenceSchema = z.object({
  operationCount: z.number().int().nonnegative().max(100_000),
  addedLineCount: z.number().int().nonnegative().max(100_000),
  removedLineCount: z.number().int().nonnegative().max(100_000),
  addedCharacterCount: z.number().int().nonnegative().max(30_000),
  removedCharacterCount: z.number().int().nonnegative().max(30_000),
  orderChanged: z.boolean(),
}).strict();
export const feedbackCandidatePatchSchema = z.object({
  type: z.literal("sectionOrder"),
  sectionOrder: z.array(sectionKeySchema).min(1).max(12),
}).strict();

export const feedbackEventRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(200),
  eventType: z.literal("FEEDBACK_CLASSIFIED"),
  generationRunId: z.string().min(1).max(200),
  draftRevisionId: z.string().min(1).max(200).optional(),
  revisionNumber: z.number().int().positive().max(100_000).optional(),
  proposalId: z.string().min(1).max(200),
  profileId: z.string().min(1).max(200),
  profileVersion: z.number().int().positive(),
  rulesVersion: feedbackRulesVersionSchema,
  changeType: feedbackChangeTypeSchema,
  status: feedbackStatusSchema,
  riskLevel: feedbackRiskLevelSchema,
  decision: feedbackDecisionSchema,
  affectedField: feedbackAffectedFieldSchema,
  ruleHits: z.array(feedbackRuleIdSchema).min(1).max(20),
  safetyReason: z.string().min(1).max(500),
  nextAllowedActions: z.array(feedbackActionSchema).max(4),
  evidence: feedbackEvidenceSchema,
  candidatePatch: feedbackCandidatePatchSchema.optional(),
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((record, context) => {
  if (record.riskLevel === "LOW") {
    if (record.status !== "CANDIDATE" || record.decision !== "PENDING") {
      context.addIssue({ code: "custom", path: ["status"], message: "LOW feedback must start as an undecided candidate." });
    }
    if (record.affectedField !== "sectionOrder" || !record.candidatePatch) {
      context.addIssue({ code: "custom", path: ["candidatePatch"], message: "LOW feedback must contain a section order patch." });
    }
  }
  if (record.riskLevel === "MEDIUM" || record.riskLevel === "UNCERTAIN") {
    if (record.status !== "HELD_FOR_REVIEW" || record.decision !== "PENDING") {
      context.addIssue({ code: "custom", path: ["status"], message: "MEDIUM and UNCERTAIN feedback must start held for review." });
    }
    if (record.candidatePatch) {
      context.addIssue({ code: "custom", path: ["candidatePatch"], message: "Held feedback cannot contain a profile patch." });
    }
  }
  if (record.riskLevel === "HIGH") {
    if (record.status !== "REJECTED" || record.decision !== "REJECTED") {
      context.addIssue({ code: "custom", path: ["status"], message: "HIGH feedback must be rejected at classification." });
    }
    if (record.nextAllowedActions.length > 0 || record.candidatePatch) {
      context.addIssue({ code: "custom", path: ["nextAllowedActions"], message: "HIGH feedback has no follow-up action or patch." });
    }
    if (record.draftRevisionId) {
      context.addIssue({ code: "custom", path: ["draftRevisionId"], message: "HIGH feedback cannot reference a persisted dangerous revision." });
    }
  }
  if (record.draftRevisionId && record.revisionNumber === undefined) {
    context.addIssue({ code: "custom", path: ["revisionNumber"], message: "Revision-bound feedback requires a revision number." });
  }
});

export type FeedbackEventRecord = z.infer<typeof feedbackEventRecordSchema>;

export const reviewDecisionRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(200),
  feedbackEventId: z.string().min(1).max(200),
  actorId: z.string().min(1).max(200),
  simulatedRole: z.enum(["PHYSICIAN", "REVIEWER"]),
  decision: z.enum(["CONFIRMED", "DISMISSED", "APPROVED", "REJECTED"]),
  rationale: z.string().min(1).max(500),
  expectedProfileVersion: z.number().int().positive().max(100_000).optional(),
  createdAt: isoUtcTimestampSchema,
}).strict();

export type ReviewDecisionRecord = z.infer<typeof reviewDecisionRecordSchema>;

const auditTokenSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/);
const auditIdSchema = z.string().min(1).max(200);
export const auditSimulatedRoleSchema = z.enum(["SYSTEM", "PHYSICIAN", "REVIEWER", "RESEARCHER"]);

export const auditEventRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: auditIdSchema,
  eventType: auditTokenSchema,
  actorId: z.string().min(1).max(200),
  simulatedRole: auditSimulatedRoleSchema,
  entityType: auditTokenSchema,
  entityId: z.string().min(1).max(200),
  beforeVersion: z.string().min(1).max(100).optional(),
  afterVersion: z.string().min(1).max(100).optional(),
  metadata: jsonObjectSchema,
  createdAt: isoUtcTimestampSchema,
}).strict();

export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;

export type RuntimeRecord =
  | GenerationRunRecord
  | PhysicianProfileVersionRecord
  | FeedbackEventRecord
  | ReviewDecisionRecord
  | AuditEventRecord;
