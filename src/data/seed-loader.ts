import rawSeedManifest from "../../data/seed-manifest.json";
import rawDatasetManifest from "../../data/seed-manifest.v0.4.1.json";
import rawSyntheticCases from "../../data/synthetic-cases/seed.v0.4.1.json";
import rawPhysicianProfiles from "../../data/physician-profiles/seed.v0.4.0.json";
import rawInstitutionalSafetyCore from "../../data/safety-rules/institutional-safety-core.v0.1.0.json";
import rawSpecialtyVisitPolicies from "../../data/specialty-policies/seed.v0.4.0.json";
import rawAdversarialFeedback from "../../data/adversarial-feedback/seed.v0.4.0.json";
import rawUncertaintyFeedback from "../../data/uncertainty-feedback/seed.v0.4.0.json";
import rawMedicalRecordManifest from "../../data/medical-records/manifest.v1.0.0.json";
import rawSyntheticMedicalRecords from "../../data/medical-records/seed.v1.0.0.json";
import { z } from "zod";

import {
  institutionalSafetyCoreSchema,
  seedManifestSchema,
  type InstitutionalSafetyCore,
  type PhysicianProfile,
  type SeedManifest,
  type SpecialtyVisitPolicy,
  type SyntheticCase,
} from "@/domain/schemas";
import {
  datasetManifestSchema,
  datasetPhysicianProfileSchema,
  datasetSpecialtyPolicySchema,
  datasetSyntheticCaseSchema,
  type DatasetSyntheticCase,
  feedbackFixtureSchema,
  type DatasetManifest,
  type FeedbackFixture,
} from "@/domain/dataset";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import {
  encounterRecordV1Schema,
  medicalRecordManifestSchema,
  parseEncounterRecordV1,
  type EncounterRecordV1,
  type MedicalRecordManifest,
} from "@/domain/medical-record";

export type SeedCollections = {
  seedManifest: SeedManifest;
  syntheticCases: SyntheticCase[];
  physicianProfiles: PhysicianProfile[];
  institutionalSafetyCore: InstitutionalSafetyCore;
  specialtyVisitPolicies: SpecialtyVisitPolicy[];
  adversarialFeedbackFixtures?: FeedbackFixture[];
  uncertaintyFeedbackFixtures?: FeedbackFixture[];
};

export type MedicalRecordCollections = {
  manifest: MedicalRecordManifest;
  records: EncounterRecordV1[];
};

function parseSeedCollection<T>(collectionName: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    const issueCodes = [...new Set(result.error.issues.map((issue) => issue.code))].join(", ");
    throw new Error(`${collectionName} seed data schema validation failed (${issueCodes || "invalid-data"}).`);
  }

  return result.data;
}

function assertUniqueIds<T extends { id: string }>(collectionName: string, items: readonly T[]): void {
  const seen = new Set<string>();

  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      throw new Error(`Invalid ${collectionName} seed data: duplicate id at index ${index}.`);
    }
    seen.add(item.id);
  });
}

function assertUniqueCaseReferences(records: readonly EncounterRecordV1[]): void {
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const key = `${record.caseId}@${record.caseVersion}`;
    if (seen.has(key)) {
      throw new Error(`Invalid medical records: duplicate case reference at index ${index}.`);
    }
    seen.add(key);
  });
}

function recordFieldValue(field: { value?: string }): string | undefined {
  return field.value;
}

function assertMatchesSourceCase(record: EncounterRecordV1, caseData: DatasetSyntheticCase): void {
  if (record.caseId !== caseData.id || record.caseVersion !== caseData.version) {
    throw new Error("Invalid medical records: record case reference does not match the active case.");
  }
  if (record.specialty !== caseData.specialty || record.visitType !== caseData.visitType) {
    throw new Error("Invalid medical records: record specialty or visit type does not match the active case.");
  }
  if (record.history.chiefComplaint.value !== caseData.chiefConcern) {
    throw new Error("Invalid medical records: chief complaint was not preserved from the active case.");
  }
  if (!record.history.presentIllness.value?.includes(caseData.patientSummary)) {
    throw new Error("Invalid medical records: patient summary was not preserved in present illness.");
  }
  if (JSON.stringify(record.history.problemFacts.items ?? []) !== JSON.stringify(caseData.providedProblems)) {
    throw new Error("Invalid medical records: provided problem facts were not preserved.");
  }
  if (JSON.stringify(record.history.recentChanges.items ?? []) !== JSON.stringify(caseData.recentChanges)) {
    throw new Error("Invalid medical records: recent changes were not preserved.");
  }
  if (JSON.stringify(record.missingInformation.items ?? []) !== JSON.stringify(caseData.missingInformation)) {
    throw new Error("Invalid medical records: missing information was not preserved.");
  }
  if (JSON.stringify(record.patientEducationFacts.items ?? []) !== JSON.stringify(caseData.patientEducationFacts)) {
    throw new Error("Invalid medical records: patient education facts were not preserved as a separate field.");
  }
  if (JSON.stringify(record.history.redFlags.items ?? []) !== JSON.stringify(caseData.redFlags)) {
    throw new Error("Invalid medical records: red-flag facts were not preserved.");
  }

  const expectedAllergies = caseData.allergies.join("；");
  const expectedMedications = caseData.currentMedications.join("；");
  if (caseData.allergies.length === 0) {
    if (record.history.allergyHistory.status !== "UNKNOWN") {
      throw new Error("Invalid medical records: absent allergy facts must remain UNKNOWN.");
    }
  } else if (recordFieldValue(record.history.allergyHistory) !== expectedAllergies) {
    throw new Error("Invalid medical records: allergy facts were not preserved.");
  }
  if (caseData.currentMedications.length === 0) {
    if (record.history.currentMedications.status !== "UNKNOWN") {
      throw new Error("Invalid medical records: absent medication facts must remain UNKNOWN.");
    }
  } else if (recordFieldValue(record.history.currentMedications) !== expectedMedications) {
    throw new Error("Invalid medical records: medication facts were not preserved.");
  }
}

export function validateMedicalRecordCollections(input: MedicalRecordCollections & {
  syntheticCases: readonly DatasetSyntheticCase[];
}): MedicalRecordCollections {
  const parsedRecords = input.records.map((record) => parseEncounterRecordV1(record));
  if (input.manifest.expectedCount !== input.records.length) {
    throw new Error(
      `Invalid medical record manifest: record count mismatch (expected ${input.manifest.expectedCount}, received ${input.records.length}).`,
    );
  }
  if (input.manifest.syntheticOnly !== true || input.manifest.contentReviewStatus !== "PENDING_DOMAIN_REVIEW") {
    throw new Error("Invalid medical record manifest: only pending synthetic records are allowed.");
  }

  assertUniqueCaseReferences(parsedRecords);
  const casesByReference = new Map(input.syntheticCases.map((caseData) => [`${caseData.id}@${caseData.version}`, caseData]));
  if (casesByReference.size !== parsedRecords.length) {
    throw new Error("Invalid medical records: active cases and records must have a one-to-one cardinality.");
  }

  const displayLabels = new Set<string>();
  const matrix = new Map<string, number>();
  for (const record of parsedRecords) {
    const sourceCase = casesByReference.get(`${record.caseId}@${record.caseVersion}`);
    if (!sourceCase) {
      throw new Error("Invalid medical records: record references a missing active case.");
    }
    if (record.contentReviewStatus !== input.manifest.contentReviewStatus
      || record.recordDataVersion !== input.manifest.recordDataVersion
      || record.sourceDatasetVersion !== input.manifest.sourceDatasetVersion
      || record.physicianConfirmationStatus !== "UNCONFIRMED") {
      throw new Error("Invalid medical records: record version or confirmation boundary is invalid.");
    }
    if (record.draftProjection !== undefined) {
      throw new Error("Invalid medical records: seed records cannot contain a generated-draft projection.");
    }
    const displayLabel = record.demographics.displayLabel;
    if (displayLabels.has(displayLabel)) {
      throw new Error("Invalid medical records: synthetic display labels must be unique.");
    }
    displayLabels.add(displayLabel);
    const visitDate = record.demographics.visitDate.value;
    const recordDate = record.demographics.recordDate.value;
    if (!visitDate || !recordDate
      || visitDate < input.manifest.demoDateWindow.startDate
      || visitDate > input.manifest.demoDateWindow.endDate
      || recordDate < input.manifest.demoDateWindow.startDate
      || recordDate > input.manifest.demoDateWindow.endDate) {
      throw new Error("Invalid medical records: dates must stay inside the fixed synthetic demo window.");
    }
    assertMatchesSourceCase(record, sourceCase);

    const quadrant = `${record.specialty}|${record.visitType}`;
    matrix.set(quadrant, (matrix.get(quadrant) ?? 0) + 1);
    const content = JSON.stringify(record);
    if (/(?:自动|自主|直接|默认)\s*(?:诊断|开药|处方|写回|更新病历)/u.test(content)
      || /(?:调整剂量|停药建议|具体处方)/u.test(content)) {
      throw new Error("Invalid medical records: record contains a prohibited clinical action phrase.");
    }
  }

  const expectedMatrix: Readonly<Record<string, number>> = {
    "普通内科|初诊": 6,
    "普通内科|慢病复诊": 6,
    "内分泌科|初诊": 6,
    "内分泌科|慢病复诊": 6,
  };
  if (Object.entries(expectedMatrix).some(([quadrant, count]) => matrix.get(quadrant) !== count)) {
    throw new Error("Invalid medical records: record matrix must remain 6/6/6/6.");
  }

  return { manifest: input.manifest, records: parsedRecords };
}

export function findApprovedPolicies(
  policies: readonly SpecialtyVisitPolicy[],
  specialty: string,
  visitType: string,
): SpecialtyVisitPolicy[] {
  return policies.filter(
    (policy) =>
      policy.approvalStatus === "APPROVED" &&
      policy.specialty === specialty &&
      policy.visitType === visitType,
  );
}

export function findApprovedPolicy(
  policies: readonly SpecialtyVisitPolicy[],
  specialty: string,
  visitType: string,
): SpecialtyVisitPolicy | undefined {
  return findApprovedPolicies(policies, specialty, visitType)[0];
}

export function validateSeedCollections(collections: SeedCollections): SeedCollections {
  assertUniqueIds("synthetic cases", collections.syntheticCases);
  assertUniqueIds("physician profiles", collections.physicianProfiles);
  assertUniqueIds("specialty policies", collections.specialtyVisitPolicies);

  const countChecks: Array<[string, number, number]> = [
    ["synthetic cases", collections.seedManifest.caseSet.expectedCount, collections.syntheticCases.length],
    ["physician profiles", collections.seedManifest.physicianProfileSet.expectedCount, collections.physicianProfiles.length],
    ["specialty policies", collections.seedManifest.specialtyPolicySet.expectedCount, collections.specialtyVisitPolicies.length],
  ];

  for (const [collectionName, expectedCount, actualCount] of countChecks) {
    if (expectedCount !== actualCount) {
      throw new Error(
        `Invalid seed manifest: ${collectionName} count mismatch (expected ${expectedCount}, received ${actualCount}).`,
      );
    }
  }

  if (collections.seedManifest.safetyCoreVersion !== collections.institutionalSafetyCore.version) {
    throw new Error("Invalid seed manifest: safety core version mismatch.");
  }

  collections.syntheticCases.forEach((caseData, index) => {
    const matchingPolicies = findApprovedPolicies(
      collections.specialtyVisitPolicies,
      caseData.specialty,
      caseData.visitType,
    );

    if (matchingPolicies.length === 0) {
      throw new Error(`Invalid specialty policies: case at index ${index} has no approved matching policy.`);
    }

    if (matchingPolicies.length > 1) {
      throw new Error(`Invalid specialty policies: case at index ${index} has ambiguous approved policies.`);
    }
  });

  return collections;
}

function validateDatasetCollections(input: {
  manifest: DatasetManifest;
  syntheticCases: DatasetSyntheticCase[];
  physicianProfiles: PhysicianProfile[];
  specialtyVisitPolicies: SpecialtyVisitPolicy[];
  adversarialFeedbackFixtures: FeedbackFixture[];
  uncertaintyFeedbackFixtures: FeedbackFixture[];
}): void {
  if (input.syntheticCases.some((caseData) => caseData.contentReviewStatus !== "PENDING_DOMAIN_REVIEW")) {
    throw new Error("Dataset content review status is not approved for the current preclinical baseline.");
  }
  if (new Set(input.syntheticCases.map((caseData) => caseData.version)).size !== input.syntheticCases.length) {
    throw new Error("Invalid dataset: duplicate synthetic case versions.");
  }
  const quadrantScenarioKeys = new Map<string, Set<string>>();
  const forbiddenCaseContent = [
    /合成结构化问题项\d*/u,
    /合成近期变化记录\d*/u,
    /用于验证(?:普通内科|内分泌科)/u,
    /自动(?:诊断|开药|写回)/u,
    /(?:调整剂量|停药建议|具体处方)/u,
  ];
  const hasScenarioKeys = input.syntheticCases.some((caseData) => caseData.scenarioKey !== undefined);
  const allCasesHaveScenarioKeys = input.syntheticCases.every((caseData) => caseData.scenarioKey !== undefined);
  if (hasScenarioKeys && !allCasesHaveScenarioKeys) {
    throw new Error("Invalid dataset: scenario keys must be present for every case in a hardened case set.");
  }
  for (const caseData of input.syntheticCases) {
    if (!caseData.scenarioKey) {
      if (scanSuspectedPii(caseData).length > 0) {
        throw new Error("Invalid dataset: synthetic case contains suspected PII.");
      }
      continue;
    }
    const quadrant = `${caseData.specialty}|${caseData.visitType}`;
    const keys = quadrantScenarioKeys.get(quadrant) ?? new Set<string>();
    if (keys.has(caseData.scenarioKey)) throw new Error("Invalid dataset: duplicate scenario key within a case quadrant.");
    keys.add(caseData.scenarioKey);
    quadrantScenarioKeys.set(quadrant, keys);
    const content = [
      caseData.title,
      caseData.patientSummary,
      caseData.chiefConcern,
      ...caseData.providedProblems,
      ...caseData.recentChanges,
      ...caseData.allergies,
      ...caseData.currentMedications,
      ...caseData.redFlags,
      ...caseData.missingInformation,
      ...caseData.patientEducationFacts,
    ];
    if (forbiddenCaseContent.some((pattern) => content.some((value) => pattern.test(value)))) {
      throw new Error("Invalid dataset: case content contains a prohibited placeholder or unsafe action phrase.");
    }
    if (scanSuspectedPii(caseData).length > 0) {
      throw new Error("Invalid dataset: synthetic case contains suspected PII.");
    }
    const missingByField: Array<[string[], RegExp]> = [
      [caseData.allergies, /过敏/u],
      [caseData.currentMedications, /用药/u],
      [caseData.redFlags, /危险|信号/u],
    ];
    for (const [values, marker] of missingByField) {
      if (values.length === 0 && !caseData.missingInformation.some((item) => marker.test(item))) {
        throw new Error("Invalid dataset: an empty safety field must be declared in missingInformation.");
      }
    }
    if (new Set([caseData.title, caseData.patientSummary, caseData.chiefConcern]).size !== 3) {
      throw new Error("Invalid dataset: case title, summary and concern must be distinct.");
    }
  }
  if (allCasesHaveScenarioKeys) {
    for (const quadrant of [
      "普通内科|初诊",
      "普通内科|慢病复诊",
      "内分泌科|初诊",
      "内分泌科|慢病复诊",
    ]) {
      if (quadrantScenarioKeys.get(quadrant)?.size !== 6) {
        throw new Error("Invalid dataset: every case quadrant must contain six distinct scenario keys.");
      }
    }
  }
  if (input.manifest.caseSet.version !== input.manifest.datasetVersion) {
    throw new Error("Invalid dataset: active dataset and case-set versions must agree.");
  }
  if (input.syntheticCases.some((caseData) => !caseData.version.startsWith(`${input.manifest.caseSet.version}-`))) {
    throw new Error("Invalid dataset: case version does not match the active case-set version.");
  }
  if (input.manifest.caseMatrix.generalMedicine.firstVisit !== 6
    || input.manifest.caseMatrix.generalMedicine.chronicFollowUp !== 6
    || input.manifest.caseMatrix.endocrinology.firstVisit !== 6
    || input.manifest.caseMatrix.endocrinology.chronicFollowUp !== 6) {
    throw new Error("Invalid dataset: case matrix must remain 6/6/6/6.");
  }
  const expectedPolicyKeys = new Set([
    "普通内科|初诊",
    "普通内科|慢病复诊",
    "内分泌科|初诊",
    "内分泌科|慢病复诊",
  ]);
  const actualPolicyKeys = new Set(input.specialtyVisitPolicies.map((policy) => `${policy.specialty}|${policy.visitType}`));
  if (actualPolicyKeys.size !== expectedPolicyKeys.size || [...expectedPolicyKeys].some((key) => !actualPolicyKeys.has(key))) {
    throw new Error("Invalid dataset: approved specialty policy combinations are incomplete or duplicated.");
  }
  const caseIds = new Set(input.syntheticCases.map((caseData) => caseData.id));
  const profileIds = new Set(input.physicianProfiles.map((profile) => profile.id));
  const allFixtures = [...input.adversarialFeedbackFixtures, ...input.uncertaintyFeedbackFixtures];
  for (const fixture of allFixtures) {
    if (!caseIds.has(fixture.caseId) || !profileIds.has(fixture.profileId)) {
      throw new Error("Invalid dataset: feedback fixture reference is missing.");
    }
    if (scanSuspectedPii(fixture).length > 0) {
      throw new Error("Invalid dataset: feedback fixture contains suspected PII.");
    }
  }
  if (input.adversarialFeedbackFixtures.some((fixture) => fixture.fixtureVersion !== input.manifest.adversarialFeedbackSet.version)
    || input.uncertaintyFeedbackFixtures.some((fixture) => fixture.fixtureVersion !== input.manifest.uncertaintyFeedbackSet.version)) {
    throw new Error("Invalid dataset: feedback fixture version does not match its collection version.");
  }
  if (input.adversarialFeedbackFixtures.length !== input.manifest.adversarialFeedbackSet.expectedCount
    || input.uncertaintyFeedbackFixtures.length !== input.manifest.uncertaintyFeedbackSet.expectedCount) {
    throw new Error("Invalid dataset: feedback fixture count mismatch.");
  }
}

export const historicalSeedManifest = parseSeedCollection("historical seed manifest", seedManifestSchema, rawSeedManifest);
const activeDatasetManifest = parseSeedCollection("dataset manifest", datasetManifestSchema, rawDatasetManifest);
const activeSyntheticCases = parseSeedCollection("dataset synthetic cases", datasetSyntheticCaseSchema.array(), rawSyntheticCases);
const activePhysicianProfiles = parseSeedCollection("dataset physician profiles", datasetPhysicianProfileSchema.array(), rawPhysicianProfiles);
const activeSpecialtyPolicies = parseSeedCollection("dataset specialty policies", datasetSpecialtyPolicySchema.array(), rawSpecialtyVisitPolicies);
const activeAdversarialFeedback = parseSeedCollection("adversarial feedback fixtures", feedbackFixtureSchema.array(), rawAdversarialFeedback);
const activeUncertaintyFeedback = parseSeedCollection("uncertainty feedback fixtures", feedbackFixtureSchema.array(), rawUncertaintyFeedback);
const activeMedicalRecordManifest = parseSeedCollection(
  "medical record manifest",
  medicalRecordManifestSchema,
  rawMedicalRecordManifest,
);
const structurallyParsedMedicalRecords = parseSeedCollection(
  "synthetic medical records",
  encounterRecordV1Schema.array(),
  rawSyntheticMedicalRecords,
);
const activeSyntheticMedicalRecords = structurallyParsedMedicalRecords.map((record) => parseEncounterRecordV1(record));

validateDatasetCollections({
  manifest: activeDatasetManifest,
  syntheticCases: activeSyntheticCases,
  physicianProfiles: activePhysicianProfiles,
  specialtyVisitPolicies: activeSpecialtyPolicies,
  adversarialFeedbackFixtures: activeAdversarialFeedback,
  uncertaintyFeedbackFixtures: activeUncertaintyFeedback,
});

const loadedMedicalRecords = validateMedicalRecordCollections({
  manifest: activeMedicalRecordManifest,
  records: activeSyntheticMedicalRecords,
  syntheticCases: activeSyntheticCases,
});

const loadedSeeds = validateSeedCollections({
  seedManifest: activeDatasetManifest,
  syntheticCases: activeSyntheticCases,
  physicianProfiles: activePhysicianProfiles,
  institutionalSafetyCore: parseSeedCollection(
    "institutional safety core",
    institutionalSafetyCoreSchema,
    rawInstitutionalSafetyCore,
  ),
  specialtyVisitPolicies: activeSpecialtyPolicies,
  adversarialFeedbackFixtures: activeAdversarialFeedback,
  uncertaintyFeedbackFixtures: activeUncertaintyFeedback,
});

export const seedManifest = loadedSeeds.seedManifest;
export const datasetManifest = activeDatasetManifest;
export const syntheticCases = loadedSeeds.syntheticCases;
export const physicianProfiles = loadedSeeds.physicianProfiles;
export const institutionalSafetyCore = loadedSeeds.institutionalSafetyCore;
export const specialtyVisitPolicies = loadedSeeds.specialtyVisitPolicies;
export const adversarialFeedbackFixtures = activeAdversarialFeedback;
export const uncertaintyFeedbackFixtures = activeUncertaintyFeedback;
export const medicalRecordManifest = loadedMedicalRecords.manifest;
export const syntheticMedicalRecords = loadedMedicalRecords.records;

export function getApprovedPolicy(specialty: string, visitType: string): SpecialtyVisitPolicy | undefined {
  return findApprovedPolicy(specialtyVisitPolicies, specialty, visitType);
}

export function findSyntheticMedicalRecord(
  caseId: string,
  caseVersion: string,
): EncounterRecordV1 | undefined {
  return syntheticMedicalRecords.find(
    (record) => record.caseId === caseId && record.caseVersion === caseVersion,
  );
}

export const findMedicalRecord = findSyntheticMedicalRecord;
