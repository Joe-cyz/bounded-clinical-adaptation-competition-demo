import { describe, expect, it } from "vitest";

import {
  advanceEncounterStatus,
  createEncounterRecord,
  encounterCreatedAuditMetadataSchema,
  encounterRecordSchema,
  encounterStatusChangedAuditMetadataSchema,
  type EncounterRecord,
} from "./encounter";
import { validateRuntimeRecord } from "@/infrastructure/sqlite/record-validation";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";

// SYNTHETIC_TEST_ONLY: runtime-built value for the PII rejection path.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");

const snapshot = {
  displayLabel: "合成患者-01",
  sex: "NOT_STATED" as const,
  ageBand: "ADULT" as const,
};

function draft(overrides: Partial<EncounterRecord> = {}): EncounterRecord {
  const record = createEncounterRecord({
    id: "encounter-domain-001",
    caseId: "endo-followup-001",
    caseVersion: "0.4.1",
    demographicSnapshot: snapshot,
    createdAt: "2026-08-21T00:00:00.000Z",
    runtimeMode: "local-research",
  });
  return encounterRecordSchema.parse({ ...record, ...overrides });
}

describe("Encounter domain model", () => {
  it("accepts a valid synthetic DRAFT Encounter", () => {
    expect(encounterRecordSchema.safeParse(draft()).success).toBe(true);
  });

  it("rejects a non-synthetic Encounter and extra identifying fields", () => {
    expect(encounterRecordSchema.safeParse({
      ...draft(),
      synthetic: false,
    }).success).toBe(false);
    expect(encounterRecordSchema.safeParse({
      ...draft(),
      demographicSnapshot: { ...snapshot, name: "合成患者" },
    }).success).toBe(false);
  });

  it("allows the complete forward path only when a record revision is associated", () => {
    const saved = advanceEncounterStatus(
      draft(),
      "RECORD_SAVED",
      "2026-08-21T00:00:01.000Z",
      { currentRecordRevisionId: "record-revision-001" },
    );
    const viewed = advanceEncounterStatus(saved, "REFERENCE_VIEWED", "2026-08-21T00:00:02.000Z");
    const pending = advanceEncounterStatus(viewed, "REVIEW_PENDING", "2026-08-21T00:00:03.000Z");
    const confirmed = advanceEncounterStatus(pending, "CONFIRMED", "2026-08-21T00:00:04.000Z");

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.currentRecordRevisionId).toBe("record-revision-001");
    expect(confirmed.confirmedAt).toBe("2026-08-21T00:00:04.000Z");
  });

  it("rejects jumps, backwards moves, repeated transitions, and terminal transitions", () => {
    const initial = draft();
    expect(() => advanceEncounterStatus(initial, "REFERENCE_VIEWED", "2026-08-21T00:00:01.000Z", {
      currentRecordRevisionId: "record-revision-001",
    })).toThrow();
    expect(() => advanceEncounterStatus(initial, "DRAFT", "2026-08-21T00:00:01.000Z")).toThrow();

    const saved = advanceEncounterStatus(
      initial,
      "RECORD_SAVED",
      "2026-08-21T00:00:01.000Z",
      { currentRecordRevisionId: "record-revision-001" },
    );
    expect(() => advanceEncounterStatus(saved, "DRAFT", "2026-08-21T00:00:02.000Z")).toThrow();
    expect(() => advanceEncounterStatus(saved, "RECORD_SAVED", "2026-08-21T00:00:02.000Z")).toThrow();

    const confirmed = advanceEncounterStatus(
      advanceEncounterStatus(
        advanceEncounterStatus(saved, "REFERENCE_VIEWED", "2026-08-21T00:00:02.000Z"),
        "REVIEW_PENDING",
        "2026-08-21T00:00:03.000Z",
      ),
      "CONFIRMED",
      "2026-08-21T00:00:04.000Z",
    );
    expect(() => advanceEncounterStatus(confirmed, "CONFIRMED", "2026-08-21T00:00:05.000Z")).toThrow();
  });

  it("enforces record revision and confirmation timestamp invariants", () => {
    expect(encounterRecordSchema.safeParse({
      ...draft(),
      status: "RECORD_SAVED",
    }).success).toBe(false);
    expect(encounterRecordSchema.safeParse({
      ...draft(),
      status: "DRAFT",
      confirmedAt: "2026-08-21T00:00:01.000Z",
    }).success).toBe(false);
    expect(encounterRecordSchema.safeParse({
      ...draft(),
      status: "CONFIRMED",
      currentRecordRevisionId: "record-revision-001",
    }).success).toBe(false);
  });

  it("enforces created, updated, and confirmed time order", () => {
    expect(encounterRecordSchema.safeParse({
      ...draft(),
      updatedAt: "2026-08-20T23:59:59.000Z",
    }).success).toBe(false);

    const confirmed = {
      ...draft({ currentRecordRevisionId: "record-revision-001" }),
      status: "CONFIRMED" as const,
      confirmedAt: "2026-08-21T00:00:00.500Z",
    };
    expect(encounterRecordSchema.safeParse({
      ...confirmed,
      confirmedAt: "2026-08-20T23:59:59.000Z",
    }).success).toBe(false);

    const saved = advanceEncounterStatus(
      draft(),
      "RECORD_SAVED",
      "2026-08-21T00:00:02.000Z",
      { currentRecordRevisionId: "record-revision-001" },
    );
    expect(() => advanceEncounterStatus(
      saved,
      "REFERENCE_VIEWED",
      "2026-08-21T00:00:01.000Z",
    )).toThrow();
  });

  it("rejects suspected PII through the existing runtime record validator", () => {
    try {
      validateRuntimeRecord(
        encounterRecordSchema,
        {
          ...draft(),
          caseId: syntheticTestOnlyPhone,
        },
      );
      throw new Error("Expected PII rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.SUSPECTED_PII);
      expect((error as Error).message).not.toContain(syntheticTestOnlyPhone);
    }
  });

  it("keeps Encounter audit metadata event-specific and strict", () => {
    const base = {
      encounterId: "encounter-audit-001",
      caseId: "endo-followup-001",
      caseVersion: "0.4.1",
      synthetic: true as const,
      runtimeMode: "local-research" as const,
    };

    expect(encounterCreatedAuditMetadataSchema.safeParse(base).success).toBe(true);
    expect(encounterCreatedAuditMetadataSchema.safeParse({
      ...base,
      fromStatus: "DRAFT",
      toStatus: "RECORD_SAVED",
    }).success).toBe(false);
    expect(encounterCreatedAuditMetadataSchema.safeParse({
      ...base,
      recordPayload: { note: "not allowed" },
    }).success).toBe(false);
    expect(encounterStatusChangedAuditMetadataSchema.safeParse({
      ...base,
      fromStatus: "DRAFT",
      toStatus: "RECORD_SAVED",
    }).success).toBe(true);
    expect(encounterStatusChangedAuditMetadataSchema.safeParse(base).success).toBe(false);
    expect(encounterStatusChangedAuditMetadataSchema.safeParse({
      ...base,
      fromStatus: "DRAFT",
      toStatus: "RECORD_SAVED",
      demographicSnapshot: snapshot,
    }).success).toBe(false);
  });
});
