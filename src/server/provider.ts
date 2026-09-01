import "server-only";

import { providerCapabilitiesSchema, providerSelectionSchema, type ProviderCapabilities, type ProviderSelection } from "@/domain/provider";
import { createDeterministicMockProvider } from "@/infrastructure/providers/deterministic-mock-provider";
import { createDeepSeekProvider, DEEPSEEK_MODEL_ID, DEEPSEEK_PROMPT_VERSION } from "@/infrastructure/providers/deepseek-provider";
import type { LLMProvider } from "@/application/ports/llm-provider";
import { readRuntimeConfig, RUNTIME_CONFIG_RULE_IDS, type RuntimeConfig } from "./runtime-config";

export const PROVIDER_RULE_IDS = {
  ...RUNTIME_CONFIG_RULE_IDS,
  SELECTION_INVALID: "PROVIDER_SELECTION_INVALID",
} as const;
export type ProviderRuleId = (typeof PROVIDER_RULE_IDS)[keyof typeof PROVIDER_RULE_IDS];

export type ProviderResolution =
  | { ok: true; provider: LLMProvider; capabilities: ProviderCapabilities }
  | { ok: false; ruleId: ProviderRuleId; message: string; capabilities: ProviderCapabilities };

const safetyNotice = "仅使用明确标注的合成数据；真实 Provider 仅限本机研究门控，不代表临床验证。";

export function providerCapabilitiesFromConfig(config: RuntimeConfig): ProviderCapabilities {
  const publicDemoReadOnly = config.runtimeMode === "public-demo";
  return providerCapabilitiesSchema.parse({
    runtimeMode: config.runtimeMode,
    publicDemoReadOnly,
    mock: {
      executionType: "MOCK",
      available: true,
      modelId: "deterministic-rule-generator",
      promptVersion: "mock-prompt-v1",
      networkCall: false,
    },
    deepseek: {
      executionType: "REAL",
      available: config.deepseekAvailable,
      modelId: DEEPSEEK_MODEL_ID,
      promptVersion: DEEPSEEK_PROMPT_VERSION,
      networkCall: true,
    },
    safetyNotice: publicDemoReadOnly
      ? "公开只读演示：仅可读取安全数据；生成、编辑、反馈决定、画像更新和评测均已关闭。"
      : safetyNotice,
  });
}

export function getProviderCapabilities(): ProviderCapabilities {
  return providerCapabilitiesFromConfig(readRuntimeConfig());
}

function unavailableMessage(ruleId: ProviderRuleId): string {
  switch (ruleId) {
    case PROVIDER_RULE_IDS.PUBLIC_DEMO_FORCED_MOCK:
      return "公开演示模式强制使用确定性 Mock，未调用真实 Provider。";
    case PROVIDER_RULE_IDS.REAL_DISABLED:
      return "本机真实 Provider 未启用，未发起网络请求。";
    case PROVIDER_RULE_IDS.CREDENTIAL_MISSING:
      return "本机真实 Provider 凭据未配置，未发起网络请求。";
    case PROVIDER_RULE_IDS.SELECTION_INVALID:
      return "Provider 选择无效，未发起网络请求。";
    default:
      return "Provider 运行时门控未通过，未发起网络请求。";
  }
}

export function resolveProvider(selection: unknown, options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  mockMode?: Parameters<typeof createDeterministicMockProvider>[0];
} = {}): ProviderResolution {
  const config = readRuntimeConfig(options.env);
  const capabilities = providerCapabilitiesFromConfig(config);
  const parsedSelection = providerSelectionSchema.safeParse(selection);
  if (!parsedSelection.success) {
    return { ok: false, ruleId: PROVIDER_RULE_IDS.SELECTION_INVALID, message: unavailableMessage(PROVIDER_RULE_IDS.SELECTION_INVALID), capabilities };
  }
  const providerSelection: ProviderSelection = parsedSelection.data;
  if (providerSelection === "MOCK") {
    return {
      ok: true,
      provider: createDeterministicMockProvider(options.mockMode ?? "SUCCESS"),
      capabilities,
    };
  }

  const failureRule = config.runtimeMode === "public-demo"
    ? PROVIDER_RULE_IDS.PUBLIC_DEMO_FORCED_MOCK
    : !config.deepseekEnabled
      ? PROVIDER_RULE_IDS.REAL_DISABLED
      : !config.deepseekApiKey
        ? PROVIDER_RULE_IDS.CREDENTIAL_MISSING
        : undefined;
  if (failureRule) {
    return { ok: false, ruleId: failureRule, message: unavailableMessage(failureRule), capabilities };
  }

  return {
    ok: true,
    provider: createDeepSeekProvider({
      apiKey: config.deepseekApiKey!,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
    capabilities,
  };
}
