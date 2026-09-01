import { describe, expect, it } from "vitest";

import {
  compileEffectiveConfig,
} from "./effective-config";
import { generateDraft } from "./generate-draft";
import {
  medicalRecordErrorCodes,
  parseEncounterRecordV1,
  type EncounterRecordV1,
} from "./medical-record";
import {
  projectBoundedDraftToEncounterRecord,
  projectBoundedGeneratedDraftToMedicalRecord,
} from "./medical-record-projection";
import {
  institutionalSafetyCore,
  medicalRecordManifest,
  physicianProfiles,
  specialtyVisitPolicies,
  syntheticMedicalRecords,
  syntheticCases,
} from "@/data/seed-loader";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";

function boundedDraftFor(record: EncounterRecordV1) {
  const caseData = syntheticCases.find((item) => item.id === record.caseId && item.version === record.caseVersion);
  if (!caseData) throw new Error("Expected the matching synthetic case.");
  const result = compileEffectiveConfig({
    caseData,
    safetyCore: institutionalSafetyCore,
    policies: specialtyVisitPolicies,
    datasetVersion: medicalRecordManifest.sourceDatasetVersion,
    mode: "BOUNDED",
    profile: physicianProfiles[0],
  });
  if (!result.ok) throw new Error("Expected the bounded configuration to compile.");
  return generateDraft(caseData, result.config, `run-${record.caseId}`);
}

describe("BOUNDED GeneratedDraft medical-record projection", () => {
  const record = syntheticMedicalRecords[0];

  it("projects matching BOUNDED content as pending without mutating the inputs", () => {
    const draft = boundedDraftFor(record);
    const recordBefore = JSON.stringify(record);
    const draftBefore = JSON.stringify(draft);
    const projected = projectBoundedGeneratedDraftToMedicalRecord(record, draft);
    const safelyParsed = parseEncounterRecordV1(projected);

    expect(JSON.stringify(record)).toBe(recordBefore);
    expect(JSON.stringify(draft)).toBe(draftBefore);
    expect(projected).not.toBe(record);
    expect(safelyParsed.caseId).toBe(record.caseId);
    expect(safelyParsed.caseVersion).toBe(record.caseVersion);
    expect(scanSuspectedPii(safelyParsed)).toHaveLength(0);
    expect(projected.draftProjection?.source).toBe("BOUNDED_GENERATED_DRAFT");
    expect(projected.draftProjection?.mode).toBe("BOUNDED");
    expect(projected.draftProjection?.sections.length).toBeGreaterThan(0);
    expect(projected.draftProjection?.sections.every((section) =>
      section.status === "PENDING_PHYSICIAN_CONFIRMATION")).toBe(true);
    expect(projected.draftProjection?.sections.map((section) => ({
      key: section.key,
      title: section.title,
      content: section.content,
      mandatory: section.mandatory,
    }))).toEqual(draft.sections
      .filter((section) => section.content.some((line) => line.trim().length > 0))
      .map((section) => ({
        key: section.key,
        title: section.title,
        content: section.content.filter((line) => line.trim().length > 0),
        mandatory: section.mandatory,
      })));
    expect(projected.history).toEqual(record.history);
    expect(projected.patientEducationFacts).toEqual(record.patientEducationFacts);
    expect(projected.draftProjection?.sections.find((section) => section.key === "patientEducation")).toBeDefined();
    expect(projected.draftProjection?.sections.find((section) => section.key === "draftDisclaimer")).toBeDefined();
  });

  it("projects all 24 records through the complete safe boundary without invention", () => {
    for (const record of syntheticMedicalRecords) {
      const draft = boundedDraftFor(record);
      const recordBefore = JSON.stringify(record);
      const draftBefore = JSON.stringify(draft);
      const projected = projectBoundedGeneratedDraftToMedicalRecord(record, draft);
      const safelyParsed = parseEncounterRecordV1(projected);

      expect(safelyParsed.caseId).toBe(record.caseId);
      expect(safelyParsed.caseVersion).toBe(record.caseVersion);
      expect(safelyParsed.draftProjection?.sections.every((section) =>
        section.status === "PENDING_PHYSICIAN_CONFIRMATION")).toBe(true);
      expect(safelyParsed.history).toEqual(record.history);
      expect(safelyParsed.physicalExam).toEqual(record.physicalExam);
      expect(safelyParsed.auxiliaryExams).toEqual(record.auxiliaryExams);
      expect(safelyParsed.patientEducationFacts).toEqual(record.patientEducationFacts);
      expect(safelyParsed.draftProjection?.sections.some((section) => section.key === "patientEducation")).toBe(true);
      expect(safelyParsed.draftProjection?.sections.some((section) => section.key === "draftDisclaimer")).toBe(true);
      expect(scanSuspectedPii(safelyParsed)).toHaveLength(0);
      expect(JSON.stringify(record)).toBe(recordBefore);
      expect(JSON.stringify(draft)).toBe(draftBefore);
    }
  });

  it("rejects GENERIC mode and case/version mismatches with controlled errors", () => {
    const draft = boundedDraftFor(record);
    expect(() => projectBoundedDraftToEncounterRecord(record, { ...draft, mode: "GENERIC" })).toThrowError(
      expect.objectContaining({ code: medicalRecordErrorCodes.PROJECTION_MODE_UNSUPPORTED }),
    );
    expect(() => projectBoundedGeneratedDraftToMedicalRecord(record, {
      ...draft,
      caseId: "general-first-002",
      caseVersion: "0.4.1-002",
    })).toThrowError(
      expect.objectContaining({ code: medicalRecordErrorCodes.PROJECTION_CASE_MISMATCH }),
    );
  });

  it("fails closed for PII, duplicate sections, and empty projected content", () => {
    const draft = boundedDraftFor(record);
    const piiDraft = {
      ...draft,
      sections: draft.sections.map((section, index) => index === 0
        ? { ...section, content: ["患者姓名：合成患者"] }
        : section),
    };
    expect(() => projectBoundedGeneratedDraftToMedicalRecord(record, piiDraft)).toThrowError(
      expect.objectContaining({ code: medicalRecordErrorCodes.PROJECTION_SUSPECTED_PII }),
    );

    const firstSection = draft.sections[0];
    expect(() => projectBoundedGeneratedDraftToMedicalRecord(record, {
      ...draft,
      sections: [firstSection, firstSection],
    })).toThrowError(
      expect.objectContaining({ code: medicalRecordErrorCodes.PROJECTION_INVALID }),
    );
    expect(() => projectBoundedGeneratedDraftToMedicalRecord(record, {
      ...draft,
      sections: draft.sections.map((section) => ({ ...section, content: [] })),
    })).toThrowError(
      expect.objectContaining({ code: medicalRecordErrorCodes.PROJECTION_INVALID }),
    );
  });
});
