import { z } from "zod";

import { isoUtcTimestampSchema } from "./runtime-records";

export const LITERATURE_PARSER_VERSION = "unpdf@1.8.1" as const;
export const LITERATURE_PARSER_SCHEMA_VERSION = "1.0.0" as const;
export const LITERATURE_MAX_PDF_PAGES = 2_500;
export const LITERATURE_MAX_PAGE_CODE_POINTS = 250_000;
export const LITERATURE_MAX_DOCUMENT_CODE_POINTS = 20_000_000;
export const LITERATURE_MAX_FRAGMENTS = 25_000;
export const LITERATURE_PARSE_TIMEOUT_MS = 180_000;
export const LITERATURE_PDF_MAX_IMAGE_SIZE = 16_777_216;
export const LITERATURE_FRAGMENT_TARGET_CODE_POINTS = 900;
export const LITERATURE_FRAGMENT_MAX_CODE_POINTS = 1_200;
export const LITERATURE_FRAGMENT_MAX_OVERLAP_CODE_POINTS = 120;
export const LITERATURE_SEARCH_MAX_QUERY_CODE_POINTS = 200;
export const LITERATURE_SEARCH_MAX_DOCUMENTS = 3;
export const LITERATURE_SEARCH_MAX_RESULTS = 5;
export const LITERATURE_CITATION_MAX_EXCERPT_CODE_POINTS = 600;
export const LITERATURE_MIN_EVIDENCE_SCORE = 0.5;

const safeIdentifierSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

function codePointStringSchema(max: number, min = 0): z.ZodString {
  return z.string().min(min).superRefine((value, context) => {
    if (Array.from(value).length > max) {
      context.addIssue({ code: "too_big", origin: "string", maximum: max, inclusive: true, message: "Text exceeds the Unicode code-point limit." });
    }
  });
}

export const literatureParseStatusSchema = z.enum(["PENDING", "PARSING", "READY", "FAILED"]);
export type LiteratureParseStatus = z.infer<typeof literatureParseStatusSchema>;

export const literatureParseFailureCodeSchema = z.enum([
  "ENCRYPTED_PDF",
  "NO_TEXT_LAYER",
  "PAGES_EXCEEDED",
  "PAGE_TEXT_EXCEEDED",
  "DOCUMENT_TEXT_EXCEEDED",
  "FRAGMENTS_EXCEEDED",
  "PARSE_TIMEOUT",
  "PARSER_CRASHED",
  "SHA_MISMATCH",
  "UNSAFE_OBJECT_PATH",
  "STORAGE_MISSING",
  "INVALID_PDF",
  "INVALID_TEXT",
  "UNSUPPORTED_FORMAT",
  "PUBLISH_FAILED",
  "CLEANUP_FAILED",
]);
export type LiteratureParseFailureCode = z.infer<typeof literatureParseFailureCodeSchema>;

export const literatureSourceKindSchema = z.enum(["PDF_PAGE", "TXT_LINES"]);
export type LiteratureSourceKind = z.infer<typeof literatureSourceKindSchema>;

export const literaturePdfLocationSchema = z.object({
  kind: z.literal("PDF_PAGE"),
  pageNumber: z.number().int().min(1).max(LITERATURE_MAX_PDF_PAGES),
  startCodePoint: z.number().int().nonnegative().max(LITERATURE_MAX_PAGE_CODE_POINTS),
  endCodePoint: z.number().int().positive().max(LITERATURE_MAX_PAGE_CODE_POINTS),
}).strict().superRefine((location, context) => {
  if (location.endCodePoint <= location.startCodePoint) {
    context.addIssue({ code: "custom", path: ["endCodePoint"], message: "A PDF location must have a positive range." });
  }
});
export type LiteraturePdfLocation = z.infer<typeof literaturePdfLocationSchema>;

export const literatureTxtLocationSchema = z.object({
  kind: z.literal("TXT_LINES"),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  title: z.string().min(1).max(200).optional(),
}).strict().superRefine((location, context) => {
  if (location.endLine < location.startLine) {
    context.addIssue({ code: "custom", path: ["endLine"], message: "A TXT location must have ordered lines." });
  }
});
export type LiteratureTxtLocation = z.infer<typeof literatureTxtLocationSchema>;

export const literatureFragmentLocationSchema = z.discriminatedUnion("kind", [
  literaturePdfLocationSchema,
  literatureTxtLocationSchema,
]);
export type LiteratureFragmentLocation = z.infer<typeof literatureFragmentLocationSchema>;

export const literatureParseRunSchema = z.object({
  schemaVersion: z.literal(LITERATURE_PARSER_SCHEMA_VERSION),
  parseRunId: safeIdentifierSchema,
  parseRequestId: safeIdentifierSchema,
  requestFingerprint: z.string().length(64).regex(/^[a-f0-9]{64}$/u),
  documentId: safeIdentifierSchema,
  versionId: safeIdentifierSchema,
  parserVersion: z.string().min(1).max(100),
  status: literatureParseStatusSchema,
  pageCount: z.number().int().nonnegative().max(LITERATURE_MAX_PDF_PAGES),
  codePointCount: z.number().int().nonnegative().max(LITERATURE_MAX_DOCUMENT_CODE_POINTS),
  fragmentCount: z.number().int().nonnegative().max(LITERATURE_MAX_FRAGMENTS),
  startedAt: isoUtcTimestampSchema,
  updatedAt: isoUtcTimestampSchema,
  completedAt: isoUtcTimestampSchema.optional(),
  failureCode: literatureParseFailureCodeSchema.optional(),
}).strict().superRefine((run, context) => {
  if (run.status === "READY" && run.completedAt === undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "A ready parse run requires completedAt." });
  }
  if (run.status !== "READY" && run.completedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Only a ready parse run can have completedAt." });
  }
  if (run.status === "FAILED" && run.failureCode === undefined) {
    context.addIssue({ code: "custom", path: ["failureCode"], message: "A failed parse run requires a controlled failure code." });
  }
  if (run.status !== "FAILED" && run.failureCode !== undefined) {
    context.addIssue({ code: "custom", path: ["failureCode"], message: "Only a failed parse run can have a failure code." });
  }
});
export type LiteratureParseRun = z.infer<typeof literatureParseRunSchema>;

export const literaturePageSchema = z.object({
  schemaVersion: z.literal(LITERATURE_PARSER_SCHEMA_VERSION),
  pageId: safeIdentifierSchema,
  parseRunId: safeIdentifierSchema,
  documentId: safeIdentifierSchema,
  versionId: safeIdentifierSchema,
  pageNumber: z.number().int().positive().max(LITERATURE_MAX_PDF_PAGES),
  sourceKind: literatureSourceKindSchema,
  text: codePointStringSchema(LITERATURE_MAX_PAGE_CODE_POINTS),
  codePointCount: z.number().int().nonnegative().max(LITERATURE_MAX_PAGE_CODE_POINTS),
  textSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((page, context) => {
  if (Array.from(page.text).length !== page.codePointCount) {
    context.addIssue({ code: "custom", path: ["codePointCount"], message: "Page code-point count does not match text." });
  }
});
export type LiteraturePage = z.infer<typeof literaturePageSchema>;

export const literatureFragmentSchema = z.object({
  schemaVersion: z.literal(LITERATURE_PARSER_SCHEMA_VERSION),
  fragmentId: safeIdentifierSchema,
  parseRunId: safeIdentifierSchema,
  pageId: safeIdentifierSchema,
  documentId: safeIdentifierSchema,
  versionId: safeIdentifierSchema,
  ordinal: z.number().int().nonnegative().max(LITERATURE_MAX_FRAGMENTS),
  sourceKind: literatureSourceKindSchema,
  location: literatureFragmentLocationSchema,
  text: codePointStringSchema(LITERATURE_FRAGMENT_MAX_CODE_POINTS, 1),
  normalizedText: codePointStringSchema(LITERATURE_FRAGMENT_MAX_CODE_POINTS, 1),
  textSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/u),
}).strict();
export type LiteratureFragment = z.infer<typeof literatureFragmentSchema>;

export const literatureParseRequestSchema = z.object({
  parseRequestId: safeIdentifierSchema,
}).strict();
export type LiteratureParseRequest = z.infer<typeof literatureParseRequestSchema>;

export const literatureSearchRequestSchema = z.object({
  encounterId: safeIdentifierSchema,
  query: codePointStringSchema(LITERATURE_SEARCH_MAX_QUERY_CODE_POINTS, 1),
  documentIds: z.array(safeIdentifierSchema).min(1).max(LITERATURE_SEARCH_MAX_DOCUMENTS),
}).strict().superRefine((request, context) => {
  if (new Set(request.documentIds).size !== request.documentIds.length) {
    context.addIssue({ code: "custom", path: ["documentIds"], message: "A search cannot select a document twice." });
  }
});
export type LiteratureSearchRequest = z.infer<typeof literatureSearchRequestSchema>;

export const literatureCitationDtoSchema = z.object({
  documentId: safeIdentifierSchema,
  versionId: safeIdentifierSchema,
  fragmentId: safeIdentifierSchema,
  displayName: z.string().min(1).max(240),
  version: z.number().int().positive().max(1_000_000),
  location: literatureFragmentLocationSchema,
  excerpt: codePointStringSchema(LITERATURE_CITATION_MAX_EXCERPT_CODE_POINTS, 1),
}).strict();
export type LiteratureCitationDto = z.infer<typeof literatureCitationDtoSchema>;

export const literatureSearchResultSchema = z.object({
  citation: literatureCitationDtoSchema,
  score: z.number().finite().min(0).max(10),
}).strict();
export type LiteratureSearchResult = z.infer<typeof literatureSearchResultSchema>;

export const literatureSearchResponseSchema = z.object({
  status: z.enum(["RESULTS", "INSUFFICIENT_EVIDENCE"]),
  results: z.array(literatureSearchResultSchema).max(LITERATURE_SEARCH_MAX_RESULTS),
}).strict().superRefine((response, context) => {
  if (response.status === "INSUFFICIENT_EVIDENCE" && response.results.length !== 0) {
    context.addIssue({ code: "custom", path: ["results"], message: "Insufficient evidence cannot include results." });
  }
  if (response.status === "RESULTS" && response.results.length === 0) {
    context.addIssue({ code: "custom", path: ["results"], message: "A results response requires at least one result." });
  }
});
export type LiteratureSearchResponse = z.infer<typeof literatureSearchResponseSchema>;

export type LiteraturePageInput = {
  sourceKind: LiteratureSourceKind;
  pageNumber: number;
  text: string;
  title?: string;
};

export type LiteratureChunk = {
  sourceKind: LiteratureSourceKind;
  pageNumber: number;
  startCodePoint: number;
  endCodePoint: number;
  text: string;
  location: LiteratureFragmentLocation;
};

export function normalizeLiteratureNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function normalizeLiteratureSearchText(value: string): string {
  return normalizeLiteratureNewlines(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/[^\p{L}\p{N}\p{Script=Han}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isBoundary(character: string | undefined, next: string | undefined): boolean {
  if (character === "\n") return true;
  if (character === "。" || character === "！" || character === "？" || character === "；") return true;
  if (character === "." || character === "!" || character === "?" || character === ";") {
    return next === undefined || /\s/u.test(next);
  }
  return false;
}

function lineNumberAt(offset: number, starts: readonly number[]): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(1, high + 1);
}

function txtLineStarts(characters: readonly string[]): number[] {
  const starts = [0];
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] === "\n" && index + 1 < characters.length) starts.push(index + 1);
  }
  return starts;
}

function chooseChunkEnd(characters: readonly string[], start: number): number {
  const targetEnd = Math.min(characters.length, start + LITERATURE_FRAGMENT_TARGET_CODE_POINTS);
  const hardEnd = Math.min(characters.length, start + LITERATURE_FRAGMENT_MAX_CODE_POINTS);
  if (targetEnd >= characters.length) return characters.length;

  const minimumEnd = Math.min(targetEnd, start + Math.max(1, Math.floor(LITERATURE_FRAGMENT_TARGET_CODE_POINTS * 0.55)));
  let candidate = -1;
  for (let index = start; index < targetEnd; index += 1) {
    if (isBoundary(characters[index], characters[index + 1]) && index + 1 >= minimumEnd) candidate = index + 1;
  }
  if (candidate > start) return candidate;
  return hardEnd === targetEnd ? targetEnd : targetEnd;
}

export function splitLiteraturePage(input: LiteraturePageInput): LiteratureChunk[] {
  const text = normalizeLiteratureNewlines(input.text);
  const characters = Array.from(text);
  if (characters.length === 0) return [];
  const chunks: LiteratureChunk[] = [];
  const lineStarts = input.sourceKind === "TXT_LINES" ? txtLineStarts(characters) : [];
  let start = 0;
  while (start < characters.length) {
    const end = chooseChunkEnd(characters, start);
    const actualEnd = Math.max(start + 1, end);
    const chunkText = characters.slice(start, actualEnd).join("");
    const location: LiteratureFragmentLocation = input.sourceKind === "PDF_PAGE"
      ? { kind: "PDF_PAGE", pageNumber: input.pageNumber, startCodePoint: start, endCodePoint: actualEnd }
      : {
        kind: "TXT_LINES",
        startLine: lineNumberAt(start, lineStarts),
        endLine: lineNumberAt(Math.max(start, actualEnd - 1), lineStarts),
        ...(input.title === undefined ? {} : { title: input.title }),
      };
    chunks.push({
      sourceKind: input.sourceKind,
      pageNumber: input.pageNumber,
      startCodePoint: start,
      endCodePoint: actualEnd,
      text: chunkText,
      location,
    });
    if (actualEnd >= characters.length) break;
    const overlap = Math.min(LITERATURE_FRAGMENT_MAX_OVERLAP_CODE_POINTS, actualEnd - start - 1);
    start = Math.max(start + 1, actualEnd - overlap);
  }
  return chunks;
}

export function truncateLiteratureExcerpt(value: string): string {
  const characters = Array.from(value);
  return characters.length <= LITERATURE_CITATION_MAX_EXCERPT_CODE_POINTS
    ? value
    : `${characters.slice(0, LITERATURE_CITATION_MAX_EXCERPT_CODE_POINTS).join("")}…`;
}
