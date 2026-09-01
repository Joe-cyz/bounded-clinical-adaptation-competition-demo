import { describe, expect, it } from "vitest";

import {
  LITERATURE_MAX_BATCH_FILES,
  LITERATURE_MAX_FILE_BYTES,
  literatureImportBatchCreateRequestSchema,
  literatureImportFileRequestSchema,
  isSafeLiteratureOriginalFilename,
} from "./literature";

const pdfFile = {
  clientFileId: "client-file-001",
  originalFilename: "pathology.pdf",
  declaredExtension: ".pdf" as const,
  declaredMime: "application/pdf",
  expectedSizeBytes: 12,
  intent: "CREATE_DOCUMENT" as const,
};

describe("literature import domain contract", () => {
  it("accepts only bounded local PDF/TXT file declarations", () => {
    expect(literatureImportFileRequestSchema.safeParse(pdfFile).success).toBe(true);
    expect(literatureImportFileRequestSchema.safeParse({ ...pdfFile, expectedSizeBytes: LITERATURE_MAX_FILE_BYTES }).success).toBe(true);
    expect(literatureImportFileRequestSchema.safeParse({
      ...pdfFile,
      clientFileId: "client-file-002",
      originalFilename: "notes.txt",
      declaredExtension: ".txt",
      declaredMime: "text/plain;charset=utf-8",
    }).success).toBe(true);

    expect(literatureImportFileRequestSchema.safeParse({ ...pdfFile, declaredMime: "text/plain" }).success).toBe(false);
    expect(literatureImportFileRequestSchema.safeParse({ ...pdfFile, originalFilename: "notes.exe" }).success).toBe(false);
    expect(literatureImportFileRequestSchema.safeParse({
      ...pdfFile,
      originalFilename: "notes.pdf",
      declaredExtension: ".txt",
      declaredMime: "text/plain",
    }).success).toBe(false);
    expect(literatureImportFileRequestSchema.safeParse({ ...pdfFile, expectedSizeBytes: LITERATURE_MAX_FILE_BYTES + 1 }).success).toBe(false);
  });

  it("rejects path, control, bidi, reserved and trailing-space filenames", () => {
    for (const filename of [
      "../pathology.pdf",
      "folder/pathology.pdf",
      "folder\\pathology.pdf",
      "CON.pdf",
      "notes. ",
      "notes.",
      "notes\u0000.txt",
      "notes\u202E.txt",
      "..hidden.txt",
    ]) {
      expect(isSafeLiteratureOriginalFilename(filename), filename).toBe(false);
    }
    expect(isSafeLiteratureOriginalFilename("病理生理学.txt")).toBe(true);
  });

  it("enforces unique client file ids, three-file batches and the 200 MiB total cap", () => {
    const makeFile = (clientFileId: string, expectedSizeBytes: number) => ({ ...pdfFile, clientFileId, expectedSizeBytes });
    expect(literatureImportBatchCreateRequestSchema.safeParse({
      requestId: "batch-request-001",
      files: [makeFile("file-1", 1), makeFile("file-2", 1), makeFile("file-3", 1)],
    }).success).toBe(true);
    expect(literatureImportBatchCreateRequestSchema.safeParse({
      requestId: "batch-request-002",
      files: [makeFile("file-1", 1), makeFile("file-1", 1)],
    }).success).toBe(false);
    expect(literatureImportBatchCreateRequestSchema.safeParse({
      requestId: "batch-request-003",
      files: Array.from({ length: LITERATURE_MAX_BATCH_FILES + 1 }, (_, index) => makeFile(`file-${index}`, 1)),
    }).success).toBe(false);
    expect(literatureImportBatchCreateRequestSchema.safeParse({
      requestId: "batch-request-004",
      files: [makeFile("file-1", LITERATURE_MAX_FILE_BYTES), makeFile("file-2", LITERATURE_MAX_FILE_BYTES)],
    }).success).toBe(true);
    expect(literatureImportBatchCreateRequestSchema.safeParse({
      requestId: "batch-request-005",
      files: [makeFile("file-1", LITERATURE_MAX_FILE_BYTES), makeFile("file-2", LITERATURE_MAX_FILE_BYTES), makeFile("file-3", 1)],
    }).success).toBe(false);
    expect(literatureImportBatchCreateRequestSchema.safeParse({
      requestId: "batch-request-006",
      files: [makeFile("file-1", LITERATURE_MAX_FILE_BYTES + 1)],
    }).success).toBe(false);

  });
});
