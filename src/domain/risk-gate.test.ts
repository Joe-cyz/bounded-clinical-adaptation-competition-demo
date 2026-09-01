import { describe, expect, it } from "vitest";

import { fixtureDraftRevision, fixtureProfile } from "@/infrastructure/sqlite/test-fixtures";
import { extractFeedbackProposals, classifyFeedback } from "./risk-gate";

const extractionContext = {
  generationRunId: "run-fixture-001",
  profileId: fixtureProfile.id,
  profileVersion: 1,
};

describe("feedback risk gate", () => {
  it("rejects deletion of a protected allergy field", () => {
    const result = classifyFeedback({
      id: "high-1",
      changeType: "DELETE",
      affectedFields: ["allergies"],
      beforeText: "保留过敏史",
      afterText: "省略过敏史",
    });

    expect(result.riskLevel).toBe("HIGH");
    expect(result.decision).toBe("REJECTED");
    expect(result.ruleHits).toContain("HIGH-PROTECTED-FIELD");
  });

  it("rejects attempts to learn a default medication rule", () => {
    const result = classifyFeedback({
      id: "high-2",
      changeType: "ADD",
      affectedFields: ["currentMedications"],
      beforeText: "无默认建议",
      afterText: "以后默认推荐某药和固定剂量",
    });

    expect(result).toMatchObject({ riskLevel: "HIGH", decision: "REJECTED" });
  });

  it("holds specialty-priority changes for review", () => {
    const result = classifyFeedback({
      id: "medium-1",
      changeType: "REORDER",
      affectedFields: ["specialtyPriority"],
      beforeText: "当前顺序",
      afterText: "新的专科顺序",
    });

    expect(result).toMatchObject({ riskLevel: "MEDIUM", decision: "HELD" });
  });

  it("creates a candidate for whitelisted presentation preferences", () => {
    const result = classifyFeedback({
      id: "low-1",
      changeType: "REORDER",
      affectedFields: ["sectionOrder"],
      beforeText: "摘要在前",
      afterText: "问题列表在前",
    });

    expect(result).toMatchObject({ riskLevel: "LOW", decision: "CANDIDATE" });
  });

  it("recognizes expandAbbreviations as a whitelisted presentation preference", () => {
    const result = classifyFeedback({
      id: "low-abbreviations",
      changeType: "REWRITE",
      affectedFields: ["expandAbbreviations"],
      beforeText: "保留缩写原文",
      afterText: "展开缩写以便阅读",
    });

    expect(result).toMatchObject({ riskLevel: "LOW", decision: "CANDIDATE" });
  });

  it("defaults ambiguous feedback to review", () => {
    const result = classifyFeedback({
      id: "uncertain-1",
      changeType: "REWRITE",
      affectedFields: ["unknownClinicalEmphasis"],
      beforeText: "原始内容",
      afterText: "含混改写",
    });

    expect(result).toMatchObject({ riskLevel: "UNCERTAIN", decision: "HELD" });
  });

  it("derives a single low-risk sectionOrder candidate from a real reorder", () => {
    const base = fixtureDraftRevision().beforeSnapshot;
    const after = { ...base, sections: [...base.sections].reverse() };
    const revision = fixtureDraftRevision({ afterSnapshot: after });
    const result = extractFeedbackProposals(revision, extractionContext);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]).toMatchObject({
        changeType: "REORDER",
        affectedField: "sectionOrder",
        riskLevel: "LOW",
        status: "CANDIDATE",
        decision: "PENDING",
        rulesVersion: "feedback-rules-v1",
      });
      expect(result.proposals[0].candidatePatch?.sectionOrder).toEqual(after.sections.map((section) => section.key));
    }
  });

  it("uses the explicit server profile context even when configurationKey text changes", () => {
    const fixture = fixtureDraftRevision();
    const configurationKey = "tampered|profile=attacker@999";
    const revision = fixtureDraftRevision({
      beforeSnapshot: {
        ...fixture.beforeSnapshot,
        configurationKey,
      },
      afterSnapshot: {
        ...fixture.afterSnapshot,
        configurationKey,
      },
    });
    const result = extractFeedbackProposals(revision, {
      ...extractionContext,
      profileId: fixtureProfile.id,
      profileVersion: 7,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposals[0]?.profileId).toBe(fixtureProfile.id);
    if (result.ok) expect(result.proposals[0]?.profileVersion).toBe(7);
  });

  it("holds content edits for review without guessing a tone or verbosity preference", () => {
    const base = fixtureDraftRevision().beforeSnapshot;
    const after = {
      ...base,
      sections: base.sections.map((section) => section.key === "summary"
        ? { ...section, content: [...section.content, "新的表达"] }
        : section),
    };
    const revision = fixtureDraftRevision({ afterSnapshot: after });
    const result = extractFeedbackProposals(revision, extractionContext);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.proposals.every((proposal) => proposal.riskLevel === "MEDIUM")).toBe(true);
  });

  it("applies hard rules before the low-risk whitelist and does not echo dangerous text", () => {
    const base = fixtureDraftRevision().beforeSnapshot;
    const after = {
      ...base,
      sections: base.sections.map((section) => section.key === "summary"
        ? { ...section, content: ["以后自动诊断并开药"] }
        : section),
    };
    const revision = fixtureDraftRevision({ afterSnapshot: after });
    const result = extractFeedbackProposals(revision, extractionContext);

    expect(result).toMatchObject({ ok: false, ruleId: "FEEDBACK_HIGH_RISK_BLOCKED" });
    expect(JSON.stringify(result)).not.toContain("以后自动诊断并开药");
    if (!result.ok) expect(result.proposals[0]).toMatchObject({ riskLevel: "HIGH", status: "REJECTED", nextAllowedActions: [] });
  });

  it("keeps a negative safety disclaimer from matching a prohibited action", () => {
    const base = fixtureDraftRevision().beforeSnapshot;
    const after = {
      ...base,
      sections: base.sections.map((section) => section.key === "summary"
        ? { ...section, content: ["不提供独立诊断，不自动开药，也不直接写回病历，仍需人工复核"] }
        : section),
    };
    const revision = fixtureDraftRevision({ afterSnapshot: after });
    const result = extractFeedbackProposals(revision, extractionContext);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.proposals[0].riskLevel).toBe("MEDIUM");
  });

  it("closes a mixed proposal when any event is high risk", () => {
    const base = fixtureDraftRevision().beforeSnapshot;
    const after = {
      ...base,
      sections: [
        ...base.sections.map((section) => section.key === "summary"
          ? { ...section, content: ["以后自动诊断"] }
          : section),
      ].reverse(),
    };
    const revision = fixtureDraftRevision({ afterSnapshot: after });
    const result = extractFeedbackProposals(revision, extractionContext);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.proposals.every((proposal) => proposal.riskLevel === "HIGH")).toBe(true);
  });
});
