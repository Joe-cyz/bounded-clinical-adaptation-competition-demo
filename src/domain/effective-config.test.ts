import { describe, expect, it } from "vitest";

import {
  institutionalSafetyCore,
  physicianProfiles,
  seedManifest,
  specialtyVisitPolicies,
  syntheticCases,
} from "@/data/seed-loader";
import { physicianProfileSchema, specialtyVisitPolicySchema } from "./schemas";
import {
  compileComparisonConfigs,
  compileEffectiveConfig,
  CONFIG_RULE_IDS,
  type EffectiveGenerationConfig,
  type ComparisonCompilationResult,
} from "./effective-config";

function comparisonInput() {
  return {
    caseData: syntheticCases[0],
    safetyCore: institutionalSafetyCore,
    policies: specialtyVisitPolicies,
    datasetVersion: seedManifest.datasetVersion,
    profile: physicianProfiles[0],
  };
}

function policyForCurrentCase() {
  const policy = specialtyVisitPolicies.find(
    (candidate) => candidate.specialty === syntheticCases[0].specialty && candidate.visitType === syntheticCases[0].visitType,
  );
  if (!policy) throw new Error("Expected a policy for the current test case.");
  return policy;
}

function requireComparison(result: ComparisonCompilationResult) {
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.ruleId).join(", "));
  return result;
}

function requireConfig(result: ReturnType<typeof compileEffectiveConfig>): EffectiveGenerationConfig {
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.ruleId).join(", "));
  return result.config;
}

describe("effective generation configuration compiler", () => {
  it.each(syntheticCases)("compiles a fair comparison for the versioned case $id", (caseData) => {
    const result = compileComparisonConfigs({ ...comparisonInput(), caseData });

    expect(result.ok).toBe(true);
  });

  it("compiles a generic configuration from explicit inputs", () => {
    const config = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC" }));

    expect(config.mode).toBe("GENERIC");
    expect(config.profileRef).toBeUndefined();
    expect(config.policyRef.approvalScope).toBe("DEMO_ONLY");
  });

  it("compiles a bounded configuration only with an ACTIVE profile", () => {
    const config = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED" }));

    expect(config.mode).toBe("BOUNDED");
    expect(config.profileRef).toEqual({ id: physicianProfiles[0].id, version: physicianProfiles[0].version });
  });

  it("keeps case identity and version shared across comparison configs", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.generic.caseRef).toEqual(result.bounded.caseRef);
    expect(result.generic.caseRef).toMatchObject({
      id: syntheticCases[0].id,
      version: syntheticCases[0].version,
    });
  });

  it("keeps safety core identity and version shared across comparison configs", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.generic.safetyCoreRef).toEqual(result.bounded.safetyCoreRef);
    expect(result.sharedVersionSummary.safetyCoreVersion).toBe(institutionalSafetyCore.version);
  });

  it("keeps the single approved policy reference shared across comparison configs", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));
    const policy = specialtyVisitPolicies.find(
      (candidate) => candidate.specialty === syntheticCases[0].specialty && candidate.visitType === syntheticCases[0].visitType,
    );

    expect(policy).toBeDefined();
    expect(result.generic.policyRef).toEqual(result.bounded.policyRef);
    expect(result.generic.policyRef).toMatchObject({ id: policy!.id, version: policy!.version });
  });

  it("keeps required sections shared and includes every safety mandatory field", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.generic.requiredSections).toEqual(result.bounded.requiredSections);
    for (const field of institutionalSafetyCore.mandatoryFields) {
      expect(result.generic.requiredSections).toContain(field);
    }
  });

  it("keeps policy terminology rules shared", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.generic.terminologyRules).toEqual(result.bounded.terminologyRules);
  });

  it("keeps the shared version summary free of a physician profile version", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.sharedVersionSummary).toEqual({
      datasetVersion: seedManifest.datasetVersion,
      caseVersion: syntheticCases[0].version,
      safetyCoreVersion: institutionalSafetyCore.version,
      policyVersion: result.generic.policyRef.version,
    });
    expect(result.generic.versionSummary.datasetVersion).toBe(result.bounded.versionSummary.datasetVersion);
  });

  it("uses the specialty policy information priority for generic order", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));
    const policy = policyForCurrentCase();

    expect(result.generic.sectionOrder.slice(0, policy.informationPriority.length)).toEqual(policy.informationPriority);
  });

  it("uses the physician allowlisted order first for bounded order", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.bounded.sectionOrder.slice(0, physicianProfiles[0].preferences.sectionOrder.length)).toEqual(
      physicianProfiles[0].preferences.sectionOrder,
    );
  });

  it("fills every valid section exactly once after requested order", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.generic.sectionOrder).toHaveLength(9);
    expect(result.bounded.sectionOrder).toHaveLength(9);
    expect(new Set(result.generic.sectionOrder).size).toBe(9);
    expect(new Set(result.bounded.sectionOrder).size).toBe(9);
  });

  it("uses centralized generic presentation defaults", () => {
    const config = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC" }));

    expect(config.presentation).toEqual({
      verbosity: "STANDARD",
      expandAbbreviations: true,
      educationTone: "PLAIN",
    });
    expect(config.provenance.presentation).toBe("GENERIC_DEFAULTS");
  });

  it("copies bounded presentation only from the physician allowlist", () => {
    const config = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED" }));

    expect(config.presentation).toEqual({
      verbosity: physicianProfiles[0].preferences.verbosity,
      expandAbbreviations: physicianProfiles[0].preferences.expandAbbreviations,
      educationTone: physicianProfiles[0].preferences.educationTone,
    });
    expect(config.provenance.presentation).toBe("PHYSICIAN_PROFILE");
  });

  it("does not allow bounded preferences to remove safety sections or disclaimer", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.bounded.requiredSections).toEqual(result.generic.requiredSections);
    expect(result.bounded.safety.mandatoryFields).toEqual(institutionalSafetyCore.mandatoryFields);
    expect(result.bounded.safety.draftDisclaimer).toBe(institutionalSafetyCore.draftDisclaimer);
  });

  it("copies safety arrays and policy terminology into the effective config", () => {
    const config = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED" }));
    const policy = policyForCurrentCase();

    expect(config.safety.prohibitedActions).toEqual(institutionalSafetyCore.prohibitedActions);
    expect(config.safety.allowedEvidenceSources).toEqual(institutionalSafetyCore.allowedEvidenceSources);
    expect(config.safety.approvalRequirements).toEqual(institutionalSafetyCore.approvalRequirements);
    expect(config.terminologyRules).toEqual(policy.terminologyRules);
  });

  it("does not apply an optional profile to generic compilation", () => {
    const withProfile = compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC" });
    const withoutProfile = compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC", profile: undefined });

    expect(withProfile).toEqual(withoutProfile);
  });

  it("rejects an empty policy collection with a stable rule", () => {
    const result = compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC", policies: [] });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.POLICY_REQUIRED }],
    });
  });

  it("produces deterministic output for repeated identical inputs", () => {
    const first = compileComparisonConfigs(comparisonInput());
    const second = compileComparisonConfigs(comparisonInput());

    expect(second).toEqual(first);
  });

  it("changes the key when the dataset version changes", () => {
    const first = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC" }));
    const second = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC", datasetVersion: "0.1.1" }));

    expect(second.configurationKey).not.toBe(first.configurationKey);
    expect(second.versionSummary.datasetVersion).toBe("0.1.1");
  });

  it("changes the key when the case version changes", () => {
    const first = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC" }));
    const second = requireConfig(compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      caseData: { ...syntheticCases[0], version: "0.1.1" },
    }));

    expect(second.configurationKey).not.toBe(first.configurationKey);
    expect(second.caseRef.version).toBe("0.1.1");
  });

  it("changes the key when the policy version changes", () => {
    const changedPolicy = specialtyVisitPolicySchema.parse({ ...policyForCurrentCase(), version: "0.2.0" });
    const first = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "GENERIC" }));
    const second = requireConfig(compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      policies: [changedPolicy, ...specialtyVisitPolicies.filter((policy) => policy.id !== changedPolicy.id)],
    }));

    expect(second.configurationKey).not.toBe(first.configurationKey);
    expect(second.versionSummary.policyVersion).toBe("0.2.0");
  });

  it("changes the bounded key when the profile version changes", () => {
    const first = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED" }));
    const updatedProfile = physicianProfileSchema.parse({ ...physicianProfiles[0], version: 2 });
    const second = requireConfig(compileEffectiveConfig({
      ...comparisonInput(),
      mode: "BOUNDED",
      profile: updatedProfile,
    }));

    expect(second.configurationKey).not.toBe(first.configurationKey);
    expect(second.versionSummary.profileVersion).toBe(2);
  });

  it("requires an approved policy for the exact case specialty and visit type", () => {
    const result = compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      policies: [specialtyVisitPolicySchema.parse({ ...policyForCurrentCase(), specialty: "其他专科" })],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.POLICY_MISMATCH }],
    });
  });

  it("blocks when all matching policies are unapproved", () => {
    const result = compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      policies: [specialtyVisitPolicySchema.parse({
        ...policyForCurrentCase(),
        approvalStatus: "DRAFT",
        approvedBy: undefined,
      })],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.POLICY_NOT_APPROVED }],
    });
  });

  it("blocks an archived matching policy", () => {
    const result = compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      policies: [specialtyVisitPolicySchema.parse({
        ...policyForCurrentCase(),
        approvalStatus: "ARCHIVED",
        approvedBy: undefined,
      })],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.POLICY_NOT_APPROVED }],
    });
  });

  it("blocks ambiguous approved policies instead of choosing the first", () => {
    const duplicate = specialtyVisitPolicySchema.parse({
      ...policyForCurrentCase(),
      id: "duplicate-approved-policy",
    });
    const result = compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      policies: [...specialtyVisitPolicies, duplicate],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.POLICY_AMBIGUOUS }],
    });
  });

  it("blocks bounded compilation without a profile", () => {
    const result = compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED", profile: undefined });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.PROFILE_REQUIRED }],
    });
  });

  it("allows frozen profiles for bounded compilation", () => {
    const frozenProfile = {
      ...physicianProfiles[0],
      status: "FROZEN" as const,
    };
    const result = compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED", profile: frozenProfile });

    expect(result.ok).toBe(true);
  });

  it("blocks archived physician profiles for new bounded configs", () => {
    const archivedProfile = physicianProfileSchema.parse({
      ...physicianProfiles[0],
      status: "ARCHIVED",
    });
    const result = compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED", profile: archivedProfile });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.PROFILE_INACTIVE }],
    });
  });

  it("fills omitted and repeated profile sections without weakening required sections", () => {
    const profile = physicianProfileSchema.parse({
      ...physicianProfiles[0],
      preferences: {
        ...physicianProfiles[0].preferences,
        sectionOrder: ["problems", "problems"],
      },
    });
    const config = requireConfig(compileEffectiveConfig({ ...comparisonInput(), mode: "BOUNDED", profile }));

    expect(config.sectionOrder[0]).toBe("problems");
    expect(config.sectionOrder).toHaveLength(9);
    expect(new Set(config.sectionOrder).size).toBe(9);
    for (const field of institutionalSafetyCore.mandatoryFields) {
      expect(config.sectionOrder).toContain(field);
    }
  });

  it("blocks a weakened institutional safety core", () => {
    const weakenedSafetyCore = {
      ...institutionalSafetyCore,
      mandatoryFields: ["allergies"],
    } as never;
    const result = compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      safetyCore: weakenedSafetyCore,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.SAFETY_INVARIANT_VIOLATION }],
    });
  });

  it("blocks a mutable institutional safety core", () => {
    const mutableSafetyCore = { ...institutionalSafetyCore, immutableForPhysician: false } as never;
    const result = compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      safetyCore: mutableSafetyCore,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.SAFETY_INVARIANT_VIOLATION }],
    });
  });

  it("keeps compiled output isolated from later input mutations", () => {
    const policy = {
      ...policyForCurrentCase(),
      terminologyRules: { original: "term" },
    };
    const safetyCore = {
      ...institutionalSafetyCore,
      prohibitedActions: [...institutionalSafetyCore.prohibitedActions],
    };
    const profile = {
      ...physicianProfiles[0],
      preferences: {
        ...physicianProfiles[0].preferences,
        sectionOrder: [...physicianProfiles[0].preferences.sectionOrder],
      },
    };
    const config = requireConfig(compileEffectiveConfig({
      caseData: syntheticCases[0],
      safetyCore,
      policies: [policy],
      datasetVersion: seedManifest.datasetVersion,
      mode: "BOUNDED",
      profile,
    }));

    policy.terminologyRules.original = "mutated";
    safetyCore.prohibitedActions.push("mutated-action");
    profile.preferences.sectionOrder.reverse();

    expect(config.terminologyRules).toEqual({ original: "term" });
    expect(config.safety.prohibitedActions).not.toContain("mutated-action");
    expect(config.sectionOrder.slice(0, 9)).not.toEqual(profile.preferences.sectionOrder);
  });

  it("blocks malformed compiler inputs without throwing", () => {
    const result = compileEffectiveConfig({
      ...comparisonInput(),
      mode: "GENERIC",
      caseData: { ...syntheticCases[0], allergies: "not-an-array" } as never,
    });

    expect(result).toMatchObject({
      ok: false,
      issues: [{ ruleId: CONFIG_RULE_IDS.INPUT_INVALID }],
    });
  });

  it("returns only JSON-serializable configuration data", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));
    const parsed = JSON.parse(JSON.stringify(result));

    expect(parsed).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("function");
    expect(result.generic).not.toBeInstanceOf(Map);
    expect(result.generic).not.toBeInstanceOf(Set);
    expect(result.bounded).not.toBeInstanceOf(Map);
    expect(result.bounded).not.toBeInstanceOf(Set);
  });

  it("uses distinct configuration keys for generic and bounded modes", () => {
    const result = requireComparison(compileComparisonConfigs(comparisonInput()));

    expect(result.generic.configurationKey).not.toBe(result.bounded.configurationKey);
    expect(result.generic.configurationKey).toContain("mode=GENERIC");
    expect(result.bounded.configurationKey).toContain("mode=BOUNDED");
    expect(result.bounded.configurationKey).toContain(`profile=${physicianProfiles[0].id}`);
  });
});
