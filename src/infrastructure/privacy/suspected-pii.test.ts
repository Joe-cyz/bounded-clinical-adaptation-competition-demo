import { describe, expect, it } from "vitest";

import { syntheticCases } from "@/data/demo";
import { suspectedPiiRuleIds, scanSuspectedPii } from "./suspected-pii";

// SYNTHETIC_TEST_ONLY: compose privacy rejection values at runtime.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");
const syntheticTestOnlyLandline = ["010", "12345678"].join("-");
const syntheticTestOnlyId = ["110101", "19900101", "1234"].join("");
const syntheticTestOnlyEmail = ["synthetic", "test", "example.invalid"].join("@");
const syntheticTestOnlyName = "合成测试甲";
const syntheticTestOnlyAddress = "地址：合成路1号";

describe("suspected PII detection", () => {
  it("finds labelled names, phones, IDs, emails, and addresses by field path", () => {
    const result = scanSuspectedPii({
      patientSummary: `姓名：${syntheticTestOnlyName}`,
      chiefConcern: syntheticTestOnlyPhone,
      currentMedications: [syntheticTestOnlyLandline],
      id: syntheticTestOnlyId,
      sourceNote: syntheticTestOnlyEmail,
      title: syntheticTestOnlyAddress,
    });

    expect(result).toEqual([
      { ruleId: suspectedPiiRuleIds.NAME, type: "NAME", fieldPath: "$.patientSummary" },
      { ruleId: suspectedPiiRuleIds.PHONE, type: "PHONE", fieldPath: "$.chiefConcern" },
      { ruleId: suspectedPiiRuleIds.PHONE, type: "PHONE", fieldPath: "$.currentMedications[0]" },
      { ruleId: suspectedPiiRuleIds.ID_NUMBER, type: "ID_NUMBER", fieldPath: "$.id" },
      { ruleId: suspectedPiiRuleIds.EMAIL, type: "EMAIL", fieldPath: "$.sourceNote" },
      { ruleId: suspectedPiiRuleIds.ADDRESS, type: "ADDRESS", fieldPath: "$.title" },
    ]);
  });

  it("recursively scans arrays and does not return matched text", () => {
    const result = scanSuspectedPii({
      recentChanges: [`姓名：${syntheticTestOnlyName}`, syntheticTestOnlyEmail],
    });

    expect(result).toEqual([
      { ruleId: suspectedPiiRuleIds.NAME, type: "NAME", fieldPath: "$.recentChanges[0]" },
      { ruleId: suspectedPiiRuleIds.EMAIL, type: "EMAIL", fieldPath: "$.recentChanges[1]" },
    ]);
    expect(JSON.stringify(result)).not.toContain(syntheticTestOnlyName);
    expect(JSON.stringify(result)).not.toContain(syntheticTestOnlyEmail);
  });

  it("redacts unsafe field names while continuing to scan their values", () => {
    const result = scanSuspectedPii({
      [syntheticTestOnlyEmail]: `姓名：${syntheticTestOnlyName}`,
      [syntheticTestOnlyPhone]: `联系电话：${syntheticTestOnlyPhone}`,
      [syntheticTestOnlyId]: syntheticTestOnlyAddress,
    });
    const serialized = JSON.stringify(result);

    expect(result).toEqual([
      { ruleId: suspectedPiiRuleIds.NAME, type: "NAME", fieldPath: "$[unknown-field]" },
      { ruleId: suspectedPiiRuleIds.PHONE, type: "PHONE", fieldPath: "$[unknown-field]" },
      { ruleId: suspectedPiiRuleIds.ADDRESS, type: "ADDRESS", fieldPath: "$[unknown-field]" },
    ]);
    expect(serialized).not.toContain(syntheticTestOnlyEmail);
    expect(serialized).not.toContain(syntheticTestOnlyPhone);
    expect(serialized).not.toContain(syntheticTestOnlyId);
  });

  it("does not flag the current synthetic seed cases", () => {
    for (const caseData of syntheticCases) {
      expect(scanSuspectedPii(caseData)).toEqual([]);
    }
  });

  it("does not flag ordinary dates, versions, doses, or identifiers", () => {
    expect(scanSuspectedPii({
      date: "2026-08-19",
      version: "1.0.0",
      runtime: "24.19.0",
      dose: "500mg",
      caseId: "endo-followup-001",
    })).toEqual([]);
  });
});
