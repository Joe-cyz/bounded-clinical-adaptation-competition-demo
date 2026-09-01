import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createManualSyntheticEncounter,
  getManualSyntheticEncounterInitialRecord,
  type ManualSyntheticEncounterIdKind,
} from "./manual-synthetic-encounter-service";
import { parseEncounterRecordPayload } from "@/domain/manual-synthetic-record";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { persistenceErrorCodes } from "@/infrastructure/sqlite/errors";

const fixedIds: Record<ManualSyntheticEncounterIdKind, string> = {
  ENCOUNTER: "manual-encounter-testz001",
  INTAKE: "manual-intake-testz001",
  DISPLAY: "manual-display-testz001",
  AUDIT: "manual-audit-testz001",
};

const idFactory = (kind: ManualSyntheticEncounterIdKind) => fixedIds[kind];
function idFactoryFor(suffix: string) {
  return (kind: ManualSyntheticEncounterIdKind) => `manual-${kind.toLowerCase()}-${suffix}`;
}
const request = {
  creationRequestId: "manual-request-testz001",
  specialty: "内分泌科" as const,
  visitType: "初诊" as const,
  sex: "INTERSEX" as const,
  age: 65,
};

type OverlappingWorkerResult = {
  encounterId: string;
  intakeId: string;
  idempotencyResult: "CREATED" | "REPLAYED";
};

function runOverlappingWorker(options: {
  databasePath: string;
  barrier: SharedArrayBuffer;
  serviceUrl: string;
  loaderPath: string;
  workerId: string;
  request: typeof request;
}): Promise<OverlappingWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../test/manual-synthetic-encounter-concurrency-worker.mjs", import.meta.url), {
      execArgv: ["--experimental-strip-types", "--import", pathToFileURL(options.loaderPath).href],
      workerData: options,
    });
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    let messageReceived = false;
    let result: OverlappingWorkerResult | undefined;
    let workerError: Error | undefined;
    let exitCode: number | undefined;
    const finishAfterExit = () => {
      if (!messageReceived || exitCode === undefined) return;
      if (exitCode !== 0) {
        settle(() => reject(new Error(`Concurrency worker exited with code ${exitCode}.`)));
        return;
      }
      if (workerError) {
        settle(() => reject(workerError));
        return;
      }
      if (result) {
        settle(() => resolve(result as OverlappingWorkerResult));
        return;
      }
      settle(() => reject(new Error("Concurrency worker exited without a result.")));
    };

    worker.on("message", (message: {
      type: "result" | "error";
      result?: OverlappingWorkerResult;
      error?: { name: string; code?: string; message: string };
    }) => {
      messageReceived = true;
      if (message.type === "result" && message.result) {
        result = message.result;
      } else {
        workerError = new Error(
          `${message.error?.name ?? "WorkerError"}: ${message.error?.message ?? "unknown worker failure"}`,
        );
      }
      finishAfterExit();
    });
    worker.on("error", (error) => {
      workerError = error;
      messageReceived = true;
      finishAfterExit();
    });
    worker.on("exit", (code) => {
      exitCode = code;
      finishAfterExit();
    });
  });
}

function dependencies(
  database: DatabaseSync,
  clock = () => "2026-08-24T15:59:59.000Z",
  factory = idFactory,
) {
  return {
    databaseFactory: () => database,
    runtimeMode: "local-research" as const,
    clock,
    idFactory: factory,
  };
}

describe("manual synthetic Encounter application service", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => "2026-08-24T00:00:00.000Z" });
  });

  afterEach(() => {
    database.close();
  });

  it("creates an immutable intake, a DRAFT Encounter, and a readable non-revision initial record", () => {
    const result = createManualSyntheticEncounter(request, dependencies(database));

    expect(result.idempotencyResult).toBe("CREATED");
    expect(result.encounter.status).toBe("DRAFT");
    expect(result.encounter.currentRecordRevisionId).toBeUndefined();
    expect(result.encounter.source).toEqual({
      type: "MANUAL_SYNTHETIC",
      intakeId: result.intake.intakeId,
      intakeSchemaVersion: "1.0.0",
    });
    expect(result.intake).toMatchObject({
      schemaVersion: "1.0.0",
      synthetic: true,
      specialty: "内分泌科",
      visitType: "初诊",
      sex: "INTERSEX",
      age: 65,
      visitDate: "2026-08-24",
      recordDate: "2026-08-24",
    });
    expect(result.initialRecord.source).toEqual(result.encounter.source);
    expect("sourceDatasetVersion" in result.initialRecord).toBe(false);
    expect(JSON.stringify(result.initialRecord)).not.toContain("暂无");
    expect(result.initialRecord.demographics.age).toEqual({ status: "PROVIDED", value: 65 });
    expect(result.initialRecord.demographics.admissionDate).toEqual({ status: "NOT_APPLICABLE" });
    expect(result.initialRecord.history.chiefComplaint).toEqual({ status: "UNKNOWN" });
    expect(result.initialRecord.patientEducationFacts).toEqual({ status: "NOT_APPLICABLE" });
    expect(parseEncounterRecordPayload(result.initialRecord)).toEqual(result.initialRecord);

    expect(database.prepare("SELECT COUNT(*) AS count FROM encounter_record_revisions").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_synthetic_intakes").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT source_type, manual_intake_id FROM encounters WHERE id = ?").get(result.encounter.id))
      .toEqual({ source_type: "MANUAL_SYNTHETIC", manual_intake_id: result.intake.intakeId });

    const auditEvents = createAuditEventRepository(database).listByEntity("ENCOUNTER", result.encounter.id);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].eventType).toBe("ENCOUNTER_CREATED");
    expect(Object.keys(auditEvents[0].metadata).sort()).toEqual([
      "createdAt",
      "encounterId",
      "encounterStatus",
      "idempotencyResult",
      "intakeId",
      "intakeSchemaVersion",
      "runtimeMode",
      "sourceType",
      "synthetic",
    ]);
    expect(auditEvents[0].metadata).not.toHaveProperty("age");
    expect(auditEvents[0].metadata).not.toHaveProperty("recordPayload");
  });

  it("acquires the database exactly once after the local runtime gate", () => {
    let databaseFactoryCalls = 0;
    const result = createManualSyntheticEncounter(request, {
      databaseFactory: () => {
        databaseFactoryCalls += 1;
        return database;
      },
      runtimeMode: "local-research",
      idFactory,
    });

    expect(result.idempotencyResult).toBe("CREATED");
    expect(databaseFactoryCalls).toBe(1);
  });

  it("replays the same creation request without duplicate rows or audit events", () => {
    const first = createManualSyntheticEncounter(request, dependencies(database));
    const replay = createManualSyntheticEncounter(request, dependencies(database));

    expect(replay.idempotencyResult).toBe("REPLAYED");
    expect(replay.encounter.id).toBe(first.encounter.id);
    expect(replay.intake.intakeId).toBe(first.intake.intakeId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_synthetic_intakes").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM encounters").get()).toEqual({ count: 1 });
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", first.encounter.id)).toHaveLength(1);
  });

  it("serializes overlapping identical requests across two independent file connections", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "manual-synthetic-concurrency-"));
    const databasePath = join(temporaryDirectory, "runtime.db");
    const migrated = openRuntimeDatabase({ path: databasePath });
    migrated.close();

    try {
      const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const serviceUrl = new URL("./manual-synthetic-encounter-service.ts", import.meta.url).href;
      const loaderPath = fileURLToPath(new URL("../test/native-ts-loader.mjs", import.meta.url));
      const results = await Promise.all([
        runOverlappingWorker({ databasePath, barrier, serviceUrl, loaderPath, workerId: "one", request }),
        runOverlappingWorker({ databasePath, barrier, serviceUrl, loaderPath, workerId: "two", request }),
      ]);

      expect(results.map((result) => result.idempotencyResult).sort()).toEqual(["CREATED", "REPLAYED"]);
      expect(new Set(results.map((result) => result.encounterId)).size).toBe(1);
      expect(new Set(results.map((result) => result.intakeId)).size).toBe(1);

      const verificationDatabase = new DatabaseSync(databasePath);
      try {
        expect(verificationDatabase.prepare("SELECT COUNT(*) AS count FROM manual_synthetic_intakes").get())
          .toEqual({ count: 1 });
        expect(verificationDatabase.prepare("SELECT COUNT(*) AS count FROM encounters").get())
          .toEqual({ count: 1 });
        expect(verificationDatabase.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'ENCOUNTER_CREATED'",
        ).get()).toEqual({ count: 1 });
        expect(verificationDatabase.prepare("SELECT id FROM encounters").get())
          .toEqual({ id: results[0].encounterId });
      } finally {
        verificationDatabase.close();
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects the same creation token with a different normalized request", () => {
    createManualSyntheticEncounter(request, dependencies(database));

    expect(() => createManualSyntheticEncounter({ ...request, age: 66 }, dependencies(database)))
      .toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_synthetic_intakes").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM encounters").get()).toEqual({ count: 1 });
  });

  it("uses Asia/Shanghai dates at the UTC boundary", () => {
    const beforeBoundary = createManualSyntheticEncounter(
      { ...request, creationRequestId: "manual-request-boundaryz001" },
      dependencies(database, () => "2026-08-24T15:59:59.999Z", idFactoryFor("boundaryz001")),
    );
    const afterBoundary = createManualSyntheticEncounter(
      { ...request, creationRequestId: "manual-request-boundaryz002" },
      dependencies(database, () => "2026-08-24T16:00:00.000Z", idFactoryFor("boundaryz002")),
    );

    expect(beforeBoundary.intake.visitDate).toBe("2026-08-24");
    expect(afterBoundary.intake.visitDate).toBe("2026-08-25");
  });

  it("rejects client-controlled fields and suspected PII before any write", () => {
    expect(() => createManualSyntheticEncounter({ ...request, name: "合成患者" }, dependencies(database)))
      .toThrowError(expect.objectContaining({ code: persistenceErrorCodes.VALIDATION_FAILED }));
    expect(() => createManualSyntheticEncounter({
      ...request,
      runtimeMode: "local-research",
      visitDate: "2026-08-24",
    }, dependencies(database)))
      .toThrowError(expect.objectContaining({ code: persistenceErrorCodes.VALIDATION_FAILED }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_synthetic_intakes").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM encounters").get()).toEqual({ count: 0 });
  });

  it("rejects public-demo before touching an uninitialized database", () => {
    let databaseFactoryCalls = 0;

    expect(() => createManualSyntheticEncounter(request, {
      databaseFactory: () => {
        databaseFactoryCalls += 1;
        throw new Error("public-demo must not acquire a database");
      },
      runtimeMode: "public-demo",
      idFactory,
    })).toThrowError(expect.objectContaining({ code: persistenceErrorCodes.RUNTIME_READ_ONLY }));
    expect(databaseFactoryCalls).toBe(0);
  });

  it("rolls back intake and Encounter when the single audit append conflicts", () => {
    createAuditEventRepository(database).append({
      schemaVersion: "1.0.0",
      id: fixedIds.AUDIT,
      eventType: "ENCOUNTER_CREATED",
      actorId: "fixture",
      simulatedRole: "SYSTEM",
      entityType: "ENCOUNTER",
      entityId: "fixture-encounter",
      afterVersion: "DRAFT",
      metadata: { fixture: true },
      createdAt: "2026-08-24T00:00:00.000Z",
    });

    expect(() => createManualSyntheticEncounter(request, dependencies(database)))
      .toThrowError(expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_synthetic_intakes").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM encounters").get()).toEqual({ count: 0 });
  });

  it("reconstructs the initial record from the persisted intake after the create call", () => {
    const created = createManualSyntheticEncounter(request, dependencies(database));
    const loaded = getManualSyntheticEncounterInitialRecord(created.encounter.id, dependencies(database));

    expect(loaded.idempotencyResult).toBe("REPLAYED");
    expect(loaded.initialRecord).toEqual(created.initialRecord);
    expect(loaded.encounter).toEqual(created.encounter);
  });
});
