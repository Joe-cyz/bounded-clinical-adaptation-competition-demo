import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { resolve } from "node:path";

import { describe, it, vi } from "vitest";

import { createLiteratureRetrievalService } from "@/application/literature-retrieval-service";
import { selectSafeEvidenceExcerpt } from "@/application/model-reference-service";
import {
  REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST,
  REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST,
  REAL_GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
  REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
  REAL_TREATMENT_DIRECTION_ALLOWLIST,
  REAL_VERIFICATION_DIRECTION_ALLOWLIST,
  controlledModelReferenceEvidenceSchema,
} from "@/domain/model-reference";
import { normalizeLiteratureSearchText } from "@/domain/literature-parsing";
import { createLiteratureParsingRepository } from "@/infrastructure/sqlite/repositories/literature-parsing-repository";
import { createLiteratureRepository } from "@/infrastructure/sqlite/repositories/literature-repository";
import { createModelReferenceRouteHandlers } from "@/server/model-reference-route";
import {
  buildSyntheticFixture,
  DEFAULT_SYNTHETIC_TEMP_ROOT,
  GENERAL_REQUEST_ID,
  GROUNDED_REQUEST_ID,
  readFixtureSnapshot,
  removeSyntheticFixtureRoot,
  SYNTHETIC_QUERY,
} from "./model-reference-contract-fixture";
import {
  createRealClinicalReferenceProvider,
  createRealLiteratureAnswerProvider,
  MODEL_REFERENCE_ENDPOINT,
  MODEL_REFERENCE_MODEL_ID,
  type ModelReferenceFetch,
  type RealDeepSeekProviderOptions,
  type SafeDeepSeekRequestProvenance,
} from "./model-reference-provider";

const DIAGNOSTIC_TEMP_ROOT = resolve(DEFAULT_SYNTHETIC_TEMP_ROOT, "..", "pwr-08d-b-r3-diagnostic");
const SYNTHETIC_DEEPSEEK_KEY = `sk-${"x".repeat(32)}`;
const DIAGNOSTIC_ENV = {
  APP_RUNTIME_MODE: "local-research",
  PWR08C_FAKE_FETCH: "false",
  PWR08D_REAL_PROVIDER_ENABLED: "true",
  PWR08D_REAL_REQUEST_LIMIT: "2",
  PWR08D_REAL_SMOKE_AUTHORIZED: "OWNER_AUTHORIZED_EXACTLY_TWO_REQUESTS_R2",
  DEEPSEEK_API_KEY: SYNTHETIC_DEEPSEEK_KEY,
} as const;

const SAFE_ROUTE_ERROR_CODE = /^[A-Z0-9_]{3,80}$/u;
const FORBIDDEN_EVIDENCE_CHARACTER = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;

type DiagnosticStage =
  | "FIXTURE_BUILD"
  | "DIRECT_ENCOUNTER_SCOPE"
  | "DIRECT_DOCUMENT_SCOPE"
  | "DIRECT_PARSE_SCOPE"
  | "DIRECT_FRAGMENT_SCOPE"
  | "DIRECT_RETRIEVAL"
  | "DIRECT_EVIDENCE_PROJECTION"
  | "HANDLER_CREATE"
  | "GENERAL_REQUEST"
  | "GROUNDED_REQUEST"
  | "PERSISTENCE_BOUNDARY"
  | "CLEANUP";

type DiagnosticKind = "GENERAL" | "LITERATURE_GROUNDED";
type DiagnosticSupport = { evidenceId: string; quote: string };
type DiagnosticItem = {
  kind: string;
  text: string;
  factIds: string[];
  supports: DiagnosticSupport[];
};
type DiagnosticCitation = {
  documentId?: string;
  versionId?: string;
  displayName?: string;
  version?: number;
  quote?: string;
};
type DiagnosticReference = {
  encounterId: string;
  recordRevisionId: string;
  kind: DiagnosticKind;
  evidenceLevel: string;
  items: DiagnosticItem[];
  citations: DiagnosticCitation[];
};

function diagnosticFailure(stage: DiagnosticStage, code: string): never {
  const safeCode = SAFE_ROUTE_ERROR_CODE.test(code) ? code : "UNSAFE_OR_UNKNOWN_ROUTE_ERROR";
  throw new Error(`R3_DIAGNOSTIC_${stage}_${safeCode}`);
}

function requireCondition(condition: unknown, stage: DiagnosticStage, code: string): asserts condition {
  if (!condition) diagnosticFailure(stage, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDiagnosticError(error: unknown, stage: DiagnosticStage): Error {
  if (error instanceof Error && /^R3_DIAGNOSTIC_[A-Z0-9_]+$/u.test(error.message)) return error;
  return new Error(`R3_DIAGNOSTIC_${stage}_UNEXPECTED_FAILURE`);
}

function sameSnapshot(
  left: ReturnType<typeof readFixtureSnapshot>,
  right: ReturnType<typeof readFixtureSnapshot>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function count(database: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): number {
  const row = database.prepare(sql).get(...parameters) as { count?: unknown } | undefined;
  const countValue = row?.count;
  if (!Number.isSafeInteger(countValue) || (countValue as number) < 0) {
    diagnosticFailure("PERSISTENCE_BOUNDARY", "DATABASE_COUNT_INVALID");
  }
  return countValue as number;
}

function locationLabel(location: { kind: "PDF_PAGE"; pageNumber: number } | { kind: "TXT_LINES"; startLine: number; endLine: number }): string {
  return location.kind === "PDF_PAGE"
    ? `第 ${location.pageNumber} 页`
    : `第 ${location.startLine}—${location.endLine} 行`;
}

async function readRouteBody(response: Response, stage: DiagnosticStage): Promise<Record<string, unknown>> {
  if (response.status !== 200) {
    let routeErrorCode = "UNSAFE_OR_UNKNOWN_ROUTE_ERROR";
    try {
      const body = await response.json() as unknown;
      if (isRecord(body) && typeof body.errorCode === "string" && SAFE_ROUTE_ERROR_CODE.test(body.errorCode)) {
        routeErrorCode = body.errorCode;
      }
    } catch {
      // Keep the fixed fallback code and never expose a response body.
    }
    diagnosticFailure(stage, routeErrorCode);
  }
  try {
    const body = await response.json() as unknown;
    if (!isRecord(body)) diagnosticFailure(stage, "INVALID_ROUTE_RESPONSE");
    return body;
  } catch {
    diagnosticFailure(stage, "INVALID_ROUTE_RESPONSE");
  }
}

function readReference(body: Record<string, unknown>, kind: DiagnosticKind, stage: DiagnosticStage): DiagnosticReference {
  const referenceValue = body.reference;
  requireCondition(body.status === "CREATED" && isRecord(referenceValue), stage, "REFERENCE_RESULT_INVALID");
  const reference = referenceValue;
  requireCondition(
    typeof reference.encounterId === "string"
      && typeof reference.recordRevisionId === "string"
      && reference.kind === kind
      && typeof reference.evidenceLevel === "string"
      && Array.isArray(reference.items)
      && Array.isArray(reference.citations),
    stage,
    "REFERENCE_RESULT_INVALID",
  );

  const items: DiagnosticItem[] = reference.items.map((item) => {
    requireCondition(isRecord(item), stage, "REFERENCE_ITEM_INVALID");
    requireCondition(
      typeof item.kind === "string"
        && typeof item.text === "string"
        && Array.isArray(item.factIds)
        && item.factIds.every((factId) => typeof factId === "string")
        && Array.isArray(item.supports),
      stage,
      "REFERENCE_ITEM_INVALID",
    );
    const supports: DiagnosticSupport[] = item.supports.map((support) => {
      requireCondition(
        isRecord(support) && typeof support.evidenceId === "string" && typeof support.quote === "string",
        stage,
        "REFERENCE_SUPPORT_INVALID",
      );
      return { evidenceId: support.evidenceId, quote: support.quote };
    });
    return {
      kind: item.kind,
      text: item.text,
      factIds: item.factIds as string[],
      supports,
    };
  });

  const citations: DiagnosticCitation[] = reference.citations.map((citation) => {
    requireCondition(isRecord(citation), stage, "REFERENCE_CITATION_INVALID");
    return {
      ...(typeof citation.documentId === "string" ? { documentId: citation.documentId } : {}),
      ...(typeof citation.versionId === "string" ? { versionId: citation.versionId } : {}),
      ...(typeof citation.displayName === "string" ? { displayName: citation.displayName } : {}),
      ...(typeof citation.version === "number" ? { version: citation.version } : {}),
      ...(typeof citation.quote === "string" ? { quote: citation.quote } : {}),
    };
  });

  return {
    encounterId: reference.encounterId,
    recordRevisionId: reference.recordRevisionId,
    kind,
    evidenceLevel: reference.evidenceLevel,
    items,
    citations,
  };
}

function referenceRequest(
  fixture: Awaited<ReturnType<typeof buildSyntheticFixture>>,
  kind: DiagnosticKind,
): Request {
  return new Request("http://127.0.0.1/api/reference/model", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1",
      Host: "127.0.0.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      referenceRequestId: kind === "GENERAL" ? GENERAL_REQUEST_ID : GROUNDED_REQUEST_ID,
      encounterId: fixture.encounterId,
      expectedUpdatedAt: fixture.expectedUpdatedAt,
      expectedCurrentRecordRevisionId: fixture.revisionId,
      kind,
      question: kind === "GENERAL"
        ? "请结合当前已保存病历，对整个合成病例给出综合判断和诊疗建议。"
        : SYNTHETIC_QUERY,
      ...(kind === "LITERATURE_GROUNDED" ? { documentIds: [fixture.documentId] } : {}),
    }),
  });
}

function assertFourRequiredRoles(items: readonly DiagnosticItem[], stage: DiagnosticStage): void {
  requireCondition(items.length === 4, stage, "ITEM_COUNT_INVALID");
  requireCondition(
    items.map((item) => item.kind).join("|") === "CONSIDERATION_DIRECTION|CONSIDERATION_DIRECTION|NEEDS_VERIFICATION|ADDITIONAL_CHECK_OR_SOURCE",
    stage,
    "ITEM_KINDS_INVALID",
  );
}

describe("PWR-08D-B R3 grounded request offline diagnosis", () => {
  it("reaches grounded retrieval and both model-reference requests without external fetch", async () => {
    let fixture: Awaited<ReturnType<typeof buildSyntheticFixture>> | undefined;
    let stage: DiagnosticStage = "FIXTURE_BUILD";
    let primaryError: Error | undefined;
    let cleanupError: Error | undefined;
    const transportCalls: DiagnosticKind[] = [];
    const provenances: SafeDeepSeekRequestProvenance[] = [];
    const budgets: RealDeepSeekProviderOptions["requestBudget"][] = [];
    const externalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("OFFLINE_GROUNDED_DIAGNOSTIC_NETWORK_FORBIDDEN");
    });

    const localTransport: ModelReferenceFetch = async (input, init) => {
      stage = "HANDLER_CREATE";
      if (String(input) !== MODEL_REFERENCE_ENDPOINT || init?.method !== "POST" || typeof init.body !== "string") {
        diagnosticFailure("HANDLER_CREATE", "TRANSPORT_CONTRACT_INVALID");
      }
      let body: unknown;
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        diagnosticFailure("HANDLER_CREATE", "TRANSPORT_BODY_INVALID");
      }
      requireCondition(isRecord(body) && body.model === MODEL_REFERENCE_MODEL_ID && Array.isArray(body.messages), "HANDLER_CREATE", "TRANSPORT_BODY_INVALID");
      const userMessage = body.messages[1];
      requireCondition(isRecord(userMessage) && typeof userMessage.content === "string", "HANDLER_CREATE", "TRANSPORT_BODY_INVALID");
      const systemMessage = body.messages[0];
      requireCondition(isRecord(systemMessage) && typeof systemMessage.content === "string", "HANDLER_CREATE", "TRANSPORT_BODY_INVALID");
      let prompt: unknown;
      try {
        prompt = JSON.parse(userMessage.content) as unknown;
      } catch {
        diagnosticFailure("HANDLER_CREATE", "TRANSPORT_PROMPT_INVALID");
      }
      requireCondition(isRecord(prompt), "HANDLER_CREATE", "TRANSPORT_PROMPT_INVALID");
      const evidenceValue = prompt.evidence;
      const evidenceArray = Array.isArray(evidenceValue) ? evidenceValue : undefined;
      const kind: DiagnosticKind = evidenceValue === undefined ? "GENERAL" : "LITERATURE_GROUNDED";
      requireCondition(
        systemMessage.content.includes(kind === "GENERAL"
          ? REAL_GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION
          : REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION),
        kind === "GENERAL" ? "GENERAL_REQUEST" : "GROUNDED_REQUEST",
        "PROMPT_VERSION_INVALID",
      );
      if (kind === "GENERAL") {
        requireCondition(evidenceValue === undefined, "GENERAL_REQUEST", "GENERAL_EVIDENCE_UNEXPECTED");
      } else {
        requireCondition(evidenceArray !== undefined && evidenceArray.length > 0, "GROUNDED_REQUEST", "GROUNDED_EVIDENCE_MISSING");
      }
      requireCondition(transportCalls.length < 2, kind === "GENERAL" ? "GENERAL_REQUEST" : "GROUNDED_REQUEST", "TRANSPORT_CALL_LIMIT");
      transportCalls.push(kind);

      const factValue = prompt.facts;
      const requestFactIds = Array.isArray(factValue)
        ? factValue.map((fact) => isRecord(fact) && typeof fact.id === "string" ? fact.id : undefined)
        : [];
      requireCondition(requestFactIds.length > 0 && requestFactIds.every((id): id is string => id !== undefined), "HANDLER_CREATE", "FACTS_INVALID");

      if (kind === "LITERATURE_GROUNDED") {
        const firstEvidence = evidenceArray?.[0];
        requireCondition(isRecord(firstEvidence)
          && typeof firstEvidence.id === "string"
          && typeof firstEvidence.excerpt === "string"
          && Array.from(firstEvidence.excerpt).length >= 12, "GROUNDED_REQUEST", "GROUNDED_EVIDENCE_INVALID");
      }

      const output = {
        schemaVersion: "1.0.0",
        recordFactIds: requestFactIds,
        items: kind === "GENERAL"
          ? [
            { itemId: "I1", kind: "CONSIDERATION_DIRECTION", text: REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST[0] },
            { itemId: "I2", kind: "CONSIDERATION_DIRECTION", text: REAL_TREATMENT_DIRECTION_ALLOWLIST[0] },
            { itemId: "I3", kind: "NEEDS_VERIFICATION", text: REAL_VERIFICATION_DIRECTION_ALLOWLIST[0] },
            { itemId: "I4", kind: "ADDITIONAL_CHECK_OR_SOURCE", text: REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST[0] },
          ]
          : [
            { itemId: "I1", kind: "CONSIDERATION_DIRECTION", text: REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST[0], supportEvidenceIds: ["E1"] },
            { itemId: "I2", kind: "CONSIDERATION_DIRECTION", text: REAL_TREATMENT_DIRECTION_ALLOWLIST[0], supportEvidenceIds: ["E1"] },
            { itemId: "I3", kind: "NEEDS_VERIFICATION", text: REAL_VERIFICATION_DIRECTION_ALLOWLIST[0], supportEvidenceIds: ["E1"] },
            { itemId: "I4", kind: "ADDITIONAL_CHECK_OR_SOURCE", text: REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST[0], supportEvidenceIds: ["E1"] },
          ],
      };

      return Response.json({
        id: "r3-diagnostic-response",
        model: MODEL_REFERENCE_MODEL_ID,
        system_fingerprint: "r3-diagnostic",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
        usage: {
          prompt_tokens: 101,
          completion_tokens: 23,
          total_tokens: 124,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 94,
        },
      });
    };

    try {
      fixture = await buildSyntheticFixture({ tempRoot: DIAGNOSTIC_TEMP_ROOT });

      stage = "DIRECT_ENCOUNTER_SCOPE";
      const encounterRow = fixture.database.prepare(
        "SELECT synthetic, runtime_mode FROM encounters WHERE id = ? LIMIT 1",
      ).get(fixture.encounterId) as { synthetic?: unknown; runtime_mode?: unknown } | undefined;
      requireCondition(encounterRow?.synthetic === 1 && encounterRow.runtime_mode === "local-research", stage, "ENCOUNTER_SCOPE_INVALID");

      stage = "DIRECT_DOCUMENT_SCOPE";
      const literatureRepository = createLiteratureRepository(fixture.database);
      const document = literatureRepository.getDocumentById(fixture.documentId);
      requireCondition(document?.status === "ACTIVE" && document.currentVersionId !== undefined, stage, "DOCUMENT_SCOPE_INVALID");
      const currentVersionId = document.currentVersionId;
      const currentVersionNumber = document.currentVersion;
      const version = literatureRepository.getAvailableVersion(fixture.documentId, currentVersionNumber);
      requireCondition(version?.versionId === currentVersionId && version.documentId === fixture.documentId, stage, "VERSION_SCOPE_INVALID");

      stage = "DIRECT_PARSE_SCOPE";
      const parsingRepository = createLiteratureParsingRepository(fixture.database);
      const readyParseRun = parsingRepository.getReadyParseRunByVersion(currentVersionId);
      requireCondition(
        readyParseRun?.status === "READY"
          && readyParseRun.documentId === fixture.documentId
          && readyParseRun.versionId === currentVersionId,
        stage,
        "PARSE_SCOPE_INVALID",
      );

      stage = "DIRECT_FRAGMENT_SCOPE";
      const fragmentRows = fixture.database.prepare(
        "SELECT fragment_id, normalized_text FROM literature_fragments WHERE document_id = ? AND version_id = ? ORDER BY ordinal ASC, fragment_id ASC",
      ).all(fixture.documentId, currentVersionId) as Array<{ fragment_id?: unknown; normalized_text?: unknown }>;
      const normalizedQuery = normalizeLiteratureSearchText(SYNTHETIC_QUERY);
      requireCondition(fragmentRows.length >= 1, stage, "FRAGMENT_COUNT_INVALID");
      requireCondition(
        fragmentRows.some((row) => typeof row.fragment_id === "string"
          && typeof row.normalized_text === "string"
          && row.normalized_text.includes(normalizedQuery)),
        stage,
        "FRAGMENT_QUERY_SCOPE_INVALID",
      );

      stage = "DIRECT_RETRIEVAL";
      const retrieval = createLiteratureRetrievalService({
        databaseFactory: () => fixture!.database,
        runtimeMode: "local-research",
      });
      const searched = retrieval.search({
        encounterId: fixture.encounterId,
        query: SYNTHETIC_QUERY,
        documentIds: [fixture.documentId],
      });
      requireCondition(searched.status === "RESULTS" && searched.results.length >= 1, stage, "RETRIEVAL_RESULTS_INVALID");
      const evidenceExcerpts: string[] = [];
      for (const result of searched.results) {
        const citation = result.citation;
        requireCondition(
          citation.documentId === fixture.documentId
            && citation.versionId === currentVersionId
            && citation.version === currentVersionNumber
            && citation.excerpt.length >= 1,
          stage,
          "RETRIEVAL_CITATION_SCOPE_INVALID",
        );
      }

      stage = "DIRECT_EVIDENCE_PROJECTION";
      let rawExcerptContainsForbiddenCharacter = false;
      for (const result of searched.results.slice(0, 5)) {
        const citation = result.citation;
        rawExcerptContainsForbiddenCharacter ||= FORBIDDEN_EVIDENCE_CHARACTER.test(citation.excerpt);
        const projectedExcerpt = selectSafeEvidenceExcerpt(citation.excerpt, SYNTHETIC_QUERY);
        if (projectedExcerpt === undefined) diagnosticFailure(stage, "SAFE_EVIDENCE_PROJECTION_MISSING");
        requireCondition(
          !FORBIDDEN_EVIDENCE_CHARACTER.test(projectedExcerpt)
            && citation.excerpt.includes(projectedExcerpt)
            && Array.from(projectedExcerpt).length >= 12
            && Array.from(projectedExcerpt).length <= 600,
          stage,
          "SAFE_EVIDENCE_PROJECTION_INVALID",
        );
        evidenceExcerpts.push(projectedExcerpt);
        const evidence = controlledModelReferenceEvidenceSchema.safeParse({
          id: `E${evidenceExcerpts.length}`,
          documentId: citation.documentId,
          versionId: citation.versionId,
          fragmentId: citation.fragmentId,
          displayName: citation.displayName,
          version: citation.version,
          excerpt: projectedExcerpt,
          locationLabel: locationLabel(citation.location),
        });
        if (!evidence.success) {
          const issuePaths = new Set(evidence.error.issues.map((issue) => issue.path.join(".")));
          diagnosticFailure(stage, issuePaths.has("excerpt")
            ? "EVIDENCE_EXCERPT_INVALID"
            : issuePaths.has("locationLabel")
              ? "EVIDENCE_LOCATION_INVALID"
              : issuePaths.has("fragmentId")
                ? "EVIDENCE_FRAGMENT_INVALID"
                : issuePaths.has("documentId") || issuePaths.has("versionId")
                  ? "EVIDENCE_SOURCE_INVALID"
                : "EVIDENCE_PROJECTION_INVALID");
        }
      }
      requireCondition(rawExcerptContainsForbiddenCharacter, stage, "RAW_EXCERPT_ROOT_CAUSE_NOT_PRESENT");
      requireCondition(externalFetch.mock.calls.length === 0, stage, "GLOBAL_FETCH_UNEXPECTED");

      stage = "HANDLER_CREATE";
      const handlers = createModelReferenceRouteHandlers({
        env: DIAGNOSTIC_ENV,
        databaseFactory: () => fixture!.database,
        realProviderObserver: (provenance) => {
          provenances.push({ ...provenance });
        },
        realProviderFactory: (options: RealDeepSeekProviderOptions) => {
          budgets.push(options.requestBudget);
          const adjusted: RealDeepSeekProviderOptions = { ...options, fetchImpl: localTransport };
          return {
            clinicalProvider: createRealClinicalReferenceProvider(adjusted),
            literatureProvider: createRealLiteratureAnswerProvider(adjusted),
          };
        },
      });

      const beforeRoutes = readFixtureSnapshot(fixture.database, fixture.encounterId);

      stage = "GENERAL_REQUEST";
      const generalBody = await readRouteBody(await handlers.post(referenceRequest(fixture, "GENERAL")), stage);
      const generalReference = readReference(generalBody, "GENERAL", stage);
      requireCondition(
        generalReference.encounterId === fixture.encounterId
          && generalReference.recordRevisionId === fixture.revisionId
          && generalReference.evidenceLevel === "GENERAL_MODEL_NO_LOCAL_EVIDENCE"
          && generalReference.citations.length === 0,
        stage,
        "GENERAL_BOUNDARY_INVALID",
      );
      assertFourRequiredRoles(generalReference.items, stage);
      requireCondition(sameSnapshot(beforeRoutes, readFixtureSnapshot(fixture.database, fixture.encounterId)), stage, "GENERAL_RECORD_CHANGED");

      stage = "GROUNDED_REQUEST";
      const groundedBody = await readRouteBody(await handlers.post(referenceRequest(fixture, "LITERATURE_GROUNDED")), stage);
      const groundedReference = readReference(groundedBody, "LITERATURE_GROUNDED", stage);
      requireCondition(
        groundedReference.encounterId === fixture.encounterId
          && groundedReference.recordRevisionId === fixture.revisionId
          && groundedReference.evidenceLevel === "SELECTED_LOCAL_LITERATURE"
          && groundedReference.citations.length >= 1,
        stage,
        "GROUNDED_BOUNDARY_INVALID",
      );
      assertFourRequiredRoles(groundedReference.items, stage);
      requireCondition(
        groundedReference.items.every((item) => item.supports.length >= 1
          && item.supports.every((support) => evidenceExcerpts.some((excerpt) => excerpt.includes(support.quote)))),
        stage,
        "GROUNDED_SUPPORT_INVALID",
      );
      requireCondition(
        groundedReference.citations.every((citation) => citation.displayName === document.displayName
          && citation.version === currentVersionNumber
          && typeof citation.quote === "string"
          && evidenceExcerpts.some((excerpt) => excerpt.includes(citation.quote as string))),
        stage,
        "GROUNDED_CITATION_INVALID",
      );
      requireCondition(sameSnapshot(beforeRoutes, readFixtureSnapshot(fixture.database, fixture.encounterId)), stage, "GROUNDED_RECORD_CHANGED");

      stage = "PERSISTENCE_BOUNDARY";
      requireCondition(transportCalls.length === 2
        && transportCalls[0] === "GENERAL"
        && transportCalls[1] === "LITERATURE_GROUNDED", stage, "TRANSPORT_ORDER_INVALID");
      requireCondition(budgets.length === 2 && budgets[0] === budgets[1] && budgets[0]?.used === 2, stage, "REQUEST_BUDGET_INVALID");
      requireCondition(provenances.length === 2
        && provenances[0]?.requestOrdinal === 1
        && provenances[1]?.requestOrdinal === 2
        && provenances.every((provenance) => provenance.responseModelId === MODEL_REFERENCE_MODEL_ID && provenance.finishReason === "stop"), stage, "PROVENANCE_INVALID");
      requireCondition(count(fixture.database, "SELECT COUNT(*) AS count FROM model_reference_runs WHERE encounter_id = ?", fixture.encounterId) === 2, stage, "RUN_COUNT_INVALID");
      requireCondition(count(fixture.database, "SELECT COUNT(*) AS count FROM model_reference_runs WHERE encounter_id = ? AND status = 'COMPLETED'", fixture.encounterId) === 2, stage, "RUN_STATUS_INVALID");
      requireCondition(count(fixture.database, "SELECT COUNT(*) AS count FROM model_reference_supports") >= 3, stage, "SUPPORT_SCOPE_INVALID");
      requireCondition(count(fixture.database, "SELECT COUNT(*) AS count FROM model_reference_followups WHERE encounter_id = ?", fixture.encounterId) === 0, stage, "FOLLOW_UP_CREATED");
      requireCondition(count(fixture.database, "SELECT COUNT(*) AS count FROM pre_sign_reviews WHERE encounter_id = ?", fixture.encounterId) === 0, stage, "REVIEW_CREATED");
      const supportRows = fixture.database.prepare(
        "SELECT document_id, version_id, fragment_id, quote FROM model_reference_supports WHERE item_id IN (SELECT item_id FROM model_reference_items WHERE reference_id IN (SELECT reference_id FROM model_reference_runs WHERE encounter_id = ? AND kind = 'LITERATURE_GROUNDED'))",
      ).all(fixture.encounterId) as Array<{ document_id?: unknown; version_id?: unknown; fragment_id?: unknown; quote?: unknown }>;
      requireCondition(supportRows.length >= 3 && supportRows.every((row) => row.document_id === fixture!.documentId
        && row.version_id === currentVersionId
        && typeof row.fragment_id === "string"
        && typeof row.quote === "string"
        && evidenceExcerpts.some((excerpt) => excerpt.includes(row.quote as string))), stage, "SUPPORT_PERSISTENCE_INVALID");
      requireCondition(externalFetch.mock.calls.length === 0, stage, "GLOBAL_FETCH_UNEXPECTED");
    } catch (error) {
      primaryError = safeDiagnosticError(error, stage);
    } finally {
      try {
        if (fixture?.database.isOpen) fixture.database.close();
      } catch {
        cleanupError = new Error("R3_DIAGNOSTIC_CLEANUP_DATABASE_CLOSE_FAILED");
      }
      try {
        const residualCount = await removeSyntheticFixtureRoot(DIAGNOSTIC_TEMP_ROOT);
        if (residualCount !== 0) cleanupError = new Error("R3_DIAGNOSTIC_CLEANUP_TEMP_RESIDUAL");
      } catch {
        cleanupError = new Error("R3_DIAGNOSTIC_CLEANUP_TEMP_FAILED");
      }
      externalFetch.mockRestore();
    }

    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
  }, 30_000);
});
