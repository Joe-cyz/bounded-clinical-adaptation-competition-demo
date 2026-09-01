import type { DatabaseSync } from "node:sqlite";

import { PersistenceError, isPersistenceError, persistenceErrorCodes } from "./errors";

type SyncCallback<T> = () => T & (T extends PromiseLike<unknown> ? never : unknown);

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
}

export function withTransaction<T>(database: DatabaseSync, callback: SyncCallback<T>): T {
  if (database.isTransaction) {
    throw new PersistenceError(
      persistenceErrorCodes.TRANSACTION_FAILED,
      "Nested transactions are not supported.",
    );
  }

  let transactionStarted = false;
  let rollbackFailed = false;

  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const result = callback();
    if (isPromiseLike(result)) {
      throw new PersistenceError(
        persistenceErrorCodes.TRANSACTION_FAILED,
        "Transactions require a synchronous callback.",
      );
    }
    database.exec("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted || database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }

    if (isPersistenceError(error) && !rollbackFailed) throw error;
    throw new PersistenceError(
      persistenceErrorCodes.TRANSACTION_FAILED,
      rollbackFailed
        ? "Transaction rollback failed; the database connection must be closed by the caller."
        : transactionStarted
          ? "Transaction failed and was rolled back."
          : "Transaction could not be started.",
    );
  }
}
