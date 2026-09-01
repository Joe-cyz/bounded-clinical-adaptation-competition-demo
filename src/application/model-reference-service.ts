import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ClinicalReferenceProvider, LiteratureAnswerProvider } from "@/application/ports/model-reference-provider";
import { createLiteratureRetrievalService, LiteratureCitationResolver } from "@/application/literature-retrieval-service";
import { normalizeLiteratureSearchText } from "@/domain/literature-parsing";
import {
  controlledModelReferenceEvidenceSchema,
  controlledModelReferenceFactSchema,
  modelReferenceFollowUpRequestSchema,
  modelReferenceRequestSchema,
  type ControlledModelReferenceEvidence,
  type ControlledModelReferenceFact,
  type ModelReferenceKind,
  type ModelReferenceRequest,
  type ModelReferenceStoredResult,
} from "@/domain/model-reference";
import { encounterSourceOf, type EncounterRecord } from "@/domain/encounter";
import {
  assertEncounterRecordPayloadBinding,
  EncounterRecordBindingError,
  parseEncounterRecordPayload,
  type EncounterRecordPayload,
} from "@/domain/manual-synthetic-record";
import { getDatabase } from "@/server/database";
import { PersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { createModelReferenceRepository, type ModelReferenceRun } from "@/infrastructure/sqlite/repositories/model-reference-repository";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { createRandomSystemId } from "./system-id";

export const MODEL_REFERENCE_ERROR_CODES = {
  PUBLIC_READ_ONLY: "PUBLIC_DEMO_READ_ONLY",
  INVALID_REQUEST: "MODEL_REFERENCE_INVALID_REQUEST",
  INSUFFICIENT_EVIDENCE: "MODEL_REFERENCE_INSUFFICIENT_EVIDENCE",
  IN_PROGRESS: "MODEL_REFERENCE_IN_PROGRESS",
  STALE: "MODEL_REFERENCE_STALE",
  PROVIDER_NOT_ENABLED: "MODEL_REFERENCE_PROVIDER_NOT_ENABLED",
  PROVIDER_FAILED: "MODEL_REFERENCE_PROVIDER_FAILED",
  CONFLICT: "MODEL_REFERENCE_CONFLICT",
} as const;

export type ModelReferenceServiceDependencies = {
  databaseFactory?: () => DatabaseSync;
  runtimeMode?: "local-research" | "public-demo";
  env?: Pick<NodeJS.ProcessEnv, "APP_RUNTIME_MODE">;
  clinicalProvider: ClinicalReferenceProvider;
  literatureProvider: LiteratureAnswerProvider;
  clock?: () => string;
  idFactory?: (kind: "REFERENCE" | "ITEM" | "SUPPORT" | "FOLLOW_UP") => string;
};

export type ModelReferenceView = ModelReferenceStoredResult & {
  stale: boolean;
  staleMessage?: string;
  factSummaries: Array<{ itemId: string; facts: ControlledModelReferenceFact[] }>;
  citations: Array<{ itemId: string; displayName: string; version: number; locationLabel: string; quote: string }>;
};

type GenerateResult =
  | { status: "CREATED" | "REPLAYED"; reference: ModelReferenceView }
  | { status: "IN_PROGRESS" }
  | { status: "INSUFFICIENT_EVIDENCE" }
  | { status: "FAILED"; errorCode: string };

const defaultClock = () => new Date().toISOString();
const defaultIdFactory = (kind: "REFERENCE" | "ITEM" | "SUPPORT" | "FOLLOW_UP") => createRandomSystemId(`model-reference-${kind.toLowerCase()}`);
const questionInjectionPattern = /(?:忽略(?:以上|此前|指令)|ignore\s+(?:previous|instructions)|system\s+prompt|developer\s+message)/iu;
const unsafeEvidenceCharacterPattern = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;

/** Selects a bounded excerpt without changing the source characters or joining source fragments. */
export function selectSafeEvidenceExcerpt(rawExcerpt: string, query: string): string | undefined {
  const normalizedQuery = normalizeLiteratureSearchText(query);
  const candidates = rawExcerpt.split(unsafeEvidenceCharacterPattern).flatMap((segment, order) => {
    const trimmed = segment.trim();
    const characters = Array.from(trimmed);
    if (characters.length < 12) return [];
    const value = characters.length > 600 ? characters.slice(0, 600).join("") : trimmed;
    if (!rawExcerpt.includes(value) || unsafeEvidenceCharacterPattern.test(value)) return [];
    return [{
      value,
      order,
      matchesQuery: normalizedQuery.length > 0
        && normalizeLiteratureSearchText(value).includes(normalizedQuery),
    }];
  });
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => {
    if (left.matchesQuery !== right.matchesQuery) return left.matchesQuery ? -1 : 1;
    const lengthDifference = Array.from(right.value).length - Array.from(left.value).length;
    return lengthDifference !== 0 ? lengthDifference : left.order - right.order;
  });
  return candidates[0]?.value;
}

/** Validates identifier membership and literal quote containment only; it does not claim medical entailment. */
export class CitationVerifier {
  verify(
    evidence: readonly ControlledModelReferenceEvidence[],
    support: { evidenceId: string; quote: string },
  ): ControlledModelReferenceEvidence {
    const matched = evidence.find((item) => item.id === support.evidenceId);
    if (!matched || !matched.excerpt.includes(support.quote)) {
      throw safeError(MODEL_REFERENCE_ERROR_CODES.PROVIDER_FAILED, "supports");
    }
    return matched;
  }
}

function localMode(dependencies: Pick<ModelReferenceServiceDependencies, "runtimeMode" | "env">): "local-research" {
  const mode = dependencies.runtimeMode ?? dependencies.env?.APP_RUNTIME_MODE ?? process.env.APP_RUNTIME_MODE;
  if (mode !== "local-research") {
    throw new PersistenceError(persistenceErrorCodes.RUNTIME_READ_ONLY, "公开演示不允许生成模型参考。", { ruleId: MODEL_REFERENCE_ERROR_CODES.PUBLIC_READ_ONLY });
  }
  return mode;
}

function safeError(code: string, fieldPath?: string): PersistenceError {
  return new PersistenceError(
    code === MODEL_REFERENCE_ERROR_CODES.STALE || code === MODEL_REFERENCE_ERROR_CODES.CONFLICT ? persistenceErrorCodes.CONFLICT : persistenceErrorCodes.VALIDATION_FAILED,
    code === MODEL_REFERENCE_ERROR_CODES.STALE ? "病历或资料已更新，请重新生成。" : "模型参考请求未通过受控校验。",
    { ...(fieldPath === undefined ? {} : { fieldPath }), ruleId: code },
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function safeFieldValue(field: { status: string; value?: string | string[] }): string {
  const value = Array.isArray(field.value) ? field.value.join("；") : field.value;
  const text = value?.trim() || "未提供";
  return truncateCodePoints(text, 300);
}

function safeFieldText(label: string, field: { status: string; value?: string | string[] }): string {
  return truncateCodePoints(`${label}：${safeFieldValue(field)}`, 300);
}

export function projectProviderFacts(facts: readonly ControlledModelReferenceFact[]): Array<Pick<ControlledModelReferenceFact, "id" | "text">> {
  return facts.map(({ id, label, text }) => {
    const prefix = `${label}：`;
    const remaining = Math.max(0, 300 - Array.from(prefix).length);
    return { id, text: `${prefix}${truncateCodePoints(text, remaining)}` };
  });
}

function projectFacts(record: EncounterRecordPayload): ControlledModelReferenceFact[] {
  const physical = [
    safeFieldText("一般情况", record.physicalExam.generalCondition),
    safeFieldText("专科检查", record.physicalExam.specialtyExam),
  ].join("；");
  const vital = record.physicalExam.vitalSigns.value;
  const vitalText = vital === undefined
    ? "未提供"
    : `体温${vital.temperatureC ?? "未提供"}；血压${vital.systolicBpMmhg ?? "未提供"}/${vital.diastolicBpMmhg ?? "未提供"}；脉搏${vital.pulseBpm ?? "未提供"}`;
  const auxiliary = Object.entries(record.auxiliaryExams).map(([name, field]) => safeFieldText(name, field)).join("；");
  const values: Array<[ControlledModelReferenceFact["id"], string, string]> = [
    ["M1", "主诉", safeFieldValue(record.history.chiefComplaint)],
    ["M2", "现病史", safeFieldValue(record.history.presentIllness)],
    ["M3", "过敏史", safeFieldValue(record.history.allergyHistory)],
    ["M4", "当前用药", safeFieldValue(record.history.currentMedications)],
    ["M5", "危险信号", safeFieldValue(record.history.redFlags)],
    ["M6", "问题事实", safeFieldValue(record.history.problemFacts)],
    ["M7", "近期变化", safeFieldValue(record.history.recentChanges)],
    ["M8", "体格检查", physical],
    ["M9", "生命体征", vitalText],
    ["M10", "辅助检查", auxiliary],
    ["M11", "待补充信息", safeFieldValue(record.missingInformation)],
    ["M12", "待核对信息", record.pendingInformation.length > 0 ? record.pendingInformation.map((item) => item.description).join("；").slice(0, 300) : "未提供"],
  ];
  const facts = values.map(([id, label, text]) => controlledModelReferenceFactSchema.parse({ id, label, text }));
  if (scanSuspectedPii(facts).length > 0) throw safeError(MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST, "facts");
  return facts;
}

function locationLabel(location: { kind: "PDF_PAGE"; pageNumber: number } | { kind: "TXT_LINES"; startLine: number; endLine: number }): string {
  return location.kind === "PDF_PAGE" ? `第 ${location.pageNumber} 页` : `第 ${location.startLine}—${location.endLine} 行`;
}

function currentRecord(database: DatabaseSync, encounterId: string): { encounter: EncounterRecord; revisionId: string; revisionNumber: number; record: EncounterRecordPayload } {
  const encounter = createEncounterRepository(database).getById(encounterId);
  if (!encounter || encounter.synthetic !== true || encounter.runtimeMode !== "local-research" || encounter.currentRecordRevisionId === undefined) {
    throw new PersistenceError(persistenceErrorCodes.NOT_FOUND, "当前合成接诊不存在。", { fieldPath: "encounterId" });
  }
  const revision = createEncounterRecordRevisionRepository(database).getLatestByEncounter(encounterId);
  if (!revision || revision.id !== encounter.currentRecordRevisionId) throw safeError(MODEL_REFERENCE_ERROR_CODES.STALE, "currentRecordRevisionId");
  let record: EncounterRecordPayload;
  try {
    record = parseEncounterRecordPayload(revision.recordPayload);
  } catch {
    throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "当前病历无法安全读取。", { fieldPath: "recordPayload" });
  }
  try {
    assertEncounterRecordPayloadBinding({
      encounter,
      source: encounterSourceOf(encounter),
      record,
    });
  } catch (error) {
    if (error instanceof EncounterRecordBindingError) {
      throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "当前病历无法安全读取。", { fieldPath: "source" });
    }
    throw error;
  }
  return { encounter, revisionId: revision.id, revisionNumber: revision.revisionNumber, record };
}

function viewFor(database: DatabaseSync, run: ModelReferenceRun): ModelReferenceView {
  const repository = createModelReferenceRepository(database);
  const items = repository.listItems(run.referenceId);
  const supports = repository.listSupports(run.referenceId);
  const current = currentRecord(database, run.encounterId);
  const originalRevision = createEncounterRecordRevisionRepository(database).getById(run.recordRevisionId);
  if (!originalRevision) throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "模型参考缺少病历修订。", { fieldPath: "recordRevisionId" });
  if (originalRevision.encounterId !== run.encounterId) {
    throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "模型参考缺少匹配的病历修订。", { fieldPath: "recordRevisionId" });
  }
  let originalRecord: EncounterRecordPayload;
  try {
    originalRecord = parseEncounterRecordPayload(originalRevision.recordPayload);
  } catch {
    throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "模型参考病历修订无法安全读取。", { fieldPath: "recordRevisionId" });
  }
  try {
    assertEncounterRecordPayloadBinding({
      encounter: current.encounter,
      source: encounterSourceOf(current.encounter),
      record: originalRecord,
    });
  } catch (error) {
    if (error instanceof EncounterRecordBindingError) {
      throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "模型参考病历修订无法安全读取。", { fieldPath: "recordRevisionId" });
    }
    throw error;
  }
  const originalFacts = new Map(projectFacts(originalRecord).map((fact) => [fact.id, fact]));
  let stale = current.revisionId !== run.recordRevisionId || current.revisionNumber !== run.revisionNumber;
  const citations: ModelReferenceView["citations"] = [];
  if (!stale && run.kind === "LITERATURE_GROUNDED") {
    const resolver = new LiteratureCitationResolver(database);
    for (const support of supports) {
      try {
        const citation = resolver.resolve(support);
        citations.push({ itemId: support.itemId, displayName: citation.displayName, version: citation.version, locationLabel: locationLabel(citation.location), quote: support.quote });
      } catch {
        stale = true;
        break;
      }
    }
  }
  const result = {
    referenceId: run.referenceId,
    requestId: run.referenceRequestId,
    encounterId: run.encounterId,
    recordRevisionId: run.recordRevisionId,
    revisionNumber: run.revisionNumber,
    kind: run.kind,
    evidenceLevel: run.evidenceLevel,
    question: run.question,
    providerId: run.providerId ?? "offline-fake-fetch",
    modelId: run.modelId ?? "deepseek-v4-flash",
    promptVersion: run.promptVersion,
    promptDigest: run.promptDigest ?? sha256("pending"),
    createdAt: run.createdAt,
    items: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      factIds: item.factIds,
      supports: supports.filter((support) => support.itemId === item.id).map(({ evidenceId, quote }) => ({ evidenceId, quote })),
    })),
  } satisfies ModelReferenceStoredResult;
  return {
    ...result,
    stale,
    ...(stale ? { staleMessage: "病历或资料已更新，请重新生成。" } : {}),
    factSummaries: [{
      itemId: "record-facts",
      facts: [...new Set(items.flatMap((item) => item.factIds))].flatMap((id) => {
        const fact = originalFacts.get(id);
        return fact === undefined ? [] : [fact];
      }),
    }],
    citations,
  };
}

function requestFingerprint(request: ModelReferenceRequest): string {
  return sha256(JSON.stringify({
    encounterId: request.encounterId,
    expectedUpdatedAt: request.expectedUpdatedAt,
    expectedCurrentRecordRevisionId: request.expectedCurrentRecordRevisionId,
    kind: request.kind,
    question: request.question.trim(),
    documentIds: [...(request.documentIds ?? [])].sort(),
  }));
}

function validateRequest(value: unknown): ModelReferenceRequest {
  const parsed = modelReferenceRequestSchema.safeParse(value);
  if (!parsed.success || scanSuspectedPii(parsed.success ? parsed.data.question : value).length > 0
    || (parsed.success && questionInjectionPattern.test(parsed.data.question))) {
    throw safeError(MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST, "request");
  }
  return parsed.data;
}

export function createModelReferenceService(dependencies: ModelReferenceServiceDependencies) {
  const databaseFactory = dependencies.databaseFactory ?? getDatabase;
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;

  async function generate(value: unknown): Promise<GenerateResult> {
    localMode(dependencies);
    const request = validateRequest(value);
    const database = databaseFactory();
    const current = currentRecord(database, request.encounterId);
    if (current.encounter.updatedAt !== request.expectedUpdatedAt || current.revisionId !== request.expectedCurrentRecordRevisionId) {
      throw safeError(MODEL_REFERENCE_ERROR_CODES.STALE, "expectedUpdatedAt");
    }
    const facts = projectFacts(current.record);
    const evidence: ControlledModelReferenceEvidence[] = [];
    if (request.kind === "LITERATURE_GROUNDED") {
      const retrieval = createLiteratureRetrievalService({ databaseFactory: () => database, runtimeMode: "local-research" });
      const searched = retrieval.search({ encounterId: request.encounterId, query: request.question, documentIds: request.documentIds });
      if (searched.status !== "RESULTS") return { status: "INSUFFICIENT_EVIDENCE" };
      for (const result of searched.results) {
        if (evidence.length >= 5) break;
        const excerpt = selectSafeEvidenceExcerpt(result.citation.excerpt, request.question);
        if (excerpt === undefined) continue;
        evidence.push(controlledModelReferenceEvidenceSchema.parse({
          id: `E${evidence.length + 1}`,
          documentId: result.citation.documentId,
          versionId: result.citation.versionId,
          fragmentId: result.citation.fragmentId,
          displayName: result.citation.displayName,
          version: result.citation.version,
          excerpt,
          locationLabel: locationLabel(result.citation.location),
        }));
      }
      if (evidence.length === 0) return { status: "INSUFFICIENT_EVIDENCE" };
    }
    const fingerprint = requestFingerprint(request);
    const documentsFingerprint = sha256(JSON.stringify(evidence.map((item) => [item.documentId, item.versionId, item.fragmentId])));
    const selectedPromptVersion = request.kind === "GENERAL"
      ? dependencies.clinicalProvider.promptVersion
      : dependencies.literatureProvider.promptVersion;
    const reservation = withTransaction(database, () => {
      const repository = createModelReferenceRepository(database);
      const existing = repository.getByRequestId(request.referenceRequestId);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw safeError(MODEL_REFERENCE_ERROR_CODES.CONFLICT, "referenceRequestId");
        return { kind: "EXISTING" as const, run: existing };
      }
      const now = clock();
      const run: ModelReferenceRun = {
        referenceId: idFactory("REFERENCE"),
        referenceRequestId: request.referenceRequestId,
        requestFingerprint: fingerprint,
        encounterId: request.encounterId,
        recordRevisionId: current.revisionId,
        revisionNumber: current.revisionNumber,
        kind: request.kind,
        evidenceLevel: request.kind === "GENERAL" ? "GENERAL_MODEL_NO_LOCAL_EVIDENCE" : "SELECTED_LOCAL_LITERATURE",
        question: request.question.trim(),
        documentsFingerprint,
        promptVersion: selectedPromptVersion,
        status: "IN_PROGRESS",
        createdAt: now,
        updatedAt: now,
      };
      repository.insertRun(run);
      return { kind: "NEW" as const, run };
    });
    if (reservation.kind === "EXISTING") {
      if (reservation.run.status === "COMPLETED") return { status: "REPLAYED", reference: viewFor(database, reservation.run) };
      if (reservation.run.status === "IN_PROGRESS") return { status: "IN_PROGRESS" };
      return { status: "FAILED", errorCode: reservation.run.failureCode ?? MODEL_REFERENCE_ERROR_CODES.PROVIDER_FAILED };
    }
    const providerFacts = projectProviderFacts(facts);
    const providerResult = request.kind === "GENERAL"
      ? await dependencies.clinicalProvider.generate({
        kind: "GENERAL",
        promptVersion: dependencies.clinicalProvider.promptVersion,
        question: reservation.run.question,
        facts: providerFacts,
        evidence: [],
      })
      : await dependencies.literatureProvider.generate({
        kind: "LITERATURE_GROUNDED",
        promptVersion: dependencies.literatureProvider.promptVersion,
        question: reservation.run.question,
        facts: providerFacts,
        evidence: evidence.map(({ id, excerpt }) => ({ id, excerpt })) as [
          { id: ControlledModelReferenceEvidence["id"]; excerpt: string },
          ...Array<{ id: ControlledModelReferenceEvidence["id"]; excerpt: string }>,
        ],
      });
    if (!providerResult.ok) {
      withTransaction(database, () => createModelReferenceRepository(database).markFailed(reservation.run.referenceId, providerResult.code, clock()));
      return { status: "FAILED", errorCode: providerResult.code === "PROVIDER_NOT_ENABLED" ? MODEL_REFERENCE_ERROR_CODES.PROVIDER_NOT_ENABLED : MODEL_REFERENCE_ERROR_CODES.PROVIDER_FAILED };
    }
    const completed = withTransaction(database, () => {
      const latest = currentRecord(database, request.encounterId);
      if (latest.revisionId !== reservation.run.recordRevisionId || latest.encounter.updatedAt !== request.expectedUpdatedAt) {
        throw safeError(MODEL_REFERENCE_ERROR_CODES.STALE, "currentRecordRevisionId");
      }
      const repository = createModelReferenceRepository(database);
      const citationVerifier = new CitationVerifier();
      providerResult.output.items.forEach((item, index) => {
        const itemId = idFactory("ITEM");
        repository.insertItem({ id: itemId, referenceId: reservation.run.referenceId, ordinal: index + 1, kind: item.kind, text: item.text, factIds: providerResult.output.recordFactIds });
        if (request.kind === "LITERATURE_GROUNDED") {
          const groundedItem = item as unknown as { supports: Array<{ evidenceId: string; quote: string }> };
          for (const support of groundedItem.supports) {
            const evidenceItem = citationVerifier.verify(evidence, support);
            repository.insertSupport({
              id: idFactory("SUPPORT"), itemId, evidenceId: support.evidenceId as ControlledModelReferenceEvidence["id"], quote: support.quote,
              documentId: evidenceItem.documentId, versionId: evidenceItem.versionId, fragmentId: evidenceItem.fragmentId,
            });
          }
        }
      });
      repository.markCompleted({ referenceId: reservation.run.referenceId, promptDigest: providerResult.promptDigest, providerId: request.kind === "GENERAL" ? dependencies.clinicalProvider.id : dependencies.literatureProvider.id, modelId: request.kind === "GENERAL" ? dependencies.clinicalProvider.modelId : dependencies.literatureProvider.modelId, completedAt: clock() });
      const run = repository.getById(reservation.run.referenceId);
      if (!run || run.status !== "COMPLETED") throw new PersistenceError(persistenceErrorCodes.DATA_CORRUPTION, "模型参考结果无法安全保存。");
      return viewFor(database, run);
    });
    return { status: "CREATED", reference: completed };
  }

  function get(referenceId: string): ModelReferenceView | undefined {
    localMode(dependencies);
    const database = databaseFactory();
    const run = createModelReferenceRepository(database).getById(referenceId);
    return run?.status === "COMPLETED" ? viewFor(database, run) : undefined;
  }

  function getLatestForEncounter(encounterId: string, kind: ModelReferenceKind): ModelReferenceView | undefined {
    localMode(dependencies);
    const database = databaseFactory();
    const run = createModelReferenceRepository(database).getLatestCompletedByEncounter(encounterId, kind);
    return run === undefined ? undefined : viewFor(database, run);
  }

  function selectFollowUp(value: unknown): { status: "CREATED" | "REPLAYED" } {
    localMode(dependencies);
    const request = modelReferenceFollowUpRequestSchema.safeParse(value);
    if (!request.success) throw safeError(MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST, "followUp");
    const database = databaseFactory();
    return withTransaction(database, () => {
      const current = currentRecord(database, request.data.encounterId);
      if (current.encounter.updatedAt !== request.data.expectedUpdatedAt) throw safeError(MODEL_REFERENCE_ERROR_CODES.STALE, "expectedUpdatedAt");
      const repository = createModelReferenceRepository(database);
      const run = repository.getById(request.data.referenceId);
      if (!run || run.status !== "COMPLETED" || run.encounterId !== current.encounter.id || run.recordRevisionId !== current.revisionId) {
        throw safeError(MODEL_REFERENCE_ERROR_CODES.STALE, "referenceId");
      }
      if (viewFor(database, run).stale) throw safeError(MODEL_REFERENCE_ERROR_CODES.STALE, "referenceId");
      const existingReview = database.prepare(
        "SELECT id FROM pre_sign_reviews WHERE encounter_id = ? AND record_revision_id = ? LIMIT 1",
      ).get(current.encounter.id, current.revisionId);
      if (existingReview !== undefined) throw safeError(MODEL_REFERENCE_ERROR_CODES.CONFLICT, "preSignReview");
      const item = repository.listItems(run.referenceId).find((candidate) => candidate.id === request.data.itemId);
      if (!item || item.kind !== "NEEDS_VERIFICATION") throw safeError(MODEL_REFERENCE_ERROR_CODES.INVALID_REQUEST, "itemId");
      const priorRequest = repository.getFollowUpByRequestId(request.data.followUpRequestId);
      if (priorRequest) return { status: "REPLAYED" as const };
      if (repository.getFollowUpByReferenceItem(run.referenceId, item.id)) return { status: "REPLAYED" as const };
      repository.insertFollowUp({
        followUpId: idFactory("FOLLOW_UP"), followUpRequestId: request.data.followUpRequestId,
        referenceId: run.referenceId, itemId: item.id, encounterId: run.encounterId, recordRevisionId: run.recordRevisionId,
        itemKind: "NEEDS_VERIFICATION", status: "SELECTED", createdAt: clock(),
      });
      return { status: "CREATED" as const };
    });
  }

  return { generate, get, getLatestForEncounter, selectFollowUp };
}

/** Distinct Scheme-B boundary: it always forces GENERAL and never accepts documents. */
export class ClinicalReferenceService {
  constructor(private readonly workflow: ReturnType<typeof createModelReferenceService>) {}

  generate(value: Omit<ModelReferenceRequest, "kind" | "documentIds">): Promise<GenerateResult> {
    return this.workflow.generate({ ...value, kind: "GENERAL" });
  }
}

/** Distinct evidence-bound boundary: it always forces LITERATURE_GROUNDED. */
export class LiteratureGroundedAnswerService {
  constructor(private readonly workflow: ReturnType<typeof createModelReferenceService>) {}

  generate(value: Omit<ModelReferenceRequest, "kind"> & { documentIds: string[] }): Promise<GenerateResult> {
    return this.workflow.generate({ ...value, kind: "LITERATURE_GROUNDED" });
  }
}

/** Explicit physician-click boundary; it never writes a medical record or auto-creates a review. */
export class ReferenceFollowUpService {
  constructor(private readonly workflow: ReturnType<typeof createModelReferenceService>) {}

  select(value: unknown): { status: "CREATED" | "REPLAYED" } {
    return this.workflow.selectFollowUp(value);
  }
}
