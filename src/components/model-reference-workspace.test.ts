import { describe, expect, it } from "vitest";

import {
  CASE_OVERVIEW_QUESTION,
  GENERAL_DEFAULT_QUESTION,
  canSubmitReferenceQuestion,
  referenceResultHeadingTag,
  referenceKindForDocuments,
  transitionQuestionForDocuments,
  uniqueVisibleCitations,
  updateReferenceDocumentSelection,
} from "./model-reference-workspace";

describe("PWR-08C visible reference citations", () => {
  it("deduplicates only identical display tuples while preserving first order", () => {
    const citations = [
      { itemId: "item-1", displayName: "合成循环资料", version: 1, locationLabel: "第 3 页", quote: "同一段合成摘录" },
      { itemId: "item-2", displayName: "合成循环资料", version: 1, locationLabel: "第 3 页", quote: "同一段合成摘录" },
      { itemId: "item-3", displayName: "合成循环资料", version: 1, locationLabel: "第 4 页", quote: "同一段合成摘录" },
    ];
    expect(uniqueVisibleCitations(citations)).toEqual([citations[0], citations[2]]);
  });

  it("keeps document selection unique, stable, and capped at three", () => {
    expect(updateReferenceDocumentSelection([], "doc-1")).toEqual(["doc-1"]);
    expect(updateReferenceDocumentSelection(["doc-1", "doc-1", "doc-2"], "doc-3")).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(updateReferenceDocumentSelection(["doc-1", "doc-2", "doc-3"], "doc-4")).toEqual(["doc-1", "doc-2", "doc-3"]);
    expect(updateReferenceDocumentSelection(["doc-1", "doc-2", "doc-3"], "doc-2")).toEqual(["doc-1", "doc-3"]);
    expect(referenceKindForDocuments([])).toBe("GENERAL");
    expect(referenceKindForDocuments(["doc-1"])).toBe("LITERATURE_GROUNDED");
  });

  it("clears the untouched general question on first material selection and restores it only when still unedited", () => {
    const selected = transitionQuestionForDocuments(
      { value: GENERAL_DEFAULT_QUESTION, edited: false },
      0,
      1,
    );
    expect(selected).toEqual({ value: "", edited: false });
    expect(transitionQuestionForDocuments(selected, 1, 0)).toEqual({
      value: GENERAL_DEFAULT_QUESTION,
      edited: false,
    });
    expect(transitionQuestionForDocuments(
      { value: "医生关注乏力变化", edited: true },
      0,
      1,
    )).toEqual({ value: "医生关注乏力变化", edited: true });
    expect(transitionQuestionForDocuments(
      { value: "", edited: true },
      1,
      0,
    )).toEqual({ value: "", edited: true });
  });

  it("disables an empty question without changing the provider request contract", () => {
    expect(canSubmitReferenceQuestion("\n  ")).toBe(false);
    expect(canSubmitReferenceQuestion("合成循环")).toBe(true);
  });

  it("keeps the one-click case overview question fixed and independently submittable", () => {
    expect(CASE_OVERVIEW_QUESTION).toBe("请结合当前已保存病历，对整个病例给出综合判断和诊疗建议。");
    expect(canSubmitReferenceQuestion(CASE_OVERVIEW_QUESTION)).toBe(true);
    expect(canSubmitReferenceQuestion("")).toBe(false);
  });

  it("uses page-level result headings for the main page and nested headings for literature", () => {
    expect(referenceResultHeadingTag(false)).toBe("h2");
    expect(referenceResultHeadingTag(true)).toBe("h4");
  });
});
