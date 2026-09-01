import { describe, expect, it } from "vitest";

import { physicianProfiles, seedManifest, specialtyVisitPolicies, institutionalSafetyCore, syntheticCases } from "@/data/seed-loader";
import { compileEffectiveConfig } from "./effective-config";
import { generateDraft } from "./generate-draft";
import {
  computeDraftDiff,
  draftDiffSummarySchema,
  draftEditMetricsSchema,
  draftRevisionRecordSchema,
  normalizeDraftLines,
} from "./draft-revisions";

function fixtureDraft() {
  const configResult = compileEffectiveConfig({
    caseData: syntheticCases[0],
    safetyCore: institutionalSafetyCore,
    policies: specialtyVisitPolicies,
    datasetVersion: seedManifest.datasetVersion,
    mode: "BOUNDED",
    profile: physicianProfiles[0],
  });
  if (!configResult.ok) throw new Error("Fixture config failed.");
  return generateDraft(syntheticCases[0], configResult.config, "run-diff-test");
}

describe("draft diff algorithm", () => {
  it("uses strict revision, diff and metrics schemas", () => {
    const draft = fixtureDraft();
    const after = {
      ...draft,
      sections: draft.sections.map((section) => section.key === "summary"
        ? { ...section, content: [...section.content, "结构化编辑"] }
        : section),
    };
    const diff = computeDraftDiff(draft, after);
    const record = draftRevisionRecordSchema.parse({
      schemaVersion: "1.0.0",
      id: "revision-schema-test",
      generationRunId: draft.runId,
      revisionNumber: 1,
      beforeSnapshot: draft,
      afterSnapshot: after,
      diffSummary: diff,
      editorId: "demo-physician",
      createdAt: "2026-08-19T00:00:00.000Z",
    });

    expect(draftRevisionRecordSchema.safeParse({ ...record, extra: true }).success).toBe(false);
    expect(draftDiffSummarySchema.safeParse({ ...diff, extra: true }).success).toBe(false);
    expect(draftEditMetricsSchema.safeParse({ ...diff.metrics, extra: true }).success).toBe(false);
  });

  it("normalizes line endings and computes stable line/character metrics", () => {
    expect(normalizeDraftLines(["a\r\nb", "c\rd"])).toEqual(["a", "b", "c", "d"]);
    const before = fixtureDraft();
    const edited = {
      ...before,
      sections: before.sections.map((section) => section.key === "summary"
        ? { ...section, content: ["abcd", "x"] }
        : section),
    };
    const baseline = {
      ...before,
      sections: before.sections.map((section) => section.key === "summary"
        ? { ...section, content: ["abc", "de"] }
        : section),
    };

    const diff = computeDraftDiff(baseline, edited);
    const baselineCharacterCount = baseline.sections.reduce(
      (sum, section) => sum + normalizeDraftLines(section.content).reduce((sectionSum, line) => sectionSum + line.length, 0),
      0,
    );
    const editedCharacterCount = edited.sections.reduce(
      (sum, section) => sum + normalizeDraftLines(section.content).reduce((sectionSum, line) => sectionSum + line.length, 0),
      0,
    );

    expect(diff).toMatchObject({
      algorithmVersion: "line-lcs-v2",
      newlineNormalization: "CRLF_AND_CR_TO_LF",
      formulaVersion: "edit-burden-v2",
      orderChanged: false,
      metrics: {
        changedSectionCount: 1,
        addedLineCount: 2,
        removedLineCount: 2,
        addedCharacterCount: 5,
        removedCharacterCount: 5,
        editBurdenRatio: Number((10 / Math.max(1, baselineCharacterCount + editedCharacterCount)).toFixed(4)),
      },
    });
    expect(diff.changedSections).toHaveLength(1);
    expect(diff.changedSections[0].key).toBe("summary");
    expect(diff.changedSections[0].operations.every((operation) => operation.operation === "REWRITE")).toBe(true);
  });

  it("uses LCS anchors so insertion and deletion do not cascade", () => {
    const draft = fixtureDraft();
    const withLines = (lines: string[]) => ({
      ...draft,
      sections: draft.sections.map((section) => section.key === "summary"
        ? { ...section, content: lines }
        : section),
    });

    const insertion = computeDraftDiff(withLines(["a", "b"]), withLines(["x", "a", "b"]));
    expect(insertion.changedSections[0].operations).toEqual([
      { operation: "ADD", index: 0, after: "x" },
    ]);

    const deletion = computeDraftDiff(withLines(["a", "b", "c"]), withLines(["a", "c"]));
    expect(deletion.changedSections[0].operations).toEqual([
      { operation: "DELETE", index: 1, before: "b" },
    ]);
  });

  it("keeps duplicate-line matching deterministic and pairs a full rewrite locally", () => {
    const draft = fixtureDraft();
    const withLines = (lines: string[]) => ({
      ...draft,
      sections: draft.sections.map((section) => section.key === "summary"
        ? { ...section, content: lines }
        : section),
    });

    const duplicateBefore = withLines(["same", "same", "tail"]);
    const duplicateAfter = withLines(["same", "tail", "same"]);
    const first = computeDraftDiff(duplicateBefore, duplicateAfter);
    const second = computeDraftDiff(duplicateBefore, duplicateAfter);
    expect(first).toEqual(second);
    expect(first.changedSections[0].operations).toEqual([
      { operation: "DELETE", index: 1, before: "same" },
      { operation: "ADD", index: 2, after: "same" },
    ]);

    const rewriteBefore = withLines(["a", "b"]);
    const rewriteAfter = withLines(["x", "y"]);
    const rewrite = computeDraftDiff(rewriteBefore, rewriteAfter);
    expect(rewrite.changedSections[0].operations).toEqual([
      { operation: "REWRITE", index: 0, before: "a", after: "x" },
      { operation: "REWRITE", index: 1, before: "b", after: "y" },
    ]);
    const rewriteCharacters = (draftToMeasure: ReturnType<typeof withLines>) => draftToMeasure.sections
      .reduce((sum, section) => sum + normalizeDraftLines(section.content).reduce((sectionSum, line) => sectionSum + line.length, 0), 0);
    expect(rewrite.metrics.editBurdenRatio).toBe(
      Number((4 / Math.max(1, rewriteCharacters(rewriteBefore) + rewriteCharacters(rewriteAfter))).toFixed(4)),
    );
  });

  it("records reorder separately and returns a stable empty diff", () => {
    const draft = fixtureDraft();
    const reordered = { ...draft, sections: [...draft.sections].reverse() };
    const reorderDiff = computeDraftDiff(draft, reordered);
    expect(reorderDiff.orderChanged).toBe(true);
    expect(reorderDiff.changedSections).toEqual([]);
    expect(reorderDiff.metrics.editBurdenRatio).toBe(0);

    const noChange = computeDraftDiff(draft, draft);
    expect(noChange).toEqual(computeDraftDiff(draft, { ...draft, sections: draft.sections.map((section) => ({ ...section, content: [...section.content] })) }));
    expect(noChange.orderChanged).toBe(false);
    expect(noChange.metrics.changedSectionCount).toBe(0);
  });
});
