import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  findMedicalRecord,
  findSyntheticMedicalRecord,
  medicalRecordManifest,
  syntheticMedicalRecords,
  syntheticCases,
} from "./seed-loader";
import { encounterRecordV1Schema, medicalRecordManifestSchema } from "@/domain/medical-record";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";

describe("PWR-03 medical-record sidecar", () => {
  it("loads exactly 24 independently versioned records", () => {
    expect(() => medicalRecordManifestSchema.parse(medicalRecordManifest)).not.toThrow();
    expect(syntheticMedicalRecords).toHaveLength(24);
    expect(syntheticMedicalRecords).toHaveLength(medicalRecordManifest.expectedCount);
    expect(new Set(syntheticMedicalRecords.map((record) => record.caseId)).size).toBe(24);
    expect(new Set(syntheticMedicalRecords.map((record) => record.caseVersion)).size).toBe(24);
    for (const record of syntheticMedicalRecords) {
      expect(() => encounterRecordV1Schema.parse(record)).not.toThrow();
      expect(record.synthetic).toBe(true);
      expect(record.recordDataVersion).toBe("1.0.0");
      expect(record.contentReviewStatus).toBe("PENDING_DOMAIN_REVIEW");
      expect(record.physicianConfirmationStatus).toBe("UNCONFIRMED");
      expect(scanSuspectedPii(record)).toHaveLength(0);
      expect(JSON.stringify(record)).not.toContain("暂无");
    }
  });

  it("keeps a one-to-one case association and the 6/6/6/6 matrix", () => {
    for (const caseData of syntheticCases) {
      const record = findSyntheticMedicalRecord(caseData.id, caseData.version);
      expect(record).toBeDefined();
      expect(record?.caseId).toBe(caseData.id);
      expect(record?.caseVersion).toBe(caseData.version);
      expect(record?.specialty).toBe(caseData.specialty);
      expect(record?.visitType).toBe(caseData.visitType);
    }
    expect(findMedicalRecord("missing-case", "0.4.1-999")).toBeUndefined();
    expect(syntheticMedicalRecords.filter((record) => record.specialty === "普通内科" && record.visitType === "初诊")).toHaveLength(6);
    expect(syntheticMedicalRecords.filter((record) => record.specialty === "普通内科" && record.visitType === "慢病复诊")).toHaveLength(6);
    expect(syntheticMedicalRecords.filter((record) => record.specialty === "内分泌科" && record.visitType === "初诊")).toHaveLength(6);
    expect(syntheticMedicalRecords.filter((record) => record.specialty === "内分泌科" && record.visitType === "慢病复诊")).toHaveLength(6);
    expect(syntheticMedicalRecords.map((record) => record.demographics.displayLabel)).toEqual(
      Array.from({ length: 24 }, (_, index) => `合成患者-${String(index + 1).padStart(2, "0")}`),
    );
  });

  it("keeps the legacy SyntheticCase object free of PWR-03 record fields", () => {
    for (const caseData of syntheticCases) {
      expect(caseData).not.toHaveProperty("recordDataVersion");
      expect(caseData).not.toHaveProperty("demographics");
      expect(caseData).not.toHaveProperty("physicalExam");
      expect(caseData).not.toHaveProperty("auxiliaryExams");
      expect(caseData).not.toHaveProperty("draftProjection");
    }
  });

  it("preserves the old case facts without turning them into diagnoses or treatment actions", () => {
    for (const caseData of syntheticCases) {
      const record = findSyntheticMedicalRecord(caseData.id, caseData.version);
      if (!record) throw new Error("Expected a matching medical record.");
      expect(record.history.chiefComplaint.value).toBe(caseData.chiefConcern);
      expect(record.history.presentIllness.value).toContain(caseData.patientSummary);
      expect(record.history.problemFacts.items).toEqual(caseData.providedProblems);
      expect(record.history.recentChanges.items).toEqual(caseData.recentChanges);
      expect(record.history.redFlags.items).toEqual(caseData.redFlags);
      expect(record.missingInformation.items).toEqual(caseData.missingInformation);
      expect(record.patientEducationFacts.items).toEqual(caseData.patientEducationFacts);
      expect(JSON.stringify(record)).not.toMatch(/(?:自动|自主|直接|默认)\s*(?:诊断|开药|处方|写回|更新病历)/u);
      expect(JSON.stringify(record)).not.toMatch(/(?:调整剂量|停药建议|具体处方)/u);
    }
  });

  it("keeps the original active case seed byte-for-byte compatible", () => {
    const hash = createHash("sha256")
      .update(readFileSync("data/synthetic-cases/seed.v0.4.1.json"))
      .digest("hex")
      .toUpperCase();
    expect(hash).toBe("8946A5EEA03467A89F1647ABF3C6731437EFD1E26C933403A588DC105186BBD4");
  });
});
