import "server-only";

import { createHash } from "node:crypto";

import type { EffectiveGenerationConfig } from "@/domain/effective-config";
import type { SyntheticCase } from "@/domain/schemas";
import { projectCanonicalDraftSections } from "@/domain/draft-projection";
import type { LLMProvider, ProviderInput, ProviderMetadata, ProviderResult } from "@/application/ports/llm-provider";

export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_MODEL_ID = "deepseek-v4-flash";
export const DEEPSEEK_PROMPT_VERSION = "deepseek-draft-v1";
export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_TIMEOUT_MS = 15_000;
export const DEEPSEEK_MAX_TOKENS = 2_000;

const systemPrompt = [
  "You are a bounded clinical adaptation prototype provider.",
  "Return JSON only. The response must be valid json and use this shape: {\"sections\":[{\"key\":\"summary\",\"content\":[\"...\"]}]}.",
  "Return only key and content for every supplied section, with no title, mandatory, runId, mode, case, policy, configuration, or other fields.",
  "Return every canonical allowed section exactly once, in the supplied order, using only the supplied allowed content lines.",
  "Never add a diagnosis, prescription, medication, dose, writeback action, identity, or missing fact.",
].join(" ");

type DeepSeekResponse = {
  id?: unknown;
  model?: unknown;
  system_fingerprint?: unknown;
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

export type DeepSeekProviderOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
};

function boundedSafeToken(value: unknown, maxLength = 200): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9._:-]+$/u.test(value)
    ? value
    : undefined;
}

function boundedInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
}

function metadata(input: { promptDigest: string; finishReason?: unknown; response?: DeepSeekResponse }): ProviderMetadata {
  const response = input.response;
  return {
    promptDigest: input.promptDigest,
    promptVersion: DEEPSEEK_PROMPT_VERSION,
    ...(boundedSafeToken(response?.id) ? { responseId: boundedSafeToken(response?.id) } : {}),
    ...(boundedSafeToken(response?.model) ? { responseModelId: boundedSafeToken(response?.model) } : {}),
    ...(boundedSafeToken(response?.system_fingerprint) ? { systemFingerprint: boundedSafeToken(response?.system_fingerprint) } : {}),
    ...(boundedSafeToken(input.finishReason, 80) ? { finishReason: boundedSafeToken(input.finishReason, 80) } : {}),
    ...(boundedInteger(response?.usage?.prompt_tokens) !== undefined ? { inputTokens: boundedInteger(response?.usage?.prompt_tokens) } : {}),
    ...(boundedInteger(response?.usage?.completion_tokens) !== undefined ? { outputTokens: boundedInteger(response?.usage?.completion_tokens) } : {}),
  };
}

function promptProjection(input: ProviderInput): { system: string; user: string } {
  const caseData: SyntheticCase = input.caseData;
  const config: EffectiveGenerationConfig = input.config;
  const canonicalSections = projectCanonicalDraftSections(caseData, config).map((section) => ({
    key: section.key,
    content: [...section.content],
  }));
  const safeCase = {
    id: caseData.id,
    version: caseData.version,
    specialty: caseData.specialty,
    visitType: caseData.visitType,
    patientSummary: caseData.patientSummary,
    chiefConcern: caseData.chiefConcern,
    allergies: caseData.allergies,
    currentMedications: caseData.currentMedications,
    redFlags: caseData.redFlags,
    providedProblems: caseData.providedProblems,
    recentChanges: caseData.recentChanges,
    missingInformation: caseData.missingInformation,
    patientEducationFacts: caseData.patientEducationFacts,
  };
  const safeConfig = {
    schemaVersion: config.schemaVersion,
    mode: config.mode,
    caseRef: config.caseRef,
    requiredSections: config.requiredSections,
    sectionOrder: config.sectionOrder,
    presentation: config.presentation,
    terminologyRules: config.terminologyRules,
    safety: config.safety,
    versionSummary: config.versionSummary,
  };
  return {
    system: systemPrompt,
    user: JSON.stringify({
      syntheticCase: safeCase,
      effectiveConfiguration: safeConfig,
      canonicalAllowedSections: canonicalSections,
    }),
  };
}

function safePromptDigest(prompt: { system: string; user: string }): string {
  return createHash("sha256").update(JSON.stringify(prompt), "utf8").digest("hex");
}

function failure(
  errorType: Extract<ProviderResult, { ok: false }>["errorType"],
  message: string,
  promptDigest: string,
  response?: DeepSeekResponse,
  finishReason?: unknown,
): ProviderResult {
  return { ok: false, errorType, message, metadata: metadata({ promptDigest, response, finishReason }) };
}

export class DeepSeekProvider implements LLMProvider {
  readonly id = DEEPSEEK_PROVIDER_ID;
  readonly modelId = DEEPSEEK_MODEL_ID;
  readonly promptVersion = DEEPSEEK_PROMPT_VERSION;
  readonly executionType = "REAL" as const;
  readonly networkCall = true as const;
  readonly outputContract = "SECTION_ENVELOPE" as const;

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(private readonly apiKey: string, options: Omit<DeepSeekProviderOptions, "apiKey"> = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? DEEPSEEK_TIMEOUT_MS));
    this.maxTokens = Math.min(DEEPSEEK_MAX_TOKENS, Math.max(256, options.maxTokens ?? DEEPSEEK_MAX_TOKENS));
  }

  async generateDraft(input: ProviderInput): Promise<ProviderResult> {
    const prompt = promptProjection(input);
    const promptDigest = safePromptDigest(prompt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(DEEPSEEK_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL_ID,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            stream: false,
            response_format: { type: "json_object" },
            thinking: { type: "disabled" },
            max_tokens: this.maxTokens,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return failure("TIMEOUT", "DeepSeek 请求超时，未重试。", promptDigest);
        }
        return failure("PROVIDER", "DeepSeek 网络请求失败，未重试。", promptDigest);
      }

      if (response.status === 401 || response.status === 403) {
        return failure("AUTH", "DeepSeek 认证失败，未重试。", promptDigest);
      }
      if (!response.ok) {
        return failure("PROVIDER", "DeepSeek 返回受控 HTTP 错误，未重试。", promptDigest);
      }

      let body: DeepSeekResponse;
      try {
        const parsed = await response.json() as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return failure("FORMAT", "DeepSeek 响应结构无效。", promptDigest);
        }
        body = parsed as DeepSeekResponse;
      } catch {
        return failure("FORMAT", "DeepSeek 响应不是可解析 JSON。", promptDigest);
      }
      const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
      const finishReason = choice?.finish_reason;
      const safeFinishReason = boundedSafeToken(finishReason, 80);
      const responseMetadata = metadata({ promptDigest, response: body, finishReason });
      if (safeFinishReason === "length") return failure("FORMAT", "DeepSeek 输出被长度上限截断。", promptDigest, body, finishReason);
      if (safeFinishReason === "tool_calls" || safeFinishReason === "insufficient_system_resource") {
        return failure("PROVIDER", "DeepSeek 未按结构化输出协议完成响应。", promptDigest, body, finishReason);
      }
      if (safeFinishReason === "content_filter" || choice?.message?.refusal !== undefined) {
        return failure("PROVIDER", "DeepSeek 输出被 provider 安全策略拒绝。", promptDigest, body, finishReason);
      }
      const content = choice?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        return { ok: false, errorType: "FORMAT", message: "DeepSeek 未返回结构化内容。", metadata: responseMetadata };
      }
      return { ok: true, raw: content, metadata: responseMetadata };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createDeepSeekProvider(options: DeepSeekProviderOptions): DeepSeekProvider {
  return new DeepSeekProvider(options.apiKey, options);
}
