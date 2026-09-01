import type { DatabaseSync } from "node:sqlite";

import {
  literatureDocumentSchema,
  literatureDocumentVersionSchema,
  literatureImportBatchSchema,
  literatureImportItemSchema,
  type LiteratureDocument,
  type LiteratureDocumentVersion,
  type LiteratureImportBatch,
  type LiteratureImportItem,
} from "@/domain/literature";
import { validateRuntimeRecord } from "../record-validation";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import {
  databaseWriteError,
  isSqliteConstraintError,
  optionalRowString,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export type StoredLiteratureBatch = {
  batch: LiteratureImportBatch;
  requestFingerprint: string;
  items: LiteratureImportItem[];
};

export type LiteratureRepository = {
  insertBatch(batch: LiteratureImportBatch, requestFingerprint: string): void;
  insertItem(item: LiteratureImportItem): void;
  getBatchById(batchId: string): StoredLiteratureBatch | undefined;
  getBatchByRequestId(requestId: string): StoredLiteratureBatch | undefined;
  getItemById(itemId: string): LiteratureImportItem | undefined;
  updateBatchStatus(batchId: string, status: LiteratureImportBatch["status"], updatedAt: string, completedAt?: string, failureCode?: string): void;
  claimItemForUpload(itemId: string, updatedAt: string): LiteratureImportItem;
  markItemValidated(itemId: string, sizeBytes: number, sha256: string, storageKey: string, detectedFormat: LiteratureDocumentVersion["format"], detectedMime: string, updatedAt: string): void;
  markItemAvailable(itemId: string, completedAt: string): void;
  markItemFailed(itemId: string, failureCode: string, updatedAt: string): void;
  markItemCancelled(itemId: string, updatedAt: string): void;
  recalculateBatchReceived(batchId: string, updatedAt: string): void;
  findVersionBySha256(sha256: string): LiteratureDocumentVersion | undefined;
  findVersionByStorageKey(storageKey: string): LiteratureDocumentVersion | undefined;
  getVersionById(versionId: string): LiteratureDocumentVersion | undefined;
  findValidatedItemBySha256(sha256: string): LiteratureImportItem | undefined;
  getDocumentById(documentId: string): LiteratureDocument | undefined;
  insertDocument(document: LiteratureDocument): void;
  insertVersion(version: LiteratureDocumentVersion): void;
  advanceDocumentVersion(documentId: string, expectedCurrentVersion: number, nextVersion: number, versionId: string, updatedAt: string): void;
  listActiveUploadingOrValidatedItemIds(): string[];
  listActiveUploadingOrValidatedItems(): LiteratureImportItem[];
  listReferencedStorageKeys(): string[];
  listAvailableCurrentDocumentIds(): string[];
  getAvailableVersion(documentId: string, versionNumber?: number): LiteratureDocumentVersion | undefined;
};

function optionalRowInteger(row: SqliteRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Stored literature record has an invalid integer field.",
      { fieldPath: column },
    );
  }
  return value;
}

function parseOptionalString(row: SqliteRow, column: string): string | undefined {
  return optionalRowString(row, column);
}

function rowToBatch(row: SqliteRow): LiteratureImportBatch {
  return validateRuntimeRecord(literatureImportBatchSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    batchId: requiredRowString(row, "batch_id"),
    requestId: requiredRowString(row, "request_id"),
    status: requiredRowString(row, "status"),
    expectedFileCount: requiredRowInteger(row, "expected_file_count"),
    expectedTotalBytes: requiredRowInteger(row, "expected_total_bytes"),
    receivedFileCount: requiredRowInteger(row, "received_file_count"),
    receivedTotalBytes: requiredRowInteger(row, "received_total_bytes"),
    sourceType: requiredRowString(row, "source_type"),
    permissionScope: requiredRowString(row, "permission_scope"),
    createdAt: requiredRowString(row, "created_at"),
    updatedAt: requiredRowString(row, "updated_at"),
    ...(parseOptionalString(row, "completed_at") ? { completedAt: requiredRowString(row, "completed_at") } : {}),
    ...(parseOptionalString(row, "failure_code") ? { failureCode: requiredRowString(row, "failure_code") } : {}),
  });
}

function rowToItem(row: SqliteRow): LiteratureImportItem {
  const documentId = parseOptionalString(row, "document_id");
  const expectedCurrentVersion = optionalRowInteger(row, "expected_current_version");
  const actualSizeBytes = optionalRowInteger(row, "actual_size_bytes");
  const actualSha256 = parseOptionalString(row, "actual_sha256");
  const storageKey = parseOptionalString(row, "storage_key");
  const detectedFormat = parseOptionalString(row, "detected_format");
  const detectedMime = parseOptionalString(row, "detected_mime");
  const failureCode = parseOptionalString(row, "failure_code");
  const completedAt = parseOptionalString(row, "completed_at");
  return validateRuntimeRecord(literatureImportItemSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    itemId: requiredRowString(row, "item_id"),
    batchId: requiredRowString(row, "batch_id"),
    clientFileId: requiredRowString(row, "client_file_id"),
    intent: requiredRowString(row, "intent"),
    ...(documentId ? { documentId } : {}),
    ...(expectedCurrentVersion === undefined ? {} : { expectedCurrentVersion }),
    originalFilename: requiredRowString(row, "original_filename"),
    declaredExtension: requiredRowString(row, "declared_extension"),
    declaredMime: requiredRowString(row, "declared_mime"),
    expectedSizeBytes: requiredRowInteger(row, "expected_size_bytes"),
    status: requiredRowString(row, "status"),
    ...(actualSizeBytes === undefined ? {} : { actualSizeBytes }),
    ...(actualSha256 ? { actualSha256 } : {}),
    ...(storageKey ? { storageKey } : {}),
    ...(detectedFormat ? { detectedFormat } : {}),
    ...(detectedMime ? { detectedMime } : {}),
    ...(failureCode ? { failureCode } : {}),
    createdAt: requiredRowString(row, "created_at"),
    updatedAt: requiredRowString(row, "updated_at"),
    ...(completedAt ? { completedAt } : {}),
  });
}

function rowToDocument(row: SqliteRow): LiteratureDocument {
  const disabledAt = parseOptionalString(row, "disabled_at");
  return validateRuntimeRecord(literatureDocumentSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    documentId: requiredRowString(row, "document_id"),
    status: requiredRowString(row, "status"),
    displayName: requiredRowString(row, "display_name"),
    currentVersion: requiredRowInteger(row, "current_version"),
    currentVersionId: requiredRowString(row, "current_version_id"),
    sourceType: requiredRowString(row, "source_type"),
    permissionScope: requiredRowString(row, "permission_scope"),
    createdAt: requiredRowString(row, "created_at"),
    updatedAt: requiredRowString(row, "updated_at"),
    ...(disabledAt ? { disabledAt } : {}),
  });
}

function rowToVersion(row: SqliteRow): LiteratureDocumentVersion {
  return validateRuntimeRecord(literatureDocumentVersionSchema, {
    schemaVersion: requiredRowString(row, "schema_version"),
    versionId: requiredRowString(row, "version_id"),
    documentId: requiredRowString(row, "document_id"),
    versionNumber: requiredRowInteger(row, "version_number"),
    format: requiredRowString(row, "format"),
    originalFilename: requiredRowString(row, "original_filename"),
    declaredMime: requiredRowString(row, "declared_mime"),
    detectedMime: requiredRowString(row, "detected_mime"),
    sizeBytes: requiredRowInteger(row, "size_bytes"),
    sha256: requiredRowString(row, "sha256"),
    storageKey: requiredRowString(row, "storage_key"),
    importBatchId: requiredRowString(row, "import_batch_id"),
    importItemId: requiredRowString(row, "import_item_id"),
    createdAt: requiredRowString(row, "created_at"),
  });
}

function constraintError(message: string): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.CONFLICT, message);
}

export function createLiteratureRepository(database: DatabaseSync): LiteratureRepository {
  const insertBatchStatement = database.prepare(`
    INSERT INTO literature_import_batches (
      batch_id, schema_version, request_id, request_fingerprint, status,
      expected_file_count, expected_total_bytes, received_file_count, received_total_bytes,
      source_type, permission_scope, created_at, updated_at, completed_at, failure_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItemStatement = database.prepare(`
    INSERT INTO literature_import_items (
      item_id, batch_id, schema_version, client_file_id, intent, document_id,
      expected_current_version, original_filename, declared_extension, declared_mime,
      expected_size_bytes, status, actual_size_bytes, actual_sha256, storage_key, detected_format, detected_mime,
      failure_code, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectBatch = database.prepare("SELECT * FROM literature_import_batches WHERE batch_id = ?");
  const selectBatchByRequest = database.prepare("SELECT * FROM literature_import_batches WHERE request_id = ?");
  const selectItems = database.prepare("SELECT * FROM literature_import_items WHERE batch_id = ? ORDER BY created_at ASC, item_id ASC");
  const selectItem = database.prepare("SELECT * FROM literature_import_items WHERE item_id = ?");
  const selectVersionBySha = database.prepare("SELECT * FROM literature_document_versions WHERE sha256 = ?");
  const selectVersionByStorage = database.prepare("SELECT * FROM literature_document_versions WHERE storage_key = ?");
  const selectVersionById = database.prepare("SELECT * FROM literature_document_versions WHERE version_id = ?");
  const selectValidatedItemBySha = database.prepare("SELECT * FROM literature_import_items WHERE actual_sha256 = ? AND status IN ('VALIDATED', 'AVAILABLE') LIMIT 1");
  const selectDocument = database.prepare("SELECT * FROM literature_documents WHERE document_id = ?");
  const selectAvailableVersion = database.prepare(`
    SELECT v.* FROM literature_document_versions v
    INNER JOIN literature_documents d ON d.document_id = v.document_id
    INNER JOIN literature_import_items i ON i.item_id = v.import_item_id
    INNER JOIN literature_import_batches b ON b.batch_id = v.import_batch_id AND b.batch_id = i.batch_id
    WHERE v.document_id = ? AND d.status = 'ACTIVE' AND i.status = 'AVAILABLE' AND b.status = 'COMPLETED'
      AND (? IS NULL OR v.version_number = ?)
    ORDER BY v.version_number DESC
    LIMIT 1
  `);
  const selectAvailableCurrentDocumentIds = database.prepare(`
    SELECT d.document_id
    FROM literature_documents d
    INNER JOIN literature_document_versions v
      ON v.version_id = d.current_version_id
      AND v.document_id = d.document_id
      AND v.version_number = d.current_version
    INNER JOIN literature_import_items i
      ON i.item_id = v.import_item_id
      AND i.batch_id = v.import_batch_id
    INNER JOIN literature_import_batches b
      ON b.batch_id = v.import_batch_id
    WHERE d.status = 'ACTIVE'
      AND i.status = 'AVAILABLE'
      AND b.status = 'COMPLETED'
    ORDER BY d.created_at ASC, d.document_id ASC
  `);

  return {
    insertBatch(batch, requestFingerprint) {
      try {
        const validated = validateRuntimeRecord(literatureImportBatchSchema, batch);
        insertBatchStatement.run(
          validated.batchId,
          validated.schemaVersion,
          validated.requestId,
          requestFingerprint,
          validated.status,
          validated.expectedFileCount,
          validated.expectedTotalBytes,
          validated.receivedFileCount,
          validated.receivedTotalBytes,
          validated.sourceType,
          validated.permissionScope,
          validated.createdAt,
          validated.updatedAt,
          validated.completedAt ?? null,
          validated.failureCode ?? null,
        );
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        if (isSqliteConstraintError(error)) throw constraintError("Literature import batch already exists or violates its constraints.");
        throw databaseWriteError();
      }
    },

    insertItem(item) {
      try {
        const validated = validateRuntimeRecord(literatureImportItemSchema, item);
        insertItemStatement.run(
          validated.itemId,
          validated.batchId,
          validated.schemaVersion,
          validated.clientFileId,
          validated.intent,
          validated.documentId ?? null,
          validated.expectedCurrentVersion ?? null,
          validated.originalFilename,
          validated.declaredExtension,
          validated.declaredMime,
          validated.expectedSizeBytes,
          validated.status,
          validated.actualSizeBytes ?? null,
          validated.actualSha256 ?? null,
          validated.storageKey ?? null,
          validated.detectedFormat ?? null,
          validated.detectedMime ?? null,
          validated.failureCode ?? null,
          validated.createdAt,
          validated.updatedAt,
          validated.completedAt ?? null,
        );
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        if (isSqliteConstraintError(error)) throw constraintError("Literature import item already exists or violates its constraints.");
        throw databaseWriteError();
      }
    },

    getBatchById(batchId) {
      const row = selectBatch.get(batchId) as SqliteRow | undefined;
      if (!row) return undefined;
      const batch = rowToBatch(row);
      const requestFingerprint = requiredRowString(row, "request_fingerprint");
      const items = (selectItems.all(batch.batchId) as SqliteRow[]).map(rowToItem);
      return { batch, requestFingerprint, items };
    },

    getBatchByRequestId(requestId) {
      const row = selectBatchByRequest.get(requestId) as SqliteRow | undefined;
      if (!row) return undefined;
      const batch = rowToBatch(row);
      const requestFingerprint = requiredRowString(row, "request_fingerprint");
      const items = (selectItems.all(batch.batchId) as SqliteRow[]).map(rowToItem);
      return { batch, requestFingerprint, items };
    },

    getItemById(itemId) {
      const row = selectItem.get(itemId) as SqliteRow | undefined;
      return row ? rowToItem(row) : undefined;
    },

    updateBatchStatus(batchId, status, updatedAt, completedAt, failureCode) {
      const result = database.prepare(`
        UPDATE literature_import_batches
        SET status = ?, updated_at = ?, completed_at = ?, failure_code = ?
        WHERE batch_id = ?
      `).run(status, updatedAt, completedAt ?? null, failureCode ?? null, batchId);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature import batch was not found.");
    },

    claimItemForUpload(itemId, updatedAt) {
      const current = this.getItemById(itemId);
      if (!current) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature import item was not found.");
      if (current.status === "AVAILABLE") throw new PersistenceError(persistenceErrorCodes.LITERATURE_REPLAYED, "Literature import item was already completed.");
      if (current.status !== "RESERVED") throw new PersistenceError(persistenceErrorCodes.LITERATURE_BATCH_CONFLICT, "Literature import item is not available for upload.");
      const result = database.prepare(`
        UPDATE literature_import_items SET status = 'UPLOADING', updated_at = ?
        WHERE item_id = ? AND status = 'RESERVED'
      `).run(updatedAt, itemId);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.LITERATURE_BATCH_CONFLICT, "Literature import item is already being processed.");
      return { ...current, status: "UPLOADING" as const, updatedAt };
    },

    markItemValidated(itemId, sizeBytes, sha256, storageKey, detectedFormat, detectedMime, updatedAt) {
      const result = database.prepare(`
        UPDATE literature_import_items
        SET status = 'VALIDATED', actual_size_bytes = ?, actual_sha256 = ?, storage_key = ?, detected_format = ?, detected_mime = ?, updated_at = ?, failure_code = NULL
        WHERE item_id = ? AND status = 'UPLOADING'
      `).run(sizeBytes, sha256, storageKey, detectedFormat, detectedMime, updatedAt, itemId);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.LITERATURE_BATCH_CONFLICT, "Literature import item is not in the upload state.");
    },

    markItemAvailable(itemId, completedAt) {
      const result = database.prepare(`
        UPDATE literature_import_items
        SET status = 'AVAILABLE', completed_at = ?, updated_at = ?, failure_code = NULL
        WHERE item_id = ? AND status = 'VALIDATED'
      `).run(completedAt, completedAt, itemId);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.LITERATURE_BATCH_CONFLICT, "Literature import item is not validated.");
    },

    markItemFailed(itemId, failureCode, updatedAt) {
      const result = database.prepare(`
        UPDATE literature_import_items
        SET status = 'FAILED', failure_code = ?, updated_at = ?, completed_at = NULL
        WHERE item_id = ? AND status IN ('RESERVED', 'UPLOADING', 'VALIDATED', 'AVAILABLE')
      `).run(failureCode, updatedAt, itemId);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.LITERATURE_BATCH_CONFLICT, "Literature import item cannot be marked failed.");
    },

    markItemCancelled(itemId, updatedAt) {
      const result = database.prepare(`
        UPDATE literature_import_items
        SET status = 'CANCELLED', updated_at = ?, completed_at = NULL
        WHERE item_id = ? AND status IN ('RESERVED', 'UPLOADING', 'VALIDATED', 'AVAILABLE')
      `).run(updatedAt, itemId);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.LITERATURE_BATCH_CONFLICT, "Literature import item cannot be cancelled.");
    },

    recalculateBatchReceived(batchId, updatedAt) {
      const result = database.prepare(`
        UPDATE literature_import_batches
        SET received_file_count = (SELECT COUNT(*) FROM literature_import_items WHERE batch_id = ? AND status = 'AVAILABLE'),
            received_total_bytes = COALESCE((SELECT SUM(actual_size_bytes) FROM literature_import_items WHERE batch_id = ? AND status = 'AVAILABLE'), 0),
            status = CASE WHEN EXISTS (SELECT 1 FROM literature_import_items WHERE batch_id = ? AND status = 'AVAILABLE') THEN 'UPLOADING' ELSE status END,
            updated_at = ?
        WHERE batch_id = ?
      `).run(batchId, batchId, batchId, updatedAt, batchId);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature import batch was not found.");
    },

    findVersionBySha256(sha256) {
      const row = selectVersionBySha.get(sha256) as SqliteRow | undefined;
      return row ? rowToVersion(row) : undefined;
    },

    findVersionByStorageKey(storageKey) {
      const row = selectVersionByStorage.get(storageKey) as SqliteRow | undefined;
      return row ? rowToVersion(row) : undefined;
    },

    getVersionById(versionId) {
      const row = selectVersionById.get(versionId) as SqliteRow | undefined;
      return row ? rowToVersion(row) : undefined;
    },

    findValidatedItemBySha256(sha256) {
      const row = selectValidatedItemBySha.get(sha256) as SqliteRow | undefined;
      return row ? rowToItem(row) : undefined;
    },

    getDocumentById(documentId) {
      const row = selectDocument.get(documentId) as SqliteRow | undefined;
      return row ? rowToDocument(row) : undefined;
    },

    insertDocument(document) {
      const validated = validateRuntimeRecord(literatureDocumentSchema, document);
      try {
        database.prepare(`
          INSERT INTO literature_documents (
            document_id, schema_version, status, display_name, current_version, current_version_id,
            source_type, permission_scope, created_at, updated_at, disabled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          validated.documentId,
          validated.schemaVersion,
          validated.status,
          validated.displayName,
          validated.currentVersion,
          validated.currentVersionId,
          validated.sourceType,
          validated.permissionScope,
          validated.createdAt,
          validated.updatedAt,
          validated.disabledAt ?? null,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) throw constraintError("Literature document already exists or violates its constraints.");
        throw databaseWriteError();
      }
    },

    insertVersion(version) {
      const validated = validateRuntimeRecord(literatureDocumentVersionSchema, version);
      try {
        database.prepare(`
          INSERT INTO literature_document_versions (
            version_id, document_id, version_number, schema_version, format, original_filename,
            declared_mime, detected_mime, size_bytes, sha256, storage_key, import_batch_id,
            import_item_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          validated.versionId,
          validated.documentId,
          validated.versionNumber,
          validated.schemaVersion,
          validated.format,
          validated.originalFilename,
          validated.declaredMime,
          validated.detectedMime,
          validated.sizeBytes,
          validated.sha256,
          validated.storageKey,
          validated.importBatchId,
          validated.importItemId,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) throw constraintError("Literature document version already exists or violates its constraints.");
        throw databaseWriteError();
      }
    },

    advanceDocumentVersion(documentId, expectedCurrentVersion, nextVersion, versionId, updatedAt) {
      const result = database.prepare(`
        UPDATE literature_documents
        SET current_version = ?, current_version_id = ?, updated_at = ?
        WHERE document_id = ? AND status = 'ACTIVE' AND current_version = ?
      `).run(nextVersion, versionId, updatedAt, documentId, expectedCurrentVersion);
      if (Number(result.changes) !== 1) throw new PersistenceError(persistenceErrorCodes.LITERATURE_VERSION_CONFLICT, "Literature document version is stale.");
    },

    listActiveUploadingOrValidatedItemIds() {
      return (database.prepare(
        "SELECT item_id FROM literature_import_items WHERE status IN ('UPLOADING', 'VALIDATED') ORDER BY item_id",
      ).all() as SqliteRow[]).map((row) => requiredRowString(row, "item_id"));
    },

    listActiveUploadingOrValidatedItems() {
      return (database.prepare(
        "SELECT * FROM literature_import_items WHERE status IN ('UPLOADING', 'VALIDATED') ORDER BY item_id",
      ).all() as SqliteRow[]).map(rowToItem);
    },

    listReferencedStorageKeys() {
      return (database.prepare(
        `SELECT v.storage_key FROM literature_document_versions v
         INNER JOIN literature_import_batches b ON b.batch_id = v.import_batch_id AND b.status = 'COMPLETED'
         UNION
         SELECT i.storage_key FROM literature_import_items i
         INNER JOIN literature_import_batches b ON b.batch_id = i.batch_id
         WHERE i.storage_key IS NOT NULL
           AND (i.status = 'VALIDATED' OR (i.status = 'AVAILABLE' AND b.status = 'COMPLETED'))
         ORDER BY storage_key`,
      ).all() as SqliteRow[]).map((row) => requiredRowString(row, "storage_key"));
    },

    listAvailableCurrentDocumentIds() {
      return (selectAvailableCurrentDocumentIds.all() as SqliteRow[])
        .map((row) => requiredRowString(row, "document_id"));
    },

    getAvailableVersion(documentId, versionNumber) {
      const selectedVersion = versionNumber ?? null;
      const row = selectAvailableVersion.get(documentId, selectedVersion, selectedVersion) as SqliteRow | undefined;
      return row ? rowToVersion(row) : undefined;
    },
  };
}
