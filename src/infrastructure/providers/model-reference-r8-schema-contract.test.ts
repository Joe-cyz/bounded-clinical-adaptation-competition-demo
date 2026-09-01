import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_REFERENCE_SCHEMA_VERSION,
  REAL_OUTPUT_SCHEMA_RULE_IDS,
  modelReferenceProviderRequestSchema,
  validateRealOutputShapeResult,
  type ModelReferenceKind,
} from "@/domain/model-reference";
import type {
  GeneralClinicalReferenceInput,
  LiteratureGroundedReferenceInput,
} from "@/application/ports/model-reference-provider";
import {
  MODEL_REFERENCE_ENDPOINT,
  MODEL_REFERENCE_MAX_TOKENS,
  MODEL_REFERENCE_MODEL_ID,
  buildRealOutputContract,
  createDeepSeekRequestBudget,
  createRealClinicalReferenceProvider,
  createRealLiteratureAnswerProvider,
  type ModelReferenceFetch,
} from "./model-reference-provider";

const SYNTHETIC_KEY = "sk-" + "x".repeat(32);
const VALID_QUOTE = "合成资料连续摘录用于结构测试";
const FACTS = [
  { id: "M1" as const, text: "合成主诉：结构测试" },
  { id: "M2" as const, text: "合成现病史：结构测试" },
  { id: "M8" as const, text: "合成检查：结构测试" },
] as const;
const EVIDENCE = [
  { id: "E1" as const, excerpt: VALID_QUOTE + "，其余内容仍为合成资料。" },
] as const;
const ALL_EVIDENCE = [
  { id: "E1" as const, excerpt: "合成证据一连续摘录用于结构测试。" },
  { id: "E2" as const, excerpt: "合成证据二连续摘录用于结构测试。" },
  { id: "E3" as const, excerpt: "合成证据三连续摘录用于结构测试。" },
  { id: "E4" as const, excerpt: "合成证据四连续摘录用于结构测试。" },
  { id: "E5" as const, excerpt: "合成证据五连续摘录用于结构测试。" },
] as const;

function generalInput(overrides: Partial<GeneralClinicalReferenceInput> = {}): GeneralClinicalReferenceInput {
  return {
    kind: "GENERAL",
    promptVersion: "general-clinical-reference-v3",
    question: "请整理合成病例的参考重点。",
    facts: [...FACTS],
    evidence: [],
    ...overrides,
  };
}

function groundedInput(overrides: Partial<LiteratureGroundedReferenceInput> = {}): LiteratureGroundedReferenceInput {
  return {
    kind: "LITERATURE_GROUNDED",
    promptVersion: "literature-grounded-reference-v4",
    question: "请结合合成资料的结构测试内容。",
    facts: [...FACTS],
    evidence: [...EVIDENCE],
    ...overrides,
  };
}

function validOutput(kind: ModelReferenceKind): Record<string, unknown> {
  const items: Array<Record<string, unknown>> = [
    {
      itemId: "I1",
      kind: "CONSIDERATION_DIRECTION",
      text: "可考虑感染性与非感染性原因，由医生结合病程及检查判断。",
    },
    {
      itemId: "I2",
      kind: "CONSIDERATION_DIRECTION",
      text: "可评估支持性处理方向，由医生结合病情和检查结果决定。",
    },
    {
      itemId: "I3",
      kind: "NEEDS_VERIFICATION",
      text: "需核对症状时间线、既往史和用药史。",
    },
    {
      itemId: "I4",
      kind: "ADDITIONAL_CHECK_OR_SOURCE",
      text: "建议医生评估是否需要补充检查或资料。",
    },
  ];
  if (kind === "LITERATURE_GROUNDED") {
    for (const item of items) item.supports = [{ evidenceId: "E1", quote: VALID_QUOTE }];
  }
  return {
    schemaVersion: MODEL_REFERENCE_SCHEMA_VERSION,
    recordFactIds: ["M1", "M2", "M8"],
    items,
  };
}

function validWireOutput(): Record<string, unknown> {
  return {
    schemaVersion: MODEL_REFERENCE_SCHEMA_VERSION,
    recordFactIds: ["M1", "M2", "M8"],
    items: [
      { itemId: "I1", kind: "CONSIDERATION_DIRECTION", text: "可考虑感染性与非感染性原因，由医生结合病程及检查判断。", supportEvidenceIds: ["E1"] },
      { itemId: "I2", kind: "CONSIDERATION_DIRECTION", text: "可评估支持性处理方向，由医生结合病情和检查结果决定。", supportEvidenceIds: ["E1"] },
      { itemId: "I3", kind: "NEEDS_VERIFICATION", text: "需核对症状时间线、既往史和用药史。", supportEvidenceIds: ["E1"] },
      { itemId: "I4", kind: "ADDITIONAL_CHECK_OR_SOURCE", text: "建议医生评估是否需要补充检查或资料。", supportEvidenceIds: ["E1"] },
    ],
  };
}

function providerResponse(content: unknown, status = 200): Response {
  return Response.json({
    id: "r8-c-schema-contract",
    model: MODEL_REFERENCE_MODEL_ID,
    choices: [{
      finish_reason: "stop",
      message: { content: JSON.stringify(content) },
    }],
    usage: {
      prompt_tokens: 101,
      completion_tokens: 23,
      total_tokens: 124,
    },
  }, { status });
}

type SchemaCase = {
  name: string;
  kind: ModelReferenceKind;
  raw: unknown;
  ruleId: string;
  itemIndex?: 1 | 2 | 3 | 4;
  itemKind?: "CONSIDERATION_DIRECTION" | "NEEDS_VERIFICATION" | "ADDITIONAL_CHECK_OR_SOURCE";
};

function withFirstItem(kind: ModelReferenceKind, change: (item: Record<string, unknown>) => void): Record<string, unknown> {
  const output = validOutput(kind);
  const item = output.items as Array<Record<string, unknown>>;
  change(item[0]!);
  return output;
}

function withGroundedFirstSupport(change: (support: Record<string, unknown>) => void): Record<string, unknown> {
  const output = validOutput("LITERATURE_GROUNDED");
  const item = (output.items as Array<Record<string, unknown>>)[0]!;
  const supports = item.supports as Array<Record<string, unknown>>;
  change(supports[0]!);
  return output;
}

const schemaCases: SchemaCase[] = [
  { name: "null root", kind: "GENERAL", raw: null, ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ROOT_OBJECT_INVALID },
  { name: "array root", kind: "GENERAL", raw: [], ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ROOT_OBJECT_INVALID },
  { name: "string root", kind: "GENERAL", raw: "not-an-object", ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ROOT_OBJECT_INVALID },
  {
    name: "unknown top-level field",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), extra: "not allowed" },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_TOP_LEVEL_FIELDS_INVALID,
  },
  {
    name: "missing top-level field",
    kind: "GENERAL",
    raw: (() => {
      const output = validOutput("GENERAL");
      delete output.items;
      return output;
    })(),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_TOP_LEVEL_FIELDS_INVALID,
  },
  {
    name: "schema version value",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), schemaVersion: "2.0.0" },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SCHEMA_VERSION_INVALID,
  },
  {
    name: "schema version type",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), schemaVersion: 1 },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SCHEMA_VERSION_INVALID,
  },
  {
    name: "record fact ids type",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), recordFactIds: "M1" },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_RECORD_FACT_IDS_SHAPE_INVALID,
  },
  {
    name: "record fact ids empty",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), recordFactIds: [] },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_RECORD_FACT_IDS_SHAPE_INVALID,
  },
  {
    name: "record fact ids element",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), recordFactIds: ["M1", 2] },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_RECORD_FACT_IDS_SHAPE_INVALID,
  },
  {
    name: "items type",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), items: {} },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEMS_ARRAY_INVALID,
  },
  {
    name: "three items",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), items: (validOutput("GENERAL").items as unknown[]).slice(0, 3) },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.ITEM_COUNT_INVALID,
  },
  {
    name: "five items",
    kind: "GENERAL",
    raw: {
      ...validOutput("GENERAL"),
      items: [
        ...(validOutput("GENERAL").items as unknown[]),
        ...(validOutput("GENERAL").items as unknown[]).slice(0, 1),
      ],
    },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.ITEM_COUNT_INVALID,
  },
  {
    name: "item object",
    kind: "GENERAL",
    raw: { ...validOutput("GENERAL"), items: [null, ...(validOutput("GENERAL").items as unknown[]).slice(1)] },
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_OBJECT_INVALID,
    itemIndex: 1,
  },
  {
    name: "item fields missing",
    kind: "GENERAL",
    raw: withFirstItem("GENERAL", (item) => { delete item.text; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "item fields extra",
    kind: "GENERAL",
    raw: withFirstItem("GENERAL", (item) => { item.extra = "not allowed"; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "item id shape",
    kind: "GENERAL",
    raw: withFirstItem("GENERAL", (item) => { item.itemId = "I5"; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "item kind shape",
    kind: "GENERAL",
    raw: withFirstItem("GENERAL", (item) => { item.kind = "UNKNOWN"; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
    itemIndex: 1,
  },
  {
    name: "item text type",
    kind: "GENERAL",
    raw: withFirstItem("GENERAL", (item) => { item.text = 42; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_TEXT_SHAPE_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "item text length",
    kind: "GENERAL",
    raw: withFirstItem("GENERAL", (item) => { item.text = "合".repeat(161); }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_TEXT_SHAPE_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "general supports forbidden",
    kind: "GENERAL",
    raw: withFirstItem("GENERAL", (item) => { item.supports = []; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "grounded supports missing",
    kind: "LITERATURE_GROUNDED",
    raw: (() => {
      const output = validOutput("LITERATURE_GROUNDED");
      delete (output.items as Array<Record<string, unknown>>)[0]!.supports;
      return output;
    })(),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "grounded supports type",
    kind: "LITERATURE_GROUNDED",
    raw: withFirstItem("LITERATURE_GROUNDED", (item) => { item.supports = {}; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORTS_ARRAY_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "grounded supports empty",
    kind: "LITERATURE_GROUNDED",
    raw: withFirstItem("LITERATURE_GROUNDED", (item) => { item.supports = []; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORTS_ARRAY_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "grounded supports too many",
    kind: "LITERATURE_GROUNDED",
    raw: withFirstItem("LITERATURE_GROUNDED", (item) => {
      item.supports = [
        { evidenceId: "E1", quote: VALID_QUOTE },
        { evidenceId: "E2", quote: VALID_QUOTE },
        { evidenceId: "E3", quote: VALID_QUOTE },
      ];
    }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORTS_ARRAY_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "support object",
    kind: "LITERATURE_GROUNDED",
    raw: withFirstItem("LITERATURE_GROUNDED", (item) => { item.supports = [null]; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_OBJECT_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "support fields missing",
    kind: "LITERATURE_GROUNDED",
    raw: withGroundedFirstSupport((support) => { delete support.quote; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_FIELDS_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "support fields extra",
    kind: "LITERATURE_GROUNDED",
    raw: withGroundedFirstSupport((support) => { support.details = "not allowed"; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_FIELDS_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "evidence id type",
    kind: "LITERATURE_GROUNDED",
    raw: withGroundedFirstSupport((support) => { support.evidenceId = 7; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "evidence id value",
    kind: "LITERATURE_GROUNDED",
    raw: withGroundedFirstSupport((support) => { support.evidenceId = "E9"; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_EVIDENCE_ID_SHAPE_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "quote type",
    kind: "LITERATURE_GROUNDED",
    raw: withGroundedFirstSupport((support) => { support.quote = 7; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_QUOTE_SHAPE_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "quote too short",
    kind: "LITERATURE_GROUNDED",
    raw: withGroundedFirstSupport((support) => { support.quote = "太短"; }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_QUOTE_SHAPE_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
  {
    name: "quote too long",
    kind: "LITERATURE_GROUNDED",
    raw: withGroundedFirstSupport((support) => { support.quote = "合".repeat(161); }),
    ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_SUPPORT_QUOTE_SHAPE_INVALID,
    itemIndex: 1,
    itemKind: "CONSIDERATION_DIRECTION",
  },
];

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("OFFLINE_R8_C_A_NETWORK_FORBIDDEN");
  });
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("PWR-08D-B R8-C-A machine-readable output schema contract", () => {
  it.each(["GENERAL", "LITERATURE_GROUNDED"] as const)("publishes a deterministic safe %s outputContract", (kind) => {
    const input = kind === "GENERAL" ? generalInput() : groundedInput();
    const contract = buildRealOutputContract(input);
    expect(JSON.stringify(contract)).toBe(JSON.stringify(buildRealOutputContract(input)));
    expect(contract).toMatchObject({
      contractType: "REAL_MODEL_REFERENCE_OUTPUT",
      kind,
      schemaVersion: MODEL_REFERENCE_SCHEMA_VERSION,
      itemCount: 4,
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
    });
    expect(contract.items).toHaveLength(4);
    expect(contract.items.map((item) => [item.position, item.itemId, item.kind])).toEqual([
      [1, "I1", "CONSIDERATION_DIRECTION"],
      [2, "I2", "CONSIDERATION_DIRECTION"],
      [3, "I3", "NEEDS_VERIFICATION"],
      [4, "I4", "ADDITIONAL_CHECK_OR_SOURCE"],
    ]);
    expect(contract.items.map((item) => item.allowedText)).toEqual([
      [
        "可考虑感染性与非感染性原因，由医生结合病程及检查判断。",
        "可考虑药物相关不良反应可能性，由医生结合用药史判断。",
        "可从其他可能原因进行鉴别，由医生结合病史和检查判断。",
        "需进一步明确诊断，由医生结合完整资料综合判断。",
        "目前资料不足，不能形成确定结论。",
      ],
      [
        "可评估支持性处理方向，由医生结合病情和检查结果决定。",
        "可评估非药物处理方向，由医生结合病情和检查结果决定。",
        "可评估抗感染治疗类别是否适用，由医生结合禁忌证和检查结果决定。",
        "可评估症状控制治疗类别是否适用，由医生结合禁忌证和检查结果决定。",
        "可评估是否需要转诊或升级处理，由医生结合病情决定。",
        "现有信息不足，暂不能形成治疗方向。",
      ],
      [
        "需核对症状时间线、既往史和用药史。",
        "需确认现有检查和检验结果是否完整。",
        "需核对过敏史、禁忌证和既往治疗情况。",
        "需补充核对当前病情变化和已有记录。",
        "现有信息不足，需由医生补充核对关键病史。",
      ],
      [
        "建议医生评估是否需要补充检查或资料。",
        "可考虑补充检验或影像资料。",
        "建议查阅相关资料来源。",
        "可考虑是否需要转诊或升级处理。",
        "现有信息不足，暂不能提出补充检查或资料方向。",
      ],
    ]);
    for (const item of contract.items) {
      expect(item.requiredKeys).toEqual(kind === "GENERAL"
        ? ["itemId", "kind", "text"]
        : ["itemId", "kind", "text", "supportEvidenceIds"]);
      expect(item.additionalKeysAllowed).toBe(false);
      expect(item.text).toEqual({ minCodePoints: 1, maxCodePoints: 160, piiAllowed: false });
      expect(item).not.toHaveProperty("supportsRequired");
      expect(item).not.toHaveProperty("supportsAllowed");
      if (kind === "LITERATURE_GROUNDED") {
        expect(item.supportEvidenceIdsMin).toBe(1);
        expect(item.supportEvidenceIdsMax).toBe(2);
        expect(item).not.toHaveProperty("supportsMin");
        expect(item).not.toHaveProperty("supportsMax");
      } else {
        expect(item).not.toHaveProperty("supportEvidenceIdsMin");
        expect(item).not.toHaveProperty("supportEvidenceIdsMax");
        expect(item).not.toHaveProperty("supportsMin");
        expect(item).not.toHaveProperty("supportsMax");
      }
    }
    if (kind === "GENERAL") {
      expect(contract).not.toHaveProperty("support");
      expect(contract).not.toHaveProperty("supportEvidenceIds");
    } else {
      expect(contract.supportEvidenceIds).toEqual({
        allowedIds: ["E1"],
        minItems: 1,
        maxItems: 2,
        unique: true,
      });
      expect(contract).not.toHaveProperty("support");
    }
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toMatch(/(?:path|url|database|姓名|身份证|手机号|excerpt|合成资料连续摘录)/iu);
    expect(serialized).not.toMatch(/"quote":"/u);
  });

  it("scopes fact and evidence IDs to the current request in deterministic order", () => {
    const scopedFacts = [
      { id: "M8" as const, text: "合成检查事实" },
      { id: "M12" as const, text: "合成既往事实" },
      { id: "M3" as const, text: "合成症状事实" },
    ];
    const scopedEvidence = [
      { id: "E4" as const, excerpt: "合成资料第四条连续摘录用于契约测试。" },
      { id: "E2" as const, excerpt: "合成资料第二条连续摘录用于契约测试。" },
    ];
    const generalContract = buildRealOutputContract({ kind: "GENERAL", facts: scopedFacts, evidence: [] });
    const groundedContract = buildRealOutputContract({ kind: "LITERATURE_GROUNDED", facts: scopedFacts, evidence: scopedEvidence });
    const allEvidenceContract = buildRealOutputContract({ kind: "LITERATURE_GROUNDED", facts: scopedFacts, evidence: [...ALL_EVIDENCE] });

    expect(generalContract.recordFactIds.allowedIds).toEqual(["M8", "M12", "M3"]);
    expect(groundedContract.recordFactIds.allowedIds).toEqual(["M8", "M12", "M3"]);
    expect(groundedContract.supportEvidenceIds?.allowedIds).toEqual(["E4", "E2"]);
    expect(buildRealOutputContract({ kind: "LITERATURE_GROUNDED", facts: [...FACTS], evidence: [...EVIDENCE] }).supportEvidenceIds?.allowedIds).toEqual(["E1"]);
    expect(allEvidenceContract.supportEvidenceIds?.allowedIds).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    expect(generalContract).not.toHaveProperty("support");
    expect(JSON.stringify(groundedContract)).not.toContain(scopedEvidence[0]!.excerpt);
    expect(JSON.stringify(groundedContract)).not.toContain(scopedEvidence[1]!.excerpt);
    expect(JSON.stringify(groundedContract)).toBe(JSON.stringify(buildRealOutputContract({
      kind: "LITERATURE_GROUNDED",
      facts: scopedFacts,
      evidence: scopedEvidence,
    })));
  });

  it("keeps evidence excerpts in the user evidence field and not in outputContract", async () => {
    const input = groundedInput({
      evidence: [
        { id: "E2" as const, excerpt: VALID_QUOTE + "，E2 仍为合成资料。" },
        { id: "E4" as const, excerpt: "另一段合成资料连续摘录用于请求测试。" },
      ],
    });
    const output = validWireOutput();
    for (const item of output.items as Array<Record<string, unknown>>) item.supportEvidenceIds = ["E2"];
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(output));
    const diagnostics: unknown[] = [];
    const provider = createRealLiteratureAnswerProvider({
      apiKey: SYNTHETIC_KEY,
      fetchImpl,
      requestBudget: createDeepSeekRequestBudget(1),
      failureObserver: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(provider.generate(input)).resolves.toMatchObject({ ok: true });
    expect(diagnostics).toEqual([]);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const user = JSON.parse(body.messages[1]!.content) as {
      outputContract: { supportEvidenceIds?: { allowedIds?: unknown } };
      evidence: Array<{ id: string; excerpt: string }>;
    };
    expect(user.outputContract.supportEvidenceIds?.allowedIds).toEqual(["E2", "E4"]);
    expect(user.evidence).toEqual(input.evidence);
    for (const evidence of input.evidence) {
      expect(body.messages[1]!.content.split(evidence.excerpt).length - 1).toBe(1);
      expect(JSON.stringify(user.outputContract)).not.toContain(evidence.excerpt);
    }
  });

  const copiedContractMetadata = [
    "supportsRequired",
    "supportsAllowed",
    "requiredKeys",
    "additionalKeysAllowed",
    "allowedText",
    "supportEvidenceIdsMin",
    "supportEvidenceIdsMax",
    "supportsMin",
    "supportsMax",
    "position",
  ] as const;

  it.each(["GENERAL", "LITERATURE_GROUNDED"] as const)("rejects copied outputContract metadata for %s", async (kind) => {
    for (const field of copiedContractMetadata) {
      const output = kind === "GENERAL" ? validOutput(kind) : validWireOutput();
      const firstItem = (output.items as Array<Record<string, unknown>>)[0]!;
      firstItem[field] = field === "requiredKeys"
        ? ["itemId", "kind", "text"]
        : field === "allowedText"
          ? ["not returned metadata"]
          : field === "additionalKeysAllowed"
            ? false
            : 1;
      const diagnostics: unknown[] = [];
      const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(output));
      if (kind === "GENERAL") {
        const provider = createRealClinicalReferenceProvider({
          apiKey: SYNTHETIC_KEY,
          fetchImpl,
          requestBudget: createDeepSeekRequestBudget(1),
          failureObserver: (diagnostic) => diagnostics.push(diagnostic),
        });
        await expect(provider.generate(generalInput())).resolves.toEqual({
          ok: false,
          code: "PROVIDER_RESPONSE_INVALID",
        });
      } else {
        const provider = createRealLiteratureAnswerProvider({
          apiKey: SYNTHETIC_KEY,
          fetchImpl,
          requestBudget: createDeepSeekRequestBudget(1),
          failureObserver: (diagnostic) => diagnostics.push(diagnostic),
        });
        await expect(provider.generate(groundedInput())).resolves.toEqual({
          ok: false,
          code: "PROVIDER_RESPONSE_INVALID",
        });
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(diagnostics).toEqual([{
        stage: "OUTPUT_SCHEMA_INVALID",
        ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_ITEM_FIELDS_INVALID,
        itemIndex: 1,
        itemKind: "CONSIDERATION_DIRECTION",
      }]);
      expect(Object.keys(diagnostics[0] as object)).toEqual(["stage", "ruleId", "itemIndex", "itemKind"]);
      expect(JSON.stringify(diagnostics)).not.toContain(field);
    }
  });

  it("rejects a well-shaped support that names an evidence ID absent from the request", () => {
    const output = validOutput("LITERATURE_GROUNDED");
    const firstSupport = ((output.items as Array<Record<string, unknown>>)[0]!.supports as Array<Record<string, unknown>>)[0]!;
    firstSupport.evidenceId = "E2";
    expect(validateRealOutputShapeResult("LITERATURE_GROUNDED", output, FACTS, EVIDENCE)).toEqual({
      ok: false,
      stage: "OUTPUT_EVIDENCE_ID_INVALID",
    });
  });

  it.each(schemaCases)("diagnoses %s with the first fixed structural rule", ({ kind, raw, ruleId, itemIndex, itemKind }) => {
    const result = validateRealOutputShapeResult(
      kind,
      raw,
      FACTS,
      kind === "GENERAL" ? [] : EVIDENCE,
    );
    expect(result).toEqual({
      ok: false,
      stage: "OUTPUT_SCHEMA_INVALID",
      ruleId,
      ...(itemIndex === undefined ? {} : { itemIndex }),
      ...(itemKind === undefined ? {} : { itemKind }),
    });
  });

  it("keeps valid general and grounded outputs on the existing strict path", () => {
    expect(validateRealOutputShapeResult("GENERAL", validOutput("GENERAL"), FACTS, [])).toEqual({
      ok: true,
      output: validOutput("GENERAL"),
    });
    expect(validateRealOutputShapeResult("LITERATURE_GROUNDED", validOutput("LITERATURE_GROUNDED"), FACTS, EVIDENCE)).toEqual({
      ok: true,
      output: validOutput("LITERATURE_GROUNDED"),
    });
  });

  it("keeps the maximum real request below the bounded body budget and uses the contract once", async () => {
    const maxFacts = Array.from({ length: 12 }, (_, index) => ({
      id: ("M" + (index + 1)) as "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9" | "M10" | "M11" | "M12",
      text: "合成事实".repeat(75),
    }));
    const input = generalInput({
      question: "合".repeat(200),
      facts: maxFacts,
    });
    expect(modelReferenceProviderRequestSchema.safeParse(input).success).toBe(true);
    const fetchImpl = vi.fn<ModelReferenceFetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        max_tokens?: unknown;
        response_format?: unknown;
        messages: Array<{ content: string }>;
      };
      void body;
      const output = validOutput("GENERAL");
      output.recordFactIds = maxFacts.map((fact) => fact.id);
      return providerResponse(output);
    });
    const provider = createRealClinicalReferenceProvider({
      apiKey: SYNTHETIC_KEY,
      fetchImpl,
      requestBudget: createDeepSeekRequestBudget(1),
    });

    const result = await provider.generate(input);
    const expectedOutput = validOutput("GENERAL");
    expectedOutput.recordFactIds = maxFacts.map((fact) => fact.id);
    expect(result).toMatchObject({ ok: true, output: expectedOutput });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as {
      max_tokens?: unknown;
      response_format?: unknown;
      messages: Array<{ content: string }>;
    };
    expect(body.max_tokens).toBe(MODEL_REFERENCE_MAX_TOKENS);
    expect(body.response_format).toEqual({ type: "json_object" });
    const user = JSON.parse(body.messages[1]!.content) as { outputContract?: unknown };
    expect(user.outputContract).toEqual(buildRealOutputContract(input));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    expect(bodyBytes).toBeLessThan(50_000 - 1_024);
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).not.toContain(SYNTHETIC_KEY);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(MODEL_REFERENCE_ENDPOINT);
  });

  it("projects a structural failure to only fixed safe observer fields", async () => {
    const diagnostics: unknown[] = [];
    const responseBody = {
      ...validOutput("GENERAL"),
      response: "synthetic response must not escape",
      details: "synthetic details must not escape",
      stack: "synthetic stack must not escape",
      prompt: "synthetic prompt must not escape",
    };
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(responseBody));
    const provider = createRealClinicalReferenceProvider({
      apiKey: SYNTHETIC_KEY,
      fetchImpl,
      requestBudget: createDeepSeekRequestBudget(1),
      failureObserver: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(provider.generate(generalInput())).resolves.toEqual({
      ok: false,
      code: "PROVIDER_RESPONSE_INVALID",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([{
      stage: "OUTPUT_SCHEMA_INVALID",
      ruleId: REAL_OUTPUT_SCHEMA_RULE_IDS.OUTPUT_TOP_LEVEL_FIELDS_INVALID,
    }]);
    expect(Object.keys(diagnostics[0] as object)).toEqual(["stage", "ruleId"]);
    expect(Object.isFrozen(diagnostics[0])).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toMatch(/(?:synthetic response|synthetic details|synthetic stack|synthetic prompt)/u);
    expect(JSON.stringify(diagnostics)).not.toMatch(/(?:question|facts|evidence|content|path|stack)/iu);
  });

  it("never falls through to global fetch when the provider transport is injected", async () => {
    const fetchImpl = vi.fn<ModelReferenceFetch>(async () => providerResponse(validOutput("GENERAL")));
    const provider = createRealClinicalReferenceProvider({
      apiKey: SYNTHETIC_KEY,
      fetchImpl,
      requestBudget: createDeepSeekRequestBudget(1),
    });
    await expect(provider.generate(generalInput())).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
