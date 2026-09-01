import "server-only";

import { resolve } from "node:path";

import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { getOrCreateRuntimeDatabase } from "@/server/runtime-database-registry";
import { readLiteratureRuntimePaths } from "@/server/literature-runtime-config";

export function getDatabase() {
  const literaturePaths = readLiteratureRuntimePaths();
  const configuredPath = literaturePaths.databasePath ?? process.env.DATABASE_PATH ?? "data/runtime/prototype.db";
  const exclusiveLock = process.env.DEMO_DATABASE_EXCLUSIVE === "true";
  const readOnly = process.env.DATABASE_READ_ONLY === "true";
  const normalizedPath = configuredPath === ":memory:"
    ? configuredPath
    : resolve(/* turbopackIgnore: true */ configuredPath);
  const cacheKey = `${normalizedPath}\u0000exclusive:${exclusiveLock ? "yes" : "no"}\u0000readonly:${readOnly ? "yes" : "no"}`;

  return getOrCreateRuntimeDatabase(cacheKey, () => openRuntimeDatabase({
    path: normalizedPath,
    exclusiveLock,
    readOnly,
  }));
}
