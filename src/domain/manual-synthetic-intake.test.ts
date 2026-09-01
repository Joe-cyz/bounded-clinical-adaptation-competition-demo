import { describe, expect, it } from "vitest";

import {
  parseEncounterSource,
  type EncounterSource,
} from "./encounter-source";
import {
  manualSyntheticIntakeCreateRequestSchema,
  manualSyntheticIntakeSchema,
} from "./manual-synthetic-intake";
import {
  assertEncounterRecordPayloadBinding,
  createManualSyntheticInitialRecord,
  EncounterRecordBindingError,
} from "./manual-synthetic-record";
import { syntheticMedicalRecords } from "@/data/seed-loader";

const intake = {
  schemaVersion: "1.0.0" as const,
  intakeId: "manual-intake-testz001",
  creationRequestId: "manual-request-testz001",
  synthetic: true as const,
  displayLabel: "合成手工患者-manual-display-testz001",
  specialty: "普通内科" as const,
  visitType: "慢病复诊" as const,
  sex: "FEMALE" as const,
  age: 30,
  visitDate: "2026-08-24",
  recordDate: "2026-08-24",
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("manual synthetic source and intake domain", () => {
  it("interprets a legacy source-less Encounter explicitly as seeded", () => {
    const source: EncounterSource = parseEncounterSource(undefined, {
      caseId: "general-first-001",
      caseVersion: "0.4.1-001",
    });

    expect(source).toEqual({
      type: "SEEDED_SYNTHETIC",
      caseId: "general-first-001",
      caseVersion: "0.4.1-001",
      sourceDatasetVersion: "0.4.1",
    });
  });

  it("requires an explicit manual source branch and never guesses by case ID", () => {
    expect(parseEncounterSource({
      type: "MANUAL_SYNTHETIC",
      intakeId: intake.intakeId,
      intakeSchemaVersion: "1.0.0",
    }, { caseId: "manual-synthetic-case-any", caseVersion: "manual-intake-1.0.0" })).toEqual({
      type: "MANUAL_SYNTHETIC",
      intakeId: intake.intakeId,
      intakeSchemaVersion: "1.0.0",
    });
    expect(() => parseEncounterSource({ type: "UNKNOWN", caseId: "manual-synthetic-case-any" }, {
      caseId: "manual-synthetic-case-any",
      caseVersion: "manual-intake-1.0.0",
    })).toThrow();
  });

  it("keeps the intake schema strict and bounded", () => {
    expect(manualSyntheticIntakeSchema.safeParse(intake).success).toBe(true);
    expect(manualSyntheticIntakeCreateRequestSchema.safeParse({
      creationRequestId: intake.creationRequestId,
      specialty: intake.specialty,
      visitType: intake.visitType,
      sex: intake.sex,
      age: 151,
    }).success).toBe(false);
    expect(manualSyntheticIntakeCreateRequestSchema.safeParse({
      creationRequestId: intake.creationRequestId,
      specialty: intake.specialty,
      visitType: intake.visitType,
      sex: intake.sex,
      age: intake.age,
      name: "合成患者",
    }).success).toBe(false);
  });

  it("builds a manual record without the seeded dataset version or clinical filler text", () => {
    const record = createManualSyntheticInitialRecord({
      intake,
      caseId: "manual-synthetic-case-manual-intake-testz001",
      caseVersion: "manual-intake-1.0.0",
    });

    expect(record.source).toEqual({
      type: "MANUAL_SYNTHETIC",
      intakeId: intake.intakeId,
      intakeSchemaVersion: "1.0.0",
    });
    expect("sourceDatasetVersion" in record).toBe(false);
    expect(JSON.stringify(record)).not.toContain("暂无");
    expect(record.physicalExam.vitalSigns).toEqual({ status: "UNKNOWN" });
    expect(record.auxiliaryExams.imaging).toEqual({ status: "UNKNOWN" });
  });

  it("binds manual and seeded records by explicit source metadata without prefix inference", () => {
    const manualRecord = createManualSyntheticInitialRecord({
      intake,
      caseId: "manual-synthetic-case-manual-intake-testz001",
      caseVersion: "manual-intake-1.0.0",
    });
    const manualEncounter = {
      caseId: manualRecord.caseId,
      caseVersion: manualRecord.caseVersion,
      demographicSnapshot: { displayLabel: manualRecord.demographics.displayLabel },
    };
    const manualSource: EncounterSource = {
      type: "MANUAL_SYNTHETIC",
      intakeId: intake.intakeId,
      intakeSchemaVersion: "1.0.0",
    };

    expect(() => assertEncounterRecordPayloadBinding({ encounter: manualEncounter, source: manualSource, record: manualRecord })).not.toThrow();
    expect(() => assertEncounterRecordPayloadBinding({
      encounter: manualEncounter,
      source: { ...manualSource, intakeId: "manual-intake-otherz001" },
      record: manualRecord,
    })).toThrowError(expect.objectContaining({ code: "MANUAL_INTAKE_ID_MISMATCH" } satisfies Partial<EncounterRecordBindingError>));

    const seededRecord = syntheticMedicalRecords[0];
    const seededSource: EncounterSource = {
      type: "SEEDED_SYNTHETIC",
      caseId: seededRecord.caseId,
      caseVersion: seededRecord.caseVersion,
      sourceDatasetVersion: "0.4.1",
    };
    expect(() => assertEncounterRecordPayloadBinding({
      encounter: {
        caseId: seededRecord.caseId,
        caseVersion: seededRecord.caseVersion,
        demographicSnapshot: { displayLabel: seededRecord.demographics.displayLabel },
      },
      source: seededSource,
      record: seededRecord,
    })).not.toThrow();
    expect(() => assertEncounterRecordPayloadBinding({
      encounter: manualEncounter,
      source: seededSource,
      record: manualRecord,
    })).toThrowError(expect.objectContaining({ code: "SOURCE_TYPE_MISMATCH" } satisfies Partial<EncounterRecordBindingError>));
  });
});
