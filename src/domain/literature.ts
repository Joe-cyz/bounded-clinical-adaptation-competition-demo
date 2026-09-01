import { z } from "zod";

import { isoUtcTimestampSchema } from "./runtime-records";

export const LITERATURE_SCHEMA_VERSION = "1.0.0" as const;
export const LITERATURE_SOURCE_TYPE = "OWNER_PROVIDED_LOCAL" as const;
export const LITERATURE_PERMISSION_SCOPE = "OWNER_AUTHORIZED_LOCAL_PROTOTYPE" as const;
export const LITERATURE_MAX_FILE_BYTES = 104_857_600;
export const LITERATURE_MAX_BATCH_BYTES = 209_715_200;
export const LITERATURE_MAX_BATCH_FILES = 3;
export const LITERATURE_IMPORT_REQUEST_MAX_BYTES = 16 * 1024;
export const LITERATURE_MAX_FILENAME_UTF8_BYTES = 240;

export const literatureFormatSchema = z.enum(["PDF", "UTF8_TEXT"]);
export type LiteratureFormat = z.infer<typeof literatureFormatSchema>;

export const literatureSourceTypeSchema = z.literal(LITERATURE_SOURCE_TYPE);
export type LiteratureSourceType = z.infer<typeof literatureSourceTypeSchema>;

export const literaturePermissionSchema = z.literal(LITERATURE_PERMISSION_SCOPE);
export type LiteraturePermission = z.infer<typeof literaturePermissionSchema>;

export const literatureDocumentStatusSchema = z.enum(["ACTIVE", "DISABLED"]);
export type LiteratureDocumentStatus = z.infer<typeof literatureDocumentStatusSchema>;

export const literatureImportBatchStatusSchema = z.enum([
  "RESERVED",
  "UPLOADING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type LiteratureImportBatchStatus = z.infer<typeof literatureImportBatchStatusSchema>;

export const literatureImportItemStatusSchema = z.enum([
  "RESERVED",
  "UPLOADING",
  "VALIDATED",
  "AVAILABLE",
  "FAILED",
  "CANCELLED",
]);
export type LiteratureImportItemStatus = z.infer<typeof literatureImportItemStatusSchema>;

export const literatureImportIntentSchema = z.enum(["CREATE_DOCUMENT", "ADD_VERSION"]);
export type LiteratureImportIntent = z.infer<typeof literatureImportIntentSchema>;

const safeServerIdentifierSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const literatureIdentifierSchema = safeServerIdentifierSchema;

const literatureExtensionSchema = z.enum([".pdf", ".txt"]);
const literatureMimeSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:;[A-Za-z0-9!#$%&'*+.^_`|~-]+=[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/u);

const forbiddenFilenameControlPattern = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;
const windowsReservedFilenamePattern = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export function isSafeLiteratureOriginalFilename(value: string): boolean {
  if (value.length === 0 || value.length > 240) return false;
  if (new TextEncoder().encode(value).byteLength > LITERATURE_MAX_FILENAME_UTF8_BYTES) return false;
  if (value === "." || value === ".." || value.includes("..")) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  if (forbiddenFilenameControlPattern.test(value)) return false;
  if (value.endsWith(".") || value.endsWith(" ")) return false;
  if (windowsReservedFilenamePattern.test(value)) return false;
  return value.trim().length > 0;
}

export const literatureOriginalFilenameSchema = z.string()
  .min(1)
  .max(240)
  .refine(isSafeLiteratureOriginalFilename, "Original filename is not a safe basename.");

export const literatureSha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
export const literatureStorageKeySchema = z.string()
  .regex(/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:pdf|txt)$/u)
  .refine((value) => !value.includes("..") && !value.includes("\\") && !value.includes(":"), "Storage key is not controlled.");

export const literatureImportFileRequestSchema = z.object({
  clientFileId: safeServerIdentifierSchema,
  originalFilename: literatureOriginalFilenameSchema,
  declaredExtension: literatureExtensionSchema,
  declaredMime: literatureMimeSchema,
  expectedSizeBytes: z.number().int().min(1).max(LITERATURE_MAX_FILE_BYTES),
  intent: literatureImportIntentSchema,
  documentId: safeServerIdentifierSchema.optional(),
  expectedCurrentVersion: z.number().int().positive().max(1_000_000).optional(),
}).strict().superRefine((file, context) => {
  if (file.intent === "CREATE_DOCUMENT" && (file.documentId !== undefined || file.expectedCurrentVersion !== undefined)) {
    context.addIssue({ code: "custom", path: ["documentId"], message: "CREATE_DOCUMENT cannot bind a document version." });
  }
  if (file.intent === "ADD_VERSION" && (file.documentId === undefined || file.expectedCurrentVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["documentId"], message: "ADD_VERSION requires documentId and expectedCurrentVersion." });
  }
  if (!file.originalFilename.toLowerCase().endsWith(file.declaredExtension)) {
    context.addIssue({ code: "custom", path: ["originalFilename"], message: "Original filename extension must match the declared extension." });
  }
  const extensionFormat = file.declaredExtension === ".pdf" ? "PDF" : "UTF8_TEXT";
  const mime = file.declaredMime.toLowerCase();
  const mimeMatches = extensionFormat === "PDF"
    ? mime === "application/pdf"
    : mime === "text/plain" || mime === "text/plain;charset=utf-8";
  if (!mimeMatches) {
    context.addIssue({ code: "custom", path: ["declaredMime"], message: "Declared MIME does not match the extension." });
  }
});

export type LiteratureImportFileRequest = z.infer<typeof literatureImportFileRequestSchema>;

export const literatureImportBatchCreateRequestSchema = z.object({
  requestId: safeServerIdentifierSchema,
  files: z.array(literatureImportFileRequestSchema).min(1).max(LITERATURE_MAX_BATCH_FILES),
}).strict().superRefine((request, context) => {
  const clientFileIds = new Set<string>();
  const addVersionDocumentIds = new Set<string>();
  let totalBytes = 0;
  for (const [index, file] of request.files.entries()) {
    if (clientFileIds.has(file.clientFileId)) {
      context.addIssue({ code: "custom", path: ["files", index, "clientFileId"], message: "clientFileId must be unique within a batch." });
    }
    clientFileIds.add(file.clientFileId);
    if (file.intent === "ADD_VERSION" && file.documentId !== undefined) {
      if (addVersionDocumentIds.has(file.documentId)) {
        context.addIssue({ code: "custom", path: ["files", index, "documentId"], message: "A batch cannot contain two ADD_VERSION items for the same document." });
      }
      addVersionDocumentIds.add(file.documentId);
    }
    totalBytes += file.expectedSizeBytes;
  }
  if (totalBytes > LITERATURE_MAX_BATCH_BYTES) {
    context.addIssue({ code: "custom", path: ["files"], message: "Batch size exceeds the binary MiB limit." });
  }
});

export type LiteratureImportBatchCreateRequest = z.infer<typeof literatureImportBatchCreateRequestSchema>;

export const literatureImportBatchSchema = z.object({
  schemaVersion: z.literal(LITERATURE_SCHEMA_VERSION),
  batchId: safeServerIdentifierSchema,
  requestId: safeServerIdentifierSchema,
  status: literatureImportBatchStatusSchema,
  expectedFileCount: z.number().int().min(1).max(LITERATURE_MAX_BATCH_FILES),
  expectedTotalBytes: z.number().int().min(1).max(LITERATURE_MAX_BATCH_BYTES),
  receivedFileCount: z.number().int().nonnegative().max(LITERATURE_MAX_BATCH_FILES),
  receivedTotalBytes: z.number().int().nonnegative().max(LITERATURE_MAX_BATCH_BYTES),
  sourceType: literatureSourceTypeSchema,
  permissionScope: literaturePermissionSchema,
  createdAt: isoUtcTimestampSchema,
  updatedAt: isoUtcTimestampSchema,
  completedAt: isoUtcTimestampSchema.optional(),
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u).optional(),
}).strict().superRefine((batch, context) => {
  if (batch.receivedFileCount > batch.expectedFileCount) {
    context.addIssue({ code: "custom", path: ["receivedFileCount"], message: "Received file count exceeds expected count." });
  }
  if (batch.receivedTotalBytes > batch.expectedTotalBytes) {
    context.addIssue({ code: "custom", path: ["receivedTotalBytes"], message: "Received byte count exceeds expected count." });
  }
  if (batch.status === "COMPLETED" && batch.completedAt === undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Completed batch requires completedAt." });
  }
  if (batch.status !== "COMPLETED" && batch.completedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Only completed batch can have completedAt." });
  }
});

export type LiteratureImportBatch = z.infer<typeof literatureImportBatchSchema>;

export const literatureImportItemSchema = z.object({
  schemaVersion: z.literal(LITERATURE_SCHEMA_VERSION),
  itemId: safeServerIdentifierSchema,
  batchId: safeServerIdentifierSchema,
  clientFileId: safeServerIdentifierSchema,
  intent: literatureImportIntentSchema,
  documentId: safeServerIdentifierSchema.optional(),
  expectedCurrentVersion: z.number().int().positive().max(1_000_000).optional(),
  originalFilename: literatureOriginalFilenameSchema,
  declaredExtension: literatureExtensionSchema,
  declaredMime: literatureMimeSchema,
  expectedSizeBytes: z.number().int().min(1).max(LITERATURE_MAX_FILE_BYTES),
  status: literatureImportItemStatusSchema,
  actualSizeBytes: z.number().int().min(1).max(LITERATURE_MAX_FILE_BYTES).optional(),
  actualSha256: literatureSha256Schema.optional(),
  storageKey: literatureStorageKeySchema.optional(),
  detectedFormat: literatureFormatSchema.optional(),
  detectedMime: literatureMimeSchema.optional(),
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u).optional(),
  createdAt: isoUtcTimestampSchema,
  updatedAt: isoUtcTimestampSchema,
  completedAt: isoUtcTimestampSchema.optional(),
}).strict().superRefine((item, context) => {
  if (item.intent === "CREATE_DOCUMENT" && (item.documentId !== undefined || item.expectedCurrentVersion !== undefined)) {
    context.addIssue({ code: "custom", path: ["documentId"], message: "CREATE_DOCUMENT cannot bind a document version." });
  }
  if (item.intent === "ADD_VERSION" && (item.documentId === undefined || item.expectedCurrentVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["documentId"], message: "ADD_VERSION requires documentId and expectedCurrentVersion." });
  }
  const hasStorageMetadata = item.actualSizeBytes !== undefined
    && item.actualSha256 !== undefined
    && item.storageKey !== undefined
    && item.detectedFormat !== undefined
    && item.detectedMime !== undefined;
  if (item.status === "VALIDATED" && (!hasStorageMetadata || item.completedAt !== undefined)) {
    context.addIssue({ code: "custom", path: ["status"], message: "VALIDATED item requires promoted storage metadata and no completion timestamp." });
  }
  if (item.status === "AVAILABLE" && (!hasStorageMetadata || item.completedAt === undefined)) {
    context.addIssue({ code: "custom", path: ["status"], message: "AVAILABLE item requires finalized storage metadata." });
  }
  if (["RESERVED", "UPLOADING", "FAILED", "CANCELLED"].includes(item.status) && item.completedAt !== undefined) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Only AVAILABLE item can have completedAt." });
  }
  if (["RESERVED", "UPLOADING"].includes(item.status)
    && (item.actualSizeBytes !== undefined || item.actualSha256 !== undefined || item.storageKey !== undefined
      || item.detectedFormat !== undefined || item.detectedMime !== undefined)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Reserved or uploading item cannot expose finalized storage metadata." });
  }
});

export type LiteratureImportItem = z.infer<typeof literatureImportItemSchema>;

export const literatureDocumentSchema = z.object({
  schemaVersion: z.literal(LITERATURE_SCHEMA_VERSION),
  documentId: safeServerIdentifierSchema,
  status: literatureDocumentStatusSchema,
  displayName: literatureOriginalFilenameSchema,
  currentVersion: z.number().int().positive(),
  currentVersionId: safeServerIdentifierSchema,
  sourceType: literatureSourceTypeSchema,
  permissionScope: literaturePermissionSchema,
  createdAt: isoUtcTimestampSchema,
  updatedAt: isoUtcTimestampSchema,
  disabledAt: isoUtcTimestampSchema.optional(),
}).strict().superRefine((document, context) => {
  if (document.status === "DISABLED" && document.disabledAt === undefined) {
    context.addIssue({ code: "custom", path: ["disabledAt"], message: "Disabled document requires disabledAt." });
  }
  if (document.status === "ACTIVE" && document.disabledAt !== undefined) {
    context.addIssue({ code: "custom", path: ["disabledAt"], message: "Active document cannot have disabledAt." });
  }
});

export type LiteratureDocument = z.infer<typeof literatureDocumentSchema>;

export const literatureDocumentVersionSchema = z.object({
  schemaVersion: z.literal(LITERATURE_SCHEMA_VERSION),
  versionId: safeServerIdentifierSchema,
  documentId: safeServerIdentifierSchema,
  versionNumber: z.number().int().positive().max(1_000_000),
  format: literatureFormatSchema,
  originalFilename: literatureOriginalFilenameSchema,
  declaredMime: literatureMimeSchema,
  detectedMime: literatureMimeSchema,
  sizeBytes: z.number().int().min(1).max(LITERATURE_MAX_FILE_BYTES),
  sha256: literatureSha256Schema,
  storageKey: literatureStorageKeySchema,
  importBatchId: safeServerIdentifierSchema,
  importItemId: safeServerIdentifierSchema,
  createdAt: isoUtcTimestampSchema,
}).strict();

export type LiteratureDocumentVersion = z.infer<typeof literatureDocumentVersionSchema>;

export function literatureFormatForExtension(extension: ".pdf" | ".txt"): LiteratureFormat {
  return extension === ".pdf" ? "PDF" : "UTF8_TEXT";
}

export function literatureMimeForFormat(format: LiteratureFormat): string {
  return format === "PDF" ? "application/pdf" : "text/plain";
}
