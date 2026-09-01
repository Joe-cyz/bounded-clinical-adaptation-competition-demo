import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  executeGenerationComparison,
  executeGenerationSingleMode,
  GENERATION_RULE_IDS,
  type GenerationIdFactory,
  type GenerationSeedSource,
} from "./generation-service";
import type { LLMProvider, ProviderInput, ProviderResult } from "./ports/llm-provider";
import {
  createDeterministicMockProvider,
  DeterministicMockProvider,
  type DeterministicMockScenario,
} from "@/infrastructure/providers/deterministic-mock-provider";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { seedManifest, specialtyVisitPolicies, institutionalSafetyCore, syntheticCases, physicianProfiles } from "@/data/seed-loader";
import { projectCanonicalDraftSections } from "@/domain/draft-projection";
import type { EffectiveGenerationConfig } from "@/domain/effective-config";
import { createDeepSeekProvider, DEEPSEEK_MODEL_ID, DEEPSEEK_PROMPT_VERSION } from "@/infrastructure/providers/deepseek-provider";

const fixedClock = () => "2026-08-19T00:00:00.000Z";

class CountingProvider implements LLMProvider {
  readonly id = "deterministic-mock";
  readonly modelId = "deterministic-rule-generator";
  readonly promptVersion = "mock-prompt-v1";
  readonly calls: ProviderInput[] = [];

  constructor(private readonly delegate: LLMProvider = createDeterministicMockProvider()) {}

  generateDraft(input: ProviderInput): Promise<ProviderResult> {
    this.calls.push(input);
    return this.delegate.generateDraft(input);
  }
}

function sequentialIds(): GenerationIdFactory {
  let sequence = 0;
  return (kind) => `${kind.toLowerCase()}-${++sequence}`;
}

function prefixedIds(prefix: string): GenerationIdFactory {
  let sequence = 0;
  return (kind) => `${prefix}-${kind.toLowerCase()}-${++sequence}`;
}

function dependencies(database: DatabaseSync, provider: LLMProvider = new CountingProvider()) {
  return {
    database,
    provider,
    clock: fixedClock,
    idFactory: sequentialIds(),
  };
}

function request(mockMode: DeterministicMockScenario = "SUCCESS") {
  return {
    caseId: syntheticCases[0].id,
    profileId: physicianProfiles[0].id,
    mockMode,
  };
}

function fakeKey(): string {
  return ["sk", "a".repeat(32)].join("-");
}

function canonicalEnvelope(input: ProviderInput): { sections: Array<{ key: string; content: string[] }> } {
  return {
    sections: projectCanonicalDraftSections(input.caseData, input.config).map((section) => ({
      key: section.key,
      content: [...section.content],
    })),
  };
}

function validRealMetadata(): Record<string, unknown> {
  return {
    promptDigest: "a".repeat(64),
    promptVersion: DEEPSEEK_PROMPT_VERSION,
  };
}

function envelopeProvider(
  output: (input: ProviderInput) => unknown,
  ...metadataArgs: [unknown?]
): LLMProvider {
  const metadata = metadataArgs.length === 0 ? validRealMetadata() : metadataArgs[0];
  return {
    id: "deepseek",
    modelId: DEEPSEEK_MODEL_ID,
    promptVersion: DEEPSEEK_PROMPT_VERSION,
    executionType: "REAL",
    networkCall: true,
    outputContract: "SECTION_ENVELOPE",
    generateDraft: async (input) => ({
      ok: true,
      raw: JSON.stringify(output(input)),
      metadata: metadata as never,
    }),
  };
}

function seedOverride(overrides: Partial<GenerationSeedSource>): GenerationSeedSource {
  return {
    seedManifest,
    syntheticCases,
    physicianProfiles,
    institutionalSafetyCore,
    specialtyVisitPolicies,
    ...overrides,
  };
}

describe("generation service", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
  });

  afterEach(() => {
    database.close();
  });

  it("runs both modes with one provider and two independent explicit run IDs", async () => {
    const provider = new CountingProvider();
    const result = await executeGenerationComparison(request(), dependencies(database, provider));

    expect(result.status).toBe("SUCCEEDED");
    expect(provider.calls).toHaveLength(2);
    expect(result.generic.status).toBe("SUCCEEDED");
    expect(result.bounded.status).toBe("SUCCEEDED");
    expect(result.generic.runId).not.toBe(result.bounded.runId);
    expect(result.generic.draft?.runId).toBe(result.generic.runId);
    expect(result.bounded.draft?.runId).toBe(result.bounded.runId);
    expect(result.generic.provider).toEqual(result.bounded.provider);
    expect(result.generic.configurationKey).not.toBe(result.bounded.configurationKey);

    const runs = createGenerationRunRepository(database).listByCase(syntheticCases[0].id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => [run.providerId, run.modelId, run.promptVersion])).toEqual([
      ["deterministic-mock", "deterministic-rule-generator", "mock-prompt-v1"],
      ["deterministic-mock", "deterministic-rule-generator", "mock-prompt-v1"],
    ]);
    expect(createAuditEventRepository(database).listByEntity("GENERATION_RUN", result.generic.runId!)).toHaveLength(1);
    expect(createAuditEventRepository(database).listByEntity("GENERATION_RUN", result.bounded.runId!)).toHaveLength(1);
  });

  it("accepts the DeepSeek section envelope through the complete generation chain", async () => {
    let calls = 0;
    const provider = createDeepSeekProvider({
      apiKey: fakeKey(),
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const promptInput = JSON.parse(body.messages[1].content) as { canonicalAllowedSections: unknown };
        return new Response(JSON.stringify({
          id: "chatcmpl-offline-envelope",
          model: DEEPSEEK_MODEL_ID,
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ sections: promptInput.canonicalAllowedSections }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await executeGenerationComparison(request(), dependencies(database, provider));

    expect(result.status).toBe("SUCCEEDED");
    expect(calls).toBe(2);
    const runs = createGenerationRunRepository(database).listByCase(syntheticCases[0].id);
    expect(runs).toHaveLength(2);
    for (const attempt of [result.generic, result.bounded]) {
      const run = runs.find((candidate) => candidate.id === attempt.runId);
      expect(run).toBeDefined();
      if (!run || !attempt.draft) continue;
      const canonical = projectCanonicalDraftSections(syntheticCases[0], run.effectiveConfigSnapshot as EffectiveGenerationConfig);
      expect(attempt.draft).toMatchObject({
        runId: run.id,
        mode: run.mode,
        caseId: run.caseId,
        caseVersion: run.caseVersion,
        safetyCoreVersion: run.safetyCoreVersion,
        policyId: run.policyId,
        policyVersion: run.policyVersion,
        configurationKey: run.configurationKey,
      });
      if (run.profileVersion !== undefined) expect(attempt.draft.physicianProfileVersion).toBe(run.profileVersion);
      expect(attempt.draft.sections).toEqual(canonical);
      expect(attempt.providerMetadata).toMatchObject({ promptVersion: DEEPSEEK_PROMPT_VERSION });
    }
  });

  it("rejects forged envelope metadata instead of letting the model override trusted fields", async () => {
    const result = await executeGenerationSingleMode(
      request(),
      "BOUNDED",
      dependencies(database, envelopeProvider((input) => ({
        runId: "forged-run-id",
        mode: "GENERIC",
        caseId: "forged-case",
        title: "伪造标题",
        mandatory: false,
        sections: canonicalEnvelope(input).sections,
      }))),
    );

    expect(result.status).toBe("FAILED");
    expect(result.error?.ruleId).toBe(GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED);
    expect(result.error?.ruleIds).toContain("OUTPUT_SCHEMA_INVALID");
    expect(result.draft).toBeUndefined();
    const run = createGenerationRunRepository(database).listByCase(syntheticCases[0].id)[0];
    expect(run.outputDraftSnapshot).toBeUndefined();
    expect(JSON.stringify(createAuditEventRepository(database).listByEntity("GENERATION_RUN", run.id)[0].metadata)).not.toContain("forged-run-id");
  });

  it.each([
    ["missing", (sections: Array<{ key: string; content: string[] }>) => sections.slice(1), "OUTPUT_SECTION_SET_INVALID"],
    ["duplicate", (sections: Array<{ key: string; content: string[] }>) => [sections[0], ...sections], "OUTPUT_SECTION_DUPLICATE"],
    ["reordered", (sections: Array<{ key: string; content: string[] }>) => [sections[1], sections[0], ...sections.slice(2)], "OUTPUT_SECTION_ORDER_INVALID"],
    ["unknown", (sections: Array<{ key: string; content: string[] }>) => [{ key: "not-a-section", content: ["未知"] }, ...sections.slice(1)], "OUTPUT_SECTION_SET_INVALID"],
    ["fact", (sections: Array<{ key: string; content: string[] }>) => sections.map((section) => section.key === "summary" ? { ...section, content: ["虚构诊断"] } : section), "OUTPUT_FACT_BOUNDARY_VIOLATION"],
    ["pii", (sections: Array<{ key: string; content: string[] }>) => sections.map((section) => section.key === "summary" ? { ...section, content: ["姓名：合成患者"] } : section), "OUTPUT_SUSPECTED_PII"],
    ["disclaimer", (sections: Array<{ key: string; content: string[] }>) => sections.map((section) => section.key === "draftDisclaimer" ? { ...section, content: ["免责声明被改写"] } : section), "OUTPUT_SECTION_METADATA_INVALID"],
  ] as const)("blocks DeepSeek envelope %s without correction", (_name, mutate, detailRuleId) => {
    // The provider output is still offline and deterministic; only the envelope is varied.
    return (async () => {
      const result = await executeGenerationSingleMode(
        request(),
        "BOUNDED",
        dependencies(database, envelopeProvider((input) => ({ sections: mutate(canonicalEnvelope(input).sections) }))),
      );
      expect(result.status).toBe("FAILED");
      expect(result.error?.ruleId).toBe(GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED);
      expect(result.error?.ruleIds).toContain(detailRuleId);
      expect(result.draft).toBeUndefined();
    })();
  });

  it.each([
    ["missing", undefined],
    ["invalid", { promptDigest: "not-a-sha", promptVersion: DEEPSEEK_PROMPT_VERSION }],
  ] as const)("fails closed when REAL provider provenance is %s", async (_name, metadata) => {
    const result = await executeGenerationSingleMode(
      request(),
      "BOUNDED",
      dependencies(database, envelopeProvider(canonicalEnvelope, metadata)),
    );

    expect(result.status).toBe("FAILED");
    expect(result.error?.ruleId).toBe(GENERATION_RULE_IDS.PROVIDER_PROVENANCE_INVALID);
    expect(result.draft).toBeUndefined();
    const run = createGenerationRunRepository(database).listByCase(syntheticCases[0].id)[0];
    expect(run.status).toBe("FAILED");
    expect(run.outputDraftSnapshot).toBeUndefined();
    expect(run.providerMetadata).toBeUndefined();
  });

  it("runs only the requested mode through the shared generation pipeline", async () => {
    const provider = new CountingProvider();
    const result = await executeGenerationSingleMode(request(), "BOUNDED", dependencies(database, provider));

    expect(result).toEqual(expect.objectContaining({ mode: "BOUNDED", status: "SUCCEEDED" }));
    expect(provider.calls).toHaveLength(1);
    expect(result.draft?.runId).toBe(result.runId);
    const runs = createGenerationRunRepository(database).listByCase(syntheticCases[0].id);
    expect(runs).toHaveLength(1);
    expect(runs[0].mode).toBe("BOUNDED");
    expect(createAuditEventRepository(database).listByEntity("GENERATION_RUN", result.runId!)).toHaveLength(1);
  });

  it("keeps single-mode provider failures persisted and controlled", async () => {
    const provider = new CountingProvider(new DeterministicMockProvider("PROVIDER_ERROR"));
    const result = await executeGenerationSingleMode(
      request("PROVIDER_ERROR"),
      "BOUNDED",
      dependencies(database, provider),
    );

    expect(result.mode).toBe("BOUNDED");
    expect(result.status).toBe("FAILED");
    expect(result.draft).toBeUndefined();
    expect(result.error).toEqual(expect.objectContaining({
      ruleId: GENERATION_RULE_IDS.PROVIDER_ERROR,
      errorType: "PROVIDER",
      persisted: true,
    }));
    expect(provider.calls).toHaveLength(1);
    expect(createGenerationRunRepository(database).listByCase(syntheticCases[0].id)).toHaveLength(1);
  });

  it("keeps single-mode output-rule failures persisted without raw output", async () => {
    const result = await executeGenerationSingleMode(
      request("INVALID_OUTPUT_FACT"),
      "BOUNDED",
      dependencies(database, new DeterministicMockProvider("INVALID_OUTPUT_FACT")),
    );

    expect(result.mode).toBe("BOUNDED");
    expect(result.status).toBe("FAILED");
    expect(result.draft).toBeUndefined();
    expect(result.error?.ruleId).toBe(GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED);
    expect(result.error?.ruleIds).toContain("OUTPUT_FACT_BOUNDARY_VIOLATION");
    const run = createGenerationRunRepository(database).listByCase(syntheticCases[0].id)[0];
    expect(run.mode).toBe("BOUNDED");
    expect(run.outputDraftSnapshot).toBeUndefined();
    expect(JSON.stringify(createAuditEventRepository(database).listByEntity("GENERATION_RUN", run.id)[0].metadata))
      .not.toContain("铏氭瀯璇婃柇");
  });

  it("fails closed on single-mode persistence failure", async () => {
    database.close();
    const result = await executeGenerationSingleMode(request(), "BOUNDED", dependencies(database));

    expect(result).toEqual(expect.objectContaining({
      mode: "BOUNDED",
      status: "NOT_RUN",
      error: expect.objectContaining({
        ruleId: GENERATION_RULE_IDS.PERSISTENCE_FAILED,
        errorType: "PERSISTENCE",
        persisted: false,
      }),
    }));
    database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
  });

  it.each([
    ["INVALID_JSON", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
    ["TIMEOUT", GENERATION_RULE_IDS.PROVIDER_TIMEOUT],
    ["PROVIDER_ERROR", GENERATION_RULE_IDS.PROVIDER_ERROR],
    ["INVALID_OUTPUT_SCHEMA", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
    ["INVALID_OUTPUT_RULE", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
    ["INVALID_OUTPUT_FACT", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
    ["INVALID_OUTPUT_PROHIBITED_ACTION", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
    ["INVALID_OUTPUT_PII", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
    ["INVALID_OUTPUT_DUPLICATE", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
    ["INVALID_OUTPUT_ORDER", GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED],
  ] as const)("persists a controlled %s failure without returning a draft", async (mockMode, ruleId) => {
    const provider = new CountingProvider(new DeterministicMockProvider(mockMode));
    const result = await executeGenerationComparison(request(mockMode), dependencies(database, provider));

    expect(result.status).toBe("FAILED");
    expect(provider.calls).toHaveLength(2);
    expect(result.generic.status).toBe("FAILED");
    expect(result.bounded.status).toBe("FAILED");
    expect(result.generic.draft).toBeUndefined();
    expect(result.bounded.draft).toBeUndefined();
    expect(result.generic.error?.ruleId).toBe(ruleId);
    expect(result.bounded.error?.ruleId).toBe(ruleId);
    expect(result.generic.error?.persisted).toBe(true);
    expect(createGenerationRunRepository(database).listByCase(syntheticCases[0].id)).toHaveLength(2);
  });

  it.each([
    ["INVALID_JSON", "OUTPUT_FORMAT_INVALID"],
    ["INVALID_OUTPUT_SCHEMA", "OUTPUT_SCHEMA_INVALID"],
    ["INVALID_OUTPUT_RULE", "OUTPUT_SECTION_SET_INVALID"],
    ["INVALID_OUTPUT_FACT", "OUTPUT_FACT_BOUNDARY_VIOLATION"],
    ["INVALID_OUTPUT_PROHIBITED_ACTION", "OUTPUT_PROHIBITED_ACTION"],
    ["INVALID_OUTPUT_PII", "OUTPUT_SUSPECTED_PII"],
    ["INVALID_OUTPUT_DUPLICATE", "OUTPUT_SECTION_DUPLICATE"],
    ["INVALID_OUTPUT_ORDER", "OUTPUT_SECTION_ORDER_INVALID"],
  ] as const)("audits safe output detail for %s", async (mockMode, detailRuleId) => {
    const result = await executeGenerationComparison(
      request(mockMode),
      dependencies(database, new DeterministicMockProvider(mockMode)),
    );
    const audit = createAuditEventRepository(database).listByEntity("GENERATION_RUN", result.generic.runId!)[0];

    expect(result.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.OUTPUT_RULE_BLOCKED);
    expect(result.generic.error?.ruleIds).toContain(detailRuleId);
    expect(JSON.stringify(audit.metadata)).not.toContain("虚构诊断");
    expect(JSON.stringify(audit.metadata)).not.toContain("姓名：合成患者");
    expect(JSON.stringify(audit.metadata)).not.toContain("自动诊断并直接开药");
  });

  it("keeps one completed side visible when the other provider attempt fails", async () => {
    const delegate = new CountingProvider();
    const successProvider = createDeterministicMockProvider();
    const provider: LLMProvider = {
      id: delegate.id,
      modelId: delegate.modelId,
      promptVersion: delegate.promptVersion,
      async generateDraft(input) {
        delegate.calls.push(input);
        return input.config.mode === "GENERIC"
          ? successProvider.generateDraft(input)
          : { ok: false, errorType: "PROVIDER", message: "hidden-provider-message" };
      },
    };

    const result = await executeGenerationComparison(request(), dependencies(database, provider));

    expect(result.status).toBe("PARTIAL_FAILURE");
    expect(result.generic.status).toBe("SUCCEEDED");
    expect(result.bounded.status).toBe("FAILED");
    expect(result.generic.draft).toBeDefined();
    expect(result.bounded.error?.message).not.toContain("hidden-provider-message");
  });

  it("resolves seed data only by server-side IDs and blocks unknown cases", async () => {
    const provider = new CountingProvider();
    const result = await executeGenerationComparison({
      caseId: "missing-case",
      profileId: physicianProfiles[0].id,
      mockMode: "SUCCESS",
    }, dependencies(database, provider));

    expect(result.status).toBe("FAILED");
    expect(provider.calls).toHaveLength(0);
    expect(result.generic.status).toBe("NOT_RUN");
    expect(result.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.CASE_NOT_FOUND);
    expect(createAuditEventRepository(database).listByEntity("GENERATION_REQUEST", result.requestId)).toHaveLength(1);
    expect(createGenerationRunRepository(database).listByCase(syntheticCases[0].id)).toEqual([]);

    const untrustedPayloadResult = await executeGenerationComparison({
      ...request(),
      caseData: syntheticCases[0],
    }, { ...dependencies(database, provider), idFactory: prefixedIds("extra") });
    expect(untrustedPayloadResult.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.INPUT_BLOCKED);
  });

  it("blocks missing or non-ACTIVE profiles before provider invocation", async () => {
    const provider = new CountingProvider();
    const result = await executeGenerationComparison({ ...request(), profileId: "missing-profile" }, dependencies(database, provider));

    expect(result.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.PROFILE_NOT_FOUND);
    expect(provider.calls).toHaveLength(0);

    const archivedProfile = { ...physicianProfiles[0], status: "ARCHIVED" as const };
    const archivedResult = await executeGenerationComparison(
      request(),
      {
        ...dependencies(database, provider),
        idFactory: prefixedIds("archived"),
        seeds: seedOverride({ physicianProfiles: [archivedProfile] }),
      },
    );
    expect(archivedResult.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.PROFILE_NOT_FOUND);
    expect(provider.calls).toHaveLength(0);
  });

  it("blocks input and configuration failures without invoking the provider", async () => {
    const provider = new CountingProvider();
    const piiCase = { ...syntheticCases[0], patientSummary: "姓名：合成测试甲" };
    const inputResult = await executeGenerationComparison(
      request(),
      { ...dependencies(database, provider), seeds: seedOverride({ syntheticCases: [piiCase] }) },
    );
    expect(inputResult.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.INPUT_BLOCKED);
    expect(provider.calls).toHaveLength(0);

    const unsafeSafetyCore = { ...institutionalSafetyCore, immutableForPhysician: false } as never;
    const configResult = await executeGenerationComparison(
      request(),
      {
        ...dependencies(database, provider),
        idFactory: prefixedIds("config"),
        seeds: seedOverride({ institutionalSafetyCore: unsafeSafetyCore }),
      },
    );
    expect(configResult.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.CONFIG_BLOCKED);
    expect(provider.calls).toHaveLength(0);
  });

  it("returns a controlled persistence failure instead of a false success", async () => {
    database.close();
    const provider = new CountingProvider();
    const result = await executeGenerationComparison(request(), dependencies(database, provider));

    expect(result.status).toBe("FAILED");
    expect(provider.calls).toHaveLength(0);
    expect(result.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.PERSISTENCE_FAILED);
    expect(result.bounded.error?.ruleId).toBe(GENERATION_RULE_IDS.PERSISTENCE_FAILED);
    database = openRuntimeDatabase({ path: ":memory:", clock: fixedClock });
  });

  it("fails closed when the profile history table cannot be read", async () => {
    database.exec("DROP TABLE physician_profile_versions");
    const provider = new CountingProvider();
    const result = await executeGenerationComparison(request(), dependencies(database, provider));

    expect(result.status).toBe("FAILED");
    expect(provider.calls).toHaveLength(0);
    expect(result.generic.error?.ruleId).toBe(GENERATION_RULE_IDS.PERSISTENCE_FAILED);
    expect(result.bounded.error?.ruleId).toBe(GENERATION_RULE_IDS.PERSISTENCE_FAILED);
    expect(result.generic.error?.persisted).toBe(false);
  });

  it("does not store provider raw output or case body in audit metadata", async () => {
    const result = await executeGenerationComparison(request("INVALID_JSON"), dependencies(database));
    const audit = createAuditEventRepository(database).listByEntity("GENERATION_RUN", result.generic.runId!)[0];

    expect(JSON.stringify(audit.metadata)).not.toContain("invalid-json");
    expect(JSON.stringify(audit.metadata)).not.toContain(syntheticCases[0].patientSummary);
    expect(audit.metadata).toMatchObject({
      runId: result.generic.runId,
      mode: "GENERIC",
      providerId: "deterministic-mock",
      modelId: "deterministic-rule-generator",
      promptVersion: "mock-prompt-v1",
    });
  });
});
