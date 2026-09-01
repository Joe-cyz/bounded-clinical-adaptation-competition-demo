import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createEncounter } from "./encounter-service";
import {
  getMedicalRecordView,
  getPublicDemoMedicalRecord,
  medicalRecordRevisionSavedAuditMetadataSchema,
  saveMedicalRecord,
  saveMedicalRecordRequestSchema,
  type MedicalRecordIdKind,
} from "./medical-record-service";
import { editableMedicalRecordPayloadOf } from "@/domain/medical-record-editing";
import type { EncounterRecordV1 } from "@/domain/medical-record";
import type { EncounterRecordPayload } from "@/domain/manual-synthetic-record";
import { auditEventRecordSchema } from "@/domain/runtime-records";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";

const fixedTimes = [
  "2026-08-21T00:00:00.000Z",
  "2026-08-21T00:00:01.000Z",
  "2026-08-21T00:00:02.000Z",
  "2026-08-21T00:00:03.000Z",
];

const request = {
  id: "encounter-medical-record-001",
  caseId: "general-first-001",
  caseVersion: "0.4.1-001",
  demographicSnapshot: {
    displayLabel: "合成患者-01",
    sex: "UNKNOWN" as const,
    ageBand: "ADULT" as const,
  },
};

function nextClock() {
  let index = 0;
  return () => fixedTimes[index++] ?? fixedTimes[fixedTimes.length - 1];
}

function idFactory(prefix: string) {
  let revisionNumber = 0;
  let auditNumber = 0;
  return (kind: MedicalRecordIdKind | "ENCOUNTER" | "AUDIT") => {
    if (kind === "ENCOUNTER") return `encounter-${prefix}-001`;
    if (kind === "RECORD_REVISION") return `medical-revision-${prefix}-${String(++revisionNumber).padStart(3, "0")}`;
    return `medical-audit-${prefix}-${String(++auditNumber).padStart(3, "0")}`;
  };
}

function createLocalEncounter(database: DatabaseSync, prefix = "fixture") {
  return createEncounter({ ...request, id: `encounter-${prefix}-001` }, {
    database,
    runtimeMode: "local-research",
    clock: () => fixedTimes[0],
    idFactory: (kind) => kind === "ENCOUNTER" ? `encounter-${prefix}-001` : `encounter-audit-${prefix}`,
  });
}

function editable(record: EncounterRecordV1 | EncounterRecordPayload): ReturnType<typeof editableMedicalRecordPayloadOf> {
  return JSON.parse(JSON.stringify(editableMedicalRecordPayloadOf(record))) as ReturnType<typeof editableMedicalRecordPayloadOf>;
}

describe("PWR-04 MedicalRecordService", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedTimes[0] });
  });

  afterEach(() => {
    database.close();
  });

  it("saves revision 1, advances DRAFT, then saves revision 2 without mutating revision 1", () => {
    const encounter = createLocalEncounter(database, "path");
    const firstRecord = getPublicDemoMedicalRecord().record;
    const clock = nextClock();
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      clock,
      idFactory: idFactory("path"),
    };

    const first = saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editable(firstRecord),
    }, dependencies);

    expect(first.revision.revisionNumber).toBe(1);
    expect(first.encounter.status).toBe("RECORD_SAVED");
    expect(first.encounter.currentRecordRevisionId).toBe(first.revision.id);
    expect(first.record.demographics).toEqual(firstRecord.demographics);
    expect(first.revision.recordPayload.demographics).toEqual(firstRecord.demographics);

    const revisionOnePayload = first.revision.recordPayload;
    const nextEditable = editable(first.record);
    nextEditable.history.chiefComplaint = { status: "PROVIDED", value: "已由医生补充的合成主诉" };
    const second = saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: first.encounter.updatedAt,
      expectedCurrentRecordRevisionId: first.revision.id,
      expectedRevisionNumber: 1,
      editableRecord: nextEditable,
    }, { ...dependencies, clock: () => fixedTimes[2] });

    expect(second.revision.revisionNumber).toBe(2);
    expect(second.encounter.currentRecordRevisionId).toBe(second.revision.id);
    expect(createEncounterRecordRevisionRepository(database).getById(first.revision.id)?.recordPayload).toEqual(revisionOnePayload);
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id)).toHaveLength(2);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)
      .filter((event) => event.eventType === "MEDICAL_RECORD_REVISION_SAVED")).toHaveLength(2);
  });

  it("keeps demographics server-owned and rejects a forged editable demographics field", () => {
    const encounter = createLocalEncounter(database, "demographics-boundary");
    const sidecar = getPublicDemoMedicalRecord().record;
    const candidate = {
      ...editable(sidecar),
      demographics: {
        ...sidecar.demographics,
        displayLabel: "伪造患者",
      },
    };
    const requestValue = {
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: candidate,
    };

    expect(saveMedicalRecordRequestSchema.safeParse(requestValue).success).toBe(false);
    expect(() => saveMedicalRecord(requestValue, {
      database,
      runtimeMode: "local-research",
      clock: () => fixedTimes[1],
      idFactory: idFactory("demographics-boundary"),
    })).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.VALIDATION_FAILED }));
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id)).toEqual([]);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)).toHaveLength(1);
  });

  it("rebuilds the local view from the latest immutable revision", () => {
    const encounter = createLocalEncounter(database, "view");
    const sidecar = getPublicDemoMedicalRecord().record;
    const saved = saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editable(sidecar),
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => fixedTimes[1],
      idFactory: idFactory("view"),
    });

    const view = getMedicalRecordView(encounter.id, { database, runtimeMode: "local-research" });
    expect(view.revisionId).toBe(saved.revision.id);
    expect(view.revisionNumber).toBe(1);
    expect(view.record).toEqual(saved.record);
  });

  it("rejects a stale updatedAt or revision token before any new write", () => {
    const encounter = createLocalEncounter(database, "stale");
    const sidecar = getPublicDemoMedicalRecord().record;
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      clock: () => fixedTimes[1],
      idFactory: idFactory("stale"),
    };
    const first = saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editable(sidecar),
    }, dependencies);
    const auditsBefore = createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id).length;
    const revisionsBefore = createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id).length;

    expect(() => saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedCurrentRecordRevisionId: first.revision.id,
      expectedRevisionNumber: 1,
      editableRecord: editable(first.record),
    }, { ...dependencies, clock: () => fixedTimes[2] })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id)).toHaveLength(revisionsBefore);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)).toHaveLength(auditsBefore);
    expect(createEncounterRepository(database).getById(encounter.id)?.currentRecordRevisionId).toBe(first.revision.id);
  });

  it("rejects suspected PII without echoing the matched text", () => {
    const encounter = createLocalEncounter(database, "pii");
    const sidecar = getPublicDemoMedicalRecord().record;
    const candidate = editable(sidecar);
    candidate.history.chiefComplaint = { status: "PROVIDED", value: "姓名：合成患者" };

    let caught: unknown;
    try {
      saveMedicalRecord({
        encounterId: encounter.id,
        expectedUpdatedAt: encounter.updatedAt,
        expectedRevisionNumber: 0,
        editableRecord: candidate,
      }, {
        database,
        runtimeMode: "local-research",
        clock: () => fixedTimes[1],
        idFactory: idFactory("pii"),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(expect.objectContaining({ code: persistenceErrorCodes.SUSPECTED_PII }));
    expect(String(caught)).not.toContain("合成患者");
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id)).toEqual([]);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)).toHaveLength(1);
  });

  it("rolls back revision and Encounter changes when audit append fails", () => {
    const encounter = createLocalEncounter(database, "rollback");
    const duplicateId = "medical-audit-rollback-duplicate";
    createAuditEventRepository(database).append(auditEventRecordSchema.parse({
      schemaVersion: "1.0.0",
      id: duplicateId,
      eventType: "MEDICAL_RECORD_REVISION_SAVED",
      actorId: "fixture",
      simulatedRole: "SYSTEM",
      entityType: "ENCOUNTER",
      entityId: "other-encounter",
      beforeVersion: "0",
      afterVersion: "1",
      metadata: medicalRecordRevisionSavedAuditMetadataSchema.parse({
        encounterId: "other-encounter",
        revisionId: "other-revision",
        revisionNumber: 1,
        previousRevisionNumber: 0,
        fromStatus: "DRAFT",
        toStatus: "RECORD_SAVED",
        fieldStatusCounts: { PROVIDED: 0, UNKNOWN: 0, NOT_APPLICABLE: 0, PENDING_PHYSICIAN_CONFIRMATION: 0 },
        savedAt: fixedTimes[1],
        synthetic: true,
        runtimeMode: "local-research",
      }),
      createdAt: fixedTimes[1],
    }));

    const sidecar = getPublicDemoMedicalRecord().record;
    expect(() => saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editable(sidecar),
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => fixedTimes[1],
      idFactory: (kind) => kind === "RECORD_REVISION" ? "medical-revision-rollback-001" : duplicateId,
    })).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));

    expect(createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id)).toEqual([]);
    expect(createEncounterRepository(database).getById(encounter.id)?.status).toBe("DRAFT");
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)).toHaveLength(1);
  });

  it("rejects public-demo before opening a write transaction", () => {
    const encounter = createLocalEncounter(database, "public");
    const sidecar = getPublicDemoMedicalRecord().record;

    expect(() => saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editable(sidecar),
    }, {
      database,
      runtimeMode: "public-demo",
      clock: () => fixedTimes[1],
      idFactory: idFactory("public"),
    })).toThrowError(expect.objectContaining({
      code: persistenceErrorCodes.RUNTIME_READ_ONLY,
      ruleId: "PUBLIC_DEMO_READ_ONLY",
    }));
    expect(database.isTransaction).toBe(false);
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id)).toEqual([]);
  });
});
