import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LITERATURE_MAX_FILE_BYTES } from "@/domain/literature";
import { PersistenceError } from "@/infrastructure/sqlite/errors";
import { createLocalLiteratureFileStorage, type LiteratureFileStorage, writeAll } from "./literature-file-storage";
import { literatureErrorCodes } from "./literature-errors";

function streamFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

function throwingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      throw new Error("synthetic stream interruption");
    },
  });
}

function validPdf(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
}

function validText(): Uint8Array {
  return new TextEncoder().encode("病理生理学本地原型文本\n");
}

async function filesIn(root: string): Promise<string[]> {
  return fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
}

describe("local literature stream storage", () => {
  let root: string;
  let storage: LiteratureFileStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "pwr-08a-literature-storage-"));
    storage = createLocalLiteratureFileStorage(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes every byte through repeated partial writer results", async () => {
    const source = new TextEncoder().encode("partial-write-安全");
    const output = new Uint8Array(source.byteLength);
    const positions: number[] = [];
    await writeAll(async (chunk, position) => {
      positions.push(position);
      output.set(chunk.subarray(0, 1), position);
      return 1;
    }, source);
    expect(output).toEqual(source);
    expect(positions).toEqual([...source.keys()]);
  });

  it.each([
    ["zero", async () => 0],
    ["beyond-chunk", async (chunk: Uint8Array) => chunk.byteLength + 1],
    ["throw", async () => { throw new Error("synthetic writer failure"); }],
  ] as const)("fails closed for %s writer results", async (_label, writer) => {
    await expect(writeAll(writer, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: literatureErrorCodes.STORAGE_FAILED });
  });

  it("streams a valid PDF/TXT, hashes it and promotes by a controlled storage key", async () => {
    const pdf = validPdf();
    const stagedPdf = await storage.stageStream({
      itemId: "item-pdf-001",
      extension: ".pdf",
      expectedSizeBytes: pdf.byteLength,
      body: streamFromChunks([pdf.subarray(0, 7), pdf.subarray(7)]),
    });
    expect(stagedPdf.format).toBe("PDF");
    expect(stagedPdf.detectedMime).toBe("application/pdf");
    expect(stagedPdf.sizeBytes).toBe(pdf.byteLength);
    expect(stagedPdf.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const promoted = await storage.promote(stagedPdf.stagingPath, stagedPdf.storageKey);
    expect(promoted.created).toBe(true);
    expect(await storage.hasObject(stagedPdf.storageKey)).toBe(true);
    expect(await fs.stat(stagedPdf.stagingPath).catch(() => undefined)).toBeUndefined();
    expect(storage.storageKeyForObjectPath(promoted.objectPath)).toBe(stagedPdf.storageKey);

    const text = validText();
    const stagedText = await storage.stageStream({
      itemId: "item-text-001",
      extension: ".txt",
      expectedSizeBytes: text.byteLength,
      body: streamFromChunks([text]),
    });
    expect(stagedText.format).toBe("UTF8_TEXT");
    expect(stagedText.detectedMime).toBe("text/plain");
  });

  it.each([
    ["invalid PDF header", ".pdf" as const, new TextEncoder().encode("not-a-pdf\n%%EOF"), "LITERATURE_INVALID_PDF"],
    ["missing PDF EOF", ".pdf" as const, new TextEncoder().encode("%PDF-1.7\nbody"), "LITERATURE_INVALID_PDF"],
    ["invalid UTF-8", ".txt" as const, new Uint8Array([0xc3, 0x28]), "LITERATURE_INVALID_TEXT"],
    ["empty text", ".txt" as const, new TextEncoder().encode("   \n\t"), "LITERATURE_INVALID_TEXT"],
    ["empty file", ".pdf" as const, new Uint8Array(0), "LITERATURE_INVALID_REQUEST"],
    ["forbidden ZIP header", ".pdf" as const, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), "LITERATURE_INVALID_PDF"],
  ] as const)("deletes a staged file after %s", async (_label, extension, bytes, code) => {
    const itemId = `item-${_label.replace(/\W/gu, "-")}`;
    await expect(storage.stageStream({
      itemId,
      extension,
      expectedSizeBytes: bytes.byteLength,
      body: streamFromChunks([bytes]),
    })).rejects.toMatchObject({ code });
    expect(await fs.stat(storage.stagingPathForItem(itemId)).catch(() => undefined)).toBeUndefined();
  });

  it("deletes a staged file after an oversized stream or an interrupted stream", async () => {
    const oversizedItem = "item-oversized-001";
    await expect(storage.stageStream({
      itemId: oversizedItem,
      extension: ".txt",
      expectedSizeBytes: 3,
      body: streamFromChunks([new Uint8Array([1, 2, 3, 4])]),
    })).rejects.toMatchObject({ code: literatureErrorCodes.FILE_TOO_LARGE });
    expect(await fs.stat(storage.stagingPathForItem(oversizedItem)).catch(() => undefined)).toBeUndefined();

    const interruptedItem = "item-interrupted-001";
    await expect(storage.stageStream({
      itemId: interruptedItem,
      extension: ".txt",
      expectedSizeBytes: 10,
      body: throwingStream(),
    })).rejects.toMatchObject({ code: literatureErrorCodes.STREAM_ABORTED });
    expect(await fs.stat(storage.stagingPathForItem(interruptedItem)).catch(() => undefined)).toBeUndefined();
  });

  it("keeps the configured 100 MiB per-file limit streaming and never accepts an overrun", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    chunk.fill(0x61);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 100) {
          controller.enqueue(new Uint8Array([0x61]));
          emitted += 1;
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        emitted += 1;
      },
    });
    await expect(storage.stageStream({
      itemId: "item-limit-001",
      extension: ".txt",
      expectedSizeBytes: LITERATURE_MAX_FILE_BYTES,
      body,
    })).rejects.toMatchObject({ code: literatureErrorCodes.FILE_TOO_LARGE });
    expect(await fs.stat(storage.stagingPathForItem("item-limit-001")).catch(() => undefined)).toBeUndefined();
  });

  it("never deletes an outside file or a hard-linked/symbolic linked target", async () => {
    const outsideRoot = await fs.mkdtemp(join(tmpdir(), "pwr-08a-literature-outside-"));
    const outsideFile = join(outsideRoot, "outside.txt");
    try {
      await fs.writeFile(outsideFile, "keep");
      await expect(storage.removeStagingPath(outsideFile)).rejects.toMatchObject({ code: literatureErrorCodes.STORAGE_FAILED });
      expect(await fs.readFile(outsideFile, "utf8")).toBe("keep");
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }

    const hardLinkedItem = "item-hard-link-001";
    const hardLinkedPath = storage.stagingPathForItem(hardLinkedItem);
    await fs.mkdir(join(root, "staging"), { recursive: true });
    await fs.writeFile(hardLinkedPath, "keep-hard-link");
    const hardLinkTarget = join(root, "hard-link-target.txt");
    await fs.link(hardLinkedPath, hardLinkTarget);
    await expect(storage.removeStagingPath(hardLinkedPath)).rejects.toMatchObject({ code: literatureErrorCodes.CLEANUP_FAILED });
    expect(await fs.readFile(hardLinkTarget, "utf8")).toBe("keep-hard-link");

    const symlinkItem = "item-symlink-001";
    const symlinkPath = storage.stagingPathForItem(symlinkItem);
    const symlinkTarget = join(root, "symlink-target.txt");
    await fs.writeFile(symlinkTarget, "keep-symlink");
    try {
      await fs.symlink(symlinkTarget, symlinkPath);
    } catch {
      return;
    }
    await expect(storage.removeStagingPath(symlinkPath)).rejects.toMatchObject({ code: literatureErrorCodes.CLEANUP_FAILED });
    expect(await fs.readFile(symlinkTarget, "utf8")).toBe("keep-symlink");
  });

  it("rejects invalid storage paths as controlled PersistenceErrors", async () => {
    expect(() => storage.objectPathForStorageKey("../outside.txt")).toThrowError(PersistenceError);
    expect(await filesIn(root)).not.toContain("outside.txt");
  });
});
