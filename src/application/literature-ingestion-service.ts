import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";

import {
  LITERATURE_PERMISSION_SCOPE,
  LITERATURE_SCHEMA_VERSION,
  LITERATURE_SOURCE_TYPE,
  literatureDocumentSchema,
  literatureDocumentVersionSchema,
  literatureImportBatchCreateRequestSchema,
  literatureImportBatchSchema,
  literatureImportItemSchema,
  literatureIdentifierSchema,
  type LiteratureDocument,
  type LiteratureDocumentVersion,
  type LiteratureImportBatch,
  type LiteratureImportBatchCreateRequest,
  type LiteratureImportItem,
} from "@/domain/literature";
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";
import { type AuditEventRecord } from "@/domain/runtime-records";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import { getDatabase } from "@/server/database";
import { readLiteratureRuntimePaths } from "@/server/literature-runtime-config";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createLiteratureRepository, type LiteratureRepository } from "@/infrastructure/sqlite/repositories/literature-repository";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { stableJsonStringify, validateRuntimeRecord } from "@/infrastructure/sqlite/record-validation";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import {
  createLocalLiteratureFileStorage,
  type LiteratureFileStorage,
  type LiteraturePromotedObject,
} from "@/infrastructure/literature/literature-file-storage";
import {
  defaultLiteratureOperationCoordinator,
  type LiteratureOperationCoordinator,
} from "@/infrastructure/literature/literature-operation-coordinator";
import { literatureError, literatureErrorCodes } from "@/infrastructure/literature/literature-errors";
import { createRandomSystemId } from "./system-id";

export type LiteratureIdKind = "BATCH" | "ITEM" | "DOCUMENT" | "VERSION" | "AUDIT";
export type LiteratureIdFactory = (kind: LiteratureIdKind) => string;
export type LiteratureClock = () => string;

export type LiteratureIngestionDependencies = {
  databaseFactory?: () => DatabaseSync;
  storageFactory?: () => LiteratureFileStorage;
  runtimeMode?: AppRuntimeMode;
  env?: NodeJS.ProcessEnv;
  clock?: LiteratureClock;
  idFactory?: LiteratureIdFactory;
  actorId?: string;
  simulatedRole?: AuditEventRecord["simulatedRole"];
  coordinator?: LiteratureOperationCoordinator;
};

export type LiteratureBatchCreationResult = {
  batch: LiteratureImportBatch;
  items: LiteratureImportItem[];
  idempotencyResult: "CREATED" | "REPLAYED";
};

export type LiteratureUploadResult = {
  batch: LiteratureImportBatch;
  item: LiteratureImportItem;
};

export type LiteratureReconciliationResult = {
  removedStagingFiles: number;
  removedOrphanObjects: number;
  checkedAvailableObjects: number;
  retainedCandidates: number;
};

const defaultClock: LiteratureClock = () => new Date().toISOString();
const defaultIdFactory: LiteratureIdFactory = (kind) => createRandomSystemId(`literature-${kind.toLowerCase()}`);

function trustedLocalResearchMode(dependencies: LiteratureIngestionDependencies): AppRuntimeMode {
  const mode = dependencies.runtimeMode;
  if (mode !== undefined) {
    const parsed = appRuntimeModeSchema.safeParse(mode);
    if (!parsed.success) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
    if (parsed.data === "public-demo") {
      throw new PersistenceError(persistenceErrorCodes.RUNTIME_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE, { ruleId: PUBLIC_DEMO_READ_ONLY });
    }
    return parsed.data;
  }
  const gate = assertRuntimeWriteAllowed(dependencies.env);
  if (!gate.ok) {
    throw new PersistenceError(persistenceErrorCodes.RUNTIME_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE, { ruleId: PUBLIC_DEMO_READ_ONLY });
  }
  return gate.runtimeMode;
}

function nowIso(clock: LiteratureClock): string {
  const value = clock();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
  return value;
}

function requestFingerprint(request: LiteratureImportBatchCreateRequest): string {
  return createHash("sha256").update(stableJsonStringify(request), "utf8").digest("hex");
}

type PersistenceErrorCodeLike = (typeof literatureErrorCodes)[keyof typeof literatureErrorCodes];

function errorCodeOf(error: unknown, fallback: PersistenceErrorCodeLike): PersistenceErrorCodeLike {
  if (error instanceof PersistenceError && error.code.startsWith("LITERATURE_")) return error.code as PersistenceErrorCodeLike;
  return fallback;
}

function validateRequest(value: unknown): LiteratureImportBatchCreateRequest {
  const parsed = literatureImportBatchCreateRequestSchema.safeParse(value);
  if (!parsed.success) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
  return parsed.data;
}

function validateId(value: string): void {
  if (!literatureIdentifierSchema.safeParse(value).success) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
}

function auditEvent(
  dependencies: LiteratureIngestionDependencies,
  kind: LiteratureIdKind,
  eventType: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
  createdAt: string,
): AuditEventRecord {
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  return {
    schemaVersion: "1.0.0",
    id: idFactory(kind),
    eventType,
    actorId: dependencies.actorId ?? "literature-ingestion-service",
    simulatedRole: dependencies.simulatedRole ?? "SYSTEM",
    entityType,
    entityId,
    metadata: metadata as AuditEventRecord["metadata"],
    createdAt,
  };
}

function makeBatch(request: LiteratureImportBatchCreateRequest, createdAt: string, idFactory: LiteratureIdFactory): LiteratureImportBatch {
  return validateRuntimeRecord(literatureImportBatchSchema, {
    schemaVersion: LITERATURE_SCHEMA_VERSION,
    batchId: idFactory("BATCH"),
    requestId: request.requestId,
    status: "RESERVED",
    expectedFileCount: request.files.length,
    expectedTotalBytes: request.files.reduce((total, file) => total + file.expectedSizeBytes, 0),
    receivedFileCount: 0,
    receivedTotalBytes: 0,
    sourceType: LITERATURE_SOURCE_TYPE,
    permissionScope: LITERATURE_PERMISSION_SCOPE,
    createdAt,
    updatedAt: createdAt,
  });
}

function makeItem(
  batch: LiteratureImportBatch,
  input: LiteratureImportBatchCreateRequest["files"][number],
  createdAt: string,
  idFactory: LiteratureIdFactory,
): LiteratureImportItem {
  return validateRuntimeRecord(literatureImportItemSchema, {
    schemaVersion: LITERATURE_SCHEMA_VERSION,
    itemId: idFactory("ITEM"),
    batchId: batch.batchId,
    clientFileId: input.clientFileId,
    intent: input.intent,
    ...(input.documentId ? { documentId: input.documentId } : {}),
    ...(input.expectedCurrentVersion === undefined ? {} : { expectedCurrentVersion: input.expectedCurrentVersion }),
    originalFilename: input.originalFilename,
    declaredExtension: input.declaredExtension,
    declaredMime: input.declaredMime,
    expectedSizeBytes: input.expectedSizeBytes,
    status: "RESERVED",
    createdAt,
    updatedAt: createdAt,
  });
}

function validatedMetadata(item: LiteratureImportItem): {
  format: LiteratureDocumentVersion["format"];
  detectedMime: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
} {
  if (item.actualSizeBytes === undefined || item.actualSha256 === undefined || item.storageKey === undefined
    || item.detectedFormat === undefined || item.detectedMime === undefined) {
    throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Literature import item metadata is incomplete.");
  }
  return {
    format: item.detectedFormat,
    detectedMime: item.detectedMime,
    sizeBytes: item.actualSizeBytes,
    sha256: item.actualSha256,
    storageKey: item.storageKey,
  };
}

function makeVersion(item: LiteratureImportItem, versionId: string, documentId: string, versionNumber: number, createdAt: string): LiteratureDocumentVersion {
  const metadata = validatedMetadata(item);
  return validateRuntimeRecord(literatureDocumentVersionSchema, {
    schemaVersion: LITERATURE_SCHEMA_VERSION,
    versionId,
    documentId,
    versionNumber,
    format: metadata.format,
    originalFilename: item.originalFilename,
    declaredMime: item.declaredMime,
    detectedMime: metadata.detectedMime,
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    storageKey: metadata.storageKey,
    importBatchId: item.batchId,
    importItemId: item.itemId,
    createdAt,
  });
}

function makeDocument(item: LiteratureImportItem, documentId: string, versionId: string, createdAt: string): LiteratureDocument {
  return validateRuntimeRecord(literatureDocumentSchema, {
    schemaVersion: LITERATURE_SCHEMA_VERSION,
    documentId,
    status: "ACTIVE",
    displayName: item.originalFilename,
    currentVersion: 1,
    currentVersionId: versionId,
    sourceType: LITERATURE_SOURCE_TYPE,
    permissionScope: LITERATURE_PERMISSION_SCOPE,
    createdAt,
    updatedAt: createdAt,
  });
}

function normalizeContentType(value: string): string {
  return value.trim().toLowerCase().replace(/\s*;\s*/gu, ";").replace(/\s*=\s*/gu, "=");
}

export function createLiteratureIngestionService(dependencies: LiteratureIngestionDependencies = {}) {
  const databaseFactory = dependencies.databaseFactory ?? getDatabase;
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const coordinator = dependencies.coordinator ?? defaultLiteratureOperationCoordinator;

  function getStorage(): LiteratureFileStorage {
    if (dependencies.storageFactory) return dependencies.storageFactory();
    const configuredRoot = readLiteratureRuntimePaths(dependencies.env).storageRoot;
    return createLocalLiteratureFileStorage(configuredRoot);
  }

  async function withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await coordinator.enterMutation();
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  function markBatchFailed(database: DatabaseSync, repository: LiteratureRepository, batchId: string, code: PersistenceErrorCodeLike, at: string): void {
    withTransaction(database, () => {
      const stored = repository.getBatchById(batchId);
      if (!stored || stored.batch.status === "COMPLETED" || stored.batch.status === "CANCELLED") return;
      for (const item of stored.items) {
        if (["RESERVED", "UPLOADING", "VALIDATED", "AVAILABLE"].includes(item.status)) repository.markItemFailed(item.itemId, code, at);
      }
      const shouldAudit = stored.batch.status !== "FAILED";
      repository.updateBatchStatus(batchId, "FAILED", at, undefined, code);
      if (shouldAudit) {
        createAuditEventRepository(database).append(auditEvent(
          dependencies,
          "AUDIT",
          "LITERATURE_IMPORT_FAILED",
          "LITERATURE_IMPORT_BATCH",
          batchId,
          { batchId, status: "FAILED", failureCode: code },
          at,
        ));
      }
    });
  }

  async function removeBatchObjectsIfUnreferenced(
    repository: LiteratureRepository,
    storage: LiteratureFileStorage,
    itemIds: readonly string[],
    storageKeys: readonly string[],
  ): Promise<boolean> {
    let cleanupFailed = false;
    for (const itemId of itemIds) {
      try {
        await storage.removeStagingForItem(itemId);
      } catch {
        cleanupFailed = true;
      }
    }
    for (const storageKey of new Set(storageKeys)) {
      let protectedKeys: Set<string>;
      try {
        protectedKeys = new Set(repository.listReferencedStorageKeys());
      } catch {
        cleanupFailed = true;
        continue;
      }
      if (protectedKeys.has(storageKey)) continue;
      try {
        await storage.removeObjectIfUnreferenced(storageKey);
      } catch {
        cleanupFailed = true;
      }
    }
    return cleanupFailed;
  }

  async function failBatchAndCleanup(
    database: DatabaseSync,
    repository: LiteratureRepository,
    storage: LiteratureFileStorage,
    batchId: string,
    code: PersistenceErrorCodeLike,
    promoted?: LiteraturePromotedObject,
  ): Promise<never> {
    const beforeFailure = repository.getBatchById(batchId);
    const itemIds = beforeFailure?.items.map((item) => item.itemId) ?? [];
    const storageKeys = [
      ...(beforeFailure?.items.flatMap((item) => item.storageKey ? [item.storageKey] : []) ?? []),
      ...(promoted?.created ? [promoted.storageKey] : []),
    ];
    try {
      markBatchFailed(database, repository, batchId, code, nowIso(clock));
    } catch {
      throw literatureError(literatureErrorCodes.STORAGE_FAILED);
    }
    if (await removeBatchObjectsIfUnreferenced(repository, storage, itemIds, storageKeys)) {
      try {
        markBatchFailed(database, repository, batchId, literatureErrorCodes.CLEANUP_FAILED, nowIso(clock));
      } catch {
        // Keep uncertain objects rather than deleting through an unverified reference.
      }
      throw literatureError(literatureErrorCodes.CLEANUP_FAILED);
    }
    throw literatureError(code);
  }

  async function createBatch(value: unknown): Promise<LiteratureBatchCreationResult> {
    trustedLocalResearchMode(dependencies);
    const request = validateRequest(value);
    const fingerprint = requestFingerprint(request);
    return withMutation(async () => {
      const database = databaseFactory();
      const repository = createLiteratureRepository(database);
      return withTransaction(database, () => {
        const existing = repository.getBatchByRequestId(request.requestId);
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) throw literatureError(literatureErrorCodes.BATCH_CONFLICT);
          return { batch: existing.batch, items: existing.items, idempotencyResult: "REPLAYED" as const };
        }
        const createdAt = nowIso(clock);
        const batch = makeBatch(request, createdAt, idFactory);
        const items = request.files.map((file) => makeItem(batch, file, createdAt, idFactory));
        repository.insertBatch(batch, fingerprint);
        for (const item of items) repository.insertItem(item);
        createAuditEventRepository(database).append(auditEvent(
          dependencies,
          "AUDIT",
          "LITERATURE_IMPORT_BATCH_RESERVED",
          "LITERATURE_IMPORT_BATCH",
          batch.batchId,
          { batchId: batch.batchId, status: batch.status, expectedFileCount: batch.expectedFileCount, expectedTotalBytes: batch.expectedTotalBytes, sourceType: batch.sourceType, permissionScope: batch.permissionScope },
          createdAt,
        ));
        return { batch, items, idempotencyResult: "CREATED" as const };
      });
    });
  }

  async function uploadFile(input: {
    batchId: string;
    itemId: string;
    body: ReadableStream<Uint8Array> | null;
    contentLength?: number;
    contentType?: string;
  }): Promise<LiteratureUploadResult> {
    trustedLocalResearchMode(dependencies);
    validateId(input.batchId);
    validateId(input.itemId);
    if (!input.body) throw literatureError(literatureErrorCodes.INVALID_REQUEST);
    const body = input.body;

    return withMutation(async () => {
      const database = databaseFactory();
      const repository = createLiteratureRepository(database);
      const storage = getStorage();
      const claimed = withTransaction(database, () => {
        const stored = repository.getItemById(input.itemId);
        if (!stored || stored.batchId !== input.batchId) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature import item was not found.");
        const batch = repository.getBatchById(input.batchId)?.batch;
        if (!batch) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature import batch was not found.");
        if (["COMPLETED", "FAILED", "CANCELLED"].includes(batch.status)) {
          throw literatureError(batch.status === "COMPLETED" ? literatureErrorCodes.REPLAYED : literatureErrorCodes.BATCH_CONFLICT);
        }
        const item = repository.claimItemForUpload(input.itemId, nowIso(clock));
        if (batch.status === "RESERVED") repository.updateBatchStatus(batch.batchId, "UPLOADING", item.updatedAt);
        return item;
      });

      let promoted: LiteraturePromotedObject | undefined;
      try {
        if (input.contentLength !== undefined && input.contentLength !== claimed.expectedSizeBytes) {
          return await failBatchAndCleanup(database, repository, storage, input.batchId, literatureErrorCodes.LENGTH_MISMATCH);
        }
        if (input.contentType !== undefined && normalizeContentType(input.contentType) !== normalizeContentType(claimed.declaredMime)) {
          return await failBatchAndCleanup(database, repository, storage, input.batchId, literatureErrorCodes.CONTENT_TYPE_INVALID);
        }

        let staged;
        try {
          staged = await storage.stageStream({ itemId: claimed.itemId, extension: claimed.declaredExtension, expectedSizeBytes: claimed.expectedSizeBytes, body });
        } catch (error) {
          return await failBatchAndCleanup(database, repository, storage, input.batchId, errorCodeOf(error, literatureErrorCodes.STORAGE_FAILED));
        }

        try {
          promoted = await storage.promote(staged.stagingPath, staged.storageKey);
        } catch (error) {
          return await failBatchAndCleanup(database, repository, storage, input.batchId, errorCodeOf(error, literatureErrorCodes.STORAGE_FAILED));
        }

        try {
          withTransaction(database, () => {
            const item = repository.getItemById(input.itemId);
            if (!item || item.status !== "UPLOADING") throw literatureError(literatureErrorCodes.BATCH_CONFLICT);
            if (repository.findVersionBySha256(staged.sha256) || repository.findValidatedItemBySha256(staged.sha256)) throw literatureError(literatureErrorCodes.DUPLICATE_CONTENT);
            const at = nowIso(clock);
            repository.markItemValidated(input.itemId, staged.sizeBytes, staged.sha256, staged.storageKey, staged.format, staged.detectedMime, at);
            createAuditEventRepository(database).append(auditEvent(
              dependencies,
              "AUDIT",
              "LITERATURE_IMPORT_ITEM_VALIDATED",
              "LITERATURE_IMPORT_ITEM",
              input.itemId,
              { batchId: input.batchId, itemId: input.itemId, status: "VALIDATED", format: staged.format, detectedMime: staged.detectedMime, sizeBytes: staged.sizeBytes, sha256: staged.sha256 },
              at,
            ));
          });
        } catch (error) {
          let code = errorCodeOf(error, literatureErrorCodes.STORAGE_FAILED);
          if (error instanceof PersistenceError && (error.code === literatureErrorCodes.DUPLICATE_CONTENT || error.code === persistenceErrorCodes.CONFLICT)) code = literatureErrorCodes.DUPLICATE_CONTENT;
          return await failBatchAndCleanup(database, repository, storage, input.batchId, code, promoted);
        }

        const result = repository.getBatchById(input.batchId);
        const item = result?.items.find((candidate) => candidate.itemId === input.itemId);
        if (!result || !item) throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Literature import item disappeared after validation.");
        return { batch: result.batch, item };
      } catch (error) {
        if (error instanceof PersistenceError && error.code.startsWith("LITERATURE_")) throw error;
        return await failBatchAndCleanup(database, repository, storage, input.batchId, errorCodeOf(error, literatureErrorCodes.STORAGE_FAILED), promoted);
      }
    });
  }

  async function completeBatch(batchId: string): Promise<LiteratureBatchCreationResult> {
    trustedLocalResearchMode(dependencies);
    validateId(batchId);
    return withMutation(async () => {
      const database = databaseFactory();
      const repository = createLiteratureRepository(database);
      const initial = repository.getBatchById(batchId);
      if (!initial) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature import batch was not found.");
      if (initial.batch.status === "COMPLETED") return { batch: initial.batch, items: initial.items, idempotencyResult: "REPLAYED" as const };
      if (initial.batch.status === "FAILED" || initial.batch.status === "CANCELLED") throw literatureError(literatureErrorCodes.BATCH_CONFLICT);
      const initialDocumentIds = initial.items.filter((item) => item.intent === "ADD_VERSION").map((item) => item.documentId);
      if (new Set(initialDocumentIds).size !== initialDocumentIds.length
        || initial.items.length !== initial.batch.expectedFileCount
        || initial.items.some((item) => item.status !== "VALIDATED")
        || initial.items.reduce((total, item) => total + (item.actualSizeBytes ?? 0), 0) !== initial.batch.expectedTotalBytes
        || initial.batch.receivedFileCount !== 0
        || initial.batch.receivedTotalBytes !== 0) throw literatureError(literatureErrorCodes.BATCH_CONFLICT);

      const storage = getStorage();
      try {
        for (const item of initial.items) {
          const metadata = validatedMetadata(item);
          if (!(await storage.hasObject(metadata.storageKey))) throw literatureError(literatureErrorCodes.CONSISTENCY_FAILED);
        }
      } catch (error) {
        return await failBatchAndCleanup(database, repository, storage, batchId, errorCodeOf(error, literatureErrorCodes.CONSISTENCY_FAILED));
      }

      try {
        return withTransaction(database, () => {
          const stored = repository.getBatchById(batchId);
          if (!stored || stored.batch.status === "FAILED" || stored.batch.status === "CANCELLED") throw literatureError(literatureErrorCodes.BATCH_CONFLICT);
          if (stored.batch.status === "COMPLETED") return { batch: stored.batch, items: stored.items, idempotencyResult: "REPLAYED" as const };
          const documentIds = stored.items.filter((item) => item.intent === "ADD_VERSION").map((item) => item.documentId);
          if (new Set(documentIds).size !== documentIds.length
            || stored.items.length !== stored.batch.expectedFileCount
            || stored.items.some((item) => item.status !== "VALIDATED")
            || stored.items.reduce((total, item) => total + (item.actualSizeBytes ?? 0), 0) !== stored.batch.expectedTotalBytes) throw literatureError(literatureErrorCodes.BATCH_CONFLICT);
          const at = nowIso(clock);
          for (const item of stored.items) {
            let documentId: string;
            let versionNumber: number;
            if (item.intent === "CREATE_DOCUMENT") {
              documentId = idFactory("DOCUMENT");
              versionNumber = 1;
            } else {
              documentId = item.documentId!;
              const existing = repository.getDocumentById(documentId);
              if (!existing || existing.status !== "ACTIVE" || existing.currentVersion !== item.expectedCurrentVersion) throw literatureError(literatureErrorCodes.VERSION_CONFLICT);
              versionNumber = existing.currentVersion + 1;
            }
            const version = makeVersion(item, idFactory("VERSION"), documentId, versionNumber, at);
            repository.insertVersion(version);
            if (item.intent === "CREATE_DOCUMENT") repository.insertDocument(makeDocument(item, documentId, version.versionId, at));
            else repository.advanceDocumentVersion(documentId, item.expectedCurrentVersion!, versionNumber, version.versionId, at);
            repository.markItemAvailable(item.itemId, at);
            createAuditEventRepository(database).append(auditEvent(
              dependencies,
              "AUDIT",
              "LITERATURE_DOCUMENT_VERSION_AVAILABLE",
              "LITERATURE_DOCUMENT_VERSION",
              version.versionId,
              { batchId, itemId: item.itemId, documentId, versionNumber, format: version.format, detectedMime: version.detectedMime, sizeBytes: version.sizeBytes, sha256: version.sha256, status: "AVAILABLE" },
              at,
            ));
          }
          repository.recalculateBatchReceived(batchId, at);
          const available = repository.getBatchById(batchId);
          if (!available || available.items.some((item) => item.status !== "AVAILABLE") || available.batch.receivedFileCount !== available.batch.expectedFileCount || available.batch.receivedTotalBytes !== available.batch.expectedTotalBytes) throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "Literature batch completion counts are inconsistent.");
          repository.updateBatchStatus(batchId, "COMPLETED", at, at);
          createAuditEventRepository(database).append(auditEvent(dependencies, "AUDIT", "LITERATURE_IMPORT_BATCH_COMPLETED", "LITERATURE_IMPORT_BATCH", batchId, { batchId, status: "COMPLETED", receivedFileCount: available.batch.expectedFileCount, receivedTotalBytes: available.batch.expectedTotalBytes }, at));
          const completed = repository.getBatchById(batchId)!;
          return { batch: completed.batch, items: completed.items, idempotencyResult: "CREATED" as const };
        });
      } catch (error) {
        if (error instanceof PersistenceError && error.code === literatureErrorCodes.BATCH_CONFLICT) throw error;
        return await failBatchAndCleanup(database, repository, storage, batchId, errorCodeOf(error, literatureErrorCodes.STORAGE_FAILED));
      }
    });
  }

  async function cancelBatch(batchId: string): Promise<{ batch: LiteratureImportBatch; items: LiteratureImportItem[]; idempotencyResult: "CANCELLED" | "REPLAYED" }> {
    trustedLocalResearchMode(dependencies);
    validateId(batchId);
    return withMutation(async () => {
      const database = databaseFactory();
      const repository = createLiteratureRepository(database);
      const stored = repository.getBatchById(batchId);
      if (!stored) throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "Literature import batch was not found.");
      if (stored.batch.status === "CANCELLED") return { batch: stored.batch, items: stored.items, idempotencyResult: "REPLAYED" as const };
      if (stored.batch.status === "COMPLETED" || stored.batch.status === "FAILED") throw literatureError(literatureErrorCodes.BATCH_CONFLICT);
      const storage = getStorage();
      const itemIds = stored.items.map((item) => item.itemId);
      const storageKeys = stored.items.flatMap((item) => item.storageKey ? [item.storageKey] : []);
      const cancelled = withTransaction(database, () => {
        const current = repository.getBatchById(batchId);
        if (!current || current.batch.status === "COMPLETED" || current.batch.status === "FAILED") throw literatureError(literatureErrorCodes.BATCH_CONFLICT);
        const at = nowIso(clock);
        for (const item of current.items) {
          if (["RESERVED", "UPLOADING", "VALIDATED", "AVAILABLE"].includes(item.status)) repository.markItemCancelled(item.itemId, at);
        }
        repository.updateBatchStatus(batchId, "CANCELLED", at);
        createAuditEventRepository(database).append(auditEvent(dependencies, "AUDIT", "LITERATURE_IMPORT_CANCELLED", "LITERATURE_IMPORT_BATCH", batchId, { batchId, status: "CANCELLED" }, at));
        const result = repository.getBatchById(batchId)!;
        return { batch: result.batch, items: result.items };
      });
      if (await removeBatchObjectsIfUnreferenced(repository, storage, itemIds, storageKeys)) throw literatureError(literatureErrorCodes.CLEANUP_FAILED);
      return { ...cancelled, idempotencyResult: "CANCELLED" as const };
    });
  }

  async function reconcile(): Promise<LiteratureReconciliationResult> {
    trustedLocalResearchMode(dependencies);
    const lease = await coordinator.enterMaintenance();
    try {
      const database = databaseFactory();
      const repository = createLiteratureRepository(database);
      const storage = getStorage();
      let removedStagingFiles = 0;
      let removedOrphanObjects = 0;
      let checkedAvailableObjects = 0;
      let retainedCandidates = 0;
      for (const path of await storage.listStagingPartPaths()) {
        const itemId = basename(path, ".part");
        if (repository.listActiveUploadingOrValidatedItemIds().includes(itemId)) continue;
        try {
          await storage.removeStagingPath(path);
          removedStagingFiles += 1;
        } catch {
          retainedCandidates += 1;
        }
      }
      const referenced = new Set(repository.listReferencedStorageKeys());
      for (const storageKey of referenced) {
        checkedAvailableObjects += 1;
        if (!(await storage.hasObject(storageKey))) throw literatureError(literatureErrorCodes.CONSISTENCY_FAILED);
      }
      for (const path of await storage.listObjectPaths()) {
        const storageKey = storage.storageKeyForObjectPath(path);
        if (new Set(repository.listReferencedStorageKeys()).has(storageKey)) continue;
        try {
          await storage.removeObjectIfUnreferenced(storageKey);
          removedOrphanObjects += 1;
        } catch {
          retainedCandidates += 1;
        }
      }
      return { removedStagingFiles, removedOrphanObjects, checkedAvailableObjects, retainedCandidates };
    } finally {
      lease.release();
    }
  }

  async function getAvailableVersion(documentId: string, versionNumber?: number): Promise<LiteratureDocumentVersion | undefined> {
    validateId(documentId);
    const version = createLiteratureRepository(databaseFactory()).getAvailableVersion(documentId, versionNumber);
    if (!version) return undefined;
    if (!(await getStorage().hasObject(version.storageKey))) throw literatureError(literatureErrorCodes.CONSISTENCY_FAILED);
    return version;
  }

  return { createBatch, uploadFile, completeBatch, cancelBatch, reconcile, getAvailableVersion };
}
