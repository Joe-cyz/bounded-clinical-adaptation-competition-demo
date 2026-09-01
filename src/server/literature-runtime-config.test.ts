import { describe, expect, it } from "vitest";

import { literatureErrorCodes } from "@/infrastructure/literature/literature-errors";
import {
  PWR08_OWNER_LIBRARY_DATABASE_PATH,
  PWR08_OWNER_LIBRARY_STORAGE_ROOT,
  PWR08_REAL_DOCUMENT_IMPORT_TOKEN,
  readLiteratureRuntimePaths,
} from "./literature-runtime-config";

describe("PWR-08 owner evidence runtime paths", () => {
  it("keeps ordinary local-research runs on their default storage paths", () => {
    expect(readLiteratureRuntimePaths({
      ...process.env,
      PWR08_REAL_DOCUMENT_IMPORT: undefined,
      PWR08_LITERATURE_EVIDENCE_STORAGE_ROOT: undefined,
    })).toEqual({});
  });

  it("rejects an evidence storage override without the exact Owner token", () => {
    expect(() => readLiteratureRuntimePaths({
      ...process.env,
      PWR08_LITERATURE_EVIDENCE_STORAGE_ROOT: PWR08_OWNER_LIBRARY_STORAGE_ROOT,
      DATABASE_PATH: PWR08_OWNER_LIBRARY_DATABASE_PATH,
    })).toThrow(expect.objectContaining({ code: literatureErrorCodes.EVIDENCE_AUTHORIZATION_REQUIRED }));
  });

  it("accepts only the frozen evidence database and storage root with the exact Owner token", () => {
    expect(readLiteratureRuntimePaths({
      ...process.env,
      PWR08_REAL_DOCUMENT_IMPORT: PWR08_REAL_DOCUMENT_IMPORT_TOKEN,
      PWR08_LITERATURE_EVIDENCE_STORAGE_ROOT: PWR08_OWNER_LIBRARY_STORAGE_ROOT,
      DATABASE_PATH: PWR08_OWNER_LIBRARY_DATABASE_PATH,
    })).toEqual({
      databasePath: PWR08_OWNER_LIBRARY_DATABASE_PATH,
      storageRoot: PWR08_OWNER_LIBRARY_STORAGE_ROOT,
    });
  });

  it("rejects a forged evidence path without returning it through the error", () => {
    expect(() => readLiteratureRuntimePaths({
      ...process.env,
      PWR08_REAL_DOCUMENT_IMPORT: PWR08_REAL_DOCUMENT_IMPORT_TOKEN,
      PWR08_LITERATURE_EVIDENCE_STORAGE_ROOT: "data/runtime/other-root",
      DATABASE_PATH: PWR08_OWNER_LIBRARY_DATABASE_PATH,
    })).toThrow(expect.objectContaining({ code: literatureErrorCodes.EVIDENCE_AUTHORIZATION_REQUIRED }));
  });
});
