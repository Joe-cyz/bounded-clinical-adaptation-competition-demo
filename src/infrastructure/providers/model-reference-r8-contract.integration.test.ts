import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelReferenceRouteHandlers } from "@/server/model-reference-route";
import {
  REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST,
  canonicalEvidenceQuote,
  REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST,
  REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
  REAL_TREATMENT_DIRECTION_ALLOWLIST,
  REAL_VERIFICATION_DIRECTION_ALLOWLIST,
} from "@/domain/model-reference";
import {
  buildSyntheticFixture,
  readFixtureSnapshot,
  removeSyntheticFixtureRoot,
  SYNTHETIC_FILENAME,
  SYNTHETIC_QUERY,
} from "./model-reference-contract-fixture";
import {
  createRealLiteratureAnswerProvider,
  MODEL_REFERENCE_MODEL_ID,
  type ModelReferenceFetch,
  type SafeDeepSeekRequestProvenance,
} from "./model-reference-provider";

const R8_INTEGRATION_TEMP_ROOT = "test-results/model-reference-r8-contract-integration";
const SYNTHETIC_KEY = `sk-${"x".repeat(32)}`;

function requestFor(fixture: Awaited<ReturnType<typeof buildSyntheticFixture>>): Request {
  return new Request("http://127.0.0.1/api/reference/model", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1",
      Host: "127.0.0.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      referenceRequestId: "r8-grounded-contract-001",
      encounterId: fixture.encounterId,
      expectedUpdatedAt: fixture.expectedUpdatedAt,
      expectedCurrentRecordRevisionId: fixture.revisionId,
      kind: "LITERATURE_GROUNDED",
      question: SYNTHETIC_QUERY,
      documentIds: [fixture.documentId],
    }),
  });
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("OFFLINE_R8_NETWORK_FORBIDDEN");
  });
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("PWR-08D-B R8 fake HTTP 200 full-chain contract", () => {
  it("runs the final grounded route/provider chain with four safe roles without medical-record/follow-up/review mutation", async () => {
    let fixture: Awaited<ReturnType<typeof buildSyntheticFixture>> | undefined;
    const providerCalls: Array<{ body: string; url: string }> = [];
    const provenances: SafeDeepSeekRequestProvenance[] = [];
    const providerFailures: string[] = [];
    const fakeFetch: ModelReferenceFetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.method).toBe("POST");
      const body = String(init?.body);
      providerCalls.push({ body, url: String(input) });
      const request = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
      const userContent = request.messages?.[1]?.content;
      expect(typeof userContent).toBe("string");
      const user = JSON.parse(String(userContent)) as {
        facts?: Array<{ id?: unknown }>;
        evidence?: Array<{ id?: unknown; excerpt?: unknown }>;
      };
      const evidence = user.evidence ?? [];
      const recordFactIds = (user.facts ?? []).flatMap((fact) => typeof fact.id === "string" ? [fact.id] : []);
      const quoteTargets = {
        I1: "感染性与非感染性方向进行鉴别",
        I2: "可评估支持性处理、非药物处理和抗感染治疗类别",
        I3: "需核对症状时间线、既往史、用药史及辅助检查",
        I4: "信息不足时应补充检查，不形成确定结论",
      } as const;
      const supportFor = (itemId: keyof typeof quoteTargets) => {
        const quote = quoteTargets[itemId];
        const matched = evidence.find((candidate) => typeof candidate.id === "string"
          && typeof candidate.excerpt === "string"
          && candidate.excerpt.includes(quote));
        if (matched === undefined || typeof matched.id !== "string") throw new Error(`R8_TEST_EVIDENCE_TARGET_MISSING_${itemId}`);
        return matched.id;
      };
      const output = {
        schemaVersion: "1.0.0",
        recordFactIds,
        items: [
          {
            itemId: "I1",
            kind: "CONSIDERATION_DIRECTION",
            text: "可考虑感染性与非感染性原因，由医生结合病程及检查判断。",
            supportEvidenceIds: [supportFor("I1")],
          },
          {
            itemId: "I2",
            kind: "CONSIDERATION_DIRECTION",
            text: "可评估支持性处理方向，由医生结合病情和检查结果决定。",
            supportEvidenceIds: [supportFor("I2")],
          },
          {
            itemId: "I3",
            kind: "NEEDS_VERIFICATION",
            text: "需核对症状时间线、既往史和用药史。",
            supportEvidenceIds: [supportFor("I3")],
          },
          {
            itemId: "I4",
            kind: "ADDITIONAL_CHECK_OR_SOURCE",
            text: "建议医生评估是否需要补充检查或资料。",
            supportEvidenceIds: [supportFor("I4")],
          },
        ],
      };
      return Response.json({
        id: "r8-contract-response",
        model: MODEL_REFERENCE_MODEL_ID,
        system_fingerprint: "r8-contract-fingerprint",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
        usage: {
          prompt_tokens: 101,
          completion_tokens: 64,
          total_tokens: 165,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 94,
        },
      });
    });

    try {
      fixture = await buildSyntheticFixture({ tempRoot: R8_INTEGRATION_TEMP_ROOT });
      const before = readFixtureSnapshot(fixture.database, fixture.encounterId);
      const handlers = createModelReferenceRouteHandlers({
        env: {
          APP_RUNTIME_MODE: "local-research",
          PWR08C_FAKE_FETCH: "false",
          PWR08D_REAL_PROVIDER_ENABLED: "true",
          PWR08D_REAL_REQUEST_LIMIT: "1",
          DEEPSEEK_API_KEY: SYNTHETIC_KEY,
        },
        databaseFactory: () => fixture!.database,
        realProviderObserver: (provenance) => provenances.push({ ...provenance }),
        realProviderFactory: (options) => ({
          clinicalProvider: {
            id: "not-used",
            modelId: MODEL_REFERENCE_MODEL_ID,
            promptVersion: "general-clinical-reference-v1",
            generate: async () => ({ ok: false, code: "PROVIDER_NOT_ENABLED" as const }),
          },
            literatureProvider: createRealLiteratureAnswerProvider({
              ...options,
              fetchImpl: fakeFetch,
              failureObserver: ({ stage }) => providerFailures.push(stage),
            }),
        }),
      });

      const response = await handlers.post(requestFor(fixture));
      expect(response.status).toBe(200);
      const body = await response.json() as { status?: unknown; reference?: Record<string, unknown> };
      expect(providerFailures).toEqual([]);
      expect(body.status).toBe("CREATED");
      expect(body.reference).toBeDefined();
      const reference = body.reference!;
      expect(reference.kind).toBe("LITERATURE_GROUNDED");
      expect(reference.promptVersion).toBe(REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION);
      expect(Array.isArray(reference.items)).toBe(true);
      const items = reference.items as Array<{ id: string; kind?: unknown; text?: unknown; supports: Array<{ evidenceId: string; quote: string }> }>;
      expect(items).toHaveLength(4);
      expect(items.map((item) => item.kind)).toEqual([
        "CONSIDERATION_DIRECTION",
        "CONSIDERATION_DIRECTION",
        "NEEDS_VERIFICATION",
        "ADDITIONAL_CHECK_OR_SOURCE",
      ]);
      expect(REAL_TREATMENT_DIRECTION_ALLOWLIST).toContain(items[1]?.text);
      expect(items.every((item) => Array.isArray(item.supports) && item.supports.length === 1)).toBe(true);

      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(providerCalls).toHaveLength(1);
      const requestBody = JSON.parse(providerCalls[0]!.body) as { messages: Array<{ content: string }> };
      expect(requestBody.messages[0]!.content).toContain(REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION);
      expect(requestBody.messages[0]!.content).toContain("exactly four items in this order");
      expect(requestBody.messages[0]!.content).toContain("supportEvidenceIds array");
      expect(requestBody.messages[0]!.content).not.toContain("supports array");
      expect(requestBody.messages[0]!.content).not.toContain("contiguous substring");
      expect(requestBody.messages[0]!.content).not.toContain("outputContract.support.allowedEvidenceIds");
      for (const text of [
        ...REAL_DIAGNOSTIC_DIRECTION_ALLOWLIST,
        ...REAL_TREATMENT_DIRECTION_ALLOWLIST,
        ...REAL_VERIFICATION_DIRECTION_ALLOWLIST,
        ...REAL_ADDITIONAL_CHECK_OR_SOURCE_ALLOWLIST,
      ]) expect(requestBody.messages[0]!.content).toContain(text);
      expect(requestBody.messages[0]!.content).toContain("Do not rewrite, add a prefix or suffix, merge strings, or use a synonym");
      expect(requestBody.messages[0]!.content).not.toContain("合成资料的连续引用片段");
      expect(requestBody.messages[0]!.content).not.toContain('"quote":"');
      expect(requestBody.messages[0]!.content).not.toContain(SYNTHETIC_KEY);
      expect(requestBody.messages[0]!.content).not.toMatch(/(?:database|storage|runtime\.db|\.codex-tmp)/iu);
      expect(requestBody.messages[0]!.content).not.toContain(SYNTHETIC_FILENAME);
      expect(requestBody.messages[0]!.content).not.toMatch(/(?:姓名|身份证|手机号)/u);
      expect(JSON.stringify(requestBody)).not.toContain(SYNTHETIC_KEY);
      const requestUser = JSON.parse(requestBody.messages[1]!.content) as { evidence?: Array<{ id?: unknown; excerpt?: unknown }> };
      const observedEvidenceIds = new Set<string>();
      for (const [index] of (["I1", "I2", "I3", "I4"] as const).entries()) {
        const item = items[index];
        expect(item).toBeDefined();
        const support = item?.supports[0];
        expect(support).toBeDefined();
        const source = requestUser.evidence?.find((candidate) => candidate.id === support?.evidenceId);
        expect(source).toBeDefined();
        expect(typeof source?.excerpt).toBe("string");
        expect(source?.excerpt).toContain(support?.quote);
        expect(support?.quote).toBe(canonicalEvidenceQuote(String(source?.excerpt)));
        expect(String(source?.excerpt)).toContain(support?.quote);
        observedEvidenceIds.add(support!.evidenceId);
      }
      expect(observedEvidenceIds.size).toBe(1);
      expect(provenances).toHaveLength(1);
      expect(provenances[0]).toMatchObject({
        executionType: "REAL",
        networkUsed: true,
        endpointHost: "api.deepseek.com",
        requestOrdinal: 1,
        promptVersion: REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
        responseModelId: MODEL_REFERENCE_MODEL_ID,
        finishReason: "stop",
      });
      expect(readFixtureSnapshot(fixture.database, fixture.encounterId)).toEqual(before);
      expect((fixture.database.prepare("SELECT COUNT(*) AS count FROM model_reference_followups WHERE encounter_id = ?").get(fixture.encounterId) as { count: number }).count).toBe(0);
      expect((fixture.database.prepare("SELECT COUNT(*) AS count FROM pre_sign_reviews WHERE encounter_id = ?").get(fixture.encounterId) as { count: number }).count).toBe(0);
      expect((fixture.database.prepare("SELECT prompt_version FROM model_reference_runs WHERE encounter_id = ? AND status = 'COMPLETED'").get(fixture.encounterId) as { prompt_version: string }).prompt_version).toBe(REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION);
      expect((fixture.database.prepare("SELECT COUNT(*) AS count FROM model_reference_runs WHERE encounter_id = ? AND status = 'COMPLETED'").get(fixture.encounterId) as { count: number }).count).toBe(1);
    } finally {
      if (fixture?.database.isOpen) fixture.database.close();
      await removeSyntheticFixtureRoot(R8_INTEGRATION_TEMP_ROOT);
    }
  }, 30_000);
});
