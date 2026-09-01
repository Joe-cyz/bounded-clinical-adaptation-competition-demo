import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "./connection";
import { PersistenceError, persistenceErrorCodes } from "./errors";
import { createAuditEventRepository } from "./repositories/audit-event-repository";
import { createGenerationRunRepository } from "./repositories/generation-run-repository";
import { createPhysicianProfileVersionRepository } from "./repositories/physician-profile-version-repository";
import {
  fixtureAuditEvent,
  fixtureCase,
  fixtureGenerationRun,
  fixtureProfileVersion,
} from "./test-fixtures";

// SYNTHETIC_TEST_ONLY: runtime-built values for privacy rejection paths.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");
const syntheticTestOnlyEmail = ["synthetic", "test", "example.invalid"].join("@");
const syntheticCorruptMarker = ["not-json-with-synthetic", "example.invalid"].join("@");

const fixedClock = () => "2026-08-19T00:00:00.000Z";

function expectPersistenceError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected persistence error.");
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).code).toBe(code);
  }
}

describe("SQLite repositories", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
  });

  afterEach(() => {
    database.close();
  });

  it("writes and reads a successful generation run without replacing snapshots", () => {
    const repository = createGenerationRunRepository(database);
    const record = fixtureGenerationRun();

    repository.insert(record);
    record.inputCaseSnapshot.patientSummary = "changed only in caller";
    record.effectiveConfigSnapshot.configurationKey = "changed only in caller";

    const stored = repository.getById(record.id);
    expect(stored).toEqual(expect.objectContaining({
      id: "run-fixture-001",
      status: "SUCCEEDED",
      providerId: "deterministic-mock",
      modelId: "deterministic-rule-generator",
      promptVersion: "mock-prompt-v1",
      outputDraftSnapshot: expect.any(Object),
    }));
    expect(stored?.inputCaseSnapshot.patientSummary).toBe(fixtureCase.patientSummary);
    expect(stored?.effectiveConfigSnapshot.configurationKey).not.toBe("changed only in caller");
  });

  it("writes and reads a failed generation run with a controlled error", () => {
    const repository = createGenerationRunRepository(database);
    const record = fixtureGenerationRun({
      id: "run-fixture-failed-002",
      status: "FAILED",
      outputDraftSnapshot: undefined,
      errorType: "OUTPUT_VALIDATION",
      errorMessage: "Output validation blocked persistence.",
    });

    repository.insert(record);

    expect(repository.getById(record.id)).toEqual(record);
  });

  it("lists generation runs by case in stable UTC time and ID order", () => {
    const repository = createGenerationRunRepository(database);
    repository.insert(fixtureGenerationRun({ id: "run-z", createdAt: "2026-08-19T00:00:02.000Z" }));
    repository.insert(fixtureGenerationRun({ id: "run-a", createdAt: "2026-08-19T00:00:01.000Z" }));
    repository.insert(fixtureGenerationRun({ id: "run-b", createdAt: "2026-08-19T00:00:01.000Z" }));

    expect(repository.listByCase(fixtureCase.id).map((record) => record.id)).toEqual(["run-a", "run-b", "run-z"]);
  });

  it("rejects duplicate generation run IDs with a stable conflict", () => {
    const repository = createGenerationRunRepository(database);
    const record = fixtureGenerationRun();
    repository.insert(record);

    expectPersistenceError(() => repository.insert(record), persistenceErrorCodes.CONFLICT);
  });

  it("rejects invalid JSON summaries before writing", () => {
    const repository = createGenerationRunRepository(database);
    const invalidRecord = {
      ...fixtureGenerationRun(),
      id: "run-invalid-json-summary",
      inputValidationSummary: [] as never,
    };

    expectPersistenceError(() => repository.insert(invalidRecord), persistenceErrorCodes.VALIDATION_FAILED);
    expect(repository.getById(invalidRecord.id)).toBeUndefined();
  });

  it("rejects suspected PII in generation snapshots without echoing the value", () => {
    const repository = createGenerationRunRepository(database);
    const piiValue = "姓名：测试甲";
    const record = fixtureGenerationRun({
      id: "run-pii-snapshot",
      inputCaseSnapshot: { ...fixtureCase, patientSummary: piiValue },
    });

    try {
      repository.insert(record);
      throw new Error("Expected suspected PII rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.SUSPECTED_PII);
      expect((error as Error).message).not.toContain(piiValue);
      expect(JSON.stringify(error)).not.toContain(piiValue);
    }
  });

  it("returns DATA_CORRUPTION for invalid stored JSON without echoing it", () => {
    const repository = createGenerationRunRepository(database);
    const record = fixtureGenerationRun({ id: "run-corrupt-json" });
    repository.insert(record);
    const corruptJson = `{${syntheticCorruptMarker}}`;
    database.prepare(
      "UPDATE generation_runs SET input_case_snapshot_json = ? WHERE id = ?",
    ).run(corruptJson, record.id);

    try {
      repository.getById(record.id);
      throw new Error("Expected data corruption rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.DATA_CORRUPTION);
      expect((error as Error).message).not.toContain(corruptJson);
    }
  });

  it("uses prepared statements for synthetic text containing SQL punctuation", () => {
    const repository = createGenerationRunRepository(database);
    const text = "合成测试文本：引号 ' ; -- 不执行";
    const record = fixtureGenerationRun({
      id: "run-sql-punctuation",
      inputCaseSnapshot: { ...fixtureCase, patientSummary: text },
    });

    repository.insert(record);

    expect(repository.getById(record.id)?.inputCaseSnapshot.patientSummary).toBe(text);
  });

  it("appends continuous physician profile versions and returns stable history", () => {
    const repository = createPhysicianProfileVersionRepository(database);
    const first = fixtureProfileVersion(1);
    const second = fixtureProfileVersion(2, 1);

    repository.append(first);
    repository.append(second, 1);

    expect(repository.get(first.profileId, 1)).toEqual(first);
    expect(repository.getLatest(first.profileId)).toEqual(second);
    expect(repository.listHistory(first.profileId)).toEqual([first, second]);
  });

  it("requires the initial profile version to be version one", () => {
    const repository = createPhysicianProfileVersionRepository(database);

    expectPersistenceError(
      () => repository.append(fixtureProfileVersion(2, 1)),
      persistenceErrorCodes.PROFILE_VERSION_CONFLICT,
    );
  });

  it("rejects profile jumps, duplicate versions, and stale expected versions", () => {
    const repository = createPhysicianProfileVersionRepository(database);
    repository.append(fixtureProfileVersion(1));

    expectPersistenceError(
      () => repository.append(fixtureProfileVersion(3, 1), 1),
      persistenceErrorCodes.PROFILE_VERSION_CONFLICT,
    );
    expectPersistenceError(
      () => repository.append(fixtureProfileVersion(2, 1), 99),
      persistenceErrorCodes.PROFILE_VERSION_CONFLICT,
    );

    repository.append(fixtureProfileVersion(2, 1), 1);
    expectPersistenceError(
      () => repository.append(fixtureProfileVersion(2, 1), 1),
      persistenceErrorCodes.PROFILE_VERSION_CONFLICT,
    );
  });

  it("rejects suspected PII in profile version records", () => {
    const repository = createPhysicianProfileVersionRepository(database);
    const record = fixtureProfileVersion(1, undefined, { profileId: syntheticTestOnlyPhone });

    expectPersistenceError(() => repository.append(record), persistenceErrorCodes.SUSPECTED_PII);
    expect(repository.getLatest(record.profileId)).toBeUndefined();
  });

  it("appends and queries audit events in stable order", () => {
    const repository = createAuditEventRepository(database);
    const first = fixtureAuditEvent({ id: "audit-b", createdAt: "2026-08-19T00:00:01.000Z" });
    const second = fixtureAuditEvent({ id: "audit-a", createdAt: "2026-08-19T00:00:01.000Z" });
    repository.append(first);
    repository.append(second);

    expect(repository.getById(first.id)).toEqual(first);
    expect(repository.listByEntity(first.entityType, first.entityId).map((event) => event.id)).toEqual(["audit-a", "audit-b"]);
  });

  it("filters audit events with a bounded keyset cursor and fixed descending order", () => {
    const repository = createAuditEventRepository(database);
    repository.append(fixtureAuditEvent({ id: "audit-b", createdAt: "2026-08-19T00:00:01.000Z" }));
    repository.append(fixtureAuditEvent({ id: "audit-a", createdAt: "2026-08-19T00:00:01.000Z" }));
    repository.append(fixtureAuditEvent({
      id: "audit-c",
      eventType: "REVIEW_APPROVED",
      simulatedRole: "REVIEWER",
      entityType: "FEEDBACK_EVENT",
      entityId: "feedback-1",
      createdAt: "2026-08-19T00:00:02.000Z",
    }));

    const firstPage = repository.listPage({ limit: 2 });
    expect(firstPage.items.map((event) => event.id)).toEqual(["audit-c", "audit-b"]);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = repository.listPage({ limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.items.map((event) => event.id)).toEqual(["audit-a"]);
    expect(repository.listPage({ eventType: "REVIEW_APPROVED" }).items.map((event) => event.id)).toEqual(["audit-c"]);
    expect(repository.listPage({ simulatedRole: "REVIEWER" }).items.map((event) => event.id)).toEqual(["audit-c"]);
  });

  it("binds run lookup to parameters and rejects non-whitelist filters", () => {
    const repository = createAuditEventRepository(database);
    repository.append(fixtureAuditEvent({
      id: "audit-run-link",
      metadata: { runId: "run-filter-001", requestId: "request-filter-001" },
    }));
    repository.append(fixtureAuditEvent({ id: "audit-other-run", metadata: { runId: "run-other" } }));

    expect(repository.listByGenerationRun("run-filter-001").map((event) => event.id)).toEqual(["audit-run-link"]);
    expect(repository.listPage({ entityId: "' OR 1=1 --" }).items).toEqual([]);
    expectPersistenceError(
      () => repository.listPage({ eventType: "DROP TABLE audit_events" as never }),
      persistenceErrorCodes.VALIDATION_FAILED,
    );
  });

  it("redacts corruption from audit query failures", () => {
    const repository = createAuditEventRepository(database);
    repository.append(fixtureAuditEvent({ id: "audit-corrupt-query" }));
    database.exec("DROP TRIGGER audit_events_no_update");
    database.prepare("UPDATE audit_events SET metadata_json = ? WHERE id = ?").run("query-secret", "audit-corrupt-query");

    try {
      repository.listPage();
      throw new Error("Expected audit data corruption.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.DATA_CORRUPTION);
      expect((error as Error).message).not.toContain("query-secret");
    }
  });

  it("blocks audit updates and deletes at the SQLite layer", () => {
    const repository = createAuditEventRepository(database);
    const event = fixtureAuditEvent();
    repository.append(event);

    expect(() => database.prepare("UPDATE audit_events SET event_type = ? WHERE id = ?").run("CHANGED", event.id)).toThrow();
    expect(() => database.prepare("DELETE FROM audit_events WHERE id = ?").run(event.id)).toThrow();
    expect(repository.getById(event.id)).toEqual(event);
  });

  it("rejects suspected PII in audit metadata", () => {
    const repository = createAuditEventRepository(database);
    const piiValue = `邮箱：${syntheticTestOnlyEmail}`;
    const event = fixtureAuditEvent({ metadata: { note: piiValue } });

    try {
      repository.append(event);
      throw new Error("Expected suspected PII rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.SUSPECTED_PII);
      expect((error as Error).message).not.toContain(piiValue);
    }
  });

  it("redacts unsafe audit metadata field names before PII scanning", () => {
    const repository = createAuditEventRepository(database);
    const emailField = syntheticTestOnlyEmail;
    const phoneField = syntheticTestOnlyPhone;
    const event = {
      ...fixtureAuditEvent({ id: "audit-unsafe-field-names" }),
      metadata: {
        [emailField]: BigInt(1),
        [phoneField]: Symbol("private-field"),
      },
    } as never;

    try {
      repository.append(event);
      throw new Error("Expected validation rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.VALIDATION_FAILED);
      expect((error as PersistenceError).fieldPath).toContain("[unknown-field]");
      expect((error as PersistenceError).fieldPath).not.toContain(emailField);
      expect((error as PersistenceError).fieldPath).not.toContain(phoneField);
      expect((error as Error).message).not.toContain(emailField);
      expect((error as Error).message).not.toContain(phoneField);
      expect(JSON.stringify(error)).not.toContain(emailField);
      expect(JSON.stringify(error)).not.toContain(phoneField);
    }
  });
});
