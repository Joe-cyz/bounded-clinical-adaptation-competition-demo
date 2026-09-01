import { z } from "zod";

import { generateDraft } from "@/domain/generate-draft";
import type { LLMProvider, ProviderInput, ProviderResult } from "@/application/ports/llm-provider";

export const deterministicMockScenarioSchema = z.enum([
  "SUCCESS",
  "INVALID_JSON",
  "TIMEOUT",
  "PROVIDER_ERROR",
  "INVALID_OUTPUT_SCHEMA",
  "INVALID_OUTPUT_RULE",
  "INVALID_OUTPUT_FACT",
  "INVALID_OUTPUT_PROHIBITED_ACTION",
  "INVALID_OUTPUT_PII",
  "INVALID_OUTPUT_DUPLICATE",
  "INVALID_OUTPUT_ORDER",
]);

export type DeterministicMockScenario = z.infer<typeof deterministicMockScenarioSchema>;

export class DeterministicMockProvider implements LLMProvider {
  readonly id = "deterministic-mock";
  readonly modelId = "deterministic-rule-generator";
  readonly promptVersion = "mock-prompt-v1";
  readonly executionType = "MOCK" as const;
  readonly networkCall = false as const;
  readonly outputContract = "FULL_DRAFT" as const;

  constructor(readonly scenario: DeterministicMockScenario = "SUCCESS") {}

  async generateDraft(input: ProviderInput): Promise<ProviderResult> {
    switch (this.scenario) {
      case "INVALID_JSON":
        return { ok: true, raw: '{"mock": invalid-json' };
      case "TIMEOUT":
        return { ok: false, errorType: "TIMEOUT", message: "Deterministic mock provider timeout." };
      case "PROVIDER_ERROR":
        return { ok: false, errorType: "PROVIDER", message: "Deterministic mock provider error." };
      case "INVALID_OUTPUT_SCHEMA": {
        const draft = generateDraft(input.caseData, input.config, input.runId);
        return { ok: true, raw: JSON.stringify({ ...draft, mode: "INVALID" }) };
      }
      case "INVALID_OUTPUT_RULE": {
        const draft = generateDraft(input.caseData, input.config, input.runId);
        return {
          ok: true,
          raw: JSON.stringify({
            ...draft,
            sections: draft.sections.filter((section) => section.key !== "draftDisclaimer"),
          }),
        };
      }
      case "INVALID_OUTPUT_FACT": {
        const draft = generateDraft(input.caseData, input.config, input.runId);
        return {
          ok: true,
          raw: JSON.stringify({
            ...draft,
            sections: draft.sections.map((section) => section.key === "problems"
              ? { ...section, content: [...section.content, "虚构诊断：病例未提供的疾病"] }
              : section),
          }),
        };
      }
      case "INVALID_OUTPUT_PROHIBITED_ACTION": {
        const draft = generateDraft(input.caseData, input.config, input.runId);
        return {
          ok: true,
          raw: JSON.stringify({
            ...draft,
            sections: draft.sections.map((section) => section.key === "patientEducation"
              ? { ...section, content: ["自动诊断并直接开药。"] }
              : section),
          }),
        };
      }
      case "INVALID_OUTPUT_PII": {
        const draft = generateDraft(input.caseData, input.config, input.runId);
        return {
          ok: true,
          raw: JSON.stringify({
            ...draft,
            sections: draft.sections.map((section) => section.key === "summary"
              ? { ...section, content: [...section.content, "姓名：合成患者"] }
              : section),
          }),
        };
      }
      case "INVALID_OUTPUT_DUPLICATE": {
        const draft = generateDraft(input.caseData, input.config, input.runId);
        return {
          ok: true,
          raw: JSON.stringify({ ...draft, sections: [...draft.sections, draft.sections[0]] }),
        };
      }
      case "INVALID_OUTPUT_ORDER": {
        const draft = generateDraft(input.caseData, input.config, input.runId);
        return {
          ok: true,
          raw: JSON.stringify({ ...draft, sections: [...draft.sections].reverse() }),
        };
      }
      case "SUCCESS":
      default:
        return {
          ok: true,
          raw: JSON.stringify(generateDraft(input.caseData, input.config, input.runId)),
        };
    }
  }
}

export function createDeterministicMockProvider(
  scenario: DeterministicMockScenario = "SUCCESS",
): DeterministicMockProvider {
  return new DeterministicMockProvider(scenario);
}
