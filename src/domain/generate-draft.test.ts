import { describe, expect, it } from "vitest";

import {
  institutionalSafetyCore,
  physicianProfiles,
  seedManifest,
  specialtyVisitPolicies,
  syntheticCases,
} from "@/data/seed-loader";
import { compileEffectiveConfig } from "./effective-config";
import { generateDraft } from "./generate-draft";
import { validateDraft } from "./safety-core";

function configFor(
  caseData: typeof syntheticCases[number],
  mode: "GENERIC" | "BOUNDED",
  profile = physicianProfiles[0],
) {
  const result = compileEffectiveConfig({
    caseData,
    safetyCore: institutionalSafetyCore,
    policies: specialtyVisitPolicies,
    datasetVersion: seedManifest.datasetVersion,
    mode,
    ...(mode === "BOUNDED" ? { profile } : {}),
  });

  if (!result.ok) throw new Error(result.issues.map((issue) => issue.ruleId).join(", "));
  return result.config;
}

describe("bounded draft generation", () => {
  it("preserves every institutional mandatory field in both modes", () => {
    for (const caseData of syntheticCases) {
      const generic = generateDraft(caseData, configFor(caseData, "GENERIC"), `run-generic-${caseData.id}`);
      const bounded = generateDraft(caseData, configFor(caseData, "BOUNDED"), `run-bounded-${caseData.id}`);

      for (const required of institutionalSafetyCore.mandatoryFields) {
        expect(generic.sections.some((section) => section.key === required)).toBe(true);
        expect(bounded.sections.some((section) => section.key === required)).toBe(true);
      }

      expect(validateDraft(generic)).toEqual([]);
      expect(validateDraft(bounded)).toEqual([]);
    }
  });

  it("changes section order without changing section facts", () => {
    const caseData = syntheticCases[0];
    const generic = generateDraft(caseData, configFor(caseData, "GENERIC"), "run-order-generic");
    const bounded = generateDraft(caseData, configFor(caseData, "BOUNDED"), "run-order-bounded");
    const policy = specialtyVisitPolicies.find(
      (candidate) => candidate.specialty === caseData.specialty && candidate.visitType === caseData.visitType,
    );

    expect(generic.sections[0].key).toBe(policy?.informationPriority[0]);
    expect(bounded.sections[0].key).toBe("problems");

    const normalize = (draft: typeof generic) =>
      Object.fromEntries(draft.sections.map((section) => [section.key, section.content]));
    expect(normalize(bounded)).toEqual(normalize(generic));
  });

  it("emits the compiled policy and configuration provenance", () => {
    const config = configFor(syntheticCases[0], "BOUNDED");
    const draft = generateDraft(syntheticCases[0], config, "run-provenance");

    expect(draft).toMatchObject({
      mode: "BOUNDED",
      caseId: config.caseRef.id,
      caseVersion: config.caseRef.version,
      safetyCoreVersion: config.safetyCoreRef.version,
      policyId: config.policyRef.id,
      policyVersion: config.policyRef.version,
      configurationKey: config.configurationKey,
      physicianProfileVersion: config.profileRef?.version,
    });
  });

  it("rejects a configuration compiled for another case", () => {
    const config = configFor(syntheticCases[0], "GENERIC");

    expect(() => generateDraft(syntheticCases[1], config, "run-mismatch")).toThrow(/does not match the selected case/i);
  });
});
