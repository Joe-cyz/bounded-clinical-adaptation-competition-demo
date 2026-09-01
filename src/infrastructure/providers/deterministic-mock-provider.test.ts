import { describe, expect, it } from "vitest";

import { fixtureCase, fixtureConfig } from "@/infrastructure/sqlite/test-fixtures";
import {
  DeterministicMockProvider,
  type DeterministicMockScenario,
} from "./deterministic-mock-provider";

describe("deterministic mock provider", () => {
  const scenarios: Array<[DeterministicMockScenario, string]> = [
    ["SUCCESS", "ok"],
    ["INVALID_JSON", "ok"],
    ["TIMEOUT", "failed"],
    ["PROVIDER_ERROR", "failed"],
    ["INVALID_OUTPUT_SCHEMA", "ok"],
    ["INVALID_OUTPUT_RULE", "ok"],
  ];

  it.each(scenarios)("handles %s without a network call", async (scenario, expected) => {
    const provider = new DeterministicMockProvider(scenario);
    const result = await provider.generateDraft({
      runId: "run-provider-test",
      caseData: fixtureCase,
      config: fixtureConfig("GENERIC"),
    });

    expect(result.ok ? "ok" : "failed").toBe(expected);
    expect(provider.id).toBe("deterministic-mock");
    expect(provider.modelId).toBe("deterministic-rule-generator");
    expect(provider.promptVersion).toBe("mock-prompt-v1");
    if (!result.ok) expect(result.message).not.toContain("secret");
  });

  it("uses the supplied run ID in a successful raw draft", async () => {
    const result = await new DeterministicMockProvider("SUCCESS").generateDraft({
      runId: "run-explicit-provider-id",
      caseData: fixtureCase,
      config: fixtureConfig("GENERIC"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.raw).runId).toBe("run-explicit-provider-id");
  });
});
