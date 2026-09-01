import { describe, expect, it } from "vitest";

import { compileComparisonConfigs } from "@/domain/effective-config";
import { projectCanonicalDraftSections } from "@/domain/draft-projection";
import { syntheticCases, physicianProfiles, institutionalSafetyCore, specialtyVisitPolicies, seedManifest } from "@/data/seed-loader";
import { createDeepSeekProvider, DEEPSEEK_CHAT_COMPLETIONS_URL, DEEPSEEK_MAX_TOKENS, DEEPSEEK_MODEL_ID } from "./deepseek-provider";
import type { ProviderInput } from "@/application/ports/llm-provider";

function fakeKey(): string {
  return ["sk", "a".repeat(32)].join("-");
}

function input(): ProviderInput {
  const caseData = syntheticCases[0];
  const profile = physicianProfiles[0];
  const compiled = compileComparisonConfigs({
    caseData,
    safetyCore: institutionalSafetyCore,
    policies: specialtyVisitPolicies,
    datasetVersion: seedManifest.datasetVersion,
    profile,
  });
  if (!compiled.ok) throw new Error("test configuration did not compile");
  return { runId: "run-deepseek-test", caseData, config: compiled.bounded };
}

function response(content: string, extra: Record<string, unknown> = {}, model = DEEPSEEK_MODEL_ID): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test-001",
    model,
    system_fingerprint: "fp-test-001",
    choices: [{ finish_reason: "stop", message: { content, ...extra } }],
    usage: { prompt_tokens: 101, completion_tokens: 23 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("DeepSeek provider offline adapter", () => {
  it("builds the fixed safe request and returns only content plus safe metadata", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const provider = createDeepSeekProvider({
      apiKey: fakeKey(),
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return response('{"sections":[]}', {}, "model-returned-by-api");
      },
    });
    const result = await provider.generateDraft(input());
    expect(result.ok).toBe(true);
    expect(provider.modelId).toBe(DEEPSEEK_MODEL_ID);
    expect(requestUrl).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
    expect(requestInit?.method).toBe("POST");
    expect(String(requestInit?.headers && (requestInit.headers as Record<string, string>).authorization)).toContain(`Bearer ${fakeKey()}`);
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: DEEPSEEK_MODEL_ID,
      stream: false,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      max_tokens: DEEPSEEK_MAX_TOKENS,
    });
    expect(String(body.messages)).not.toContain("sk-");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain('{"sections":[{"key":"summary","content":["..."]}]}');
    expect(messages[0].content).toContain("only key and content");
    const promptUser = JSON.parse(messages[1].content) as { syntheticCase: Record<string, unknown>; canonicalAllowedSections: unknown };
    expect(promptUser.syntheticCase).not.toHaveProperty("runId");
    expect(promptUser.canonicalAllowedSections).toEqual(projectCanonicalDraftSections(input().caseData, input().config).map((section) => ({
      key: section.key,
      content: [...section.content],
    })));
    if (result.ok) {
      expect(result.raw).toBe('{"sections":[]}');
      expect(result.metadata?.promptDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.metadata?.responseModelId).toBe("model-returned-by-api");
      expect(result.metadata?.inputTokens).toBe(101);
      expect(JSON.stringify(result)).not.toContain("reasoning_content");
    }
  });

  it("maps auth, provider, truncation, and empty-content responses without response text", async () => {
    for (const status of [401, 403]) {
      const auth = createDeepSeekProvider({ apiKey: fakeKey(), fetchImpl: async () => new Response("secret response body", { status }) });
      const authResult = await auth.generateDraft(input());
      expect(authResult).toMatchObject({ ok: false, errorType: "AUTH" });
      expect(JSON.stringify(authResult)).not.toContain("secret response body");
    }

    for (const status of [429, 500]) {
      const providerError = createDeepSeekProvider({ apiKey: fakeKey(), fetchImpl: async () => new Response("private provider body", { status }) });
      const providerResult = await providerError.generateDraft(input());
      expect(providerResult).toMatchObject({ ok: false, errorType: "PROVIDER" });
      expect(JSON.stringify(providerResult)).not.toContain("private provider body");
    }

    const invalidJson = createDeepSeekProvider({ apiKey: fakeKey(), fetchImpl: async () => new Response("{not-json", { status: 200 }) });
    expect(await invalidJson.generateDraft(input())).toMatchObject({ ok: false, errorType: "FORMAT" });

    const truncated = createDeepSeekProvider({
      apiKey: fakeKey(),
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }), { status: 200 }),
    });
    expect(await truncated.generateDraft(input())).toMatchObject({ ok: false, errorType: "FORMAT", metadata: { finishReason: "length" } });

    const empty = createDeepSeekProvider({
      apiKey: fakeKey(),
      fetchImpl: async () => response("", { reasoning_content: "do not persist this" }),
    });
    const emptyResult = await empty.generateDraft(input());
    expect(emptyResult).toMatchObject({ ok: false, errorType: "FORMAT" });
    expect(JSON.stringify(emptyResult)).not.toContain("do not persist this");

    const contentFilter = createDeepSeekProvider({
      apiKey: fakeKey(),
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "content_filter", message: { content: "blocked" } }] }), { status: 200 }),
    });
    expect(await contentFilter.generateDraft(input())).toMatchObject({ ok: false, errorType: "PROVIDER", metadata: { finishReason: "content_filter" } });

    const refusal = createDeepSeekProvider({
      apiKey: fakeKey(),
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { refusal: "refused", content: "" } }] }), { status: 200 }),
    });
    const refusalResult = await refusal.generateDraft(input());
    expect(refusalResult).toMatchObject({ ok: false, errorType: "PROVIDER" });
    expect(JSON.stringify(refusalResult)).not.toContain("refused");
  });

  it("maps timeout and network failure with one request and no retry", async () => {
    let calls = 0;
    const timeout = createDeepSeekProvider({
      apiKey: fakeKey(),
      timeoutMs: 1_000,
      fetchImpl: async () => {
        calls += 1;
        throw new DOMException("aborted", "AbortError");
      },
    });
    expect(await timeout.generateDraft(input())).toMatchObject({ ok: false, errorType: "TIMEOUT" });
    expect(calls).toBe(1);

    const network = createDeepSeekProvider({ apiKey: fakeKey(), fetchImpl: async () => { throw new Error("private network detail"); } });
    const result = await network.generateDraft(input());
    expect(result).toMatchObject({ ok: false, errorType: "PROVIDER" });
    expect(JSON.stringify(result)).not.toContain("private network detail");
  });
});
