import { z } from "zod";

const schemaVersionSchema = z.literal("1.0.0");

export const mandatoryFieldSchema = z.enum([
  "allergies",
  "currentMedications",
  "redFlags",
  "missingInformation",
  "draftDisclaimer",
]);

export type MandatoryField = z.infer<typeof mandatoryFieldSchema>;

export const syntheticCaseSchema = z.object({
  id: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  version: z.string().min(1),
  scenarioKey: z.string().min(3).max(80).regex(/^[A-Z][A-Z0-9_]*$/u).optional(),
  synthetic: z.literal(true),
  specialty: z.string().min(1),
  visitType: z.string().min(1),
  title: z.string().min(1),
  patientSummary: z.string().min(1),
  chiefConcern: z.string().min(1),
  allergies: z.array(z.string()),
  currentMedications: z.array(z.string()),
  redFlags: z.array(z.string()),
  providedProblems: z.array(z.string()),
  recentChanges: z.array(z.string()),
  missingInformation: z.array(z.string()),
  patientEducationFacts: z.array(z.string()),
  mandatoryFields: z.array(mandatoryFieldSchema),
  sourceNote: z.string().min(1),
  contentReviewStatus: z.enum(["PENDING_DOMAIN_REVIEW", "DOMAIN_REVIEWED"]).optional(),
}).strict();

export type SyntheticCase = z.infer<typeof syntheticCaseSchema>;

export const sectionKeySchema = z.enum([
  "summary",
  "problems",
  "recentChanges",
  "allergies",
  "currentMedications",
  "redFlags",
  "missingInformation",
  "patientEducation",
  "draftDisclaimer",
]);

export type SectionKey = z.infer<typeof sectionKeySchema>;

export const physicianPreferenceSchema = z.object({
  sectionOrder: z.array(sectionKeySchema).min(1),
  verbosity: z.enum(["BRIEF", "STANDARD", "DETAILED"]),
  expandAbbreviations: z.boolean(),
  educationTone: z.enum(["CONCISE", "PLAIN", "SUPPORTIVE"]),
}).strict();

export type PhysicianPreference = z.infer<typeof physicianPreferenceSchema>;

export const physicianProfileSchema = z.object({
  id: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  synthetic: z.literal(true),
  displayName: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["ACTIVE", "FROZEN", "ARCHIVED"]),
  preferences: physicianPreferenceSchema,
  sourceNote: z.string().min(1),
}).strict();

export type PhysicianProfile = z.infer<typeof physicianProfileSchema>;

export const institutionalSafetyCoreSchema = z.object({
  id: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  version: z.string().min(1),
  immutableForPhysician: z.literal(true),
  mandatoryFields: z.array(mandatoryFieldSchema).min(1),
  prohibitedActions: z.array(z.string().min(1)).min(1),
  draftDisclaimer: z.string().min(1),
  allowedEvidenceSources: z.array(z.enum([
    "VERSIONED_SYNTHETIC_CASE_FACTS",
    "APPROVED_STATIC_TEST_MATERIALS",
  ])).min(1),
  approvalRequirements: z.array(z.string().min(1)).min(1),
}).strict();

export type InstitutionalSafetyCore = z.infer<typeof institutionalSafetyCoreSchema>;

export const specialtyVisitPolicySchema = z.object({
  id: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  version: z.string().min(1),
  synthetic: z.literal(true),
  specialty: z.string().min(1),
  visitType: z.string().min(1),
  approvalStatus: z.enum(["DRAFT", "APPROVED", "ARCHIVED"]),
  approvalScope: z.literal("DEMO_ONLY"),
  requiredSections: z.array(sectionKeySchema).min(1),
  informationPriority: z.array(sectionKeySchema).min(1),
  terminologyRules: z.record(z.string(), z.string()),
  approvedBy: z.string().min(1).optional(),
  sourceNote: z.string().min(1),
}).strict().superRefine((policy, context) => {
  if (policy.approvalStatus === "APPROVED" && !policy.approvedBy) {
    context.addIssue({
      code: "custom",
      path: ["approvedBy"],
      message: "Approved policies require an approver.",
    });
  }
});

export type SpecialtyVisitPolicy = z.infer<typeof specialtyVisitPolicySchema>;

export const seedCollectionManifestSchema = z.object({
  version: z.string().min(1),
  expectedCount: z.number().int().nonnegative(),
}).strict();

export const seedManifestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  datasetVersion: z.string().min(1).max(100),
  safetyCoreVersion: z.string().min(1),
  caseSet: seedCollectionManifestSchema,
  physicianProfileSet: seedCollectionManifestSchema,
  specialtyPolicySet: seedCollectionManifestSchema,
  adversarialFeedbackSet: seedCollectionManifestSchema.optional(),
  uncertaintyFeedbackSet: seedCollectionManifestSchema.optional(),
  profileLifecycleSet: seedCollectionManifestSchema.optional(),
  caseMatrix: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())).optional(),
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  syntheticOnly: z.literal(true),
}).strict();

export type SeedManifest = z.infer<typeof seedManifestSchema>;

export const draftOutputLimits = {
  // Keep a small overflow window so post-generation validation can report
  // duplicate/extra sections with a stable rule instead of a generic parse error.
  maxSections: 12,
  maxSectionLines: 40,
  maxLineCharacters: 500,
  maxSectionCharacters: 8_000,
  maxTotalCharacters: 30_000,
  maxTitleCharacters: 120,
} as const;

const boundedDraftLineSchema = z.string().max(draftOutputLimits.maxLineCharacters);

export const draftSectionSchema = z.object({
  key: sectionKeySchema,
  title: z.string().min(1).max(draftOutputLimits.maxTitleCharacters),
  content: z.array(boundedDraftLineSchema).max(draftOutputLimits.maxSectionLines),
  mandatory: z.boolean(),
}).strict().superRefine((section, context) => {
  const totalCharacters = section.title.length + section.content.reduce((sum, line) => sum + line.length, 0);
  if (totalCharacters > draftOutputLimits.maxSectionCharacters) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: "Draft section exceeds the bounded character limit.",
    });
  }
});

/**
 * The only output shape a real provider may return. Trusted draft metadata is
 * deliberately absent and is assembled from the server-side input/config.
 */
export const providerDraftSectionSchema = z.object({
  key: sectionKeySchema,
  content: z.array(boundedDraftLineSchema).max(draftOutputLimits.maxSectionLines),
}).strict().superRefine((section, context) => {
  const totalCharacters = section.content.reduce((sum, line) => sum + line.length, 0);
  if (totalCharacters > draftOutputLimits.maxSectionCharacters) {
    context.addIssue({
      code: "custom",
      path: ["content"],
      message: "Provider section exceeds the bounded character limit.",
    });
  }
});

export const providerDraftEnvelopeSchema = z.object({
  sections: z.array(providerDraftSectionSchema).min(1).max(draftOutputLimits.maxSections),
}).strict().superRefine((draft, context) => {
  const totalCharacters = draft.sections.reduce(
    (sum, section) => sum + section.content.reduce((sectionSum, line) => sectionSum + line.length, 0),
    0,
  );
  if (totalCharacters > draftOutputLimits.maxTotalCharacters) {
    context.addIssue({
      code: "custom",
      path: ["sections"],
      message: "Provider envelope exceeds the bounded total character limit.",
    });
  }
});

export type ProviderDraftEnvelope = z.infer<typeof providerDraftEnvelopeSchema>;

export const generatedDraftSchema = z.object({
  runId: z.string().min(1).max(200),
  mode: z.enum(["GENERIC", "BOUNDED"]),
  caseId: z.string().min(1).max(200),
  caseVersion: z.string().min(1).max(100),
  safetyCoreVersion: z.string().min(1).max(100),
  policyId: z.string().min(1).max(200),
  policyVersion: z.string().min(1).max(100),
  configurationKey: z.string().min(1).max(1_000),
  physicianProfileVersion: z.number().int().positive().optional(),
  sections: z.array(draftSectionSchema).min(1).max(draftOutputLimits.maxSections),
}).strict().superRefine((draft, context) => {
  const totalCharacters = draft.sections.reduce(
    (sum, section) => sum + section.title.length + section.content.reduce((sectionSum, line) => sectionSum + line.length, 0),
    0,
  );
  if (totalCharacters > draftOutputLimits.maxTotalCharacters) {
    context.addIssue({
      code: "custom",
      path: ["sections"],
      message: "Generated draft exceeds the bounded total character limit.",
    });
  }
});

export type GeneratedDraft = z.infer<typeof generatedDraftSchema>;
export type DraftSection = z.infer<typeof draftSectionSchema>;
