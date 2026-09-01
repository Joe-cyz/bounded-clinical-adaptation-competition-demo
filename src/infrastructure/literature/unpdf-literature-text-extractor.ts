import "server-only";

import { Worker } from "node:worker_threads";

import {
  LITERATURE_MAX_DOCUMENT_CODE_POINTS,
  LITERATURE_MAX_PAGE_CODE_POINTS,
  LITERATURE_MAX_PDF_PAGES,
  LITERATURE_PARSE_TIMEOUT_MS,
} from "@/domain/literature-parsing";
import {
  LiteratureParsingFailure,
  type ExtractedLiteraturePage,
  type LiteratureTextExtractorPort,
} from "./literature-text-extractor";

const PDF_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

function failureCode(error) {
  const name = typeof error?.name === "string" ? error.name.toLowerCase() : "";
  if (name.includes("password") || name.includes("encrypt")) return "ENCRYPTED_PDF";
  return "INVALID_PDF";
}

(async () => {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const document = await getDocumentProxy(workerData.buffer, {
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      isEvalSupported: false,
      maxImageSize: 16777216,
    });
    parentPort.postMessage({ kind: "meta", pageCount: document.numPages });
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item) => item && typeof item.str === "string")
        .map((item) => item.str + (item.hasEOL ? "\n" : ""))
        .join("");
      parentPort.postMessage({ kind: "page", pageNumber, text });
      if (typeof page.cleanup === "function") page.cleanup();
    }
    if (typeof document.cleanup === "function") await document.cleanup();
    parentPort.postMessage({ kind: "done" });
  } catch (error) {
    parentPort.postMessage({ kind: "error", code: failureCode(error) });
  }
})();
`;

type WorkerMessage =
  | { kind: "meta"; pageCount: number }
  | { kind: "page"; pageNumber: number; text: string }
  | { kind: "done" }
  | { kind: "error"; code: "ENCRYPTED_PDF" | "INVALID_PDF" };

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function abortError(signal?: AbortSignal): LiteratureParsingFailure | undefined {
  return signal?.aborted ? new LiteratureParsingFailure("PARSE_TIMEOUT") : undefined;
}

export class UnpdfLiteratureTextExtractor implements LiteratureTextExtractorPort {
  async extractPdf(
    bytes: Uint8Array,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ExtractedLiteraturePage[]> {
    const aborted = abortError(options.signal);
    if (aborted) throw aborted;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const timeoutMs = options.timeoutMs ?? LITERATURE_PARSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new LiteratureParsingFailure("PARSE_TIMEOUT");

    const worker = new Worker(PDF_WORKER_SOURCE, {
      eval: true,
      workerData: { buffer },
      transferList: [buffer],
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    });
    const pages: ExtractedLiteraturePage[] = [];
    let pageCount: number | undefined;
    let totalCodePoints = 0;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;

    return await new Promise<ExtractedLiteraturePage[]>((resolve, reject) => {
      const finish = (error?: LiteratureParsingFailure): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        removeAbortListener?.();
        void worker.terminate().then(() => {
          if (error) reject(error);
          else resolve(pages);
        }).catch(() => reject(new LiteratureParsingFailure("PARSER_CRASHED")));
      };

      timeoutHandle = setTimeout(() => finish(new LiteratureParsingFailure("PARSE_TIMEOUT")), timeoutMs);
      if (options.signal) {
        const onAbort = (): void => finish(new LiteratureParsingFailure("PARSE_TIMEOUT"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      worker.on("message", (message: WorkerMessage) => {
        if (settled) return;
        if (message.kind === "meta") {
          pageCount = message.pageCount;
          if (!Number.isInteger(pageCount) || pageCount < 1) {
            finish(new LiteratureParsingFailure("INVALID_PDF"));
          } else if (pageCount > LITERATURE_MAX_PDF_PAGES) {
            finish(new LiteratureParsingFailure("PAGES_EXCEEDED"));
          }
          return;
        }
        if (message.kind === "page") {
          const pageLength = codePointLength(message.text);
          totalCodePoints += pageLength;
          if (pageLength > LITERATURE_MAX_PAGE_CODE_POINTS) {
            finish(new LiteratureParsingFailure("PAGE_TEXT_EXCEEDED"));
            return;
          }
          if (totalCodePoints > LITERATURE_MAX_DOCUMENT_CODE_POINTS) {
            finish(new LiteratureParsingFailure("DOCUMENT_TEXT_EXCEEDED"));
            return;
          }
          if (pages.length >= LITERATURE_MAX_PDF_PAGES) {
            finish(new LiteratureParsingFailure("PAGES_EXCEEDED"));
            return;
          }
          pages.push({ pageNumber: message.pageNumber, text: message.text });
          return;
        }
        if (message.kind === "error") {
          finish(new LiteratureParsingFailure(message.code));
          return;
        }
        if (message.kind === "done") {
          if (pageCount === undefined || pages.length !== pageCount) {
            finish(new LiteratureParsingFailure("PARSER_CRASHED"));
          } else if (totalCodePoints === 0) {
            finish(new LiteratureParsingFailure("NO_TEXT_LAYER"));
          } else {
            finish();
          }
        }
      });
      worker.on("error", () => finish(new LiteratureParsingFailure("PARSER_CRASHED")));
      worker.on("exit", (code) => {
        if (!settled && code !== 0) finish(new LiteratureParsingFailure("PARSER_CRASHED"));
      });
    });
  }
}
