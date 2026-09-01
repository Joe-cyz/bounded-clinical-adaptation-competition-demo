import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  advanceEncounterStatus,
  createEncounterRecord,
  encounterRecordRevisionSchema,
  type EncounterRecord,
} from "@/domain/encounter";
import { PersistenceError, persistenceErrorCodes } from "./errors";
import { openRuntimeDatabase } from "./connection";
import { createEncounterRecordRevisionRepository } from "./repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "./repositories/encounter-repository";

// SYNTHETIC_TEST_ONLY: runtime-built corruption marker avoids a public email-like literal.
const syntheticCorruptMarker = ["bad-json-with-synthetic", "example.invalid"].join("@");

const fixedClock = "2026-08-21T00:00:00.000Z";

function encounter(overrides: Partial<EncounterRecord> = {}): EncounterRecord {
  const record = createEncounterRecord({
    id: "encounter-repository-001",
    caseId: "endo-followup-001",
    caseVersion: "0.4.1",
    demographicSnapshot: {
      displayLabel: "合成患者-01",
      sex: "NOT_STATED",
      ageBand: "ADULT",
    },
    createdAt: fixedClock,
    runtimeMode: "local-research",
  });
  return { ...record, ...overrides };
}

function revision(overrides: Partial<ReturnType<typeof encounterRecordRevisionSchema.parse>> = {}) {
  return encounterRecordRevisionSchema.parse({
    schemaVersion: "1.0.0",
    id: "record-revision-repository-001",
    encounterId: "encounter-repository-001",
    revisionNumber: 1,
    recordPayload: {},
    createdAt: fixedClock,
    ...overrides,
  });
}

describe("Encounter SQLite repositories", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => fixedClock });
  });

  afterEach(() => {
    database.close();
  });

  it("creates and reads an Encounter by ID", () => {
    const repository = createEncounterRepository(database);
    const record = encounter();
    repository.insert(record);

    expect(repository.getById(record.id)).toEqual(record);
    expect(repository.listByCase(record.caseId, record.caseVersion).map((item) => item.id)).toEqual([record.id]);
    expect(repository.listByStatus("DRAFT").map((item) => item.id)).toEqual([record.id]);
  });

  it("returns a controlled conflict for duplicate Encounter IDs", () => {
    const repository = createEncounterRepository(database);
    const record = encounter();
    repository.insert(record);

    expect(() => repository.insert(record)).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
  });

  it("stores immutable record revisions and rejects stale or mutable writes", () => {
    const encounters = createEncounterRepository(database);
    const revisions = createEncounterRecordRevisionRepository(database);
    encounters.insert(encounter());

    const first = revision();
    revisions.append(first);
    expect(revisions.getById(first.id)).toEqual(first);

    expect(() => revisions.append(revision({ id: "record-revision-repository-002", revisionNumber: 2 }))).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    const second = revision({
      id: "record-revision-repository-002",
      revisionNumber: 2,
      recordPayload: { synthetic: true },
    });
    revisions.append(second, 1);
    expect(revisions.getLatestByEncounter(first.encounterId)).toEqual(second);

    expect(() => database.prepare(
      "UPDATE encounter_record_revisions SET record_payload_json = ? WHERE id = ?",
    ).run("{}", first.id)).toThrow();
    expect(() => database.prepare(
      "DELETE FROM encounter_record_revisions WHERE id = ?",
    ).run(first.id)).toThrow();
  });

  it("protects status writes with an optimistic status and timestamp check", () => {
    const encounters = createEncounterRepository(database);
    const revisions = createEncounterRecordRevisionRepository(database);
    const initial = encounter();
    encounters.insert(initial);
    revisions.append(revision());

    const saved = advanceEncounterStatus(
      initial,
      "RECORD_SAVED",
      "2026-08-21T00:00:01.000Z",
      { currentRecordRevisionId: "record-revision-repository-001" },
    );
    encounters.updateStatus(saved, { status: initial.status, updatedAt: initial.updatedAt });
    expect(encounters.getById(initial.id)?.status).toBe("RECORD_SAVED");

    expect(() => encounters.updateStatus(
      { ...saved, status: "REFERENCE_VIEWED", updatedAt: "2026-08-21T00:00:02.000Z" },
      { status: "DRAFT", updatedAt: initial.updatedAt },
    )).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));
  });

  it("maps damaged persisted JSON to DATA_CORRUPTION without exposing the raw value", () => {
    const repository = createEncounterRepository(database);
    const record = encounter();
    repository.insert(record);
    const corruptJson = `{${syntheticCorruptMarker}}`;
    database.prepare(
      "UPDATE encounters SET demographic_snapshot_json = ? WHERE id = ?",
    ).run(corruptJson, record.id);

    try {
      repository.getById(record.id);
      throw new Error("Expected corruption error.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.DATA_CORRUPTION);
      expect((error as Error).message).not.toContain(corruptJson);
    }
  });
});
