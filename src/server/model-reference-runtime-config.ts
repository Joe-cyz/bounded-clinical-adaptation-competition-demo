import "server-only";

export const MODEL_REFERENCE_REAL_RULE_IDS = {
  PUBLIC_DEMO_READ_ONLY: "MODEL_REFERENCE_PUBLIC_DEMO_READ_ONLY",
  REAL_PROVIDER_DISABLED: "MODEL_REFERENCE_REAL_PROVIDER_DISABLED",
  REAL_PROVIDER_ENABLE_FLAG_INVALID: "MODEL_REFERENCE_REAL_PROVIDER_ENABLE_FLAG_INVALID",
  REAL_PROVIDER_REQUEST_LIMIT_INVALID: "MODEL_REFERENCE_REAL_PROVIDER_REQUEST_LIMIT_INVALID",
  REAL_PROVIDER_FAKE_CONFLICT: "MODEL_REFERENCE_REAL_PROVIDER_FAKE_CONFLICT",
  REAL_PROVIDER_CREDENTIAL_MISSING: "MODEL_REFERENCE_REAL_PROVIDER_CREDENTIAL_MISSING",
  REAL_PROVIDER_CREDENTIAL_INVALID: "MODEL_REFERENCE_REAL_PROVIDER_CREDENTIAL_INVALID",
} as const;

export type ModelReferenceRealRuleId = (typeof MODEL_REFERENCE_REAL_RULE_IDS)[keyof typeof MODEL_REFERENCE_REAL_RULE_IDS];

export type DeepSeekCredentialStatus = "MISSING" | "INVALID" | "CONFIGURED_VALID";
export type DeepSeekRequestLimit = 0 | 1 | 2;

export type ModelReferenceRealGateInput = {
  runtimeMode: string | undefined;
  fakeFetchEnabled: boolean;
  realProviderEnabled: string | undefined;
  requestLimit: string | undefined;
  apiKey?: string;
};

export type ModelReferenceRealGateResult =
  | { ok: true; apiKey: string; requestLimit: 1 | 2 }
  | {
    ok: false;
    ruleId: ModelReferenceRealRuleId;
    credentialStatus: DeepSeekCredentialStatus;
    requestLimit: DeepSeekRequestLimit | "INVALID";
  };

const DEEPSEEK_API_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{16,200}$/u;

export function classifyDeepSeekCredential(value: string | undefined): DeepSeekCredentialStatus {
  if (value === undefined || value === "") return "MISSING";
  return DEEPSEEK_API_KEY_PATTERN.test(value) ? "CONFIGURED_VALID" : "INVALID";
}

export function parseDeepSeekRequestLimit(value: string | undefined): DeepSeekRequestLimit | "INVALID" {
  if (value === undefined || value === "") return 0;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return "INVALID";
  const parsed = Number(value);
  return parsed === 0 || parsed === 1 || parsed === 2 ? parsed : "INVALID";
}

export function parseRealProviderEnabled(value: string | undefined): { value: boolean; valid: boolean } {
  if (value === undefined || value === "false" || value === "") return { value: false, valid: true };
  if (value === "true") return { value: true, valid: true };
  return { value: false, valid: false };
}

export function evaluateModelReferenceRealGate(input: ModelReferenceRealGateInput): ModelReferenceRealGateResult {
  const credentialStatus = classifyDeepSeekCredential(input.apiKey);
  const requestLimit = parseDeepSeekRequestLimit(input.requestLimit);
  const enabled = parseRealProviderEnabled(input.realProviderEnabled);
  if (input.runtimeMode !== "local-research") {
    return {
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.PUBLIC_DEMO_READ_ONLY,
      credentialStatus: "MISSING",
      requestLimit,
    };
  }
  if (!enabled.valid) {
    return {
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_ENABLE_FLAG_INVALID,
      credentialStatus,
      requestLimit,
    };
  }
  if (input.fakeFetchEnabled && enabled.value) {
    return {
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_FAKE_CONFLICT,
      credentialStatus,
      requestLimit,
    };
  }
  if (!enabled.value) {
    return {
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_DISABLED,
      credentialStatus,
      requestLimit,
    };
  }
  if (requestLimit !== 1 && requestLimit !== 2) {
    return {
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_REQUEST_LIMIT_INVALID,
      credentialStatus,
      requestLimit,
    };
  }
  if (credentialStatus === "MISSING") {
    return {
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_CREDENTIAL_MISSING,
      credentialStatus,
      requestLimit,
    };
  }
  if (credentialStatus === "INVALID") {
    return {
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_CREDENTIAL_INVALID,
      credentialStatus,
      requestLimit,
    };
  }
  return { ok: true, apiKey: input.apiKey!, requestLimit };
}

export function readModelReferenceRealGate(env: NodeJS.ProcessEnv = process.env): ModelReferenceRealGateResult {
  const baseInput = {
    runtimeMode: env.APP_RUNTIME_MODE,
    fakeFetchEnabled: env.PWR08C_FAKE_FETCH === "true",
    realProviderEnabled: env.PWR08D_REAL_PROVIDER_ENABLED,
    requestLimit: env.PWR08D_REAL_REQUEST_LIMIT,
  } satisfies Omit<ModelReferenceRealGateInput, "apiKey">;
  const preliminary = evaluateModelReferenceRealGate(baseInput);
  if (!preliminary.ok && preliminary.ruleId !== MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_CREDENTIAL_MISSING) {
    return preliminary;
  }
  return evaluateModelReferenceRealGate({ ...baseInput, apiKey: env.DEEPSEEK_API_KEY });
}
