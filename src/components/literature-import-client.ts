import {
  LITERATURE_MAX_BATCH_BYTES,
  LITERATURE_MAX_BATCH_FILES,
  LITERATURE_MAX_FILE_BYTES,
  isSafeLiteratureOriginalFilename,
} from "@/domain/literature";

export type SelectedLiteratureFile = {
  clientFileId: string;
  file: File;
  declaredExtension: ".pdf" | ".txt";
  declaredMime: "application/pdf" | "text/plain";
};

export type LiteratureSelectionResult =
  | { ok: true; files: SelectedLiteratureFile[] }
  | { ok: false; message: string };

function extensionFor(filename: string): ".pdf" | ".txt" | undefined {
  const normalized = filename.toLowerCase();
  if (normalized.endsWith(".pdf")) return ".pdf";
  if (normalized.endsWith(".txt")) return ".txt";
  return undefined;
}

function hasCompatibleBrowserMime(file: File, extension: ".pdf" | ".txt"): boolean {
  const mime = file.type.trim().toLowerCase();
  if (mime.length === 0) return true;
  if (extension === ".pdf") return mime === "application/pdf";
  return mime === "text/plain";
}

function clientFileId(index: number): string {
  return `literature-file-${crypto.randomUUID()}-${index + 1}`;
}

export function createLiteratureRequestId(): string {
  return `literature-request-${crypto.randomUUID()}`;
}

/**
 * This examines only browser-supplied metadata. It deliberately never reads a
 * File body or turns it into a string; the raw bytes go straight to the
 * sequential PUT request when the physician explicitly starts the import.
 */
export function validateLiteratureSelection(filesLike: FileList | readonly File[]): LiteratureSelectionResult {
  const files = Array.from(filesLike);
  if (files.length === 0) return { ok: false, message: "请选择 1 至 3 份 PDF 或 TXT 资料。" };
  if (files.length > LITERATURE_MAX_BATCH_FILES) return { ok: false, message: "一次最多可选择 3 份资料。" };

  let totalBytes = 0;
  const names = new Set<string>();
  const selected: SelectedLiteratureFile[] = [];
  for (const [index, file] of files.entries()) {
    if (!isSafeLiteratureOriginalFilename(file.name)) {
      return { ok: false, message: "资料名称不符合要求，请重新选择文件。" };
    }
    if (names.has(file.name)) return { ok: false, message: "请不要重复选择同一份资料。" };
    names.add(file.name);

    const extension = extensionFor(file.name);
    if (!extension) return { ok: false, message: "仅支持 PDF 或 TXT 资料。" };
    if (!hasCompatibleBrowserMime(file, extension)) {
      return { ok: false, message: "资料类型与文件名称不一致，请重新选择。" };
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      return { ok: false, message: "不能导入空文件。" };
    }
    if (file.size > LITERATURE_MAX_FILE_BYTES) {
      return { ok: false, message: "单份资料不能超过 100 MiB。" };
    }
    totalBytes += file.size;
    if (totalBytes > LITERATURE_MAX_BATCH_BYTES) {
      return { ok: false, message: "本次资料总大小不能超过 200 MiB。" };
    }
    selected.push({
      clientFileId: clientFileId(index),
      file,
      declaredExtension: extension,
      declaredMime: extension === ".pdf" ? "application/pdf" : "text/plain",
    });
  }

  return { ok: true, files: selected };
}

export function formatLiteratureSize(sizeBytes: number): string {
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} KiB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function friendlyImportFailure(): string {
  return "导入未完成，未发布任何资料。请检查文件后重新选择。";
}
