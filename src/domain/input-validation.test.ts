import { describe, expect, it } from "vitest";

import { physicianProfiles, syntheticCases } from "@/data/demo";
import { findApprovedPolicies, specialtyVisitPolicies } from "@/data/seed-loader";
import { specialtyVisitPolicySchema } from "./schemas";
import {
  INPUT_RULE_IDS,
  validateCaseInput,
} from "./input-validation";

// SYNTHETIC_TEST_ONLY: compose privacy rejection values at runtime.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");
const syntheticTestOnlyLandline = ["010", "12345678"].join("-");
const syntheticTestOnlyId = ["110101", "19900101", "1234"].join("");
const syntheticTestOnlyEmail = ["synthetic", "test", "example.invalid"].join("@");
const syntheticTestOnlyName = "合成测试甲";
const syntheticTestOnlyAddress = "地址：合成路1号";

describe("pre-generation input validation", () => {
  it("accepts all current synthetic cases and their unique approved policies", () => {
    for (const caseData of syntheticCases) {
      const result = validateCaseInput(caseData);

      expect(result.status).toBe("PASS");
      expect(result.canGenerate).toBe(true);
      expect(result.caseId).toBe(caseData.id);
      expect(findApprovedPolicies(specialtyVisitPolicies, caseData.specialty, caseData.visitType)).toHaveLength(1);
      expect(result.issues.some((issue) => issue.category === "POLICY" && issue.severity === "ERROR")).toBe(false);
    }
  });

  it.each(["allergies", "currentMedications", "redFlags", "missingInformation"] as const)(
    "blocks a missing required input field: %s",
    (field) => {
      const rawCase = { ...syntheticCases[0] } as Record<string, unknown>;
      delete rawCase[field];

      const result = validateCaseInput(rawCase);
      const issue = result.issues.find(
        (candidate) => candidate.ruleId === INPUT_RULE_IDS.REQUIRED_FIELD_MISSING && candidate.fieldPath === field,
      );

      expect(result.status).toBe("BLOCKED");
      expect(result.canGenerate).toBe(false);
      expect(result.fieldStates[field]).toBe("MISSING");
      expect(issue).toMatchObject({
        category: "COMPLETENESS",
        severity: "ERROR",
        fieldPath: field,
      });
    },
  );

  it("does not treat the generated disclaimer as an input requirement", () => {
    const result = validateCaseInput(syntheticCases[0]);

    expect(result.fieldStates).not.toHaveProperty("draftDisclaimer");
    expect(result.issues.some((issue) => issue.fieldPath === "draftDisclaimer")).toBe(false);
  });

  it("blocks a non-synthetic case with a dedicated rule", () => {
    const result = validateCaseInput({ ...syntheticCases[0], synthetic: false });

    expect(result.status).toBe("BLOCKED");
    expect(result.canGenerate).toBe(false);
    expect(result.issues).toContainEqual({
      ruleId: INPUT_RULE_IDS.SYNTHETIC_REQUIRED,
      category: "SYNTHETIC",
      severity: "ERROR",
      fieldPath: "synthetic",
      message: "病例必须明确声明 synthetic: true，才允许进入演示生成。",
    });
  });

  it("blocks schema type errors without throwing to the caller", () => {
    const result = validateCaseInput({ ...syntheticCases[0], allergies: "not-an-array" });

    expect(result.status).toBe("BLOCKED");
    expect(result.canGenerate).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      ruleId: INPUT_RULE_IDS.SCHEMA_INVALID,
      category: "SCHEMA",
      severity: "ERROR",
      fieldPath: "allergies",
    }));
  });

  it.each([
    [`姓名：${syntheticTestOnlyName}`, INPUT_RULE_IDS.SUSPECTED_PII_NAME],
    [`联系电话：${syntheticTestOnlyPhone}`, INPUT_RULE_IDS.SUSPECTED_PII_PHONE],
    [`座机：${syntheticTestOnlyLandline}`, INPUT_RULE_IDS.SUSPECTED_PII_PHONE],
    [`身份证号：${syntheticTestOnlyId}`, INPUT_RULE_IDS.SUSPECTED_PII_ID_NUMBER],
    [`邮箱：${syntheticTestOnlyEmail}`, INPUT_RULE_IDS.SUSPECTED_PII_EMAIL],
    [syntheticTestOnlyAddress, INPUT_RULE_IDS.SUSPECTED_PII_ADDRESS],
  ] as const)("blocks suspected PII without returning its original text: %s", (value, ruleId) => {
    const result = validateCaseInput({ ...syntheticCases[0], patientSummary: value });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("BLOCKED");
    expect(result.canGenerate).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      ruleId,
      category: "PRIVACY",
      severity: "ERROR",
      fieldPath: "patientSummary",
    }));
    expect(serialized).not.toContain(value);
  });

  it("does not echo a suspected PII-like case ID", () => {
    const result = validateCaseInput({ ...syntheticCases[0], id: syntheticTestOnlyPhone });

    expect(result.caseId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(syntheticTestOnlyPhone);
  });

  it("does not echo unsafe PII-like field names", () => {
    const unsafeFieldNames = {
      [syntheticTestOnlyEmail]: `姓名：${syntheticTestOnlyName}`,
      [syntheticTestOnlyPhone]: `联系电话：${syntheticTestOnlyPhone}`,
    };
    const result = validateCaseInput({ ...syntheticCases[0], ...unsafeFieldNames });
    const serialized = JSON.stringify(result);

    expect(result.canGenerate).toBe(false);
    expect(result.issues.some((issue) => issue.fieldPath === "[unknown-field]")).toBe(true);
    expect(serialized).not.toContain(syntheticTestOnlyEmail);
    expect(serialized).not.toContain(syntheticTestOnlyPhone);
  });

  it("does not flag ordinary dates, versions, doses, or case IDs", () => {
    const result = validateCaseInput({
      ...syntheticCases[0],
      patientSummary: "模拟日期 2026-08-19，版本 24.19.0，病例编号 demo-001，剂量记录为 500mg。",
    });

    expect(result.issues.filter((issue) => issue.category === "PRIVACY")).toEqual([]);
  });

  it("blocks when no approved policy matches", () => {
    const rawCase = { ...syntheticCases[0], specialty: "未配置专科" };
    const result = validateCaseInput(rawCase);

    expect(result.canGenerate).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      ruleId: INPUT_RULE_IDS.APPROVED_POLICY_REQUIRED,
      category: "POLICY",
      severity: "ERROR",
    }));
  });

  it("blocks ambiguous approved policies instead of choosing the first", () => {
    const duplicate = specialtyVisitPolicySchema.parse({
      ...specialtyVisitPolicies[0],
      id: "ambiguous-policy-for-test",
    });
    const result = validateCaseInput(syntheticCases[1], {
      policies: [...specialtyVisitPolicies, duplicate],
    });

    expect(result.canGenerate).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      ruleId: INPUT_RULE_IDS.APPROVED_POLICY_AMBIGUOUS,
      category: "POLICY",
      severity: "ERROR",
    }));
  });

  it("does not treat draft or archived policies as approved matches", () => {
    const draft = specialtyVisitPolicySchema.parse({
      ...specialtyVisitPolicies[0],
      id: "draft-policy-for-validation-test",
      approvalStatus: "DRAFT",
      approvedBy: undefined,
    });
    const archived = specialtyVisitPolicySchema.parse({
      ...specialtyVisitPolicies[0],
      id: "archived-policy-for-validation-test",
      approvalStatus: "ARCHIVED",
      approvedBy: undefined,
    });
    const result = validateCaseInput(syntheticCases[1], { policies: [draft, archived] });

    expect(result.canGenerate).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      ruleId: INPUT_RULE_IDS.APPROVED_POLICY_REQUIRED,
      category: "POLICY",
      severity: "ERROR",
    }));
  });

  it.each(["allergies", "currentMedications", "redFlags"] as const)(
    "marks an empty %s array as unknown warning without blocking",
    (field) => {
      const result = validateCaseInput({ ...syntheticCases[0], [field]: [] });

      expect(result.status).toBe("PASS");
      expect(result.canGenerate).toBe(true);
      expect(result.fieldStates[field]).toBe("UNKNOWN");
      expect(result.issues).toContainEqual(expect.objectContaining({
        ruleId: INPUT_RULE_IDS.FIELD_UNKNOWN,
        category: "COMPLETENESS",
        severity: "WARNING",
        fieldPath: field,
      }));
    },
  );

  it("treats an existing empty missingInformation array as provided", () => {
    const result = validateCaseInput({ ...syntheticCases[0], missingInformation: [] });

    expect(result.fieldStates.missingInformation).toBe("PROVIDED");
    expect(result.issues.some((issue) => issue.fieldPath === "missingInformation")).toBe(false);
  });

  it("returns stable, serializable results without exposing profile internals", () => {
    const first = validateCaseInput(syntheticCases[0]);
    const second = validateCaseInput(syntheticCases[0]);

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.issues.every((issue) => !issue.message.includes(physicianProfiles[0].displayName))).toBe(true);
  });
});
