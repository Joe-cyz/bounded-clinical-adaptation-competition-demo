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
import { OUTPUT_RULE_IDS, validateGeneratedDraft } from "./safety-core";
import { draftSectionSchema, generatedDraftSchema } from "./schemas";

function boundedConfig() {
  const result = compileEffectiveConfig({
    caseData: syntheticCases[0],
    safetyCore: institutionalSafetyCore,
    policies: specialtyVisitPolicies,
    datasetVersion: seedManifest.datasetVersion,
    mode: "BOUNDED",
    profile: physicianProfiles[0],
  });
  if (!result.ok) throw new Error("Fixture config failed.");
  return result.config;
}

describe("generated output validation", () => {
  it("uses strict bounded output schemas", () => {
    const config = boundedConfig();
    const draft = generateDraft(syntheticCases[0], config, "run-strict-schema");

    expect(draftSectionSchema.safeParse({ ...draft.sections[0], extra: true }).success).toBe(false);
    expect(generatedDraftSchema.safeParse({ ...draft, extra: true }).success).toBe(false);
    expect(generatedDraftSchema.safeParse({
      ...draft,
      sections: draft.sections.map((section) => ({
        ...section,
        content: ["x".repeat(501)],
      })),
    }).success).toBe(false);
  });

  it("accepts the shared deterministic projection", () => {
    const config = boundedConfig();
    const draft = generateDraft(syntheticCases[0], config, "run-output-validation");

    expect(validateGeneratedDraft(draft, {
      caseData: syntheticCases[0],
      config,
      expectedRunId: draft.runId,
    })).toEqual({ ok: true });
  });

  it.each([
    ["fact", (draft: ReturnType<typeof generateDraft>) => ({
      ...draft,
      sections: draft.sections.map((section) => section.key === "problems"
        ? { ...section, content: [...section.content, "虚构数值：999"] }
        : section),
    }), OUTPUT_RULE_IDS.FACT_BOUNDARY_VIOLATION],
    ["duplicate", (draft: ReturnType<typeof generateDraft>) => ({
      ...draft,
      sections: [...draft.sections, draft.sections[0]],
    }), OUTPUT_RULE_IDS.SECTION_DUPLICATE],
    ["order", (draft: ReturnType<typeof generateDraft>) => ({
      ...draft,
      sections: [...draft.sections].reverse(),
    }), OUTPUT_RULE_IDS.SECTION_ORDER_INVALID],
    ["metadata", (draft: ReturnType<typeof generateDraft>) => ({
      ...draft,
      sections: draft.sections.map((section) => section.key === "allergies"
        ? { ...section, mandatory: false }
        : section),
    }), OUTPUT_RULE_IDS.SECTION_METADATA_INVALID],
  ] as const)("blocks %s output", (_label, mutate, ruleId) => {
    const config = boundedConfig();
    const draft = generateDraft(syntheticCases[0], config, `run-${_label}`);
    const result = validateGeneratedDraft(mutate(draft), {
      caseData: syntheticCases[0],
      config,
      expectedRunId: draft.runId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.ruleId)).toContain(ruleId);
  });

  it("blocks prohibited actions but does not flag negated safety language", () => {
    const config = boundedConfig();
    const draft = generateDraft(syntheticCases[0], config, "run-prohibited");
    const safeDraft = {
      ...draft,
      sections: draft.sections.map((section) => section.key === "patientEducation"
        ? { ...section, content: ["不提供独立诊断，不自动开药，也不写回病历。"] }
        : section),
    };
    const unsafeDraft = {
      ...draft,
      sections: draft.sections.map((section) => section.key === "patientEducation"
        ? { ...section, content: ["自动诊断并直接开药。"] }
        : section),
    };

    const safeResult = validateGeneratedDraft(safeDraft, { caseData: syntheticCases[0], config });
    const unsafeResult = validateGeneratedDraft(unsafeDraft, { caseData: syntheticCases[0], config });

    expect(safeResult.ok).toBe(false);
    if (!safeResult.ok) expect(safeResult.issues.map((issue) => issue.ruleId)).not.toContain(OUTPUT_RULE_IDS.PROHIBITED_ACTION);
    expect(unsafeResult.ok).toBe(false);
    if (!unsafeResult.ok) expect(unsafeResult.issues.map((issue) => issue.ruleId)).toContain(OUTPUT_RULE_IDS.PROHIBITED_ACTION);
  });

  it("blocks suspected PII with a safe field path only", () => {
    const config = boundedConfig();
    const draft = generateDraft(syntheticCases[0], config, "run-pii");
    const candidate = {
      ...draft,
      sections: draft.sections.map((section) => section.key === "summary"
        ? { ...section, content: [...section.content, "姓名：合成患者"] }
        : section),
    };

    const result = validateGeneratedDraft(candidate, { caseData: syntheticCases[0], config });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const piiIssues = result.issues.filter((issue) => issue.ruleId === OUTPUT_RULE_IDS.SUSPECTED_PII);
      expect(piiIssues).toHaveLength(1);
      expect(piiIssues[0].fieldPath).toMatch(/^\$\.sections\[\d+\]\.content\[\d+\]$/);
      expect(JSON.stringify(piiIssues)).not.toContain("合成患者");
    }
  });

  it("classifies an unknown section key as a section-set violation", () => {
    const config = boundedConfig();
    const draft = generateDraft(syntheticCases[0], config, "run-unknown-section");
    const candidate = {
      ...draft,
      sections: [
        ...draft.sections,
        { ...draft.sections[0], key: "unknown-section" },
      ],
    } as unknown;

    const result = validateGeneratedDraft(candidate, { caseData: syntheticCases[0], config });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.ruleId)).toContain(OUTPUT_RULE_IDS.SECTION_SET_INVALID);
  });
});
