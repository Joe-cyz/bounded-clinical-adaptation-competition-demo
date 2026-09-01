import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PersistenceError, isPersistenceError, persistenceErrorCodes } from "./errors";
import {
  runMigrations,
  validateReadonlyRuntimeDatabase,
  type MigrationClock,
  type RuntimeMigration,
  runtimeMigrations,
} from "./migrations";

export type RuntimeDatabaseOptions = {
  path: string;
  migrations?: readonly RuntimeMigration[];
  clock?: MigrationClock;
  exclusiveLock?: boolean;
  readOnly?: boolean;
};

function resolveDatabasePath(databasePath: string): string {
  if (databasePath === ":memory:") return databasePath;
  if (databasePath.trim().length === 0) {
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_FAILED,
      "Database path must not be empty.",
    );
  }
  return resolve(databasePath);
}

export function openRuntimeDatabase(options: RuntimeDatabaseOptions): DatabaseSync {
  const databasePath = resolveDatabasePath(options.path);
  if (options.readOnly && databasePath === ":memory:") {
    throw new PersistenceError(persistenceErrorCodes.MIGRATION_FAILED, "Readonly runtime database must be file-backed.");
  }
  if (databasePath !== ":memory:" && options.readOnly !== true) mkdirSync(dirname(databasePath), { recursive: true });
  if (options.readOnly && !statSync(databasePath).isFile()) {
    throw new PersistenceError(persistenceErrorCodes.MIGRATION_FAILED, "Readonly runtime database must be a regular file.");
  }

  const database = new DatabaseSync(databasePath, options.readOnly ? { readOnly: true } : {});
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA busy_timeout = 5000;");
    if (databasePath !== ":memory:" && options.readOnly !== true) database.exec("PRAGMA journal_mode = WAL;");
    if (databasePath !== ":memory:" && options.exclusiveLock) database.exec("PRAGMA locking_mode = EXCLUSIVE;");
    if (options.readOnly) validateReadonlyRuntimeDatabase(database, options.migrations ?? runtimeMigrations);
    else runMigrations(database, options.migrations ?? runtimeMigrations, options.clock);
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // The original controlled error is more useful than a close failure.
    }

    if (isPersistenceError(error)) throw error;
    throw new PersistenceError(
      persistenceErrorCodes.MIGRATION_FAILED,
      "Runtime database initialization failed.",
    );
  }
}
