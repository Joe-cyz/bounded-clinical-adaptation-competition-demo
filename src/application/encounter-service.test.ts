import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  createEncounter,
  transitionEncounter,
} from "./encounter-service";
import {
  encounterCreatedAuditMetadataSchema,
  encounterRecordRevisionSchema,
  encounterStatusChangedAuditMetadataSchema,
} from "@/domain/encounter";
import { auditEventRecordSchema } from "@/domain/runtime-records";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";

const request = {
  id: "encounter-application-001",
  caseId: "general-first-001",
  caseVersion: "0.4.1-001",
  demographicSnapshot: {
    displayLabel: "合成患者-01",
    sex: "NOT_STATED" as const,
    ageBand: "ADULT" as const,
  },
};

function ids(prefix: string) {
  let auditNumber = 0;
  return (kind: "ENCOUNTER" | "AUDIT") => kind === "ENCOUNTER"
    ? `encounter-${prefix}-001`
    : `audit-${prefix}-${String(auditNumber++).padStart(3, "0")}`;
}

function revision(encounterId: string, revisionNumber = 1) {
  return encounterRecordRevisionSchema.parse({
    schemaVersion: "1.0.0",
    id: revisionNumber === 1 ? `record-revision-${encounterId}` : `record-revision-${encounterId}-${revisionNumber}`,
    encounterId,
    revisionNumber,
    recordPayload: {},
    createdAt: "2026-08-21T00:00:01.000Z",
  });
}

function duplicateAudit(id: string) {
  return auditEventRecordSchema.parse({
    schemaVersion: "1.0.0",
    id,
    eventType: "ENCOUNTER_CREATED",
    actorId: "test-fixture",
    simulatedRole: "SYSTEM",
    entityType: "ENCOUNTER",
    entityId: "existing-encounter",
    afterVersion: "DRAFT",
    metadata: {
      encounterId: "existing-encounter",
      caseId: "general-first-001",
      caseVersion: "0.4.1-001",
      synthetic: true,
      runtimeMode: "local-research",
    },
    createdAt: "2026-08-21T00:00:00.000Z",
  });
}

describe("Encounter application service", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => "2026-08-21T00:00:00.000Z" });
  });

  afterEach(() => {
    database.close();
  });

  it("creates an Encounter and its audit event atomically", () => {
    const record = createEncounter(request, {
      database,
      runtimeMode: "local-research",
      idFactory: ids("create"),
      clock: () => "2026-08-21T00:00:00.000Z",
    });

    expect(record.status).toBe("DRAFT");
    expect(createEncounterRepository(database).getById(record.id)).toEqual(record);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", record.id)).toEqual([
      expect.objectContaining({ eventType: "ENCOUNTER_CREATED", entityId: record.id }),
    ]);
  });

  it("validates event-specific audit metadata before appending it", () => {
    const base = {
      encounterId: "encounter-audit-schema-001",
      caseId: "general-first-001",
      caseVersion: "0.4.1-001",
      synthetic: true as const,
      runtimeMode: "local-research" as const,
    };

    expect(encounterCreatedAuditMetadataSchema.safeParse({
      ...base,
      demographicSnapshot: { displayLabel: "合成患者-01" },
    }).success).toBe(false);
    expect(encounterCreatedAuditMetadataSchema.safeParse({
      ...base,
      fromStatus: "DRAFT",
      toStatus: "RECORD_SAVED",
    }).success).toBe(false);
    expect(encounterStatusChangedAuditMetadataSchema.safeParse({
      ...base,
      fromStatus: "DRAFT",
      toStatus: "RECORD_SAVED",
      recordPayload: { note: "not allowed" },
    }).success).toBe(false);
    expect(encounterStatusChangedAuditMetadataSchema.safeParse(base).success).toBe(false);
  });

  it("returns a controlled conflict for duplicate IDs", () => {
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      idFactory: ids("duplicate"),
      clock: () => "2026-08-21T00:00:00.000Z",
    };
    createEncounter(request, dependencies);

    expect(() => createEncounter(request, dependencies)).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", request.id)).toHaveLength(1);
  });

  it("rolls back the Encounter when the create audit append fails", () => {
    const audit = createAuditEventRepository(database);
    audit.append(duplicateAudit("audit-create-rollback"));
    const idFactory = (kind: "ENCOUNTER" | "AUDIT") => kind === "ENCOUNTER"
      ? "encounter-create-rollback"
      : "audit-create-rollback";

    expect(() => createEncounter(request, {
      database,
      runtimeMode: "local-research",
      idFactory,
      clock: () => "2026-08-21T00:00:01.000Z",
    })).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));

    expect(createEncounterRepository(database).getById("encounter-create-rollback")).toBeUndefined();
    expect(audit.listByEntity("ENCOUNTER", "encounter-create-rollback")).toEqual([]);
  });

  it("executes the complete forward path with one audit event per transition", () => {
    const timeValues = [
      "2026-08-21T00:00:00.000Z",
      "2026-08-21T00:00:02.000Z",
      "2026-08-21T00:00:03.000Z",
      "2026-08-21T00:00:04.000Z",
      "2026-08-21T00:00:05.000Z",
    ];
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      idFactory: ids("path"),
      clock: () => timeValues.shift() ?? "2026-08-21T00:00:05.000Z",
    };
    const created = createEncounter({ ...request, id: "encounter-path-001" }, dependencies);
    createEncounterRecordRevisionRepository(database).append(revision(created.id));

    let current = transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: `record-revision-${created.id}`,
    }, dependencies);
    current = transitionEncounter({
      encounterId: created.id,
      expectedStatus: current.status,
      expectedUpdatedAt: current.updatedAt,
      targetStatus: "REFERENCE_VIEWED",
    }, dependencies);
    current = transitionEncounter({
      encounterId: created.id,
      expectedStatus: current.status,
      expectedUpdatedAt: current.updatedAt,
      targetStatus: "REVIEW_PENDING",
    }, dependencies);
    current = transitionEncounter({
      encounterId: created.id,
      expectedStatus: current.status,
      expectedUpdatedAt: current.updatedAt,
      targetStatus: "CONFIRMED",
    }, dependencies);

    expect(current.status).toBe("CONFIRMED");
    expect(current.confirmedAt).toBe("2026-08-21T00:00:05.000Z");
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", created.id)).toHaveLength(5);
    const auditJson = JSON.stringify(createAuditEventRepository(database).listByEntity("ENCOUNTER", created.id));
    expect(auditJson).not.toContain("合成患者-01");
    expect(auditJson).not.toContain("recordPayload");
  });

  it("requires the latest revision for the initial RECORD_SAVED transition", () => {
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      idFactory: ids("latest-initial"),
      clock: () => "2026-08-21T00:00:02.000Z",
    };
    const created = createEncounter({ ...request, id: "encounter-latest-initial-001" }, dependencies);
    const revisions = createEncounterRecordRevisionRepository(database);
    revisions.append(revision(created.id));
    revisions.append(revision(created.id, 2), 1);
    const audits = createAuditEventRepository(database);

    expect(() => transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: `record-revision-${created.id}`,
    }, dependencies)).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));
    expect(createEncounterRepository(database).getById(created.id)?.status).toBe("DRAFT");
    expect(audits.listByEntity("ENCOUNTER", created.id)).toHaveLength(1);

    const saved = transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: `record-revision-${created.id}-2`,
    }, dependencies);
    expect(saved.status).toBe("RECORD_SAVED");
    expect(saved.currentRecordRevisionId).toBe(`record-revision-${created.id}-2`);
    expect(audits.listByEntity("ENCOUNTER", created.id)).toHaveLength(2);
  });

  it("rejects a newer revision after RECORD_SAVED before the next transition", () => {
    const timeValues = [
      "2026-08-21T00:00:00.000Z",
      "2026-08-21T00:00:01.000Z",
      "2026-08-21T00:00:02.000Z",
    ];
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      idFactory: ids("latest-follow-up"),
      clock: () => timeValues.shift() ?? "2026-08-21T00:00:02.000Z",
    };
    const created = createEncounter({ ...request, id: "encounter-latest-follow-up-001" }, dependencies);
    const revisions = createEncounterRecordRevisionRepository(database);
    revisions.append(revision(created.id));
    const saved = transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: `record-revision-${created.id}`,
    }, dependencies);
    revisions.append(revision(created.id, 2), 1);
    const audits = createAuditEventRepository(database);

    expect(() => transitionEncounter({
      encounterId: created.id,
      expectedStatus: saved.status,
      expectedUpdatedAt: saved.updatedAt,
      targetStatus: "REFERENCE_VIEWED",
    }, dependencies)).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));
    const unchanged = createEncounterRepository(database).getById(created.id);
    expect(unchanged?.status).toBe("RECORD_SAVED");
    expect(unchanged?.currentRecordRevisionId).toBe(`record-revision-${created.id}`);
    expect(audits.listByEntity("ENCOUNTER", created.id)).toHaveLength(2);
  });

  it("returns a controlled missing-revision error before writing", () => {
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      idFactory: ids("missing-revision"),
      clock: () => "2026-08-21T00:00:00.000Z",
    };
    const created = createEncounter({ ...request, id: "encounter-missing-revision-001" }, dependencies);
    const audits = createAuditEventRepository(database);

    expect(() => transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: "record-revision-does-not-exist",
    }, dependencies)).toThrowError(expect.objectContaining({
      code: persistenceErrorCodes.NOT_FOUND,
      ruleId: "ENCOUNTER_RECORD_REVISION_NOT_FOUND",
    }));
    expect(createEncounterRepository(database).getById(created.id)?.status).toBe("DRAFT");
    expect(audits.listByEntity("ENCOUNTER", created.id)).toHaveLength(1);
  });

  it("rejects illegal, repeated, and stale transitions without audit writes", () => {
    const dependencies = {
      database,
      runtimeMode: "local-research" as const,
      idFactory: ids("invalid"),
      clock: () => "2026-08-21T00:00:02.000Z",
    };
    const created = createEncounter(request, dependencies);
    const audits = createAuditEventRepository(database);

    expect(() => transitionEncounter({
      encounterId: created.id,
      expectedStatus: "DRAFT",
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "REFERENCE_VIEWED",
    }, dependencies)).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));
    expect(audits.listByEntity("ENCOUNTER", created.id)).toHaveLength(1);

    expect(() => transitionEncounter({
      encounterId: created.id,
      expectedStatus: "DRAFT",
      expectedUpdatedAt: "2026-08-20T00:00:00.000Z",
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: "record-revision-missing",
    }, dependencies)).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));
    expect(audits.listByEntity("ENCOUNTER", created.id)).toHaveLength(1);
    expect(createEncounterRepository(database).getById(created.id)?.status).toBe("DRAFT");
  });

  it("rolls back a transition when its audit append fails", () => {
    const created = createEncounter(request, {
      database,
      runtimeMode: "local-research",
      idFactory: ids("transition-rollback-create"),
      clock: () => "2026-08-21T00:00:00.000Z",
    });
    createEncounterRecordRevisionRepository(database).append(revision(created.id));
    createAuditEventRepository(database).append(duplicateAudit("audit-transition-rollback"));
    let auditCalls = 0;
    const idFactory = (kind: "ENCOUNTER" | "AUDIT") => {
      if (kind === "ENCOUNTER") return created.id;
      auditCalls += 1;
      return auditCalls === 1 ? "audit-transition-rollback" : "audit-unused";
    };

    expect(() => transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: `record-revision-${created.id}`,
    }, {
      database,
      runtimeMode: "local-research",
      idFactory,
      clock: () => "2026-08-21T00:00:02.000Z",
    })).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));

    expect(createEncounterRepository(database).getById(created.id)?.status).toBe("DRAFT");
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", created.id)).toHaveLength(1);
  });

  it("blocks public-demo writes before starting a transaction", () => {
    const dependencies = {
      database,
      env: { NODE_ENV: "test", APP_RUNTIME_MODE: "public-demo" } as NodeJS.ProcessEnv,
      idFactory: ids("public"),
      clock: () => "2026-08-21T00:00:00.000Z",
    };

    expect(() => createEncounter(request, dependencies)).toThrowError(
      expect.objectContaining({
        code: persistenceErrorCodes.RUNTIME_READ_ONLY,
        ruleId: "PUBLIC_DEMO_READ_ONLY",
      }),
    );
    expect(database.isTransaction).toBe(false);
    expect(createEncounterRepository(database).getById(request.id)).toBeUndefined();
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", request.id)).toEqual([]);
  });

  it("blocks public-demo transitions before starting a transaction", () => {
    const created = createEncounter(request, {
      database,
      runtimeMode: "local-research",
      idFactory: ids("public-transition-create"),
      clock: () => "2026-08-21T00:00:00.000Z",
    });
    const audits = createAuditEventRepository(database);

    expect(() => transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: "record-revision-not-used",
    }, {
      database,
      runtimeMode: "public-demo",
      clock: () => "2026-08-21T00:00:01.000Z",
    })).toThrowError(expect.objectContaining({
      code: persistenceErrorCodes.RUNTIME_READ_ONLY,
      ruleId: "PUBLIC_DEMO_READ_ONLY",
    }));
    expect(database.isTransaction).toBe(false);
    expect(createEncounterRepository(database).getById(created.id)).toEqual(created);
    expect(audits.listByEntity("ENCOUNTER", created.id)).toHaveLength(1);
  });
});
