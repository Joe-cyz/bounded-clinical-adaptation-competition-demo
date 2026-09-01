import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/server/database", () => ({
  getDatabase: vi.fn(() => {
    throw new Error("database factory should not be opened by this action test");
  }),
}));

import {
  createManualSyntheticEncounterAction,
  transitionToReferenceAction,
} from "./actions";
import { createManualSyntheticEncounter } from "@/application/manual-synthetic-encounter-service";
import { getDatabase } from "@/server/database";
import { editableMedicalRecordPayloadOf } from "@/domain/medical-record-editing";
import { saveMedicalRecord } from "@/application/medical-record-service";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";

const previousRuntimeMode = process.env.APP_RUNTIME_MODE;

function formData(entries: Array<[string, string | File]>): FormData {
  const value = new FormData();
  entries.forEach(([name, entry]) => value.append(name, entry));
  return value;
}

afterEach(() => {
  vi.mocked(getDatabase).mockClear();
  if (previousRuntimeMode === undefined) delete process.env.APP_RUNTIME_MODE;
  else process.env.APP_RUNTIME_MODE = previousRuntimeMode;
});

describe("PWR-13B manual encounter Server Action boundary", () => {
  it("rejects public-demo before invoking the counted throwing database factory", async () => {
    process.env.APP_RUNTIME_MODE = "public-demo";
    const result = await createManualSyntheticEncounterAction(
      { status: "idle" },
      formData([
        ["creationRequestId", "manual-request-actionz001"],
        ["specialty", "普通内科"],
        ["visitType", "初诊"],
        ["sex", "FEMALE"],
        ["age", "0"],
      ]),
    );

    expect(result).toEqual(expect.objectContaining({ status: "error", code: "PUBLIC_DEMO_READ_ONLY" }));
    expect(vi.mocked(getDatabase)).toHaveBeenCalledTimes(0);
  });

  it("ignores Next action metadata but rejects unknown, duplicate, File, date, and runtime fields", async () => {
    process.env.APP_RUNTIME_MODE = "local-research";
    const invalidForms = [
      [["$ACTION_ID", "next"], ["creationRequestId", "manual-request-actionz001"], ["specialty", "普通内科"], ["visitType", "初诊"], ["sex", "FEMALE"], ["age", "0"], ["unknown", "reject"]],
      [["creationRequestId", "manual-request-actionz001"], ["creationRequestId", "manual-request-actionz002"], ["specialty", "普通内科"], ["visitType", "初诊"], ["sex", "FEMALE"], ["age", "0"]],
      [["creationRequestId", "manual-request-actionz001"], ["specialty", "普通内科"], ["visitType", "初诊"], ["sex", "FEMALE"], ["age", new File(["0"], "age.txt")]],
      [["creationRequestId", "manual-request-actionz001"], ["specialty", "普通内科"], ["visitType", "初诊"], ["sex", "FEMALE"], ["age", "0"], ["visitDate", "2026-08-24"]],
      [["creationRequestId", "manual-request-actionz001"], ["specialty", "普通内科"], ["visitType", "初诊"], ["sex", "FEMALE"], ["age", "0"], ["runtimeMode", "local-research"]],
    ] satisfies Array<Array<[string, string | File]>>;

    for (const entries of invalidForms) {
      const result = await createManualSyntheticEncounterAction({ status: "idle" }, formData(entries));
      expect(result).toEqual(expect.objectContaining({ status: "error", code: "MANUAL_SYNTHETIC_INPUT_INVALID" }));
    }
    expect(vi.mocked(getDatabase)).toHaveBeenCalledTimes(0);
  });

  it("accepts the closed local form and obtains the database once through the service factory", async () => {
    process.env.APP_RUNTIME_MODE = "local-research";
    const result = await createManualSyntheticEncounterAction(
      { status: "idle" },
      formData([
        ["$ACTION_ID", "next"],
        ["creationRequestId", "manual-request-actionz001"],
        ["specialty", "内分泌科"],
        ["visitType", "慢病复诊"],
        ["sex", "INTERSEX"],
        ["age", "150"],
      ]),
    );

    expect(result).toEqual(expect.objectContaining({ status: "error" }));
    expect(vi.mocked(getDatabase)).toHaveBeenCalledTimes(1);
  });

  it("allows a bound saved manual Encounter to enter AI reference without changing its record", async () => {
    process.env.APP_RUNTIME_MODE = "local-research";
    const database = openRuntimeDatabase({ path: ":memory:" });
    try {
      const created = createManualSyntheticEncounter({
        creationRequestId: "manual-request-action-referencez001",
        specialty: "普通内科",
        visitType: "初诊",
        sex: "MALE",
        age: 42,
      }, {
        databaseFactory: () => database,
        runtimeMode: "local-research",
        clock: () => "2026-08-21T00:00:00.000Z",
        idFactory: (kind) => `manual-${kind.toLowerCase()}-actionrefz001`,
      });
      const saved = saveMedicalRecord({
        encounterId: created.encounter.id,
        expectedUpdatedAt: created.encounter.updatedAt,
        expectedRevisionNumber: 0,
        editableRecord: editableMedicalRecordPayloadOf(created.initialRecord),
      }, {
        database,
        runtimeMode: "local-research",
        clock: () => "2026-08-21T00:00:01.000Z",
        idFactory: (() => {
          let auditNumber = 0;
          return (kind) => kind === "RECORD_REVISION"
            ? "record-revision-actionrefz001"
            : `audit-actionrefz001-${++auditNumber}`;
        })(),
      });
      vi.mocked(getDatabase).mockReturnValue(database);

      const result = await transitionToReferenceAction({ status: "idle" }, formData([
        ["encounterId", created.encounter.id],
        ["expectedStatus", "RECORD_SAVED"],
        ["expectedUpdatedAt", saved.encounter.updatedAt],
        ["currentRecordRevisionId", saved.revision.id],
      ]));

      expect(result).toBeUndefined();
      expect(createEncounterRepository(database).getById(created.encounter.id)?.status).toBe("REFERENCE_VIEWED");
      expect(createEncounterRepository(database).getById(created.encounter.id)?.currentRecordRevisionId).toBe(saved.revision.id);
      expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", created.encounter.id)).toHaveLength(4);
    } finally {
      database.close();
    }
  });
});
