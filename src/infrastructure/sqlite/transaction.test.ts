import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "./connection";
import { PersistenceError, persistenceErrorCodes } from "./errors";
import { withTransaction } from "./transaction";

describe("SQLite transactions", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:" });
    database.exec("CREATE TABLE transaction_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  });

  afterEach(() => {
    database.close();
  });

  it("commits synchronous callback writes", () => {
    withTransaction(database, () => {
      database.prepare("INSERT INTO transaction_test (id, value) VALUES (?, ?)").run("one", "committed");
    });

    expect(database.prepare("SELECT value FROM transaction_test WHERE id = ?").get("one")).toEqual({ value: "committed" });
  });

  it("rolls back all writes when the callback throws", () => {
    expect(() => withTransaction(database, () => {
      database.prepare("INSERT INTO transaction_test (id, value) VALUES (?, ?)").run("one", "rolled back");
      throw new PersistenceError(persistenceErrorCodes.CONFLICT, "Controlled test conflict.");
    })).toThrowError(PersistenceError);

    expect(database.prepare("SELECT COUNT(*) AS count FROM transaction_test").get()).toEqual({ count: 0 });
  });

  it("rejects nested transactions without committing the outer transaction", () => {
    withTransaction(database, () => {
      database.prepare("INSERT INTO transaction_test (id, value) VALUES (?, ?)").run("one", "outer");
      expect(() => withTransaction(database, () => undefined)).toThrowError(PersistenceError);
    });

    expect(database.prepare("SELECT COUNT(*) AS count FROM transaction_test").get()).toEqual({ count: 1 });
  });

  it("rejects an async callback and rolls back before the promise can continue", () => {
    const asyncCallback = (async () => {
      database.prepare("INSERT INTO transaction_test (id, value) VALUES (?, ?)").run("one", "async");
    }) as never;
    expect(() => withTransaction(database, asyncCallback)).toThrowError(PersistenceError);

    expect(database.prepare("SELECT COUNT(*) AS count FROM transaction_test").get()).toEqual({ count: 0 });
  });

  it("normalizes BEGIN IMMEDIATE lock failures and reuses the contender connection after release", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "bounded-transaction-lock-"));
    const databasePath = join(temporaryDirectory, "runtime.db");
    const migrated = openRuntimeDatabase({ path: databasePath });
    migrated.exec("CREATE TABLE transaction_test (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    migrated.close();

    const holder = new DatabaseSync(databasePath);
    const contender = new DatabaseSync(databasePath);

    try {
      holder.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
      contender.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");

      let lockError: unknown;
      try {
        withTransaction(contender, () => {
          contender.prepare("INSERT INTO transaction_test (id, value) VALUES (?, ?)").run("locked", "not-written");
        });
      } catch (error) {
        lockError = error;
      }
      expect(lockError).toBeInstanceOf(PersistenceError);
      expect(lockError).toEqual(expect.objectContaining({
        code: persistenceErrorCodes.TRANSACTION_FAILED,
      }));
      expect((lockError as Error).message).not.toMatch(/SQLITE|database is locked|BEGIN|runtime\.db|D:\\|stack/i);
      expect(contender.isTransaction).toBe(false);

      holder.exec("ROLLBACK");
      withTransaction(contender, () => {
        contender.prepare("INSERT INTO transaction_test (id, value) VALUES (?, ?)").run("recovered", "written");
      });

      expect(contender.prepare("SELECT value FROM transaction_test WHERE id = ?").get("recovered"))
        .toEqual({ value: "written" });
    } finally {
      if (holder.isTransaction) holder.exec("ROLLBACK");
      contender.close();
      holder.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
