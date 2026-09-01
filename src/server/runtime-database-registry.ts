import type { DatabaseSync } from "node:sqlite";

const runtimeDatabaseRegistrySymbol = Symbol.for(
  "bounded-clinical-adaptation.runtime-database-registry",
);

type RuntimeDatabaseGlobal = typeof globalThis & {
  [runtimeDatabaseRegistrySymbol]?: Map<string, DatabaseSync>;
};

function runtimeDatabaseRegistry(): Map<string, DatabaseSync> {
  const sharedGlobal = globalThis as RuntimeDatabaseGlobal;
  sharedGlobal[runtimeDatabaseRegistrySymbol] ??= new Map<string, DatabaseSync>();
  return sharedGlobal[runtimeDatabaseRegistrySymbol];
}

export function getOrCreateRuntimeDatabase(
  cacheKey: string,
  createDatabase: () => DatabaseSync,
): DatabaseSync {
  const registry = runtimeDatabaseRegistry();
  const existing = registry.get(cacheKey);
  if (existing) return existing;

  const database = createDatabase();
  registry.set(cacheKey, database);
  return database;
}
