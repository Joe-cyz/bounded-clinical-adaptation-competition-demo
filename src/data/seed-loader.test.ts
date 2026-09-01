import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";

import {
  findApprovedPolicy,
  findApprovedPolicies,
  getApprovedPolicy,
  institutionalSafetyCore,
  physicianProfiles,
  seedManifest,
  specialtyVisitPolicies,
  syntheticCases,
  adversarialFeedbackFixtures,
  uncertaintyFeedbackFixtures,
  type SeedCollections,
  validateSeedCollections,
} from "./seed-loader";
import { compileEffectiveConfig } from "@/domain/effective-config";
import {
  institutionalSafetyCoreSchema,
  physicianProfileSchema,
  specialtyVisitPolicySchema,
  syntheticCaseSchema,
} from "@/domain/schemas";
import { generateDraft } from "@/domain/generate-draft";
import { datasetManifestSchema, datasetSyntheticCaseSchema, datasetVersionSchema } from "@/domain/dataset";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";

function copySeedCollections(): SeedCollections {
  return {
    seedManifest,
    syntheticCases: [...syntheticCases],
    physicianProfiles: [...physicianProfiles],
    institutionalSafetyCore,
    specialtyVisitPolicies: [...specialtyVisitPolicies],
  };
}

describe("versioned seed data", () => {
  it("accepts strict semantic dataset versions and rejects loose labels", () => {
    expect(datasetVersionSchema.parse("0.4.0")).toBe("0.4.0");
    expect(datasetVersionSchema.parse("0.4.1")).toBe("0.4.1");
    expect(() => datasetVersionSchema.parse("latest")).toThrow();
    expect(() => datasetVersionSchema.parse("0.4")).toThrow();
  });

  it("keeps the 0.4.0 manifest and case file readable as historical data", () => {
    const historicalManifest = JSON.parse(readFileSync("data/seed-manifest.v0.4.0.json", "utf8")) as unknown;
    const historicalCases = JSON.parse(readFileSync("data/synthetic-cases/seed.v0.4.0.json", "utf8")) as unknown;
    expect(datasetManifestSchema.parse(historicalManifest).datasetVersion).toBe("0.4.0");
    expect(datasetSyntheticCaseSchema.array().parse(historicalCases)).toHaveLength(24);
  });

  it("matches the counts declared by the seed manifest", () => {
    expect(syntheticCases).toHaveLength(seedManifest.caseSet.expectedCount);
    expect(physicianProfiles).toHaveLength(seedManifest.physicianProfileSet.expectedCount);
    expect(specialtyVisitPolicies).toHaveLength(seedManifest.specialtyPolicySet.expectedCount);
    expect(seedManifest.adversarialFeedbackSet?.expectedCount).toBe(adversarialFeedbackFixtures.length);
    expect(seedManifest.uncertaintyFeedbackSet?.expectedCount).toBe(uncertaintyFeedbackFixtures.length);
  });

  it("keeps the 6/6/6/6 case matrix and feedback risk distribution balanced", () => {
    expect(seedManifest.datasetVersion).toBe("0.4.1");
    expect(seedManifest.caseSet.version).toBe("0.4.1");
    expect(seedManifest.physicianProfileSet.version).toBe("0.4.0");
    expect(seedManifest.specialtyPolicySet.version).toBe("0.4.0");
    expect(seedManifest.adversarialFeedbackSet?.version).toBe("0.4.0");
    expect(seedManifest.uncertaintyFeedbackSet?.version).toBe("0.4.0");
    expect(syntheticCases.filter((item) => item.specialty === "普通内科" && item.visitType === "初诊")).toHaveLength(6);
    expect(syntheticCases.filter((item) => item.specialty === "普通内科" && item.visitType === "慢病复诊")).toHaveLength(6);
    expect(syntheticCases.filter((item) => item.specialty === "内分泌科" && item.visitType === "初诊")).toHaveLength(6);
    expect(syntheticCases.filter((item) => item.specialty === "内分泌科" && item.visitType === "慢病复诊")).toHaveLength(6);
    expect(Object.fromEntries(Object.entries(Object.groupBy(adversarialFeedbackFixtures, (item) => item.expectedRiskLevel)).map(([key, value]) => [key, value.length]))).toEqual({ HIGH: 10, LOW: 10, MEDIUM: 10 });
    expect(uncertaintyFeedbackFixtures.every((item) => item.expectedRiskLevel === "UNCERTAIN" && item.expectedStatus === "HELD_FOR_REVIEW")).toBe(true);
  });

  it("loads 24 versioned synthetic cases through the strict schema", () => {
    expect(syntheticCases).toHaveLength(24);

    for (const caseData of syntheticCases) {
      expect(() => syntheticCaseSchema.parse(caseData)).not.toThrow();
      expect(caseData.synthetic).toBe(true);
      expect(caseData.schemaVersion).toBe("1.0.0");
      expect(caseData.contentReviewStatus).toBe("PENDING_DOMAIN_REVIEW");
    }
  });

  it("keeps the active 0.4.1 cases concrete, balanced and reviewable", () => {
    expect(existsSync("data/synthetic-cases/seed.v0.4.0.json")).toBe(true);
    expect(existsSync("data/synthetic-cases/seed.v0.4.1.json")).toBe(true);
    expect(existsSync("data/seed-manifest.v0.4.1.json")).toBe(true);

    const forbidden = [
      /合成结构化问题项\d*/u,
      /合成近期变化记录\d*/u,
      /用于验证(?:普通内科|内分泌科)/u,
      /(?:具体处方|调整剂量|停药建议|自动(?:诊断|开药|写回))/u,
    ];
    const quadrantKeys = new Map<string, Set<string>>();
    for (const caseData of syntheticCases) {
      expect(caseData.scenarioKey).toMatch(/^[A-Z][A-Z0-9_]+$/u);
      const quadrant = `${caseData.specialty}|${caseData.visitType}`;
      const keys = quadrantKeys.get(quadrant) ?? new Set<string>();
      keys.add(caseData.scenarioKey!);
      quadrantKeys.set(quadrant, keys);
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
      expect(new Set([caseData.title, caseData.patientSummary, caseData.chiefConcern]).size).toBe(3);
      expect(content.every((value) => !forbidden.some((pattern) => pattern.test(value)))).toBe(true);
      expect(scanSuspectedPii(caseData)).toHaveLength(0);
      if (caseData.allergies.length === 0) expect(caseData.missingInformation.some((item) => item.includes("过敏"))).toBe(true);
      if (caseData.currentMedications.length === 0) expect(caseData.missingInformation.some((item) => item.includes("用药"))).toBe(true);
      if (caseData.redFlags.length === 0) expect(caseData.missingInformation.some((item) => item.includes("危险") || item.includes("信号"))).toBe(true);
      expect(caseData.providedProblems.length).toBeGreaterThanOrEqual(1);
      expect(caseData.providedProblems.length).toBeLessThanOrEqual(3);
      expect(caseData.recentChanges.length).toBeGreaterThanOrEqual(1);
      expect(caseData.recentChanges.length).toBeLessThanOrEqual(3);
      expect(caseData.patientEducationFacts.length).toBeGreaterThanOrEqual(1);
      expect(caseData.patientEducationFacts.length).toBeLessThanOrEqual(3);
      expect(caseData.version.startsWith("0.4.1-")).toBe(true);
    }
    expect([...quadrantKeys.values()].map((keys) => keys.size)).toEqual([6, 6, 6, 6]);
    expect(new Set(syntheticCases.map((caseData) => caseData.title)).size).toBe(24);
    expect(new Set(syntheticCases.map((caseData) => caseData.patientSummary)).size).toBe(24);
    expect(new Set(syntheticCases.map((caseData) => caseData.chiefConcern)).size).toBe(24);
  });

  it("loads only whitelisted physician preferences", () => {
    const preferenceKeys = ["educationTone", "expandAbbreviations", "sectionOrder", "verbosity"];

    expect(physicianProfiles).toHaveLength(3);
    for (const profile of physicianProfiles) {
      expect(() => physicianProfileSchema.parse(profile)).not.toThrow();
      expect(profile.synthetic).toBe(true);
      expect(Object.keys(profile.preferences).sort()).toEqual(preferenceKeys.sort());
      expect(profile).not.toHaveProperty("sectionOrder");
    }
  });

  it("keeps all four policies within the demo-only scope", () => {
    expect(specialtyVisitPolicies).toHaveLength(4);

    for (const policy of specialtyVisitPolicies) {
      expect(() => specialtyVisitPolicySchema.parse(policy)).not.toThrow();
      expect(policy.approvalStatus).toBe("APPROVED");
      expect(policy.approvalScope).toBe("DEMO_ONLY");
      expect(policy.approvedBy).toBe("simulated-reviewer");
    }
  });

  it("finds an approved policy for every current case", () => {
    for (const caseData of syntheticCases) {
      expect(getApprovedPolicy(caseData.specialty, caseData.visitType)).toMatchObject({
        approvalStatus: "APPROVED",
        approvalScope: "DEMO_ONLY",
      });
    }
  });

  it("does not return a draft policy from the approved-policy query", () => {
    const draftPolicy = specialtyVisitPolicySchema.parse({
      ...specialtyVisitPolicies[0],
      id: "draft-policy-for-test",
      approvalStatus: "DRAFT",
      approvedBy: undefined,
    });

    expect(findApprovedPolicy([draftPolicy], draftPolicy.specialty, draftPolicy.visitType)).toBeUndefined();
  });

  it("rejects multiple approved policies for one specialty and visit type", () => {
    const collections = copySeedCollections();
    const duplicateApprovedPolicy = specialtyVisitPolicySchema.parse({
      ...specialtyVisitPolicies[0],
      id: "duplicate-approved-policy-for-test",
    });
    collections.seedManifest = {
      ...collections.seedManifest,
      specialtyPolicySet: {
        ...collections.seedManifest.specialtyPolicySet,
        expectedCount: 5,
      },
    };
    collections.specialtyVisitPolicies.push(duplicateApprovedPolicy);

    expect(findApprovedPolicies(collections.specialtyVisitPolicies, "普通内科", "初诊")).toHaveLength(2);
    expect(() => validateSeedCollections(collections)).toThrow(/ambiguous approved policies/i);
  });

  it.each([
    ["synthetic cases", (collections: SeedCollections) => collections.syntheticCases.push(syntheticCases[0])],
    ["physician profiles", (collections: SeedCollections) => collections.physicianProfiles.push(physicianProfiles[0])],
    ["specialty policies", (collections: SeedCollections) => collections.specialtyVisitPolicies.push(specialtyVisitPolicies[0])],
  ])("rejects duplicate IDs in %s", (_collectionName, addDuplicate) => {
    const collections = copySeedCollections();
    addDuplicate(collections);

    expect(() => validateSeedCollections(collections)).toThrow(/duplicate id/i);
  });

  it("loads the versioned safety core with mandatory fields and disclaimer", () => {
    expect(() => institutionalSafetyCoreSchema.parse(institutionalSafetyCore)).not.toThrow();
    expect(institutionalSafetyCore.version).toBe("0.1.0");
    expect(institutionalSafetyCore.mandatoryFields).toEqual([
      "allergies",
      "currentMedications",
      "redFlags",
      "missingInformation",
      "draftDisclaimer",
    ]);
    expect(institutionalSafetyCore.draftDisclaimer).toContain("必须由人工复核");
  });

  it("keeps generic and bounded draft facts equivalent after migration", () => {
    const genericConfig = compileEffectiveConfig({
      caseData: syntheticCases[0],
      safetyCore: institutionalSafetyCore,
      policies: specialtyVisitPolicies,
      datasetVersion: seedManifest.datasetVersion,
      mode: "GENERIC",
    });
    const boundedConfig = compileEffectiveConfig({
      caseData: syntheticCases[0],
      safetyCore: institutionalSafetyCore,
      policies: specialtyVisitPolicies,
      datasetVersion: seedManifest.datasetVersion,
      mode: "BOUNDED",
      profile: physicianProfiles[0],
    });

    if (!genericConfig.ok || !boundedConfig.ok) throw new Error("Expected seed configurations to compile.");

    const generic = generateDraft(syntheticCases[0], genericConfig.config, "run-seed-generic");
    const bounded = generateDraft(syntheticCases[0], boundedConfig.config, "run-seed-bounded");
    const normalize = (draft: typeof generic) =>
      Object.fromEntries(draft.sections.map((section) => [section.key, section.content]));

    expect(bounded.sections[0].key).toBe("problems");
    expect(normalize(bounded)).toEqual(normalize(generic));
  });
});
