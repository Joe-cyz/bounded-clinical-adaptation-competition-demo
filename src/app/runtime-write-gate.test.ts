import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmCandidateAction,
  dismissCandidateAction,
  freezeProfileAction,
  reviewFeedbackAction,
  rollbackProfileAction,
  runGenerationAction,
  saveDraftRevisionAction,
} from "@/app/workbench/actions";
import {
  confirmFeedbackCandidateAction,
  dismissFeedbackCandidateAction,
  freezeProfileReviewAction,
  reviewFeedbackEventAction,
  rollbackProfileReviewAction,
} from "@/app/review/actions";
import { runDeepSeekEvaluationBatchAction, runEvaluationBatchAction } from "@/app/evaluation/actions";
import { syntheticCases, physicianProfiles } from "@/data/seed-loader";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY } from "@/server/runtime-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public-demo write gate", () => {
  it("blocks every write/provider action before database or network initialization", async () => {
    const databasePath = join(tmpdir(), `bounded-public-demo-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    vi.stubEnv("APP_RUNTIME_MODE", "public-demo");
    vi.stubEnv("DATABASE_PATH", databasePath);
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("public-demo must not reach a provider");
    }) as typeof fetch;

    try {
      const generationA = await runGenerationAction({
        caseId: syntheticCases[0].id,
        profileId: physicianProfiles[0].id,
        providerSelection: "MOCK",
      });
      const generationB = await runGenerationAction({
        caseId: syntheticCases[0].id,
        profileId: physicianProfiles[0].id,
        providerSelection: "MOCK",
      });
      const results = await Promise.all([
        saveDraftRevisionAction({}),
        confirmCandidateAction({}),
        dismissCandidateAction({}),
        reviewFeedbackAction({}),
        freezeProfileAction({}),
        rollbackProfileAction({}),
        confirmFeedbackCandidateAction({}),
        dismissFeedbackCandidateAction({}),
        reviewFeedbackEventAction({}),
        freezeProfileReviewAction({}),
        rollbackProfileReviewAction({}),
        runEvaluationBatchAction(),
        runDeepSeekEvaluationBatchAction(),
      ]);

      expect(generationA.status).toBe("FAILED");
      expect(generationA.generic.error?.ruleId).toBe(PUBLIC_DEMO_READ_ONLY);
      expect(generationA.bounded.error?.ruleId).toBe(PUBLIC_DEMO_READ_ONLY);
      expect(generationA.requestId).toMatch(/^public-demo-request-[a-z0-9-]+$/u);
      expect(generationB.requestId).not.toBe(generationA.requestId);
      for (const result of results) expect(result).toMatchObject({ ok: false, ruleId: PUBLIC_DEMO_READ_ONLY });
      expect(fetchCalls).toBe(0);
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows the existing local-research Mock action path", async () => {
    vi.stubEnv("APP_RUNTIME_MODE", "local-research");
    vi.stubEnv("DATABASE_PATH", ":memory:");
    expect(assertRuntimeWriteAllowed()).toMatchObject({ ok: true, runtimeMode: "local-research" });
    const result = await runGenerationAction({
      caseId: syntheticCases[0].id,
      profileId: physicianProfiles[0].id,
      providerSelection: "MOCK",
      mockMode: "SUCCESS",
    });
    expect(result.status).toBe("SUCCEEDED");
  });
});
