import { describe, expect, it } from "vitest";

import { scanSuspectedPii, suspectedPiiRuleIds } from "@/infrastructure/privacy/suspected-pii";
import { createRandomSystemId, formatSystemId } from "./system-id";

// SYNTHETIC_TEST_ONLY: runtime-built values exercise PII-safe identifier handling.
const syntheticTestOnlyPhone = ["138", "0013", "8000"].join("");
const syntheticTestOnlyId = ["110101", "19900101", "1234"].join("");

describe("system identifiers", () => {
  it("breaks dangerous UUID entropy into short, alphabetically separated groups", () => {
    const formatted = formatSystemId("evaluation-result", `${syntheticTestOnlyPhone}-${syntheticTestOnlyId}`);

    expect(formatted).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
    expect(formatted).toContain("z");
    expect(scanSuspectedPii({ id: formatted })).toEqual([]);
  });

  it("keeps random system identifiers unique-shaped and PII-safe", () => {
    const identifiers = Array.from({ length: 100 }, () => createRandomSystemId("evaluation-result"));

    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(identifiers.every((identifier) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(identifier))).toBe(true);
    expect(scanSuspectedPii({ ids: identifiers })).toEqual([]);
  });

  it("continues to block real PII and does not globally exclude id fields", () => {
    expect(scanSuspectedPii({ id: syntheticTestOnlyPhone }).map((match) => match.ruleId)).toContain(suspectedPiiRuleIds.PHONE);
    expect(scanSuspectedPii({ id: syntheticTestOnlyId }).map((match) => match.ruleId)).toContain(suspectedPiiRuleIds.ID_NUMBER);
    expect(scanSuspectedPii({ metadata: { content: `联系电话：${syntheticTestOnlyPhone}` } }).map((match) => match.ruleId)).toContain(suspectedPiiRuleIds.PHONE);
  });
});
