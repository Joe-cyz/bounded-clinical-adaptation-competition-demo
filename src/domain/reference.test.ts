import { describe, expect, it } from "vitest";

import { syntheticMedicalRecords } from "@/data/seed-loader";
import {
  auxiliaryExamsSchema,
  medicalListFieldSchema,
  medicalTextFieldSchema,
  vitalSignsFieldSchema,
} from "@/domain/medical-record";
import {
  buildMedicalRecordSummary,
  createReferenceView,
  emptyLiteratureEntryState,
  literatureEntryStateSchema,
  referenceViewSchema,
} from "./reference";

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function shortRecord() {
  const record = copy(syntheticMedicalRecords[0]);
  const unknownText = () => medicalTextFieldSchema.parse({ status: "UNKNOWN" });
  const unknownList = () => medicalListFieldSchema.parse({ status: "UNKNOWN" });
  record.history = {
    chiefComplaint: unknownText(),
    presentIllness: unknownText(),
    problemFacts: unknownList(),
    recentChanges: unknownList(),
    pastHistory: unknownText(),
    personalHistory: unknownText(),
    familyHistory: unknownText(),
    allergyHistory: unknownText(),
    currentMedications: unknownText(),
    redFlags: unknownList(),
  };
  record.physicalExam = {
    vitalSigns: vitalSignsFieldSchema.parse({ status: "UNKNOWN" }),
    generalCondition: unknownText(),
    specialtyExam: unknownText(),
    notExaminedOrUnknown: unknownList(),
  };
  record.auxiliaryExams = auxiliaryExamsSchema.parse({
    laboratory: { status: "UNKNOWN" },
    electrocardiogram: { status: "UNKNOWN" },
    imaging: { status: "UNKNOWN" },
    other: { status: "UNKNOWN" },
  });
  record.missingInformation = unknownList();
  record.patientEducationFacts = unknownList();
  record.pendingInformation = [];
  return record;
}

describe("PWR-07 reference projections", () => {
  it("combines only source facts and preserves unknown states", () => {
    const record = shortRecord();
    record.history.chiefComplaint = medicalTextFieldSchema.parse({
      status: "PROVIDED",
      value: "合成主诉：晨起乏力",
    });
    record.history.allergyHistory = medicalTextFieldSchema.parse({ status: "UNKNOWN" });

    const summary = buildMedicalRecordSummary(record);

    expect(summary.fullText).toContain("主诉：合成主诉：晨起乏力");
    expect(summary.fullText).toContain("过敏史：未记录");
    expect(summary.fullText).not.toMatch(/诊断|鉴别|治疗建议|风险判断/u);
  });

  it("does not add an expand action for a short summary", () => {
    const summary = buildMedicalRecordSummary(shortRecord());

    expect(summary.isExpandable).toBe(false);
    expect(summary.previewText).toBe(summary.fullText);
  });

  it("provides a deterministic collapsed preview for a long summary", () => {
    const record = shortRecord();
    record.history.chiefComplaint = medicalTextFieldSchema.parse({
      status: "PROVIDED",
      value: "合成症状".repeat(100),
    });

    const summary = buildMedicalRecordSummary(record);

    expect(summary.isExpandable).toBe(true);
    expect(summary.previewText.length).toBeLessThan(summary.fullText.length);
    expect(summary.fullText).toContain("合成症状");
  });

  it("uses strict view and literature schemas", () => {
    const record = syntheticMedicalRecords[0];
    const view = createReferenceView({
      mode: "public-demo",
      encounterId: "demo",
      encounter: {
        displayLabel: record.demographics.displayLabel,
        caseId: record.caseId,
        caseVersion: record.caseVersion,
        specialty: record.specialty,
        visitType: record.visitType,
        revisionNumber: 0,
      },
      record,
    });
    const literature = emptyLiteratureEntryState();

    expect(referenceViewSchema.safeParse({ ...view, recordPayload: record }).success).toBe(false);
    expect(literatureEntryStateSchema.safeParse({ ...literature, citation: "fake" }).success).toBe(false);
    expect(literature.hasImportedSources).toBe(false);
    expect(literature.questionAnsweringEnabled).toBe(false);
    expect(literature.citationCount).toBe(0);
  });
});
