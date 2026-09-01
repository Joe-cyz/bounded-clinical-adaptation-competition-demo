import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GeneralClinicalReferenceInput,
  LiteratureGroundedReferenceInput,
} from "@/application/ports/model-reference-provider";
import {
  canonicalEvidenceQuote,
  MODEL_REFERENCE_SCHEMA_VERSION,
  REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
  validateRealLiteratureGroundedWireOutputResult,
} from "@/domain/model-reference";
import {
  buildRealOutputContract,
  createDeepSeekRequestBudget,
  createRealClinicalReferenceProvider,
  createRealLiteratureAnswerProvider,
  MODEL_REFERENCE_ENDPOINT,
  MODEL_REFERENCE_MODEL_ID,
  type ModelReferenceFetch,
  type RealDeepSeekProviderOptions,
  type SafeDeepSeekRequestProvenance,
} from "./model-reference-provider";

const SYNTHETIC_KEY = `sk-${"x".repeat(32)}`;
const FACTS = [
  { id: "M1" as const, text: "合成主诉：间断乏力" },
  { id: "M2" as const, text: "合成现病史：今日晨起明显" },
  { id: "M8" as const, text: "合成检查：生命体征稳定" },
] as const;
const EVIDENCE = [
  { id: "E1" as const, excerpt: "合成证据一：感染性与非感染性方向进行鉴别，供结构验证。" },
  { id: "E2" as const, excerpt: "合成证据二：可评估支持性处理方向，仍需医生结合病情判断。" },
  { id: "E3" as const, excerpt: "合成证据三：需核对症状时间线、既往史和用药史及辅助检查。" },
  { id: "E4" as const, excerpt: "合成证据四：信息不足时应补充检查，不形成确定结论。" },
] as const;

type AnyRecord = Record<string, unknown>;

function generalInput(): GeneralClinicalReferenceInput {
  return {
    kind: "GENERAL",
    promptVersion: "general-clinical-reference-v3",
    question: "请整理合成病例的参考重点。",
    facts: [...FACTS],
    evidence: [],
  };
}

function groundedInput(): LiteratureGroundedReferenceInput {
  return {
    kind: "LITERATURE_GROUNDED",
    promptVersion: REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
    question: "请结合合成资料整理核实重点。",
    facts: [...FACTS],
    evidence: [...EVIDENCE],
  };
}

function generalOutput(): AnyRecord {
  return {
    schemaVersion: MODEL_REFERENCE_SCHEMA_VERSION,
    recordFactIds: ["M1", "M2", "M8"],
    items: [
      { itemId: "I1", kind: "CONSIDERATION_DIRECTION", text: "可考虑感染性与非感染性原因，由医生结合病程及检查判断。" },
      { itemId: "I2", kind: "CONSIDERATION_DIRECTION", text: "可评估支持性处理方向，由医生结合病情和检查结果决定。" },
      { itemId: "I3", kind: "NEEDS_VERIFICATION", text: "需核对症状时间线、既往史和用药史。" },
      { itemId: "I4", kind: "ADDITIONAL_CHECK_OR_SOURCE", text: "建议医生评估是否需要补充检查或资料。" },
    ],
  };
}

function groundedWireOutput(): AnyRecord {
  return {
    schemaVersion: MODEL_REFERENCE_SCHEMA_VERSION,
    recordFactIds: ["M1", "M2", "M8"],
    items: [
      { itemId: "I1", kind: "CONSIDERATION_DIRECTION", text: "可考虑感染性与非感染性原因，由医生结合病程及检查判断。", supportEvidenceIds: ["E1"] },
      { itemId: "I2", kind: "CONSIDERATION_DIRECTION", text: "可评估支持性处理方向，由医生结合病情和检查结果决定。", supportEvidenceIds: ["E2"] },
      { itemId: "I3", kind: "NEEDS_VERIFICATION", text: "需核对症状时间线、既往史和用药史。", supportEvidenceIds: ["E3"] },
      { itemId: "I4", kind: "ADDITIONAL_CHECK_OR_SOURCE", text: "建议医生评估是否需要补充检查或资料。", supportEvidenceIds: ["E4"] },
    ],
  };
}

function providerResponse(content: unknown, status = 200): Response {
  return Response.json({
    id: "r10-wire-contract",
    model: MODEL_REFERENCE_MODEL_ID,
    system_fingerprint: "r10-synthetic-fingerprint",
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 101, completion_tokens: 64, total_tokens: 165 },
  }, { status });
}

function providerOptions(fetchImpl: ModelReferenceFetch, overrides: Partial<RealDeepSeekProviderOptions> = {}) {
  return {
    apiKey: SYNTHETIC_KEY,
    fetchImpl,
    requestBudget: createDeepSeekRequestBudget(1),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("R10_OFFLINE_NETWORK_FORBIDDEN");
  });
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("PWR-08D-B R10 server-hydrated grounded wire contract", () => {
  it("derives deterministic code-point bounded quotes without model input", () => {
    const twelve = "合".repeat(12);
    const exact160 = "😀".repeat(160);
    const over160 = "甲".repeat(161);
    const sixHundred = "合成".repeat(300);

    expect(canonicalEvidenceQuote(twelve)).toBe(twelve);
    expect(canonicalEvidenceQuote(exact160)).toBe(exact160);
    expect(canonicalEvidenceQuote(over160)).toBe("甲".repeat(160));
    expect(canonicalEvidenceQuote(over160)).toHaveLength(160);
    expect(canonicalEvidenceQuote(over160)).not.toContain("...");
    expect(over160).toContain(canonicalEvidenceQuote(over160)!);
    expect(canonicalEvidenceQuote(sixHundred)).toBe(Array.from(sixHundred).slice(0, 160).join(""));
    expect(canonicalEvidenceQuote("😀".repeat(11))).toBeUndefined();
    expect(canonicalEvidenceQuote(`${"合".repeat(11)}\n`)).toBeUndefined();
    expect(canonicalEvidenceQuote(`${"合".repeat(160)}\u202E`)).toBeUndefined();
    expect(canonicalEvidenceQuote(over160)).toBe(canonicalEvidenceQuote(over160));
  });

  it("publishes an exact grounded ID-only contract with no citation text", () => {
    const contract = buildRealOutputContract(groundedInput());
    expect(contract).toMatchObject({
      contractType: "REAL_MODEL_REFERENCE_OUTPUT",
      kind: "LITERATURE_GROUNDED",
      schemaVersion: MODEL_REFERENCE_SCHEMA_VERSION,
      topLevel: {
        requiredKeys: ["schemaVersion", "recordFactIds", "items"],
        additionalKeysAllowed: false,
      },
      recordFactIds: {
        allowedIds: ["M1", "M2", "M8"],
        useEveryAllowedIdExactlyOnce: true,
        minItems: 1,
        maxItems: 12,
        unique: true,
      },
      itemCount: 4,
      supportEvidenceIds: {
        allowedIds: ["E1", "E2", "E3", "E4"],
        minItems: 1,
        maxItems: 2,
        unique: true,
      },
    });
    expect(contract.items.map((item) => item.requiredKeys)).toEqual([
      ["itemId", "kind", "text", "supportEvidenceIds"],
      ["itemId", "kind", "text", "supportEvidenceIds"],
      ["itemId", "kind", "text", "supportEvidenceIds"],
      ["itemId", "kind", "text", "supportEvidenceIds"],
    ]);
    expect(contract).not.toHaveProperty("support");
    const serializedContract = JSON.stringify(contract);
    expect(serializedContract).not.toMatch(/"(?:support|supportsMin|supportsMax|quote|allowedEvidenceIds)":/u);
    expect(serializedContract).not.toMatch(/(?:supportsRequired|supportsAllowed|quoteMinimum|quoteMaximum|contiguous)/u);
    for (const item of contract.items) {
      expect(item).not.toHaveProperty("supportsMin");
      expect(item).not.toHaveProperty("supportsMax");
      expect(item).not.toHaveProperty("support");
    }
    const generalContract = buildRealOutputContract(generalInput());
    expect(generalContract).not.toHaveProperty("supportEvidenceIds");
    expect(JSON.stringify(generalContract)).not.toMatch(/"supportEvidenceIds":/u);
    for (const evidence of EVIDENCE) expect(serializedContract).not.toContain(evidence.excerpt);
  });

  it("accepts GENERAL unchanged and rejects a GENERAL item carrying grounded wire fields", async () => {
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(generalOutput()));
    const provider = createRealClinicalReferenceProvider(providerOptions(fetchImpl));
    await expect(provider.generate(generalInput())).resolves.toMatchObject({ ok: true, output: generalOutput() });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const invalidGeneral = generalOutput();
    (invalidGeneral.items as AnyRecord[])[0]!.supportEvidenceIds = ["E1"];
    const invalidFetch = vi.fn<ModelReferenceFetch>(async () => providerResponse(invalidGeneral));
    const invalidProvider = createRealClinicalReferenceProvider(providerOptions(invalidFetch));
    await expect(invalidProvider.generate(generalInput())).resolves.toEqual({ ok: false, code: "PROVIDER_RESPONSE_INVALID" });
    expect(invalidFetch).toHaveBeenCalledTimes(1);
  });

  it("hydrates distinct evidence IDs into canonical final supports and records v4 provenance", async () => {
    const provenances: SafeDeepSeekRequestProvenance[] = [];
    const wire = groundedWireOutput();
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(wire));
    const provider = createRealLiteratureAnswerProvider(providerOptions(fetchImpl, {
      observer: (provenance: SafeDeepSeekRequestProvenance) => provenances.push(provenance),
    }));

    const result = await provider.generate(groundedInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.items.map((item) => item.supports.map((support) => support.evidenceId))).toEqual([
        ["E1"], ["E2"], ["E3"], ["E4"],
      ]);
      expect(result.output.items.map((item) => item.supports[0]!.quote)).toEqual(
        EVIDENCE.map((evidence) => canonicalEvidenceQuote(evidence.excerpt)),
      );
      expect(result.output.items.every((item) => item.supports.every((support) => !("supportEvidenceIds" in support)))).toBe(true);
      expect(JSON.stringify(result.output)).not.toMatch(/"supportEvidenceIds":/u);
      expect(result.output.items.every((item) => item.supports.every((support) => Object.keys(support).sort().join(",") === "evidenceId,quote"))).toBe(true);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0]!.content;
    const user = JSON.parse(body.messages[1]!.content) as AnyRecord;
    expect(system).toContain(REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION);
    expect(system).toContain("supportEvidenceIds array");
    expect(system).not.toContain("supports array");
    expect(system).not.toContain("quote");
    expect(system).not.toContain("contiguous");
    expect(system).not.toContain("synthetic-fingerprint");
    expect(user.outputContract).toEqual(buildRealOutputContract(groundedInput()));
    for (const evidence of EVIDENCE) expect(JSON.stringify(user.outputContract)).not.toContain(evidence.excerpt);
    expect(user.evidence).toEqual(EVIDENCE);
    expect(provenances).toMatchObject([{
      executionType: "REAL",
      networkUsed: true,
      endpointHost: "api.deepseek.com",
      requestOrdinal: 1,
      promptVersion: REAL_LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
      responseModelId: MODEL_REFERENCE_MODEL_ID,
      finishReason: "stop",
    }]);

    await expect(provider.generate(groundedInput())).resolves.toEqual({ ok: false, code: "PROVIDER_REQUEST_BUDGET_EXHAUSTED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects PII in request evidence before fetch and before quote hydration", async () => {
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(groundedWireOutput()));
    const provider = createRealLiteratureAnswerProvider(providerOptions(fetchImpl));
    const result = await provider.generate({
      ...groundedInput(),
      evidence: [
        { id: "E1", excerpt: "患者姓名：合成测试，感染性与非感染性方向进行鉴别。" },
        ...EVIDENCE.slice(1),
      ],
    });
    expect(result).toEqual({ ok: false, code: "PROVIDER_REQUEST_FAILED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("合成测试");
  });

  it("accepts a complete wire output through the pure validator", () => {
    const raw = groundedWireOutput();
    const result = validateRealLiteratureGroundedWireOutputResult(raw, FACTS, EVIDENCE);
    expect(result).toEqual({ ok: true, output: raw });
  });

  it.each([
    ["missing supportEvidenceIds", (item: AnyRecord) => { delete item.supportEvidenceIds; }, "OUTPUT_ITEM_FIELDS_INVALID"],
    ["empty supportEvidenceIds", (item: AnyRecord) => { item.supportEvidenceIds = []; }, "OUTPUT_SUPPORTS_ARRAY_INVALID"],
    ["too many supportEvidenceIds", (item: AnyRecord) => { item.supportEvidenceIds = ["E1", "E2", "E3"]; }, "OUTPUT_SUPPORTS_ARRAY_INVALID"],
    ["duplicate supportEvidenceIds", (item: AnyRecord) => { item.supportEvidenceIds = ["E1", "E1"]; }, "OUTPUT_SUPPORTS_ARRAY_INVALID"],
    ["non-string supportEvidenceId", (item: AnyRecord) => { item.supportEvidenceIds = [7]; }, "OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID"],
    ["invalid supportEvidenceId", (item: AnyRecord) => { item.supportEvidenceIds = ["E9"]; }, "OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID"],
    ["legacy supports field", (item: AnyRecord) => { item.supports = [{ evidenceId: "E1", quote: "合成证据一" }]; }, "OUTPUT_ITEM_FIELDS_INVALID"],
    ["legacy quote field", (item: AnyRecord) => { item.quote = "合成证据一"; }, "OUTPUT_ITEM_FIELDS_INVALID"],
    ["legacy fields together", (item: AnyRecord) => { item.supports = []; item.quote = "合成证据一"; }, "OUTPUT_ITEM_FIELDS_INVALID"],
    ["copied contract metadata", (item: AnyRecord) => { item.position = 1; }, "OUTPUT_ITEM_FIELDS_INVALID"],
    ["unknown item field", (item: AnyRecord) => { item.extra = "not allowed"; }, "OUTPUT_ITEM_FIELDS_INVALID"],
  ] as const)("rejects %s at a fixed wire-schema stage", (_name, mutate, expectedRuleId) => {
    const raw = groundedWireOutput();
    mutate((raw.items as AnyRecord[])[0]!);
    const result = validateRealLiteratureGroundedWireOutputResult(raw, FACTS, EVIDENCE);
    expect(result).toMatchObject({ ok: false, stage: "OUTPUT_SCHEMA_INVALID", ruleId: expectedRuleId });
  });

  it.each([
    ["missing item", (raw: AnyRecord) => { raw.items = (raw.items as AnyRecord[]).slice(0, 3); }, "OUTPUT_SCHEMA_INVALID", "ITEM_COUNT_INVALID"],
    ["extra item", (raw: AnyRecord) => { raw.items = [...raw.items as AnyRecord[], (raw.items as AnyRecord[])[0]!]; }, "OUTPUT_SCHEMA_INVALID", "ITEM_COUNT_INVALID"],
    ["wrong item id", (raw: AnyRecord) => { (raw.items as AnyRecord[])[0]!.itemId = "I5"; }, "OUTPUT_SCHEMA_INVALID", "OUTPUT_ITEM_FIELDS_INVALID"],
    ["wrong item kind", (raw: AnyRecord) => { (raw.items as AnyRecord[])[0]!.kind = "NEEDS_VERIFICATION"; }, "OUTPUT_ITEM_KINDS_INVALID", undefined],
    ["wrong item order", (raw: AnyRecord) => { const items = raw.items as AnyRecord[]; [items[0], items[1]] = [items[1], items[0]]; }, "OUTPUT_ITEM_IDS_INVALID", "ITEM_ID_SEQUENCE_INVALID"],
    ["missing fact id", (raw: AnyRecord) => { raw.recordFactIds = ["M1", "M2"]; }, "OUTPUT_FACT_IDS_INVALID", undefined],
    ["extra fact id", (raw: AnyRecord) => { raw.recordFactIds = ["M1", "M2", "M8", "M10"]; }, "OUTPUT_FACT_IDS_INVALID", undefined],
    ["reordered fact ids", (raw: AnyRecord) => { raw.recordFactIds = ["M2", "M1", "M8"]; }, "OUTPUT_FACT_IDS_INVALID", undefined],
    ["unknown evidence id", (raw: AnyRecord) => { (raw.items as AnyRecord[])[0]!.supportEvidenceIds = ["E5"]; }, "OUTPUT_EVIDENCE_ID_INVALID", undefined],
  ] as const)("rejects %s without broadening request ID or item order rules", (_name, mutate, expectedStage, expectedRuleId) => {
    const raw = groundedWireOutput();
    mutate(raw);
    const result = validateRealLiteratureGroundedWireOutputResult(raw, FACTS, EVIDENCE);
    expect(result).toMatchObject({ ok: false, stage: expectedStage, ...(expectedRuleId === undefined ? {} : { ruleId: expectedRuleId }) });
  });

  it("rejects duplicate request evidence and legacy citation fields", () => {
    const duplicateEvidence = [...EVIDENCE, EVIDENCE[0]];
    const duplicateResult = validateRealLiteratureGroundedWireOutputResult(groundedWireOutput(), FACTS, duplicateEvidence);
    expect(duplicateResult).toEqual({ ok: false, stage: "OUTPUT_EVIDENCE_SET_INVALID" });

    const legacyWire = groundedWireOutput();
    (legacyWire.items as AnyRecord[])[0]!.supports = [{ evidenceId: "E1", quote: "非原文连续片段" }];
    expect(validateRealLiteratureGroundedWireOutputResult(legacyWire, FACTS, EVIDENCE)).toEqual({
      ok: false,
      stage: "OUTPUT_SCHEMA_INVALID",
      ruleId: "OUTPUT_ITEM_FIELDS_INVALID",
      itemIndex: 1,
      itemKind: "CONSIDERATION_DIRECTION",
    });
  });

  it("keeps evidence excerpts in the user evidence field only", async () => {
    const input = groundedInput();
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(groundedWireOutput()));
    const provider = createRealLiteratureAnswerProvider(providerOptions(fetchImpl));
    await expect(provider.generate(input)).resolves.toMatchObject({ ok: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as { messages: Array<{ content: string }> };
    const system = body.messages[0]!.content;
    const user = JSON.parse(body.messages[1]!.content) as AnyRecord;
    for (const evidence of EVIDENCE) {
      expect(system).not.toContain(evidence.excerpt);
      expect(JSON.stringify(user.outputContract)).not.toContain(evidence.excerpt);
      expect(user.evidence).toEqual(expect.arrayContaining([evidence]));
    }
  });

  it("never calls global fetch and never performs a second injected request", async () => {
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(groundedWireOutput()));
    const provider = createRealLiteratureAnswerProvider(providerOptions(fetchImpl));
    await provider.generate(groundedInput());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(MODEL_REFERENCE_ENDPOINT);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
