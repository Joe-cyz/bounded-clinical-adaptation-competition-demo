import { z } from "zod";

import {
  physicianProfileSchema,
  sectionKeySchema,
  specialtyVisitPolicySchema,
  syntheticCaseSchema,
  type SectionKey,
} from "./schemas";
import { feedbackRulesVersionSchema } from "./runtime-records";

const safeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const versionTokenSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const safeVersionSchema = versionTokenSchema;
const semanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);
const ruleIdSchema = z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_.-]*$/u);

export const datasetVersionSchema = semanticVersionSchema;
export const datasetContentReviewStatusSchema = z.enum(["PENDING_DOMAIN_REVIEW", "DOMAIN_REVIEWED"]);
export type DatasetContentReviewStatus = z.infer<typeof datasetContentReviewStatusSchema>;
const scenarioKeySchema = z.string().min(3).max(80).regex(/^[A-Z][A-Z0-9_]*$/u);

export const datasetSyntheticCaseSchema = syntheticCaseSchema.extend({
  id: safeIdSchema,
  version: safeVersionSchema,
  scenarioKey: scenarioKeySchema.optional(),
  contentReviewStatus: datasetContentReviewStatusSchema,
}).strict();
export type DatasetSyntheticCase = z.infer<typeof datasetSyntheticCaseSchema>;

export const datasetPhysicianProfileSchema = physicianProfileSchema.extend({
  id: safeIdSchema,
}).strict();
export type DatasetPhysicianProfile = z.infer<typeof datasetPhysicianProfileSchema>;

export const datasetSpecialtyPolicySchema = specialtyVisitPolicySchema.safeExtend({
  id: safeIdSchema,
  version: safeVersionSchema,
}).strict();
export type DatasetSpecialtyPolicy = z.infer<typeof datasetSpecialtyPolicySchema>;

const datasetCollectionSchema = z.object({
  version: safeVersionSchema,
  expectedCount: z.number().int().positive().max(100_000),
}).strict();

export const datasetCaseMatrixSchema = z.object({
  generalMedicine: z.object({ firstVisit: z.literal(6), chronicFollowUp: z.literal(6) }).strict(),
  endocrinology: z.object({ firstVisit: z.literal(6), chronicFollowUp: z.literal(6) }).strict(),
}).strict();

export const datasetManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  datasetVersion: datasetVersionSchema,
  safetyCoreVersion: safeVersionSchema,
  caseSet: datasetCollectionSchema,
  physicianProfileSet: datasetCollectionSchema,
  specialtyPolicySet: datasetCollectionSchema,
  adversarialFeedbackSet: datasetCollectionSchema,
  uncertaintyFeedbackSet: datasetCollectionSchema,
  profileLifecycleSet: datasetCollectionSchema.optional(),
  caseMatrix: datasetCaseMatrixSchema,
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  syntheticOnly: z.literal(true),
}).strict();
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

export const feedbackFixtureMutationTypeSchema = z.enum([
  "REORDER_SECTIONS",
  "ADD_SECTION_LINE",
  "REWRITE_SECTION",
  "CLEAR_MANDATORY_SECTION",
  "REMOVE_MANDATORY_SECTION",
  "ADD_PROHIBITED_ACTION",
  "MIXED_RISK_CHANGE",
  "UNKNOWN_FIELD_CHANGE",
]);
export type FeedbackFixtureMutationType = z.infer<typeof feedbackFixtureMutationTypeSchema>;

export const feedbackFixtureMutationSchema = z.object({
  type: feedbackFixtureMutationTypeSchema,
  sectionKey: sectionKeySchema.optional(),
  fromSectionKey: sectionKeySchema.optional(),
  toSectionKey: sectionKeySchema.optional(),
  lineIndex: z.number().int().nonnegative().max(100_000).optional(),
  contentKind: z.enum(["SAFE_SYNTHETIC_LINE", "PROHIBITED_ACTION_TEXT", "EMPTY_CONTENT", "UNKNOWN_FIELD_MARKER"]).optional(),
  prohibitedAction: z.enum([
    "automatic-diagnosis",
    "automatic-prescription",
    "automatic-record-writeback",
    "learning-from-unreviewed-edits",
    "inventing-missing-facts",
  ]).optional(),
}).strict();
export type FeedbackFixtureMutation = z.infer<typeof feedbackFixtureMutationSchema>;

const expectedFeedbackRiskSchema = z.enum(["LOW", "MEDIUM", "HIGH", "UNCERTAIN"]);
const expectedFeedbackStatusSchema = z.enum(["CANDIDATE", "HELD_FOR_REVIEW", "REJECTED"]);
const expectedFeedbackDecisionSchema = z.enum(["PENDING", "REJECTED"]);

export const feedbackFixtureSchema = z.object({
  fixtureId: safeIdSchema,
  fixtureVersion: datasetVersionSchema,
  synthetic: z.literal(true),
  caseId: safeIdSchema,
  caseVersion: safeVersionSchema,
  profileId: safeIdSchema,
  profileVersion: z.number().int().positive().max(100_000),
  mutation: feedbackFixtureMutationSchema,
  expectedRiskLevel: expectedFeedbackRiskSchema,
  expectedStatus: expectedFeedbackStatusSchema,
  expectedDecision: expectedFeedbackDecisionSchema,
  expectedRuleIds: z.array(ruleIdSchema).min(1).max(20),
  allowRevisionBody: z.boolean(),
  allowProfileUpdate: z.boolean(),
  sourceNote: z.string().trim().min(1).max(500),
}).strict();
export type FeedbackFixture = z.infer<typeof feedbackFixtureSchema>;

export const feedbackFixtureSetSchema = z.array(feedbackFixtureSchema).max(100);

export const feedbackFixtureObservedSchema = z.object({
  executionPath: z.enum(["WORKBENCH_REVISION", "CONTROLLED_CLASSIFIER_HARNESS"]),
  riskLevel: expectedFeedbackRiskSchema.optional(),
  status: expectedFeedbackStatusSchema.optional(),
  decision: expectedFeedbackDecisionSchema.optional(),
  ruleIds: z.array(ruleIdSchema).max(20),
  feedbackEventIds: z.array(safeIdSchema).max(20),
  revisionSaved: z.boolean(),
  profileUpdated: z.boolean(),
  dangerousBodyStored: z.boolean(),
  auditRecorded: z.boolean(),
  sectionOrderDistance: z.number().int().nonnegative().max(100),
  distanceAlgorithmVersion: z.literal("section-order-distance-v1"),
}).strict();
export type FeedbackFixtureObserved = z.infer<typeof feedbackFixtureObservedSchema>;

export const feedbackFixtureResultStatusSchema = z.enum(["PASS", "FAIL"]);

export const feedbackFixtureEvaluationResultSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  id: safeIdSchema,
  evaluationBatchId: safeIdSchema,
  generationRunId: safeIdSchema.optional(),
  datasetVersion: datasetVersionSchema,
  fixtureId: safeIdSchema,
  fixtureVersion: datasetVersionSchema,
  caseId: safeIdSchema,
  caseVersion: safeVersionSchema,
  profileId: safeIdSchema,
  profileVersion: z.number().int().positive().max(100_000),
  mutationType: feedbackFixtureMutationTypeSchema,
  expectedRiskLevel: expectedFeedbackRiskSchema,
  expectedStatus: expectedFeedbackStatusSchema,
  expectedDecision: expectedFeedbackDecisionSchema,
  expectedRuleIds: z.array(ruleIdSchema).min(1).max(20),
  observed: feedbackFixtureObservedSchema,
  resultStatus: feedbackFixtureResultStatusSchema,
  rulesVersion: feedbackRulesVersionSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type FeedbackFixtureEvaluationResult = z.infer<typeof feedbackFixtureEvaluationResultSchema>;

export const profileLifecycleFixtureSchema = z.object({
  fixtureId: safeIdSchema,
  fixtureVersion: datasetVersionSchema,
  synthetic: z.literal(true),
  profileId: safeIdSchema,
  baselineVersion: z.number().int().positive(),
  targetVersion: z.number().int().positive(),
  expectedIsolation: z.literal(true),
  sourceNote: z.string().trim().min(1).max(500),
}).strict();
export type ProfileLifecycleFixture = z.infer<typeof profileLifecycleFixtureSchema>;

export function sectionKeysAreUnique(keys: readonly SectionKey[]): boolean {
  return new Set(keys).size === keys.length;
}
