import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEncounter, transitionEncounter } from "@/application/encounter-service";
import { getPublicDemoMedicalRecord } from "@/application/medical-record-service";
import { createLiteratureIngestionService } from "@/application/literature-ingestion-service";
import { createLiteratureParsingService } from "@/application/literature-parsing-service";
import { encounterRecordRevisionSchema } from "@/domain/encounter";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createLocalLiteratureFileStorage } from "@/infrastructure/literature/literature-file-storage";

export const SYNTHETIC_FILENAME = "pwr-08d-synthetic-reference.txt";
export const SYNTHETIC_QUERY = "合成诊疗参考";
export const SYNTHETIC_TEXT = [
  "合成资料范围说明：本材料仅用于本地工程验证，不代表临床准确率或生产结论。",
  "合成诊疗参考：合成表现可从感染性与非感染性方向进行鉴别；可评估支持性处理、非药物处理和抗感染治疗类别，具体决定需由医生结合禁忌证和检查结果作出；需核对症状时间线、既往史、用药史及辅助检查；信息不足时应补充检查，不形成确定结论。",
].join("\n");
export const ENCOUNTER_ID = "pwr08d-b-encounter-001";
export const GENERAL_REQUEST_ID = "pwr08d-b-general-20260829";
export const GROUNDED_REQUEST_ID = "pwr08d-b-grounded-20260829";
export const GENERAL_QUESTION = "请结合当前已保存病历，对整个合成病例给出综合判断和诊疗建议。";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_SYNTHETIC_TEMP_ROOT = resolve(PROJECT_ROOT, "test-results", "model-reference-contract");
const SYNTHETIC_TEMP_RELATIVE_PREFIX = join("test-results", "");

export const FIXTURE_STAGES = [
  "FIXTURE_ENCOUNTER",
  "FIXTURE_RECORD",
  "FIXTURE_INGESTION_CREATE",
  "FIXTURE_INGESTION_UPLOAD",
  "FIXTURE_INGESTION_COMPLETE",
  "FIXTURE_PARSE",
  "FIXTURE_ASSERT",
] as const;
export type FixtureStage = (typeof FIXTURE_STAGES)[number];

export function createSequentialIdFactory(prefix: string): (kind: string) => string {
  const counters = new Map<string, number>();

  return (kind: string) => {
    const sequence = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, sequence);
    return `${prefix}-${kind.toLowerCase()}-${String(sequence).padStart(3, "0")}`;
  };
}

export type FixtureSnapshot = {
  encounterUpdatedAt: string;
  currentRecordRevisionId: string;
  revisionNumber: number;
  payloadSha256: string;
  revisionCount: number;
};

export type SyntheticFixture = {
  database: DatabaseSync;
  databasePath: string;
  storageRoot: string;
  textPath: string;
  documentId: string;
  encounterId: string;
  revisionId: string;
  expectedUpdatedAt: string;
  auditEventIds: string[];
  auditEventTypes: string[];
};

export type SyntheticFixtureOptions = {
  tempRoot?: string;
  failAfterDatabaseOpen?: boolean;
  onDatabaseOpened?: (database: DatabaseSync) => void;
  onStage?: (stage: FixtureStage) => void;
};

function controlFailure(message: string): never {
  throw new Error(message);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function assertEmptyOrAbsent(path: string): Promise<void> {
  try {
    const info = await fs.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SYNTHETIC_TEMP_ROOT_UNSAFE");
    if ((await fs.readdir(path)).length !== 0) throw new Error("SYNTHETIC_TEMP_ROOT_NOT_EMPTY");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return;
    return controlFailure(error instanceof Error && /^SYNTHETIC_[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : "SYNTHETIC_TEMP_ROOT_UNREADABLE");
  }
}

function assertOwnedTempRoot(tempRoot: string): string {
  const resolved = resolve(tempRoot);
  const relativePath = relative(PROJECT_ROOT, resolved);
  if (!relativePath.startsWith(SYNTHETIC_TEMP_RELATIVE_PREFIX)
    || relativePath.includes("..")) return controlFailure("SYNTHETIC_TEMP_ROOT_SCOPE_INVALID");
  return resolved;
}

export async function removeSyntheticFixtureRoot(tempRoot: string = DEFAULT_SYNTHETIC_TEMP_ROOT): Promise<number> {
  const resolved = assertOwnedTempRoot(tempRoot);
  await fs.rm(resolved, { recursive: true, force: true });
  try {
    return (await fs.readdir(resolved)).length;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? 0 : 1;
  }
}

export function readFixtureSnapshot(database: DatabaseSync, encounterId: string): FixtureSnapshot {
  const encounter = database.prepare(
    "SELECT updated_at, current_record_revision_id FROM encounters WHERE id = ? LIMIT 1",
  ).get(encounterId) as { updated_at?: unknown; current_record_revision_id?: unknown } | undefined;
  const revision = database.prepare(
    "SELECT id, revision_number, record_payload_json FROM encounter_record_revisions WHERE encounter_id = ? ORDER BY revision_number DESC LIMIT 1",
  ).get(encounterId) as { id?: unknown; revision_number?: unknown; record_payload_json?: unknown } | undefined;
  if (typeof encounter?.updated_at !== "string"
    || typeof encounter.current_record_revision_id !== "string"
    || typeof revision?.id !== "string"
    || !Number.isSafeInteger(revision.revision_number)
    || (revision.revision_number as number) < 0
    || typeof revision.record_payload_json !== "string") {
    return controlFailure("SYNTHETIC_RECORD_SNAPSHOT_INVALID");
  }
  const revisionCount = database.prepare(
    "SELECT COUNT(*) AS count FROM encounter_record_revisions WHERE encounter_id = ?",
  ).get(encounterId) as { count?: unknown } | undefined;
  const revisionCountValue = revisionCount?.count;
  if (!Number.isSafeInteger(revisionCountValue) || (revisionCountValue as number) < 0) {
    return controlFailure("SYNTHETIC_RECORD_SNAPSHOT_INVALID");
  }
  return {
    encounterUpdatedAt: encounter.updated_at,
    currentRecordRevisionId: encounter.current_record_revision_id,
    revisionNumber: revision.revision_number as number,
    payloadSha256: sha256Text(revision.record_payload_json),
    revisionCount: revisionCountValue as number,
  };
}

export async function buildSyntheticFixture(options: SyntheticFixtureOptions = {}): Promise<SyntheticFixture> {
  const tempRoot = assertOwnedTempRoot(options.tempRoot ?? DEFAULT_SYNTHETIC_TEMP_ROOT);
  await assertEmptyOrAbsent(tempRoot);
  await fs.mkdir(tempRoot, { recursive: true });

  const databasePath = join(tempRoot, "runtime.db");
  const storageRoot = join(tempRoot, "literature-storage");
  const textPath = join(tempRoot, SYNTHETIC_FILENAME);
  let database: DatabaseSync | undefined;

  try {
    database = openRuntimeDatabase({ path: databasePath });
    options.onDatabaseOpened?.(database);
    if (options.failAfterDatabaseOpen) throw new Error("SYNTHETIC_TEST_FAILURE_AFTER_DATABASE_OPEN");

    const record = getPublicDemoMedicalRecord().record;
    options.onStage?.("FIXTURE_ENCOUNTER");
    const created = createEncounter({
      id: ENCOUNTER_ID,
      caseId: record.caseId,
      caseVersion: record.caseVersion,
      demographicSnapshot: { displayLabel: record.demographics.displayLabel, sex: "UNKNOWN", ageBand: "ADULT" },
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-29T00:00:00.000Z",
      idFactory: createSequentialIdFactory("pwr08d-b-encounter"),
    });

    options.onStage?.("FIXTURE_RECORD");
    const revision = encounterRecordRevisionSchema.parse({
      schemaVersion: "1.0.0",
      id: "pwr08d-b-record-revision-001",
      encounterId: created.id,
      revisionNumber: 1,
      recordPayload: record,
      createdAt: "2026-08-29T00:00:01.000Z",
    });
    createEncounterRecordRevisionRepository(database).append(revision);
    const saved = transitionEncounter({
      encounterId: created.id,
      expectedStatus: created.status,
      expectedUpdatedAt: created.updatedAt,
      targetStatus: "RECORD_SAVED",
      currentRecordRevisionId: revision.id,
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-29T00:00:02.000Z",
      idFactory: createSequentialIdFactory("pwr08d-b-record-saved"),
    });
    const viewed = transitionEncounter({
      encounterId: saved.id,
      expectedStatus: saved.status,
      expectedUpdatedAt: saved.updatedAt,
      targetStatus: "REFERENCE_VIEWED",
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-29T00:00:03.000Z",
      idFactory: createSequentialIdFactory("pwr08d-b-reference-viewed"),
    });

    const textBytes = new TextEncoder().encode(SYNTHETIC_TEXT);
    options.onStage?.("FIXTURE_INGESTION_CREATE");
    await fs.writeFile(textPath, textBytes);
    const storage = createLocalLiteratureFileStorage(storageRoot);
    const literatureIdFactory = createSequentialIdFactory("pwr08d-b-literature");
    const ingestion = createLiteratureIngestionService({
      runtimeMode: "local-research",
      databaseFactory: () => database!,
      storageFactory: () => storage,
      clock: () => "2026-08-29T00:00:04.000Z",
      idFactory: literatureIdFactory,
    });

    const batch = await ingestion.createBatch({
      requestId: "pwr08d-b-literature-request-001",
      files: [{
        clientFileId: "pwr08d-b-literature-file-001",
        originalFilename: SYNTHETIC_FILENAME,
        declaredExtension: ".txt",
        declaredMime: "text/plain",
        expectedSizeBytes: textBytes.byteLength,
        intent: "CREATE_DOCUMENT",
      }],
    });

    options.onStage?.("FIXTURE_INGESTION_UPLOAD");
    await ingestion.uploadFile({
      batchId: batch.batch.batchId,
      itemId: batch.items[0]!.itemId,
      body: streamFromBytes(textBytes),
      contentLength: textBytes.byteLength,
      contentType: "text/plain",
    });

    options.onStage?.("FIXTURE_INGESTION_COMPLETE");
    await ingestion.completeBatch(batch.batch.batchId);
    const documentRow = database.prepare(
      "SELECT document_id, current_version_id FROM literature_documents WHERE display_name = ? AND status = 'ACTIVE' LIMIT 1",
    ).get(SYNTHETIC_FILENAME) as { document_id?: unknown; current_version_id?: unknown } | undefined;
    if (typeof documentRow?.document_id !== "string" || typeof documentRow.current_version_id !== "string") {
      return controlFailure("SYNTHETIC_DOCUMENT_MISSING");
    }

    const parser = createLiteratureParsingService({
      runtimeMode: "local-research",
      databaseFactory: () => database!,
      storageFactory: () => storage,
      clock: () => "2026-08-29T00:00:05.000Z",
      idFactory: createSequentialIdFactory("pwr08d-b-parser"),
    });
    options.onStage?.("FIXTURE_PARSE");
    const parsed = await parser.parseVersion({
      documentId: documentRow.document_id,
      versionId: documentRow.current_version_id,
      request: { parseRequestId: "pwr08d-b-parse-request-001" },
    });
    if (parsed.parseRun.status !== "READY") return controlFailure("SYNTHETIC_PARSE_NOT_READY");

    options.onStage?.("FIXTURE_ASSERT");
    const activeDocuments = database.prepare(
      "SELECT COUNT(*) AS count FROM literature_documents WHERE status = 'ACTIVE'",
    ).get() as { count?: unknown } | undefined;
    const versions = database.prepare(
      "SELECT COUNT(*) AS count FROM literature_document_versions WHERE document_id = ? AND version_id = ?",
    ).get(documentRow.document_id, documentRow.current_version_id) as { count?: unknown } | undefined;
    const parseRuns = database.prepare(
      "SELECT COUNT(*) AS count FROM literature_parse_runs WHERE version_id = ? AND status = 'READY'",
    ).get(documentRow.current_version_id) as { count?: unknown } | undefined;
    const fragments = database.prepare(
      "SELECT COUNT(*) AS count FROM literature_fragments WHERE version_id = ?",
    ).get(documentRow.current_version_id) as { count?: unknown } | undefined;
    const fragmentCount = fragments?.count;
    if (activeDocuments?.count !== 1 || versions?.count !== 1 || parseRuns?.count !== 1
      || !Number.isSafeInteger(fragmentCount) || (fragmentCount as number) < 1) {
      return controlFailure("SYNTHETIC_SCOPE_INVALID");
    }

    const auditRows = database.prepare(
      "SELECT id, event_type FROM audit_events ORDER BY created_at ASC, id ASC",
    ).all() as Array<{ id?: unknown; event_type?: unknown }>;
    if (!auditRows.every((row) => typeof row.id === "string" && typeof row.event_type === "string")) {
      return controlFailure("SYNTHETIC_AUDIT_INVALID");
    }
    const auditEventIds = auditRows.map((row) => row.id as string);
    if (new Set(auditEventIds).size !== auditEventIds.length) return controlFailure("SYNTHETIC_AUDIT_DUPLICATE");

    return {
      database,
      databasePath,
      storageRoot,
      textPath,
      documentId: documentRow.document_id,
      encounterId: viewed.id,
      revisionId: revision.id,
      expectedUpdatedAt: viewed.updatedAt,
      auditEventIds,
      auditEventTypes: auditRows.map((row) => row.event_type as string),
    };
  } catch (error) {
    if (database?.isOpen) database.close();
    throw error;
  }
}
