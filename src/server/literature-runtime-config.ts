import "server-only";

import { resolve } from "node:path";

import { literatureError, literatureErrorCodes } from "@/infrastructure/literature/literature-errors";

export const PWR08_REAL_DOCUMENT_IMPORT_TOKEN = "owner-authorized-first-batch-2026-08-26" as const;
export const PWR08_OWNER_LIBRARY_DATABASE_PATH = resolve(process.cwd(), "data/runtime/pwr-08-owner-library.sqlite");
export const PWR08_OWNER_LIBRARY_STORAGE_ROOT = resolve(
  process.cwd(),
  "data/runtime/literature-evidence/pwr-08-owner-library",
);
const PWR08_SYNTHETIC_STORAGE_ROOT = resolve(process.cwd(), ".codex-tmp", "pwr-08b", "storage");

export type LiteratureRuntimePaths = {
  databasePath?: string;
  storageRoot?: string;
};

/**
 * The evidence database and object root are intentionally unavailable unless
 * the exact one-batch Owner authorization is present in the server process.
 * The client never receives these environment variables or resolved paths.
 */
export function readLiteratureRuntimePaths(env: NodeJS.ProcessEnv = process.env): LiteratureRuntimePaths {
  const requestsEvidencePaths = env.PWR08_REAL_DOCUMENT_IMPORT !== undefined
    || env.PWR08_LITERATURE_EVIDENCE_STORAGE_ROOT !== undefined;
  if (!requestsEvidencePaths) {
    if (env.PWR08_SYNTHETIC_STORAGE_ROOT === undefined) return {};
    if (env.APP_RUNTIME_MODE !== "local-research"
      || resolve(env.PWR08_SYNTHETIC_STORAGE_ROOT) !== PWR08_SYNTHETIC_STORAGE_ROOT) {
      throw literatureError(literatureErrorCodes.INVALID_REQUEST);
    }
    return { storageRoot: PWR08_SYNTHETIC_STORAGE_ROOT };
  }

  if (env.PWR08_REAL_DOCUMENT_IMPORT !== PWR08_REAL_DOCUMENT_IMPORT_TOKEN
    || env.PWR08_LITERATURE_EVIDENCE_STORAGE_ROOT === undefined
    || resolve(env.PWR08_LITERATURE_EVIDENCE_STORAGE_ROOT) !== PWR08_OWNER_LIBRARY_STORAGE_ROOT
    || env.DATABASE_PATH === undefined
    || resolve(env.DATABASE_PATH) !== PWR08_OWNER_LIBRARY_DATABASE_PATH) {
    throw literatureError(literatureErrorCodes.EVIDENCE_AUTHORIZATION_REQUIRED);
  }

  return {
    databasePath: PWR08_OWNER_LIBRARY_DATABASE_PATH,
    storageRoot: PWR08_OWNER_LIBRARY_STORAGE_ROOT,
  };
}
