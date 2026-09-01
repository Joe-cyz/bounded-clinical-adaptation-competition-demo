import { describe, expect, it } from "vitest";

import { getProviderCapabilities, resolveProvider } from "./provider";
import { readRuntimeConfig, RUNTIME_CONFIG_RULE_IDS } from "./runtime-config";

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...values };
}

function fakeKey(): string {
  return ["sk", "a".repeat(32)].join("-");
}

describe("provider runtime gates", () => {
  it("defaults to public-demo Mock without a credential", () => {
    const config = readRuntimeConfig(env());
    expect(config.runtimeMode).toBe("public-demo");
    expect(config.requestedProvider).toBe("MOCK");
    expect(config.deepseekAvailable).toBe(false);
    expect(resolveProvider("MOCK", { env: env() }).ok).toBe(true);
  });

  it("forces public-demo DeepSeek selection closed without falling back", () => {
    let calls = 0;
    const publicEnv = env({
      APP_RUNTIME_MODE: "public-demo",
      LLM_PROVIDER: "deepseek",
      DEEPSEEK_ENABLED: "true",
      DEEPSEEK_API_KEY: fakeKey(),
    });
    const config = readRuntimeConfig(publicEnv);
    expect(config.issues).toContainEqual({ ruleId: RUNTIME_CONFIG_RULE_IDS.PUBLIC_DEMO_FORCED_MOCK });
    const result = resolveProvider("DEEPSEEK", { env: publicEnv });
    const gated = resolveProvider("DEEPSEEK", {
      env: publicEnv,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not be reached");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.ruleId).toBe("PROVIDER_PUBLIC_DEMO_FORCED_MOCK");
    expect(gated.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("requires local-research, enable flag, and a minimally valid key", () => {
    expect(readRuntimeConfig(env({ APP_RUNTIME_MODE: "local-research", DEEPSEEK_ENABLED: "false" })).deepseekAvailable).toBe(false);
    expect(readRuntimeConfig(env({ APP_RUNTIME_MODE: "local-research", DEEPSEEK_ENABLED: "true" })).deepseekAvailable).toBe(false);
    expect(readRuntimeConfig(env({
      APP_RUNTIME_MODE: "local-research",
      DEEPSEEK_ENABLED: "true",
      DEEPSEEK_API_KEY: fakeKey(),
    })).deepseekAvailable).toBe(true);

    const resolved = resolveProvider("DEEPSEEK", {
      env: env({
        APP_RUNTIME_MODE: "local-research",
        DEEPSEEK_ENABLED: "true",
        DEEPSEEK_API_KEY: fakeKey(),
      }),
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider).toMatchObject({ id: "deepseek", executionType: "REAL", networkCall: true });
  });

  it("returns a client-safe capability DTO without credential material", () => {
    const capabilities = getProviderCapabilities();
    expect(capabilities).toMatchObject({
      mock: { available: true, executionType: "MOCK", networkCall: false },
      deepseek: { executionType: "REAL", networkCall: true },
    });
    expect(JSON.stringify(capabilities)).not.toContain("DEEPSEEK_API_KEY");
    expect(JSON.stringify(capabilities)).not.toMatch(/sk-[A-Za-z0-9_-]+/u);
  });
});
