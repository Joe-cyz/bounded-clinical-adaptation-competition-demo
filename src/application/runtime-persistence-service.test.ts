import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  appendProfileVersionWithAudit,
  recordGenerationRunWithAudit,
} from "./runtime-persistence-service";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { createPhysicianProfileVersionRepository } from "@/infrastructure/sqlite/repositories/physician-profile-version-repository";
import {
  fixtureAuditEvent,
  fixtureGenerationRun,
  fixtureProfileVersion,
} from "@/infrastructure/sqlite/test-fixtures";

// SYNTHETIC_TEST_ONLY: runtime-built value for the PII rejection path.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");

describe("runtime persistence service", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:" });
  });

  afterEach(() => {
    database.close();
  });

  it("commits a generation run and its audit event atomically", () => {
    const record = fixtureGenerationRun({ id: "run-atomic-success" });
    const auditEvent = fixtureAuditEvent({
      id: "audit-atomic-success",
      entityId: record.id,
    });

    recordGenerationRunWithAudit(database, record, auditEvent);

    expect(createGenerationRunRepository(database).getById(record.id)).toEqual(record);
    expect(createAuditEventRepository(database).getById(auditEvent.id)).toEqual(auditEvent);
  });

  it("rolls back a generation run when the audit append fails", () => {
    const record = fixtureGenerationRun({ id: "run-atomic-rollback" });
    const auditEvent = fixtureAuditEvent({
      id: "audit-atomic-rollback",
      entityId: record.id,
      metadata: { note: "姓名：测试甲" },
    });

    try {
      recordGenerationRunWithAudit(database, record, auditEvent);
    } catch (error) {
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.SUSPECTED_PII);
    }

    expect(createGenerationRunRepository(database).getById(record.id)).toBeUndefined();
    expect(createAuditEventRepository(database).listByEntity("GENERATION_RUN", record.id)).toEqual([]);
  });

  it("commits a profile version and its audit event atomically", () => {
    const profileVersion = fixtureProfileVersion(1);
    const auditEvent = fixtureAuditEvent({
      id: "audit-profile-success",
      eventType: "PROFILE_VERSION_APPENDED",
      entityType: "PHYSICIAN_PROFILE_VERSION",
      entityId: profileVersion.profileId,
      afterVersion: String(profileVersion.version),
    });

    appendProfileVersionWithAudit(database, profileVersion, undefined, auditEvent);

    expect(createPhysicianProfileVersionRepository(database).getLatest(profileVersion.profileId)).toEqual(profileVersion);
    expect(createAuditEventRepository(database).getById(auditEvent.id)).toEqual(auditEvent);
  });

  it("rolls back a profile version when the audit append fails", () => {
    const profileVersion = fixtureProfileVersion(1);
    const auditEvent = fixtureAuditEvent({
      id: "audit-profile-rollback",
      eventType: "PROFILE_VERSION_APPENDED",
      entityType: "PHYSICIAN_PROFILE_VERSION",
      entityId: profileVersion.profileId,
      metadata: { note: `联系电话：${syntheticTestOnlyPhone}` },
    });

    try {
      appendProfileVersionWithAudit(database, profileVersion, undefined, auditEvent);
      throw new Error("Expected audit failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(persistenceErrorCodes.SUSPECTED_PII);
    }

    expect(createPhysicianProfileVersionRepository(database).getLatest(profileVersion.profileId)).toBeUndefined();
    expect(createAuditEventRepository(database).listByEntity("PHYSICIAN_PROFILE_VERSION", profileVersion.profileId)).toEqual([]);
  });
});
