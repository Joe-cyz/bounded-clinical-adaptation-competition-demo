import "server-only";

import { providerSelectionSchema, type ProviderSelection } from "@/domain/provider";
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";

export { appRuntimeModeSchema, type AppRuntimeMode };

export const RUNTIME_CONFIG_RULE_IDS = {
  SELECTION_INVALID: "PROVIDER_SELECTION_INVALID",
  REAL_DISABLED: "PROVIDER_REAL_DISABLED",
  CREDENTIAL_MISSING: "PROVIDER_CREDENTIAL_MISSING",
  PUBLIC_DEMO_FORCED_MOCK: "PROVIDER_PUBLIC_DEMO_FORCED_MOCK",
  RUNTIME_MODE_INVALID: "PROVIDER_RUNTIME_MODE_INVALID",
  ENABLE_FLAG_INVALID: "PROVIDER_ENABLE_FLAG_INVALID",
} as const;

export const PUBLIC_DEMO_READ_ONLY = "PUBLIC_DEMO_READ_ONLY" as const;
export const PUBLIC_DEMO_READ_ONLY_MESSAGE = "公开只读演示不允许生成、编辑、反馈决定、画像更新或评测写入。";

export type RuntimeConfigRuleId = (typeof RUNTIME_CONFIG_RULE_IDS)[keyof typeof RUNTIME_CONFIG_RULE_IDS];

export type RuntimeConfigIssue = {
  ruleId: RuntimeConfigRuleId;
};

export type RuntimeConfig = {
  runtimeMode: AppRuntimeMode;
  requestedProvider: ProviderSelection;
  deepseekEnabled: boolean;
  deepseekApiKey?: string;
  deepseekAvailable: boolean;
  issues: RuntimeConfigIssue[];
};

function readMode(value: string | undefined, issues: RuntimeConfigIssue[]): AppRuntimeMode {
  if (value === undefined || value === "") return "public-demo";
  const parsed = appRuntimeModeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  issues.push({ ruleId: RUNTIME_CONFIG_RULE_IDS.RUNTIME_MODE_INVALID });
  return "public-demo";
}

function readProvider(value: string | undefined, issues: RuntimeConfigIssue[]): ProviderSelection {
  if (value === undefined || value === "") return "MOCK";
  const parsed = providerSelectionSchema.safeParse(value.toUpperCase());
  if (parsed.success) return parsed.data;
  issues.push({ ruleId: RUNTIME_CONFIG_RULE_IDS.SELECTION_INVALID });
  return "MOCK";
}

function readBoolean(value: string | undefined, issues: RuntimeConfigIssue[]): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  issues.push({ ruleId: RUNTIME_CONFIG_RULE_IDS.ENABLE_FLAG_INVALID });
  return false;
}

function isSafeCredential(value: string | undefined): value is string {
  return typeof value === "string" && /^sk-[A-Za-z0-9_-]{16,200}$/u.test(value);
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const issues: RuntimeConfigIssue[] = [];
  const runtimeMode = readMode(env.APP_RUNTIME_MODE, issues);
  const requestedProvider = readProvider(env.LLM_PROVIDER, issues);
  const deepseekEnabled = readBoolean(env.DEEPSEEK_ENABLED, issues);
  const deepseekApiKey = isSafeCredential(env.DEEPSEEK_API_KEY) ? env.DEEPSEEK_API_KEY : undefined;
  const deepseekRequested = requestedProvider === "DEEPSEEK";

  if (deepseekRequested && runtimeMode === "public-demo") {
    issues.push({ ruleId: RUNTIME_CONFIG_RULE_IDS.PUBLIC_DEMO_FORCED_MOCK });
  } else if (deepseekRequested && !deepseekEnabled) {
    issues.push({ ruleId: RUNTIME_CONFIG_RULE_IDS.REAL_DISABLED });
  } else if (deepseekRequested && !deepseekApiKey) {
    issues.push({ ruleId: RUNTIME_CONFIG_RULE_IDS.CREDENTIAL_MISSING });
  }

  return {
    runtimeMode,
    requestedProvider,
    deepseekEnabled,
    ...(deepseekApiKey ? { deepseekApiKey } : {}),
    deepseekAvailable: runtimeMode === "local-research" && deepseekEnabled && deepseekApiKey !== undefined,
    issues,
  };
}

export function runtimeConfigIssue(config: RuntimeConfig, ruleId: RuntimeConfigRuleId): RuntimeConfigIssue | undefined {
  return config.issues.find((issue) => issue.ruleId === ruleId);
}

export type RuntimeWriteGate =
  | { ok: true; runtimeMode: AppRuntimeMode }
  | { ok: false; ruleId: typeof PUBLIC_DEMO_READ_ONLY; message: string };

/**
 * This gate is intentionally independent of the database and provider
 * factories so public-demo write attempts fail before either can initialize.
 */
export function assertRuntimeWriteAllowed(env: NodeJS.ProcessEnv = process.env): RuntimeWriteGate {
  const config = readRuntimeConfig(env);
  if (config.runtimeMode === "public-demo") {
    return { ok: false, ruleId: PUBLIC_DEMO_READ_ONLY, message: PUBLIC_DEMO_READ_ONLY_MESSAGE };
  }
  return { ok: true, runtimeMode: config.runtimeMode };
}
