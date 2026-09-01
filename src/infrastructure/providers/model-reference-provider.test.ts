import { describe, expect, it, vi } from "vitest";

import {
  GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
  LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
} from "@/domain/model-reference";
import {
  MODEL_REFERENCE_ENDPOINT,
  MODEL_REFERENCE_MAX_TOKENS,
  MODEL_REFERENCE_MODEL_ID,
  createClinicalReferenceProvider,
  createLiteratureAnswerProvider,
  createOfflineModelReferenceFakeFetch,
  selectSyntheticQuote,
} from "./model-reference-provider";

function response(content: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
}

describe("PWR-08C offline model reference provider transport", () => {
  it("uses the frozen general request body through only an injected fake fetch", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response({
        schemaVersion: "1.0.0",
        recordFactIds: ["M1"],
        items: [{ itemId: "I1", kind: "NEEDS_VERIFICATION", text: "建议进一步核实当前信息。" }],
      });
    });
    const provider = createClinicalReferenceProvider({ fetchImpl });
    const result = await provider.generate({
      kind: "GENERAL",
      promptVersion: GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
      question: "请整理核实重点。",
      facts: [{ id: "M1", text: "主诉：合成信息" }],
      evidence: [],
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(MODEL_REFERENCE_ENDPOINT);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: MODEL_REFERENCE_MODEL_ID,
      stream: false,
      thinking: { type: "disabled" },
      temperature: 0,
      max_tokens: MODEL_REFERENCE_MAX_TOKENS,
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(body)).not.toContain("encounter");
    expect(JSON.stringify(body)).not.toContain("storage");
  });

  it("keeps grounded supports in a separate strict schema and rejects free-form source fields", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response({
        schemaVersion: "1.0.0",
        recordFactIds: ["M1"],
        items: [{ itemId: "I1", kind: "NEEDS_VERIFICATION", text: "请结合资料核实。", supports: [{ evidenceId: "E1", quote: "合成资料的连续引用片段" }], source: "forbidden" }],
      });
    });
    const provider = createLiteratureAnswerProvider({ fetchImpl });
    const result = await provider.generate({
      kind: "LITERATURE_GROUNDED",
      promptVersion: LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
      question: "请整理核实重点。",
      facts: [{ id: "M1", text: "主诉：合成信息" }],
      evidence: [{ id: "E1", excerpt: "合成资料的连续引用片段，后续仍为合成文本。" }],
    });
    expect(result).toEqual({ ok: false, code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("does not fall through to global fetch when the fake transport is not explicitly injected", async () => {
    const provider = createClinicalReferenceProvider();
    await expect(provider.generate({
      kind: "GENERAL",
      promptVersion: GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
      question: "请整理核实重点。",
      facts: [{ id: "M1", text: "主诉：合成信息" }],
      evidence: [],
    })).resolves.toEqual({ ok: false, code: "PROVIDER_NOT_ENABLED" });
  });

  it("returns all three physician-facing result groups for the explicit synthetic fake", async () => {
    const clinical = createClinicalReferenceProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() });
    const grounded = createLiteratureAnswerProvider({ fetchImpl: createOfflineModelReferenceFakeFetch() });
    const general = await clinical.generate({
      kind: "GENERAL",
      promptVersion: GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
      question: "请整理核实重点。",
      facts: [{ id: "M1", text: "合成信息" }],
      evidence: [],
    });
    const withSources = await grounded.generate({
      kind: "LITERATURE_GROUNDED",
      promptVersion: LITERATURE_GROUNDED_REFERENCE_PROMPT_VERSION,
      question: "请整理核实重点。",
      facts: [{ id: "M1", text: "合成信息" }],
      evidence: [{ id: "E1", excerpt: "合成资料的连续引用片段，后续仍为合成文本。" }],
    });
    expect(general.ok && general.output.items.map((item) => item.kind)).toEqual([
      "CONSIDERATION_DIRECTION",
      "NEEDS_VERIFICATION",
      "ADDITIONAL_CHECK_OR_SOURCE",
    ]);
    if (general.ok) {
      expect(general.output.recordFactIds).toEqual(["M1", "M2", "M8", "M9", "M10", "M12"]);
      const generalText = general.output.items.map((item) => item.text).join(" ");
      expect(generalText).toContain("病史");
      expect(generalText).toContain("体征");
      expect(generalText).toContain("检查");
      expect(generalText).toContain("医生");
      expect(generalText).not.toMatch(/姓名|电话|身份证|处方|剂量|患者/u);
    }
    expect(withSources.ok && withSources.output.items.map((item) => item.kind)).toEqual([
      "CONSIDERATION_DIRECTION",
      "NEEDS_VERIFICATION",
      "ADDITIONAL_CHECK_OR_SOURCE",
    ]);
    if (withSources.ok) expect(withSources.output.items.every((item) => item.supports.length === 1)).toBe(true);
  });

  it("uses the first complete sentence as a bounded substring without an artificial ellipsis", () => {
    const excerpt = "合成资料第一句完整内容。第二句不应进入引用。";
    expect(selectSyntheticQuote(excerpt)).toBe("合成资料第一句完整内容。");
    expect(selectSyntheticQuote("🙂".repeat(200), 160)).toBe("🙂".repeat(160));
    expect(selectSyntheticQuote(excerpt, 7)).toBe("合成资料第一句");
    expect(selectSyntheticQuote(excerpt)).not.toContain("…");
  });

  it("rejects control or bidi-override input before invoking even an injected transport", async () => {
    const fetchImpl = vi.fn();
    const provider = createClinicalReferenceProvider({ fetchImpl });
    await expect(provider.generate({
      kind: "GENERAL",
      promptVersion: GENERAL_CLINICAL_REFERENCE_PROMPT_VERSION,
      question: "请整理\u202E核实重点。",
      facts: [{ id: "M1", text: "主诉：合成信息" }],
      evidence: [],
    })).resolves.toEqual({ ok: false, code: "PROVIDER_REQUEST_FAILED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
