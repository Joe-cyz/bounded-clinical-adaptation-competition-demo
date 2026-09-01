import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  createManualSyntheticEncounter,
  type ManualSyntheticEncounterIdKind,
} from "./manual-synthetic-encounter-service";
import {
  getMedicalRecordView,
  saveMedicalRecord,
} from "./medical-record-service";
import { getReferenceView } from "./reference-service";
import { editableMedicalRecordPayloadOf } from "@/domain/medical-record-editing";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { persistenceErrorCodes } from "@/infrastructure/sqlite/errors";

const request = {
  creationRequestId: "manual-request-medical-recordz001",
  specialty: "普通内科" as const,
  visitType: "慢病复诊" as const,
  sex: "FEMALE" as const,
  age: 0,
};

function idFactory(suffix: string) {
  return (kind: ManualSyntheticEncounterIdKind): string =>
    `manual-${kind.toLowerCase()}-${suffix}z001`;
}

function editable(record: Parameters<typeof editableMedicalRecordPayloadOf>[0]) {
  return JSON.parse(JSON.stringify(editableMedicalRecordPayloadOf(record))) as ReturnType<typeof editableMedicalRecordPayloadOf>;
}

describe("PWR-13B manual medical record integration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => "2026-08-24T00:00:00.000Z" });
  });

  afterEach(() => {
    database.close();
  });

  it("reads a manual intake as revision zero with trusted unknown demographics", () => {
    const created = createManualSyntheticEncounter(request, {
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clock: () => "2026-08-24T00:00:00.000Z",
      idFactory: idFactory("initial"),
    });

    const view = getMedicalRecordView(created.encounter.id, { database, runtimeMode: "local-research" });

    expect(view.revisionNumber).toBe(0);
    expect(view.revisionId).toBeUndefined();
    expect(view.encounter?.status).toBe("DRAFT");
    expect(view.record).toHaveProperty("source", created.encounter.source);
    expect("sourceDatasetVersion" in view.record).toBe(false);
    expect(view.record.demographics.displayLabel).toBe(created.intake.displayLabel);
    expect(view.record.demographics.sex).toEqual({ status: "PROVIDED", value: "FEMALE" });
    expect(view.record.demographics.age).toEqual({ status: "PROVIDED", value: 0 });
    expect(view.record.demographics.occupation).toEqual({ status: "UNKNOWN" });
    expect(view.record.demographics.ethnicity).toEqual({ status: "UNKNOWN" });
    expect(view.record.demographics.maritalStatus).toEqual({ status: "UNKNOWN" });
    expect(view.record.demographics.syntheticRegion).toEqual({ status: "UNKNOWN" });
    expect(view.record.demographics.admissionDate).toEqual({ status: "NOT_APPLICABLE" });
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(created.encounter.id)).toEqual([]);
  });

  it("saves only editable clinical fields and reloads the same manual source", () => {
    const created = createManualSyntheticEncounter(request, {
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clock: () => "2026-08-24T00:00:00.000Z",
      idFactory: idFactory("save"),
    });
    const view = getMedicalRecordView(created.encounter.id, { database, runtimeMode: "local-research" });
    const nextEditable = editable(view.record);
    nextEditable.history.chiefComplaint = { status: "PROVIDED", value: "头晕两天" };

    let saveAuditSequence = 0;
    const saved = saveMedicalRecord({
      encounterId: created.encounter.id,
      expectedUpdatedAt: view.expectedUpdatedAt,
      expectedRevisionNumber: 0,
      editableRecord: nextEditable,
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-24T00:00:01.000Z",
      idFactory: (kind) => kind === "RECORD_REVISION"
        ? "medical-revision-savez001"
        : `medical-audit-savez${String(++saveAuditSequence).padStart(3, "0")}`,
    });

    expect(saved.revision.revisionNumber).toBe(1);
    expect(saved.encounter.status).toBe("RECORD_SAVED");
    expect(saved.record).toHaveProperty("source", created.encounter.source);
    expect(saved.record.history.chiefComplaint).toEqual({ status: "PROVIDED", value: "头晕两天" });
    expect("sourceDatasetVersion" in saved.record).toBe(false);

    const reloaded = getMedicalRecordView(created.encounter.id, { database, runtimeMode: "local-research" });
    expect(reloaded.revisionNumber).toBe(1);
    expect(reloaded.revisionId).toBe(saved.revision.id);
    expect(reloaded.record).toEqual(saved.record);
    expect(createEncounterRepository(database).getById(created.encounter.id)?.currentRecordRevisionId)
      .toBe(saved.revision.id);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", created.encounter.id)
      .filter((event) => event.eventType === "ENCOUNTER_CREATED")).toHaveLength(1);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", created.encounter.id)
      .filter((event) => event.eventType === "MEDICAL_RECORD_REVISION_SAVED")).toHaveLength(1);
  });

  it("rejects forged identity, source, date, and schema fields before writing a revision", () => {
    const created = createManualSyntheticEncounter(request, {
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clock: () => "2026-08-24T00:00:00.000Z",
      idFactory: idFactory("forged"),
    });
    const view = getMedicalRecordView(created.encounter.id, { database, runtimeMode: "local-research" });
    const forged = {
      ...editable(view.record),
      source: { type: "SEEDED_SYNTHETIC" },
      demographics: { ...view.record.demographics, age: { status: "PROVIDED", value: 150 } },
      visitDate: "2099-01-01",
      schemaVersion: "9.9.9",
    };

    expect(() => saveMedicalRecord({
      encounterId: created.encounter.id,
      expectedUpdatedAt: view.expectedUpdatedAt,
      expectedRevisionNumber: 0,
      editableRecord: forged,
    }, { database, runtimeMode: "local-research" })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.VALIDATION_FAILED }),
    );
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(created.encounter.id)).toEqual([]);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", created.encounter.id)).toHaveLength(1);
  });

  it("allows a bound manual record at the reference boundary without changing state", () => {
    const created = createManualSyntheticEncounter(request, {
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clock: () => "2026-08-24T00:00:00.000Z",
      idFactory: idFactory("reference"),
    });
    const view = getMedicalRecordView(created.encounter.id, { database, runtimeMode: "local-research" });
    const nextEditable = editable(view.record);
    nextEditable.history.chiefComplaint = { status: "PROVIDED", value: "待参考边界测试" };
    const saved = saveMedicalRecord({
      encounterId: created.encounter.id,
      expectedUpdatedAt: view.expectedUpdatedAt,
      expectedRevisionNumber: 0,
      editableRecord: nextEditable,
    }, { database, runtimeMode: "local-research", clock: () => "2026-08-24T00:00:01.000Z" });

    const reference = getReferenceView(created.encounter.id, { database, runtimeMode: "local-research" });
    expect(reference.encounter.displayLabel).toBe(saved.record.demographics.displayLabel);
    expect(reference.encounter.revisionNumber).toBe(saved.revision.revisionNumber);
    expect(reference.summary.fullText).toContain("主诉：待参考边界测试");
    expect(createEncounterRepository(database).getById(created.encounter.id)).toEqual(saved.encounter);
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(created.encounter.id)).toHaveLength(1);
  });
});
