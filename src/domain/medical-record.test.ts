import { describe, expect, it } from "vitest";

import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { medicalRecordManifest, syntheticMedicalRecords } from "@/data/seed-loader";
import {
  auxiliaryExamsSchema,
  encounterRecordV1Schema,
  medicalCalendarDateSchema,
  medicalDateFieldSchema,
  medicalListFieldSchema,
  medicalRecordLimits,
  medicalRecordManifestSchema,
  medicalTextFieldSchema,
  parseEncounterRecordV1,
  vitalSignsFieldSchema,
} from "./medical-record";

// SYNTHETIC_TEST_ONLY: construct privacy-test values at runtime to keep public source free of PII-like literals.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");
const syntheticTestOnlyEmail = ["synthetic", "test", "example.invalid"].join("@");
const syntheticTestOnlyId = ["110105", "19491231", "002X"].join("");

describe("EncounterRecordV1 domain model", () => {
  const record = syntheticMedicalRecords[0];

  it("accepts a valid versioned synthetic record and manifest", () => {
    expect(() => encounterRecordV1Schema.parse(record)).not.toThrow();
    expect(() => medicalRecordManifestSchema.parse(medicalRecordManifest)).not.toThrow();
    expect(record.synthetic).toBe(true);
    expect(record.contentReviewStatus).toBe("PENDING_DOMAIN_REVIEW");
    expect(record.physicianConfirmationStatus).toBe("UNCONFIRMED");
    expect(record.demographics.admissionDate).toEqual({ status: "NOT_APPLICABLE" });
  });

  it("rejects non-synthetic records", () => {
    expect(() => encounterRecordV1Schema.parse({ ...record, synthetic: false })).toThrow();
  });

  it("enforces field-state content invariants", () => {
    expect(() => medicalTextFieldSchema.parse({ status: "PROVIDED" })).toThrow();
    expect(() => medicalTextFieldSchema.parse({ status: "UNKNOWN", value: "事实" })).toThrow();
    expect(() => medicalTextFieldSchema.parse({ status: "NOT_APPLICABLE", value: "事实" })).toThrow();
    expect(() => medicalTextFieldSchema.parse({ status: "PROVIDED", value: "暂无" })).toThrow();
    expect(() => medicalListFieldSchema.parse({ status: "PROVIDED", items: [] })).toThrow();
    expect(() => medicalListFieldSchema.parse({ status: "UNKNOWN", items: ["不应存在"] })).toThrow();
  });

  it("rejects inconsistent dates and outpatient admission values", () => {
    expect(() => medicalDateFieldSchema.parse({ status: "UNKNOWN", value: "2026-08-21" })).toThrow();
    expect(() => encounterRecordV1Schema.parse({
      ...record,
      demographics: {
        ...record.demographics,
        admissionDate: { status: "PROVIDED", value: "2026-08-21" },
      },
    })).toThrow();
    expect(() => encounterRecordV1Schema.parse({
      ...record,
      demographics: {
        ...record.demographics,
        recordDate: { status: "PROVIDED", value: "2026-08-20" },
      },
    })).toThrow();
  });

  it("accepts real leap-year dates and rejects impossible calendar dates", () => {
    for (const value of ["2024-02-29", "2000-02-29", "2026-04-30", "2026-12-31"]) {
      expect(() => medicalCalendarDateSchema.parse(value)).not.toThrow();
    }
    for (const value of [
      "2026-02-29",
      "2026-02-30",
      "2026-04-31",
      "2026-13-01",
      "2026-00-01",
      "2026-01-00",
    ]) {
      expect(() => medicalCalendarDateSchema.parse(value)).toThrow();
    }
    expect(() => medicalRecordManifestSchema.parse({
      ...medicalRecordManifest,
      demoDateWindow: { startDate: "2026-02-29", endDate: "2026-03-01" },
    })).toThrow();
    expect(() => medicalRecordManifestSchema.parse({
      ...medicalRecordManifest,
      demoDateWindow: { startDate: "2026-03-02", endDate: "2026-03-01" },
    })).toThrow();
    expect(() => auxiliaryExamsSchema.parse({
      ...record.auxiliaryExams,
      laboratory: {
        status: "PENDING_PHYSICIAN_CONFIRMATION",
        examinationDate: "2026-02-30",
        result: "待医生核对",
      },
    })).toThrow();
  });

  it("requires a numeric vital-sign reading and keeps measuredAt separate", () => {
    for (const status of ["PROVIDED", "PENDING_PHYSICIAN_CONFIRMATION"] as const) {
      expect(() => vitalSignsFieldSchema.parse({
        status,
        value: { measuredAt: "2026-08-21" },
      })).toThrow();
      expect(() => vitalSignsFieldSchema.parse({
        status,
        value: { measuredAt: "2026-08-21", temperatureC: 36.5 },
      })).not.toThrow();
    }
    for (const status of ["UNKNOWN", "NOT_APPLICABLE"] as const) {
      expect(() => vitalSignsFieldSchema.parse({
        status,
        value: { measuredAt: "2026-08-21" },
      })).toThrow();
      expect(() => vitalSignsFieldSchema.parse({
        status,
        value: { temperatureC: 36.5 },
      })).toThrow();
    }
  });

  it("rejects out-of-range vital signs and invalid measurement dates", () => {
    const invalidReadings = [
      { temperatureC: 19.9 },
      { temperatureC: 45.1 },
      { systolicBpMmhg: 39 },
      { systolicBpMmhg: 301 },
      { diastolicBpMmhg: 19 },
      { diastolicBpMmhg: 201 },
      { pulseBpm: 19 },
      { pulseBpm: 251 },
      { respiratoryRatePerMin: 4 },
      { respiratoryRatePerMin: 81 },
    ];
    for (const value of invalidReadings) {
      expect(() => vitalSignsFieldSchema.parse({ status: "PROVIDED", value })).toThrow();
    }
    expect(() => vitalSignsFieldSchema.parse({
      status: "PROVIDED",
      value: { measuredAt: "2026-02-30", temperatureC: 36.5 },
    })).toThrow();
  });

  it("enforces required columns, strict objects, and bounded record size", () => {
    const missingTopLevel = { ...record } as Record<string, unknown>;
    delete missingTopLevel.history;
    expect(() => encounterRecordV1Schema.parse(missingTopLevel)).toThrow();

    const missingHistoryField = { ...record.history } as Record<string, unknown>;
    delete missingHistoryField.pastHistory;
    expect(() => encounterRecordV1Schema.parse({ ...record, history: missingHistoryField })).toThrow();

    const missingExamField = { ...record.physicalExam } as Record<string, unknown>;
    delete missingExamField.generalCondition;
    expect(() => encounterRecordV1Schema.parse({ ...record, physicalExam: missingExamField })).toThrow();

    const missingAuxiliaryField = { ...record.auxiliaryExams } as Record<string, unknown>;
    delete missingAuxiliaryField.laboratory;
    expect(() => encounterRecordV1Schema.parse({ ...record, auxiliaryExams: missingAuxiliaryField })).toThrow();

    expect(() => encounterRecordV1Schema.parse({ ...record, unexpectedField: true })).toThrow();
    expect(() => encounterRecordV1Schema.parse({
      ...record,
      demographics: { ...record.demographics, unexpectedField: true },
    })).toThrow();
    expect(() => encounterRecordV1Schema.parse({
      ...record,
      history: { ...record.history, presentIllness: { status: "PROVIDED", value: "x".repeat(2_001) } },
    })).toThrow();
    expect(() => encounterRecordV1Schema.parse({
      ...record,
      history: { ...record.history, problemFacts: {
        status: "PROVIDED",
        items: Array.from({ length: 21 }, (_, index) => `合成问题-${index}`),
      } },
    })).toThrow();
    expect(() => encounterRecordV1Schema.parse({
      ...record,
      history: { ...record.history, recentChanges: {
        status: "PROVIDED",
        items: ["x".repeat(1_001)],
      } },
    })).toThrow();

    const projectionSections = [
      "summary",
      "problems",
      "recentChanges",
      "allergies",
      "currentMedications",
      "redFlags",
      "missingInformation",
      "patientEducation",
      "draftDisclaimer",
    ].map((key) => ({
      key,
      title: key,
      status: "PENDING_PHYSICIAN_CONFIRMATION" as const,
      content: Array.from({ length: 40 }, () => "x".repeat(500)),
      mandatory: false,
    }));
    expect(JSON.stringify({ ...record, draftProjection: {
      source: "BOUNDED_GENERATED_DRAFT",
      runId: "run-size-test",
      mode: "BOUNDED",
      caseId: record.caseId,
      caseVersion: record.caseVersion,
      sections: projectionSections,
    } }).length).toBeGreaterThan(medicalRecordLimits.maxTotalCharacters);
    expect(() => encounterRecordV1Schema.parse({ ...record, draftProjection: {
      source: "BOUNDED_GENERATED_DRAFT",
      runId: "run-size-test",
      mode: "BOUNDED",
      caseId: record.caseId,
      caseVersion: record.caseVersion,
      sections: projectionSections,
    } })).toThrow();
  });

  it("rejects confirmed or otherwise non-unconfirmed seed status", () => {
    expect(() => encounterRecordV1Schema.parse({ ...record, physicianConfirmationStatus: "CONFIRMED" })).toThrow();
    expect(() => encounterRecordV1Schema.parse({ ...record, contentReviewStatus: "DOMAIN_REVIEWED" })).toThrow();
  });

  it("keeps the missing-information category extensible without seeding low-confidence transcript facts", () => {
    expect(record.pendingInformation.every((item) => item.category === "PHYSICIAN_FOLLOW_UP")).toBe(true);
    const lowConfidence = {
      ...record.pendingInformation[0],
      id: "missing-general-first-001-99",
      category: "LOW_CONFIDENCE_TRANSCRIPT" as const,
    };
    expect(() => encounterRecordV1Schema.parse({
      ...record,
      pendingInformation: [lowConfidence],
    })).not.toThrow();
  });

  it("uses the existing recursive PII detector through the safe parsing entry", () => {
    expect(scanSuspectedPii(record)).toHaveLength(0);
    const payloads = [
      "患者姓名：合成患者",
      `电话：${syntheticTestOnlyPhone}`,
      `邮箱：${syntheticTestOnlyEmail}`,
      `身份证号：${syntheticTestOnlyId}`,
      "地址：合成地区",
    ];
    for (const payload of payloads) {
      const candidate = {
        ...record,
        sourceDescription: `完全虚构合成数据；${payload}`,
      };
      expect(scanSuspectedPii(candidate).length).toBeGreaterThan(0);
      expect(() => parseEncounterRecordV1(candidate)).toThrowError(
        expect.objectContaining({ code: "MEDICAL_RECORD_SUSPECTED_PII" }),
      );
      try {
        parseEncounterRecordV1(candidate);
      } catch (error) {
        expect(String(error)).not.toContain(payload);
      }
    }
  });

  it("returns a controlled validation error for malformed record input", () => {
    expect(() => parseEncounterRecordV1({ ...record, caseId: "" })).toThrowError(
      expect.objectContaining({ code: "MEDICAL_RECORD_SCHEMA_INVALID" }),
    );
  });
});
