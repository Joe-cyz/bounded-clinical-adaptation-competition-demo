import { describe, expect, it } from "vitest";

import {
  MODEL_REFERENCE_REAL_RULE_IDS,
  classifyDeepSeekCredential,
  evaluateModelReferenceRealGate,
  parseDeepSeekRequestLimit,
  parseRealProviderEnabled,
  readModelReferenceRealGate,
} from "./model-reference-runtime-config";

function syntheticKey(): string {
  return `sk-${"x".repeat(32)}`;
}

function base() {
  return {
    runtimeMode: "local-research",
    fakeFetchEnabled: false,
    realProviderEnabled: "true",
    requestLimit: "1",
  } as const;
}

describe("PWR-08D-A real model-reference runtime gate", () => {
  it("classifies missing, invalid, and valid credentials without exposing a value", () => {
    expect(classifyDeepSeekCredential(undefined)).toBe("MISSING");
    expect(classifyDeepSeekCredential("sk-short")).toBe("INVALID");
    const status = classifyDeepSeekCredential(syntheticKey());
    expect(status).toBe("CONFIGURED_VALID");
    expect(JSON.stringify(status)).not.toContain(syntheticKey());
  });

  it("accepts only exact boolean values and safe request limits", () => {
    expect(parseRealProviderEnabled(undefined)).toEqual({ value: false, valid: true });
    expect(parseRealProviderEnabled("true")).toEqual({ value: true, valid: true });
    expect(parseRealProviderEnabled("TRUE")).toEqual({ value: false, valid: false });
    expect(parseDeepSeekRequestLimit(undefined)).toBe(0);
    expect(parseDeepSeekRequestLimit("1")).toBe(1);
    expect(parseDeepSeekRequestLimit("2")).toBe(2);
    expect(parseDeepSeekRequestLimit("3")).toBe("INVALID");
    expect(parseDeepSeekRequestLimit("1.0")).toBe("INVALID");
  });

  it("fails closed for public demo before credential status can matter", () => {
    const result = evaluateModelReferenceRealGate({
      ...base(),
      runtimeMode: "public-demo",
      apiKey: syntheticKey(),
    });
    expect(result).toMatchObject({ ok: false, ruleId: MODEL_REFERENCE_REAL_RULE_IDS.PUBLIC_DEMO_READ_ONLY, credentialStatus: "MISSING" });
  });

  it("does not read a credential for a public gate", () => {
    const env = new Proxy({
      APP_RUNTIME_MODE: "public-demo",
      PWR08D_REAL_PROVIDER_ENABLED: "true",
      PWR08D_REAL_REQUEST_LIMIT: "1",
    } as unknown as NodeJS.ProcessEnv, {
      get(target, property, receiver) {
        if (property === "DEEPSEEK_API_KEY") throw new Error("credential read");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(readModelReferenceRealGate(env)).toMatchObject({
      ok: false,
      ruleId: MODEL_REFERENCE_REAL_RULE_IDS.PUBLIC_DEMO_READ_ONLY,
      credentialStatus: "MISSING",
    });
  });

  it("requires the independent flag, a limit of one or two, and a valid key", () => {
    expect(evaluateModelReferenceRealGate({ ...base(), realProviderEnabled: "false", apiKey: syntheticKey() })).toMatchObject({ ok: false, ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_DISABLED });
    expect(evaluateModelReferenceRealGate({ ...base(), requestLimit: "0", apiKey: syntheticKey() })).toMatchObject({ ok: false, ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_REQUEST_LIMIT_INVALID });
    expect(evaluateModelReferenceRealGate({ ...base(), requestLimit: "3", apiKey: syntheticKey() })).toMatchObject({ ok: false, ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_REQUEST_LIMIT_INVALID });
    expect(evaluateModelReferenceRealGate({ ...base(), apiKey: undefined })).toMatchObject({ ok: false, ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_CREDENTIAL_MISSING });
    expect(evaluateModelReferenceRealGate({ ...base(), apiKey: "sk-invalid" })).toMatchObject({ ok: false, ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_CREDENTIAL_INVALID });
    const allowed = evaluateModelReferenceRealGate({ ...base(), apiKey: syntheticKey() });
    expect(allowed).toMatchObject({ ok: true, requestLimit: 1 });
  });

  it("rejects fake/real conflict without choosing either transport", () => {
    expect(evaluateModelReferenceRealGate({ ...base(), fakeFetchEnabled: true, apiKey: syntheticKey() })).toMatchObject({ ok: false, ruleId: MODEL_REFERENCE_REAL_RULE_IDS.REAL_PROVIDER_FAKE_CONFLICT });
  });
});
