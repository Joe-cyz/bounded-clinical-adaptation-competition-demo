import { promises as fs } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEncounter, transitionEncounter } from "./encounter-service";
import { createLiteratureIngestionService } from "./literature-ingestion-service";
import { createLiteratureParsingService } from "./literature-parsing-service";
import { getPublicDemoMedicalRecord, saveMedicalRecord } from "./medical-record-service";
import { createManualSyntheticEncounter } from "./manual-synthetic-encounter-service";
import { CitationVerifier, createModelReferenceService, projectProviderFacts, selectSafeEvidenceExcerpt } from "./model-reference-service";
import { enterPreSignReview } from "./pre-sign-review-service";
import type { GeneralClinicalReferenceInput, LiteratureGroundedReferenceInput } from "./ports/model-reference-provider";
import { createLocalLiteratureFileStorage } from "@/infrastructure/literature/literature-file-storage";
import { controlledModelReferenceEvidenceSchema } from "@/domain/model-reference";
import { encounterRecordRevisionSchema } from "@/domain/encounter";
import { editableMedicalRecordPayloadOf } from "@/domain/medical-record-editing";
import {
  createClinicalReferenceProvider,
  createLiteratureAnswerProvider,
  createOfflineModelReferenceFakeFetch,
} from "@/infrastructure/providers/model-reference-provider";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";

const now = "2026-08-26T00:00:00.000Z";

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createIdFactory(prefix: string) {
  let counter = 0;
  return (kind: string) => `${prefix}-${kind.toLowerCase()}-${++counter}`;
}

async function importReadyText(
  database: DatabaseSync,
  storageRoot: string,
  text: string,
  filename: string,
  prefix: string,
): Promise<{ documentId: string; versionId: string }> {
  const bytes = new TextEncoder().encode(text);
  const storage = createLocalLiteratureFileStorage(storageRoot);
  const ingestion = createLiteratureIngestionService({
    runtimeMode: "local-research",
    databaseFactory: () => database,
    storageFactory: () => storage,
    idFactory: createIdFactory(`${prefix}-ingest`),
    clock: () => "2026-08-26T00:00:00.000Z",
  });
  const batch = await ingestion.createBatch({
    requestId: `${prefix}-request`,
    files: [{
      clientFileId: `${prefix}-file`,
      originalFilename: filename,
      declaredExtension: ".txt",
      declaredMime: "text/plain",
      expectedSizeBytes: bytes.byteLength,
      intent: "CREATE_DOCUMENT",
    }],
  });
  await ingestion.uploadFile({
    batchId: batch.batch.batchId,
    itemId: batch.items[0]!.itemId,
    body: streamFromBytes(bytes),
    contentLength: bytes.byteLength,
    contentType: "text/plain",
  });
  await ingestion.completeBatch(batch.batch.batchId);
  const documentRow = database.prepare(
    "SELECT document_id, current_version_id FROM literature_documents WHERE display_name = ? LIMIT 1",
  ).get(filename) as { document_id: string; current_version_id: string };
  const parser = createLiteratureParsingService({
    runtimeMode: "local-research",
    databaseFactory: () => database,
    storageFactory: () => storage,
    idFactory: createIdFactory(`${prefix}-parse`),
    clock: () => "2026-08-26T00:00:01.000Z",
  });
  await parser.parseVersion({
    documentId: documentRow.document_id,
    versionId: documentRow.current_version_id,
    request: { parseRequestId: `${prefix}-parse-request` },
  });
  return { documentId: documentRow.document_id, versionId: documentRow.current_version_id };
}

function createCapturedGroundedProvider(received: LiteratureGroundedReferenceInput[]) {
  const baseProvider = createLiteratureAnswerProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() });
  return {
    ...baseProvider,
    generate: vi.fn(async (input: LiteratureGroundedReferenceInput) => {
      received.push(input);
      return baseProvider.generate(input);
    }),
  };
}

function fixture(database: DatabaseSync) {
  const record = getPublicDemoMedicalRecord().record;
  const created = createEncounter({
    id: "encounter-model-reference-001",
    caseId: record.caseId,
    caseVersion: record.caseVersion,
    demographicSnapshot: { displayLabel: record.demographics.displayLabel, sex: "UNKNOWN", ageBand: "ADULT" },
  }, {
    database,
    runtimeMode: "local-research",
    clock: () => now,
    idFactory: (kind) => kind === "ENCOUNTER" ? "encounter-model-reference-001" : `audit-${kind.toLowerCase()}-001`,
  });
  const revision = encounterRecordRevisionSchema.parse({
    schemaVersion: "1.0.0",
    id: "record-revision-model-reference-001",
    encounterId: created.id,
    revisionNumber: 1,
    recordPayload: record,
    createdAt: now,
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
    clock: () => "2026-08-26T00:00:01.000Z",
    idFactory: (kind) => `transition-${kind.toLowerCase()}-001`,
  });
  const referenceViewed = transitionEncounter({
    encounterId: saved.id,
    expectedStatus: saved.status,
    expectedUpdatedAt: saved.updatedAt,
    targetStatus: "REFERENCE_VIEWED",
  }, {
    database,
    runtimeMode: "local-research",
    clock: () => "2026-08-26T00:00:02.000Z",
    idFactory: (kind) => `transition-${kind.toLowerCase()}-002`,
  });
  return { encounter: referenceViewed, revision };
}

describe("PWR-08C offline model reference service", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => now });
  });

  afterEach(() => database.close());

  it("rejects public-demo before obtaining its counted database factory", async () => {
    const databaseFactory = vi.fn(() => { throw new Error("database must not be opened"); });
    const service = createModelReferenceService({
      databaseFactory,
      runtimeMode: "public-demo",
      clinicalProvider: createClinicalReferenceProvider(),
      literatureProvider: createLiteratureAnswerProvider(),
    });
    await expect(service.generate({})).rejects.toMatchObject({ code: "RUNTIME_READ_ONLY" });
    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it("uses one injected fake fetch for an idempotent general reference and keeps only validated items", async () => {
    const { encounter, revision } = fixture(database);
    const counter = { calls: 0 };
    let ids = 0;
    const service = createModelReferenceService({
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clinicalProvider: createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch(counter) }),
      literatureProvider: createLiteratureAnswerProvider({ fetchImpl: createOfflineModelReferenceFakeFetch(counter) }),
      clock: () => "2026-08-26T00:00:03.000Z",
      idFactory: (kind) => `${kind.toLowerCase()}-model-${++ids}`,
    });
    const request = {
      referenceRequestId: "model-reference-request-001",
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedCurrentRecordRevisionId: revision.id,
      kind: "GENERAL" as const,
      question: "请整理当前病历的核实重点。",
    };
    const first = await service.generate(request);
    const replay = await service.generate(request);
    expect(first.status).toBe("CREATED");
    expect(replay.status).toBe("REPLAYED");
    expect(counter.calls).toBe(1);
    if (first.status === "CREATED") {
      expect(first.reference.evidenceLevel).toBe("GENERAL_MODEL_NO_LOCAL_EVIDENCE");
      expect(first.reference.items.map((item) => item.kind)).toEqual(["CONSIDERATION_DIRECTION", "NEEDS_VERIFICATION", "ADDITIONAL_CHECK_OR_SOURCE"]);
      expect(first.reference.citations).toEqual([]);
      expect(first.reference.factSummaries[0]?.facts.find((fact) => fact.id === "M1")).toMatchObject({ label: "主诉" });
      expect(first.reference.factSummaries[0]?.facts.find((fact) => fact.id === "M1")?.text).not.toMatch(/^主诉：/u);
      expect(database.prepare("SELECT COUNT(*) AS count FROM model_reference_items").get()).toEqual({ count: 3 });
    }
  });

  it("keeps displayed facts label-free while adding each label once at the provider boundary", async () => {
    const facts = projectProviderFacts([
      { id: "M1", label: "主诉", text: "合成信息" },
      { id: "M2", label: "现病史", text: "🙂".repeat(400) },
    ]);
    expect(facts[0]).toEqual({ id: "M1", text: "主诉：合成信息" });
    expect(facts[0]?.text.match(/主诉：/gu)).toHaveLength(1);
    expect(Array.from(facts[1]?.text ?? "")).toHaveLength(300);
    expect(facts[1]?.text.startsWith("现病史：")).toBe(true);
    expect(facts[1]?.text.endsWith("🙂")).toBe(true);
    expect(JSON.stringify(facts)).not.toMatch(/姓名|患者编号|电话|地址|身份证/gu);

    const { encounter, revision } = fixture(database);
    const baseProvider = createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() });
    const received: GeneralClinicalReferenceInput["facts"][] = [];
    const clinicalProvider = {
      ...baseProvider,
      generate: vi.fn(async (input: GeneralClinicalReferenceInput) => {
        received.push(input.facts);
        const response = await baseProvider.generate(input);
        if (!response.ok) return response;
        return {
          ...response,
          output: {
            ...response.output,
            recordFactIds: input.facts.map((fact) => fact.id),
          },
        };
      }),
    };
    const service = createModelReferenceService({
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clinicalProvider,
      literatureProvider: createLiteratureAnswerProvider(),
    });
    const generated = await service.generate({
      referenceRequestId: "model-reference-provider-facts-001",
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedCurrentRecordRevisionId: revision.id,
      kind: "GENERAL",
      question: "请整理当前病历的核实重点。",
    });
    expect(generated.status).toBe("CREATED");
    expect(received).toHaveLength(1);
    const projectedFacts = received[0] ?? [];
    expect(projectedFacts).toHaveLength(12);
    expect(projectedFacts.every((fact) => Array.from(fact.text).length <= 300)).toBe(true);
    for (const [id, label] of [
      ["M1", "主诉"],
      ["M2", "现病史"],
      ["M3", "过敏史"],
      ["M4", "当前用药"],
      ["M9", "生命体征"],
    ] as const) {
      const fact = projectedFacts.find((candidate) => candidate.id === id);
      expect(fact?.text.startsWith(`${label}：`), id).toBe(true);
      expect(fact?.text.match(new RegExp(`${label}：`, "gu")), id).toHaveLength(1);
    }
    const providerVital = projectedFacts.find((fact) => fact.id === "M9");
    expect(providerVital?.text).not.toContain("生命体征：生命体征：");
    expect(JSON.stringify(received[0])).not.toMatch(/姓名|患者编号|电话|地址|身份证/gu);
    if (generated.status === "CREATED") {
      const displayedVital = generated.reference.factSummaries.flatMap((summary) => summary.facts).find((fact) => fact.id === "M9");
      expect(displayedVital?.text).not.toMatch(/^生命体征：/u);
    }
  });

  it("rejects unavailable grounded evidence before either provider and adds selected follow-up only to a new review snapshot", async () => {
    const { encounter, revision } = fixture(database);
    const counter = { calls: 0 };
    let ids = 0;
    const service = createModelReferenceService({
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clinicalProvider: createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch(counter) }),
      literatureProvider: createLiteratureAnswerProvider({ fetchImpl: createOfflineModelReferenceFakeFetch(counter) }),
      clock: () => "2026-08-26T00:00:03.000Z",
      idFactory: (kind) => `${kind.toLowerCase()}-followup-${++ids}`,
    });
    await expect(service.generate({
      referenceRequestId: "model-reference-request-grounded-001",
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedCurrentRecordRevisionId: revision.id,
      kind: "LITERATURE_GROUNDED",
      question: "不存在的资料关键词",
      documentIds: ["document-missing-001"],
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(counter.calls).toBe(0);

    const general = await service.generate({
      referenceRequestId: "model-reference-request-followup-001",
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedCurrentRecordRevisionId: revision.id,
      kind: "GENERAL",
      question: "请整理当前病历的核实重点。",
    });
    expect(general.status).toBe("CREATED");
    if (general.status !== "CREATED") return;
    const item = general.reference.items.find((candidate) => candidate.kind === "NEEDS_VERIFICATION");
    expect(item).toBeDefined();
    expect(service.selectFollowUp({
      followUpRequestId: "model-reference-followup-request-001",
      encounterId: encounter.id,
      referenceId: general.reference.referenceId,
      itemId: item!.id,
      expectedUpdatedAt: encounter.updatedAt,
    })).toEqual({ status: "CREATED" });
    let reviewIds = 0;
    const review = enterPreSignReview({
      encounterId: encounter.id,
      expectedUpdatedAt: encounter.updatedAt,
      expectedCurrentRecordRevisionId: revision.id,
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-26T00:00:04.000Z",
      idFactory: (kind) => `review-model-reference-${kind.toLowerCase()}-${++reviewIds}`,
    });
    expect(review.review.items.some((candidate) => candidate.source === "MODEL_REFERENCE")).toBe(true);
    expect(review.review.items.find((candidate) => candidate.source === "MODEL_REFERENCE")?.title).toMatch(/^AI参考：/u);
    const afterReview = database.prepare("SELECT updated_at FROM encounters WHERE id = ?").get(encounter.id) as { updated_at: string };
    expect(() => service.selectFollowUp({
      followUpRequestId: "model-reference-followup-request-after-review-001",
      encounterId: encounter.id,
      referenceId: general.reference.referenceId,
      itemId: item!.id,
      expectedUpdatedAt: afterReview.updated_at,
    })).toThrow(expect.objectContaining({ ruleId: "MODEL_REFERENCE_CONFLICT" }));
  });

  it("uses the bound manual record in the existing model-reference workflow without exposing source metadata", async () => {
    let idNumber = 0;
    const created = createManualSyntheticEncounter({
      creationRequestId: "manual-request-model-referencez001",
      specialty: "普通内科",
      visitType: "初诊",
      sex: "FEMALE",
      age: 30,
    }, {
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clock: () => now,
      idFactory: (kind) => `manual-model-${kind.toLowerCase()}-${++idNumber}`,
    });
    let saveAuditNumber = 0;
    const saved = saveMedicalRecord({
      encounterId: created.encounter.id,
      expectedUpdatedAt: created.encounter.updatedAt,
      expectedRevisionNumber: 0,
      editableRecord: editableMedicalRecordPayloadOf(created.initialRecord),
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-26T00:00:01.000Z",
      idFactory: (kind) => kind === "RECORD_REVISION" ? "manual-model-record-001" : `manual-model-save-audit-${++saveAuditNumber}`,
    });
    const referenceViewed = transitionEncounter({
      encounterId: saved.encounter.id,
      expectedStatus: saved.encounter.status,
      expectedUpdatedAt: saved.encounter.updatedAt,
      targetStatus: "REFERENCE_VIEWED",
      currentRecordRevisionId: saved.revision.id,
    }, {
      database,
      runtimeMode: "local-research",
      clock: () => "2026-08-26T00:00:02.000Z",
      idFactory: (kind) => `manual-model-transition-${kind.toLowerCase()}-001`,
    });
    const received: GeneralClinicalReferenceInput[] = [];
    const baseProvider = createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() });
    const clinicalProvider = {
      ...baseProvider,
      generate: vi.fn(async (input: GeneralClinicalReferenceInput) => {
        received.push(input);
        return baseProvider.generate(input);
      }),
    };
    const service = createModelReferenceService({
      databaseFactory: () => database,
      runtimeMode: "local-research",
      clinicalProvider,
      literatureProvider: createLiteratureAnswerProvider(),
      clock: () => "2026-08-26T00:00:03.000Z",
      idFactory: (() => {
        let referenceIdNumber = 0;
        return (kind) => `manual-model-reference-${kind.toLowerCase()}-${++referenceIdNumber}`;
      })(),
    });

    const result = await service.generate({
      referenceRequestId: "manual-model-reference-request-001",
      encounterId: referenceViewed.id,
      expectedUpdatedAt: referenceViewed.updatedAt,
      expectedCurrentRecordRevisionId: saved.revision.id,
      kind: "GENERAL",
      question: "请整理当前病历的核实重点。",
    });

    expect(result.status).toBe("CREATED");
    expect(received).toHaveLength(1);
    expect(received[0]?.facts).toHaveLength(12);
    expect(JSON.stringify(received[0])).not.toMatch(/MANUAL_SYNTHETIC|intakeId|manual-model-case|node_modules|DATABASE_PATH/iu);
    if (result.status === "CREATED") {
      expect(result.reference.factSummaries.flatMap((summary) => summary.facts).some((fact) => fact.text.includes("manual-model"))).toBe(false);
    }
  });
});

describe("PWR-08D-B-R4 safe evidence projection", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => now });
  });

  afterEach(() => database.close());

  it("selects the longest query-bearing line without replacing source characters", () => {
    const rawExcerpt = "首行仅作范围说明。\r\n较短行包含查询词并保留引用。\n较长行包含查询词并保留更完整的连续引用内容。";
    const projected = selectSafeEvidenceExcerpt(rawExcerpt, "查询词");

    expect(projected).toBe("较长行包含查询词并保留更完整的连续引用内容。");
    expect(projected).not.toMatch(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u);
    expect(rawExcerpt.includes(projected!)).toBe(true);
    expect(Array.from(projected!).length).toBeGreaterThanOrEqual(12);
    expect(Array.from(projected!).length).toBeLessThanOrEqual(600);
  });

  it("keeps bidi-delimited segments separate and truncates Unicode by code point", () => {
    const left = "左侧连续安全片段足够长内容";
    const right = "右侧连续安全片段也足够长内容";
    const rawExcerpt = `${left}\u202E屏蔽内容\u2066${right}\u2069`;
    const projected = selectSafeEvidenceExcerpt(rawExcerpt, "不存在的查询");
    expect([left, right]).toContain(projected);
    expect(rawExcerpt.includes(projected!)).toBe(true);
    expect(projected).not.toMatch(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u);
    expect(projected).not.toBe(`${left}${right}`);

    const longRawExcerpt = `前缀${"🙂".repeat(650)}后缀`;
    const bounded = selectSafeEvidenceExcerpt(longRawExcerpt, "不存在的查询");
    expect(bounded).toBeDefined();
    expect(Array.from(bounded!).length).toBe(600);
    expect(Array.from(bounded!).join("")).toBe(bounded);
    expect(longRawExcerpt.includes(bounded!)).toBe(true);
  });

  it("passes a multiline source-preserving excerpt and quote through the grounded provider boundary", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pwr-08d-r4-multiline-"));
    try {
      const { encounter, revision } = fixture(database);
      const rawText = "首行背景说明。\r\n第二行：循环稳态参考是查询所在的连续片段。\n第三行补充引用内容。";
      const imported = await importReadyText(database, join(root, "storage"), rawText, "r4-multiline.txt", "r4-multiline");
      const received: LiteratureGroundedReferenceInput[] = [];
      const service = createModelReferenceService({
        databaseFactory: () => database,
        runtimeMode: "local-research",
        clinicalProvider: createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() }),
        literatureProvider: createCapturedGroundedProvider(received),
      });

      const generated = await service.generate({
        referenceRequestId: "r4-multiline-reference-001",
        encounterId: encounter.id,
        expectedUpdatedAt: encounter.updatedAt,
        expectedCurrentRecordRevisionId: revision.id,
        kind: "LITERATURE_GROUNDED",
        question: "循环稳态参考",
        documentIds: [imported.documentId],
      });
      expect(generated.status).toBe("CREATED");
      expect(received).toHaveLength(1);
      const providerInput = received[0];
      expect(providerInput?.evidence).toHaveLength(1);
      const projected = providerInput?.evidence[0]?.excerpt;
      expect(projected).toBe(selectSafeEvidenceExcerpt(rawText, "循环稳态参考"));
      expect(projected).not.toMatch(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u);
      expect(rawText.includes(projected!)).toBe(true);

      const fragment = database.prepare(
        "SELECT fragment_id FROM literature_fragments WHERE document_id = ? AND version_id = ? LIMIT 1",
      ).get(imported.documentId, imported.versionId) as { fragment_id: string };
      const support = database.prepare(
        "SELECT evidence_id, quote FROM model_reference_supports LIMIT 1",
      ).get() as { evidence_id: string; quote: string };
      const controlledEvidence = controlledModelReferenceEvidenceSchema.parse({
        id: support.evidence_id,
        documentId: imported.documentId,
        versionId: imported.versionId,
        fragmentId: fragment.fragment_id,
        displayName: "r4-multiline.txt",
        version: 1,
        excerpt: projected,
        locationLabel: "第 1—3 行",
      });
      expect(new CitationVerifier().verify([controlledEvidence], {
        evidenceId: support.evidence_id,
        quote: support.quote,
      })).toEqual(controlledEvidence);
      expect(projected!.includes(support.quote)).toBe(true);
      expect(rawText.includes(support.quote)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns insufficient evidence without creating a run when all safe fragments are too short", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pwr-08d-r4-no-safe-"));
    try {
      const { encounter, revision } = fixture(database);
      const imported = await importReadyText(database, join(root, "storage"), "查询词\n短句", "r4-no-safe.txt", "r4-no-safe");
      const received: LiteratureGroundedReferenceInput[] = [];
      const before = database.prepare("SELECT updated_at, current_record_revision_id FROM encounters WHERE id = ?").get(encounter.id);
      const service = createModelReferenceService({
        databaseFactory: () => database,
        runtimeMode: "local-research",
        clinicalProvider: createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() }),
        literatureProvider: createCapturedGroundedProvider(received),
      });

      const result = await service.generate({
        referenceRequestId: "r4-no-safe-reference-001",
        encounterId: encounter.id,
        expectedUpdatedAt: encounter.updatedAt,
        expectedCurrentRecordRevisionId: revision.id,
        kind: "LITERATURE_GROUNDED",
        question: "查询词",
        documentIds: [imported.documentId],
      });
      expect(result).toEqual({ status: "INSUFFICIENT_EVIDENCE" });
      expect(received).toHaveLength(0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM model_reference_runs").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM model_reference_followups").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM pre_sign_reviews").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT updated_at, current_record_revision_id FROM encounters WHERE id = ?").get(encounter.id)).toEqual(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("filters an unsafe result and renumbers the remaining evidence from E1", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pwr-08d-r4-renumber-"));
    try {
      const { encounter, revision } = fixture(database);
      const short = await importReadyText(database, join(root, "storage"), "查询词", "a-r4-short.txt", "r4-short");
      const safeOne = await importReadyText(database, join(root, "storage"), "第一份合成资料包含查询词并提供足够长的引用内容。", "b-r4-safe.txt", "r4-safe-one");
      const safeTwo = await importReadyText(database, join(root, "storage"), "第二份合成资料包含查询词并提供另一段足够长的引用内容。", "c-r4-safe.txt", "r4-safe-two");
      const received: LiteratureGroundedReferenceInput[] = [];
      const service = createModelReferenceService({
        databaseFactory: () => database,
        runtimeMode: "local-research",
        clinicalProvider: createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() }),
        literatureProvider: createCapturedGroundedProvider(received),
      });

      const result = await service.generate({
        referenceRequestId: "r4-renumber-reference-001",
        encounterId: encounter.id,
        expectedUpdatedAt: encounter.updatedAt,
        expectedCurrentRecordRevisionId: revision.id,
        kind: "LITERATURE_GROUNDED",
        question: "查询词",
        documentIds: [short.documentId, safeOne.documentId, safeTwo.documentId],
      });
      expect(result.status).toBe("CREATED");
      expect(received).toHaveLength(1);
      expect(received[0]?.evidence.map((item) => item.id)).toEqual(["E1", "E2"]);
      expect(received[0]?.evidence.every((item) => !item.excerpt.match(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u))).toBe(true);
      expect(received[0]?.evidence.every((item) => item.excerpt.length >= 12)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
