import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

let database;

try {
  const { createManualSyntheticEncounter } = await import(workerData.serviceUrl);
  database = new DatabaseSync(workerData.databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;");
  const barrier = new Int32Array(workerData.barrier);
  const wrappedDatabase = {
    get isTransaction() {
      return database.isTransaction;
    },
    exec(statement) {
      if (statement === "BEGIN IMMEDIATE") {
        const arrival = Atomics.add(barrier, 0, 1) + 1;
        Atomics.notify(barrier, 0);
        if (arrival < 2) Atomics.wait(barrier, 0, arrival);
      }
      return database.exec(statement);
    },
    prepare(...args) {
      return database.prepare(...args);
    },
  };
  const idFactory = (kind) => "manual-" + kind.toLowerCase() + "-" + workerData.workerId + "z001";
  const result = createManualSyntheticEncounter(workerData.request, {
    databaseFactory: () => wrappedDatabase,
    runtimeMode: "local-research",
    clock: () => "2026-08-24T15:59:59.000Z",
    idFactory,
  });
  parentPort.postMessage({
    type: "result",
    result: {
      encounterId: result.encounter.id,
      intakeId: result.intake.intakeId,
      idempotencyResult: result.idempotencyResult,
    },
  });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    },
  });
} finally {
  database?.close();
}
