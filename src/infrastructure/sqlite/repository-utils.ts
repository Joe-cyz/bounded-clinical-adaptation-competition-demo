import {
  PersistenceError,
  persistenceErrorCodes,
} from "./errors";

export type SqliteRow = Record<string, unknown>;

export function requiredRowString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored runtime record has an invalid scalar field.",
      { fieldPath: column },
    );
  }
  return value;
}

export function optionalRowString(row: SqliteRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored runtime record has an invalid scalar field.",
      { fieldPath: column },
    );
  }
  return value;
}

export function requiredRowInteger(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored runtime record has an invalid integer field.",
      { fieldPath: column },
    );
  }
  return value;
}

export function isSqliteConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return true;
  if (code !== "ERR_SQLITE_ERROR") return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /constraint failed|unique constraint|primary key/i.test(message);
}

export function databaseWriteError(): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.TRANSACTION_FAILED,
    "Runtime record database write failed.",
  );
}

export function invalidQueryLimit(): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.VALIDATION_FAILED,
    "Query limit is invalid.",
    { fieldPath: "limit" },
  );
}
