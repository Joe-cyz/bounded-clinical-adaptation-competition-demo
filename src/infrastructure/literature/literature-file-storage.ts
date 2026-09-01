import "server-only";

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  LITERATURE_MAX_FILE_BYTES,
  literatureFormatForExtension,
  literatureStorageKeySchema,
  type LiteratureFormat,
} from "@/domain/literature";
import { literatureError, literatureErrorCodes } from "./literature-errors";

export const LITERATURE_STORAGE_ROOT = resolve(process.cwd(), "data/runtime/literature");

export type LiteratureStreamInput = {
  itemId: string;
  extension: ".pdf" | ".txt";
  expectedSizeBytes: number;
  body: ReadableStream<Uint8Array>;
};

export type LiteratureStagedFile = {
  stagingPath: string;
  storageKey: string;
  format: LiteratureFormat;
  detectedMime: string;
  sizeBytes: number;
  sha256: string;
};

export type LiteraturePromotedObject = {
  storageKey: string;
  objectPath: string;
  created: boolean;
};

export type LiteratureChunkWriter = (chunk: Uint8Array, position: number) => Promise<number>;

/** Write one chunk completely, including FileHandle partial-write results. */
export async function writeAll(
  writer: LiteratureChunkWriter,
  chunk: Uint8Array,
  position = 0,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    let bytesWritten: number;
    try {
      bytesWritten = await writer(chunk.subarray(offset), position + offset);
    } catch {
      throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    }
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
      throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    }
    offset += bytesWritten;
  }
}

export type LiteratureFileStorage = {
  stageStream(input: LiteratureStreamInput): Promise<LiteratureStagedFile>;
  promote(stagingPath: string, storageKey: string): Promise<LiteraturePromotedObject>;
  removeStagingForItem(itemId: string): Promise<void>;
  removeStagingPath(stagingPath: string): Promise<void>;
  removeObjectIfUnreferenced(storageKey: string): Promise<void>;
  listStagingPartPaths(): Promise<string[]>;
  listObjectPaths(): Promise<string[]>;
  objectPathForStorageKey(storageKey: string): string;
  storageKeyForObjectPath(objectPath: string): string;
  hasObject(storageKey: string): Promise<boolean>;
  stagingPathForItem(itemId: string): string;
  /** Opens a verified, owned object for a server-side parser and nothing else. */
  openObject?: (storageKey: string) => Promise<Awaited<ReturnType<typeof open>>>;
};

function isPathInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const fromRoot = relative(rootPath, candidatePath);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${candidatePath.includes("\\") ? "\\" : "/"}`) && !isAbsolute(fromRoot));
}

function assertControlledPath(root: string, candidate: string): void {
  if (!isPathInside(root, candidate)) {
    throw literatureError(literatureErrorCodes.STORAGE_FAILED);
  }
}

async function assertDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a safe directory");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      await mkdir(path, { recursive: true });
      const created = await lstat(path);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("not a safe directory");
      return;
    }
    throw error;
  }
}

async function assertOwnedRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw literatureError(literatureErrorCodes.STORAGE_FAILED);
  }
}

async function cleanupOwnedFile(path: string): Promise<void> {
  try {
    await assertOwnedRegularFile(path);
    await rm(path, { force: false });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    throw literatureError(literatureErrorCodes.CLEANUP_FAILED);
  }
}

function appendTail(
  previous: Uint8Array<ArrayBufferLike>,
  chunk: Uint8Array<ArrayBufferLike>,
  maxBytes: number,
): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(Math.min(maxBytes, previous.byteLength + chunk.byteLength));
  const sourceStart = Math.max(0, previous.byteLength + chunk.byteLength - maxBytes);
  let targetOffset = 0;
  if (sourceStart < previous.byteLength) {
    const previousStart = sourceStart;
    const previousLength = previous.byteLength - previousStart;
    combined.set(previous.subarray(previousStart), targetOffset);
    targetOffset += previousLength;
  }
  const chunkStart = Math.max(0, sourceStart - previous.byteLength);
  combined.set(chunk.subarray(chunkStart), targetOffset);
  return combined;
}

function hasForbiddenTextControl(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

function firstBytesMatch(value: Uint8Array, expected: string): boolean {
  if (value.byteLength < expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (value[index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function looksLikeForbiddenBinary(value: Uint8Array): boolean {
  return firstBytesMatch(value, "PK\u0003\u0004")
    || firstBytesMatch(value, "MZ")
    || firstBytesMatch(value, "\u00D0\u00CF\u0011\u00E0\u00A1\u00B1\u001A\u00E1");
}

function normalizeContentLength(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw literatureError(literatureErrorCodes.LENGTH_MISMATCH);
  return value;
}

export function createLocalLiteratureFileStorage(root = LITERATURE_STORAGE_ROOT): LiteratureFileStorage {
  const storageRoot = resolve(root);
  const stagingRoot = join(storageRoot, "staging");
  const objectsRoot = join(storageRoot, "objects");

  function stagingPathForItem(itemId: string): string {
    const candidate = join(stagingRoot, `${itemId}.part`);
    assertControlledPath(storageRoot, candidate);
    return candidate;
  }

  function objectPathForStorageKey(storageKey: string): string {
    const parsed = literatureStorageKeySchema.safeParse(storageKey);
    if (!parsed.success) throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    const candidate = join(storageRoot, ...storageKey.split("/"));
    assertControlledPath(storageRoot, candidate);
    return candidate;
  }

  function storageKeyForObjectPath(objectPath: string): string {
    assertControlledPath(objectsRoot, objectPath);
    const value = relative(storageRoot, resolve(objectPath)).replace(/\\/gu, "/");
    if (!literatureStorageKeySchema.safeParse(value).success) {
      throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    }
    return value;
  }

  async function ensureRoots(): Promise<void> {
    await assertDirectory(storageRoot);
    await assertDirectory(stagingRoot);
    await assertDirectory(objectsRoot);
  }

  async function stageStream(input: LiteratureStreamInput): Promise<LiteratureStagedFile> {
    if (!input.body || !Number.isInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1 || input.expectedSizeBytes > LITERATURE_MAX_FILE_BYTES) {
      throw literatureError(literatureErrorCodes.INVALID_REQUEST);
    }
    const expectedContentLength = normalizeContentLength(input.expectedSizeBytes);
    if (expectedContentLength === undefined) throw literatureError(literatureErrorCodes.LENGTH_MISMATCH);
    await ensureRoots();
    const stagingPath = stagingPathForItem(input.itemId);
    const format = literatureFormatForExtension(input.extension);
    const storageExtension = input.extension.slice(1);
    const reader = input.body.getReader();
    const hash = createHash("sha256");
    const decoder = format === "UTF8_TEXT" ? new TextDecoder("utf-8", { fatal: true }) : undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let sizeBytes = 0;
    let first: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let hasTextContent = false;
    let handleClosed = false;

    try {
      try {
        const openFlags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
        handle = await open(stagingPath, openFlags, 0o600);
      } catch {
        throw literatureError(literatureErrorCodes.STORAGE_FAILED);
      }

      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch {
          throw literatureError(literatureErrorCodes.STREAM_ABORTED);
        }
        if (readResult.done) break;
        const chunk = readResult.value;
        if (!(chunk instanceof Uint8Array)) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > LITERATURE_MAX_FILE_BYTES || sizeBytes > expectedContentLength) {
          throw literatureError(literatureErrorCodes.FILE_TOO_LARGE);
        }
        if (first.byteLength < 8) {
          const firstCombined = new Uint8Array(Math.min(8, first.byteLength + chunk.byteLength));
          firstCombined.set(first);
          firstCombined.set(chunk.subarray(0, firstCombined.byteLength - first.byteLength), first.byteLength);
          first = firstCombined;
        }
        tail = appendTail(tail, chunk, 1024);
        hash.update(chunk);
        if (decoder) {
          let decoded: string;
          try {
            decoded = decoder.decode(chunk, { stream: true });
          } catch {
            throw literatureError(literatureErrorCodes.INVALID_TEXT);
          }
          if (hasForbiddenTextControl(decoded)) throw literatureError(literatureErrorCodes.INVALID_TEXT);
          if (decoded.replace(/^\uFEFF/u, "").trim().length > 0) hasTextContent = true;
        }
        await writeAll(async (part, position) => {
          const result = await handle!.write(part, 0, part.byteLength, position);
          return result.bytesWritten;
        }, chunk, sizeBytes - chunk.byteLength);
      }

      if (decoder) {
        let decoded: string;
        try {
          decoded = decoder.decode();
        } catch {
          throw literatureError(literatureErrorCodes.INVALID_TEXT);
        }
        if (hasForbiddenTextControl(decoded)) throw literatureError(literatureErrorCodes.INVALID_TEXT);
        if (decoded.replace(/^\uFEFF/u, "").trim().length > 0) hasTextContent = true;
      }

      if (expectedContentLength !== sizeBytes) throw literatureError(literatureErrorCodes.LENGTH_MISMATCH);
      if (sizeBytes === 0) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
      if (format === "PDF") {
        if (!firstBytesMatch(first, "%PDF-") || looksLikeForbiddenBinary(first)) {
          throw literatureError(literatureErrorCodes.INVALID_PDF);
        }
        if (!Buffer.from(tail).toString("latin1").includes("%%EOF")) {
          throw literatureError(literatureErrorCodes.INVALID_PDF);
        }
      } else if (!hasTextContent) {
        throw literatureError(literatureErrorCodes.INVALID_TEXT);
      }

      if (handle) {
        try {
          await handle.close();
          handleClosed = true;
          handle = undefined;
        } catch {
          throw literatureError(literatureErrorCodes.CLEANUP_FAILED);
        }
      }

      const sha256 = hash.digest("hex");
      const storageKey = `objects/${sha256.slice(0, 2)}/${sha256}.${storageExtension}`;
      return {
        stagingPath,
        storageKey,
        format,
        detectedMime: format === "PDF" ? "application/pdf" : "text/plain",
        sizeBytes,
        sha256,
      };
    } catch (error) {
      try {
        await reader.cancel().catch(() => undefined);
      } catch {
        // Cleanup below is authoritative.
      }
      let cleanupFailed = false;
      if (handle && !handleClosed) {
        try {
          await handle.close();
          handleClosed = true;
          handle = undefined;
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await cleanupOwnedFile(stagingPath);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) throw literatureError(literatureErrorCodes.CLEANUP_FAILED);
      if (error instanceof Error && error.message === "Literature import request failed.") throw error;
      throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    } finally {
      if (handle && !handleClosed) {
        try {
          await handle.close();
          handleClosed = true;
        } catch {
          // The main path converts close failures into a controlled cleanup error.
        }
      }
      reader.releaseLock();
    }
  }

  async function promote(stagingPath: string, storageKey: string): Promise<LiteraturePromotedObject> {
    await ensureRoots();
    assertControlledPath(storageRoot, stagingPath);
    await assertOwnedRegularFile(stagingPath);
    const objectPath = objectPathForStorageKey(storageKey);
    await assertDirectory(dirname(objectPath));
    try {
      const existing = await lstat(objectPath);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
        throw literatureError(literatureErrorCodes.STORAGE_FAILED);
      }
      await cleanupOwnedFile(stagingPath);
      return { storageKey, objectPath, created: false };
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        if (error instanceof Error && error.message === "Literature import request failed.") throw error;
        throw error;
      }
    }
    try {
      await rename(stagingPath, objectPath);
      await assertOwnedRegularFile(objectPath);
      return { storageKey, objectPath, created: true };
    } catch {
      try {
        const existing = await lstat(objectPath);
        if (existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1) {
          await cleanupOwnedFile(stagingPath);
          return { storageKey, objectPath, created: false };
        }
      } catch {
        // The caller reports a controlled storage failure.
      }
      throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    }
  }

  async function removeStagingPath(stagingPath: string): Promise<void> {
    assertControlledPath(storageRoot, stagingPath);
    await cleanupOwnedFile(stagingPath);
  }

  async function removeStagingForItem(itemId: string): Promise<void> {
    await removeStagingPath(stagingPathForItem(itemId));
  }

  async function removeObjectIfUnreferenced(storageKey: string): Promise<void> {
    const objectPath = objectPathForStorageKey(storageKey);
    await cleanupOwnedFile(objectPath);
  }

  async function hasObject(storageKey: string): Promise<boolean> {
    const objectPath = objectPathForStorageKey(storageKey);
    try {
      await assertOwnedRegularFile(objectPath);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false;
      if (error instanceof Error && error.message === "Literature import request failed.") throw error;
      throw literatureError(literatureErrorCodes.CONSISTENCY_FAILED);
    }
  }

  async function openObject(storageKey: string): Promise<Awaited<ReturnType<typeof open>>> {
    await ensureRoots();
    const objectPath = objectPathForStorageKey(storageKey);
    try {
      const parent = await lstat(dirname(objectPath));
      if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw literatureError(literatureErrorCodes.STORAGE_FAILED);
      }
      await assertOwnedRegularFile(objectPath);
      return await open(objectPath, fsConstants.O_RDONLY);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        throw literatureError(literatureErrorCodes.CONSISTENCY_FAILED);
      }
      if (error instanceof Error && error.message === "Literature import request failed.") throw error;
      throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    }
  }

  async function listStagingPartPaths(): Promise<string[]> {
    await ensureRoots();
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".part") || !entry.isFile()) continue;
      const candidate = join(stagingRoot, entry.name);
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) paths.push(candidate);
    }
    return paths;
  }

  async function listObjectPaths(): Promise<string[]> {
    await ensureRoots();
    const prefixes = await readdir(objectsRoot, { withFileTypes: true });
    const paths: string[] = [];
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
      const directory = join(objectsRoot, prefix.name);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.(?:pdf|txt)$/u.test(entry.name)) continue;
        const candidate = join(directory, entry.name);
        const info = await lstat(candidate);
        if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) paths.push(candidate);
      }
    }
    return paths;
  }

  return {
    stageStream,
    promote,
    removeStagingForItem,
    removeStagingPath,
    removeObjectIfUnreferenced,
    listStagingPartPaths,
    listObjectPaths,
    objectPathForStorageKey,
    storageKeyForObjectPath,
    hasObject,
    openObject,
    stagingPathForItem,
  };
}
