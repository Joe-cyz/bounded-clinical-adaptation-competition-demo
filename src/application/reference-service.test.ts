import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createEncounter } from "./encounter-service";
import { createLiteratureIngestionService } from "./literature-ingestion-service";
import {
  getAvailableLiteratureDocumentWorkspaceItems,
  getLiteratureWorkspaceView,
  getReferenceView,
} from "./reference-service";
import { getPublicDemoMedicalRecord, saveMedicalRecord } from "./medical-record-service";
import { editableMedicalRecordPayloadOf } from "@/domain/medical-record-editing";
import { encounterRecordRevisionSchema } from "@/domain/encounter";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createLocalLiteratureFileStorage } from "@/infrastructure/literature/literature-file-storage";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { createLiteratureRepository } from "@/infrastructure/sqlite/repositories/literature-repository";

const encounterRequest = {
  id: "encounter-reference-service-001",
  caseId: "general-first-001",
  caseVersion: "0.4.1-001",
  demographicSnapshot: {
    displayLabel: "合成患者-01" as const,
    sex: "UNKNOWN" as const,
    ageBand: "ADULT" as const,
  },
};

function editableSeedRecord() {
  return JSON.parse(JSON.stringify(editableMedicalRecordPayloadOf(getPublicDemoMedicalRecord().record))) as ReturnType<
    typeof editableMedicalRecordPayloadOf
  >;
}

function createLocalEncounter(database: DatabaseSync) {
  let auditNumber = 0;
  return createEncounter(encounterRequest, {
    database,
    runtimeMode: "local-research",
    clock: () => "2026-08-21T00:00:00.000Z",
    idFactory: (kind) => kind === "ENCOUNTER"
      ? encounterRequest.id
      : `audit-reference-service-create-${++auditNumber}`,
  });
}

function byteStream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

describe("PWR-07 reference read service", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => "2026-08-21T00:00:00.000Z" });
  });

  afterEach(() => {
    database.close();
  });

  it("reads the public synthetic reference without opening a database", () => {
    const view = getReferenceView("demo", { runtimeMode: "public-demo" });
    const literature = getLiteratureWorkspaceView("demo", { runtimeMode: "public-demo" });

    expect(view.mode).toBe("public-demo");
    expect(view.readOnly).toBe(true);
    expect(view.encounter.displayLabel).toBe("合成患者-01");
    expect(literature.entryState.hasImportedSources).toBe(false);
    expect(literature.entryState.citationCount).toBe(0);

    let databaseReads = 0;
    const publicDocuments = getAvailableLiteratureDocumentWorkspaceItems({
      runtimeMode: "public-demo",
      get database(): DatabaseSync {
        databaseReads += 1;
        throw new Error("public-demo must not obtain a database");
      },
    });
    expect(publicDocuments).toEqual([]);
    expect(databaseReads).toBe(0);
  });

  it("reads the current latest saved revision without writing status, audit, or revision rows", () => {
    const encounter = createLocalEncounter(database);
    const saved = saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editableSeedRecord(),
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-21T00:00:01.000Z",
      idFactory: (() => {
        let auditNumber = 0;
        return (kind: string) => kind === "RECORD_REVISION"
          ? "record-reference-service-001"
          : `audit-reference-service-save-${++auditNumber}`;
      })(),
    });

    const auditsBefore = createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id).length;
    const revisionsBefore = createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id).length;
    const reference = getReferenceView(encounter.id, { database, runtimeMode: "local-research" });
    const literature = getLiteratureWorkspaceView(encounter.id, { database, runtimeMode: "local-research" });
    const after = createEncounterRepository(database).getById(encounter.id);

    expect(reference.encounter.revisionNumber).toBe(saved.revision.revisionNumber);
    expect(reference.encounter.status).toBe("RECORD_SAVED");
    expect(literature.encounterId).toBe(encounter.id);
    expect(after?.status).toBe("RECORD_SAVED");
    expect(after?.currentRecordRevisionId).toBe(saved.revision.id);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)).toHaveLength(auditsBefore);
    expect(createEncounterRecordRevisionRepository(database).listByEncounter(encounter.id)).toHaveLength(revisionsBefore);
  });

  it("projects only completed, current, AVAILABLE document metadata and excludes storage details", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "pwr08-reference-projection-"));
    try {
      const storage = createLocalLiteratureFileStorage(storageRoot);
      let idNumber = 0;
      const service = createLiteratureIngestionService({
        runtimeMode: "local-research",
        databaseFactory: () => database,
        storageFactory: () => storage,
        clock: () => "2026-08-26T00:00:00.000Z",
        idFactory: (kind) => `${kind.toLowerCase()}-reference-projection-${++idNumber}`,
      });
      const bytes = new TextEncoder().encode("%PDF-1.7\nreference projection\n%%EOF\n");
      const created = await service.createBatch({
        requestId: "reference-projection-request-001",
        files: [{
          clientFileId: "reference-projection-file-001",
          originalFilename: "pathology.pdf",
          declaredExtension: ".pdf",
          declaredMime: "application/pdf",
          expectedSizeBytes: bytes.byteLength,
          intent: "CREATE_DOCUMENT",
        }],
      });
      await service.uploadFile({
        batchId: created.batch.batchId,
        itemId: created.items[0].itemId,
        body: byteStream(bytes),
        contentLength: bytes.byteLength,
        contentType: "application/pdf",
      });
      await service.completeBatch(created.batch.batchId);

      const published = getAvailableLiteratureDocumentWorkspaceItems({ database, runtimeMode: "local-research" });
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        displayName: "pathology.pdf",
        version: 1,
        format: "PDF",
        sizeBytes: bytes.byteLength,
        source: "负责人提供的本地资料",
        scope: "仅限本地比赛原型",
        pendingStatus: "已安全导入 · 待解析",
      });
      expect(Object.keys(published[0]).sort()).toEqual([
        "displayName",
        "documentId",
        "format",
        "importedAt",
        "pendingStatus",
        "scope",
        "sha256",
        "sizeBytes",
        "source",
        "version",
      ]);
      expect(JSON.stringify(published)).not.toMatch(/storageKey|objects\/|staging\//i);

      database.prepare("UPDATE literature_import_batches SET status = 'FAILED', completed_at = NULL WHERE batch_id = ?")
        .run(created.batch.batchId);
      expect(getAvailableLiteratureDocumentWorkspaceItems({ database, runtimeMode: "local-research" })).toEqual([]);

      database.prepare("UPDATE literature_import_batches SET status = 'CANCELLED' WHERE batch_id = ?")
        .run(created.batch.batchId);
      expect(getAvailableLiteratureDocumentWorkspaceItems({ database, runtimeMode: "local-research" })).toEqual([]);

      database.prepare("UPDATE literature_import_batches SET status = 'UPLOADING' WHERE batch_id = ?")
        .run(created.batch.batchId);
      database.prepare("UPDATE literature_import_items SET status = 'VALIDATED', completed_at = NULL WHERE item_id = ?")
        .run(created.items[0].itemId);
      expect(getAvailableLiteratureDocumentWorkspaceItems({ database, runtimeMode: "local-research" })).toEqual([]);

      const repository = createLiteratureRepository(database);
      const document = repository.getDocumentById(published[0].documentId)!;
      const at = "2026-08-26T00:00:01.000Z";
      repository.insertBatch({
        schemaVersion: "1.0.0",
        batchId: "batch-reference-noncurrent-002",
        requestId: "request-reference-noncurrent-002",
        status: "UPLOADING",
        expectedFileCount: 1,
        expectedTotalBytes: 20,
        receivedFileCount: 0,
        receivedTotalBytes: 0,
        sourceType: "OWNER_PROVIDED_LOCAL",
        permissionScope: "OWNER_AUTHORIZED_LOCAL_PROTOTYPE",
        createdAt: at,
        updatedAt: at,
      }, "b".repeat(64));
      repository.insertItem({
        schemaVersion: "1.0.0",
        itemId: "item-reference-noncurrent-002",
        batchId: "batch-reference-noncurrent-002",
        clientFileId: "file-reference-noncurrent-002",
        intent: "ADD_VERSION",
        documentId: document.documentId,
        expectedCurrentVersion: 1,
        originalFilename: "pathology-v2.pdf",
        declaredExtension: ".pdf",
        declaredMime: "application/pdf",
        expectedSizeBytes: 20,
        status: "VALIDATED",
        actualSizeBytes: 20,
        actualSha256: "b".repeat(64),
        storageKey: `objects/bb/${"b".repeat(64)}.pdf`,
        detectedFormat: "PDF",
        detectedMime: "application/pdf",
        createdAt: at,
        updatedAt: at,
      });
      repository.insertVersion({
        schemaVersion: "1.0.0",
        versionId: "version-reference-noncurrent-002",
        documentId: document.documentId,
        versionNumber: 2,
        format: "PDF",
        originalFilename: "pathology-v2.pdf",
        declaredMime: "application/pdf",
        detectedMime: "application/pdf",
        sizeBytes: 20,
        sha256: "b".repeat(64),
        storageKey: `objects/bb/${"b".repeat(64)}.pdf`,
        importBatchId: "batch-reference-noncurrent-002",
        importItemId: "item-reference-noncurrent-002",
        createdAt: at,
      });
      repository.advanceDocumentVersion(
        document.documentId,
        1,
        2,
        "version-reference-noncurrent-002",
        at,
      );
      expect(getAvailableLiteratureDocumentWorkspaceItems({ database, runtimeMode: "local-research" })).toEqual([]);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("rejects DRAFT and leaves the existing audit state untouched", () => {
    const encounter = createLocalEncounter(database);
    const auditsBefore = createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id).length;

    expect(() => getReferenceView(encounter.id, { database, runtimeMode: "local-research" })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    expect(createEncounterRepository(database).getById(encounter.id)?.status).toBe("DRAFT");
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)).toHaveLength(auditsBefore);
  });

  it("rejects an Encounter pointer that is no longer the latest revision", () => {
    const encounter = createLocalEncounter(database);
    const saved = saveMedicalRecord({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editableSeedRecord(),
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-21T00:00:01.000Z",
      idFactory: (() => {
        let auditNumber = 0;
        return (kind: string) => kind === "RECORD_REVISION"
          ? "record-reference-service-stale-001"
          : `audit-reference-service-stale-save-${++auditNumber}`;
      })(),
    });
    const revisions = createEncounterRecordRevisionRepository(database);
    revisions.append(encounterRecordRevisionSchema.parse({
      schemaVersion: "1.0.0",
      id: "record-reference-service-stale-002",
      encounterId: encounter.id,
      revisionNumber: 2,
      recordPayload: saved.revision.recordPayload,
      createdAt: "2026-08-21T00:00:02.000Z",
    }), 1);
    const auditsBefore = createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id).length;

    expect(() => getReferenceView(encounter.id, { database, runtimeMode: "local-research" })).toThrowError(
      expect.objectContaining({ code: persistenceErrorCodes.CONFLICT }),
    );
    expect(createEncounterRepository(database).getById(encounter.id)?.currentRecordRevisionId).toBe(saved.revision.id);
    expect(createAuditEventRepository(database).listByEntity("ENCOUNTER", encounter.id)).toHaveLength(auditsBefore);
  });
});
