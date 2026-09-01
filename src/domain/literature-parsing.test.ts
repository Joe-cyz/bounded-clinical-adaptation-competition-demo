import { describe, expect, it } from "vitest";

import {
  LITERATURE_FRAGMENT_MAX_CODE_POINTS,
  LITERATURE_FRAGMENT_MAX_OVERLAP_CODE_POINTS,
  literatureCitationDtoSchema,
  literatureSearchRequestSchema,
  normalizeLiteratureNewlines,
  normalizeLiteratureSearchText,
  splitLiteraturePage,
} from "./literature-parsing";

describe("literature parsing domain contract", () => {
  it("normalizes line endings and search text without changing Unicode code-point semantics", () => {
    expect(normalizeLiteratureNewlines("甲\r\n乙\r丙")).toBe("甲\n乙\n丙");
    expect(normalizeLiteratureSearchText("ＡＢＣ\u2003合成资料（安全）")).toBe("ABC 合成资料 安全");

    const chunks = splitLiteraturePage({
      sourceKind: "PDF_PAGE",
      pageNumber: 1,
      text: "甲😀乙。\r\n合成资料。",
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endCodePoint).toBe(Array.from("甲😀乙。\n合成资料。").length);
    expect(chunks[0]?.location).toEqual({ kind: "PDF_PAGE", pageNumber: 1, startCodePoint: 0, endCodePoint: 10 });
  });

  it("splits deterministically at bounded Unicode lengths with capped overlap", () => {
    const text = `${"合成资料内容。".repeat(180)}\n${"第二段观察内容。".repeat(180)}`;
    const first = splitLiteraturePage({ sourceKind: "PDF_PAGE", pageNumber: 4, text });
    const second = splitLiteraturePage({ sourceKind: "PDF_PAGE", pageNumber: 4, text });
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);
    for (let index = 0; index < first.length; index += 1) {
      const chunk = first[index]!;
      expect(Array.from(chunk.text).length).toBeLessThanOrEqual(LITERATURE_FRAGMENT_MAX_CODE_POINTS);
      expect(chunk.location).toMatchObject({ kind: "PDF_PAGE", pageNumber: 4 });
      if (index > 0) {
        const previous = first[index - 1]!;
        expect(previous.endCodePoint - chunk.startCodePoint).toBeLessThanOrEqual(LITERATURE_FRAGMENT_MAX_OVERLAP_CODE_POINTS);
      }
    }
  });

  it("maps TXT fragments to one-based line locations and bounds DTO text", () => {
    const chunks = splitLiteraturePage({
      sourceKind: "TXT_LINES",
      pageNumber: 1,
      title: "合成观察记录",
      text: "第一行\r\n第二行\n第三行",
    });
    expect(chunks[0]?.location).toEqual({ kind: "TXT_LINES", startLine: 1, endLine: 3, title: "合成观察记录" });
    expect(literatureCitationDtoSchema.safeParse({
      documentId: "document-001",
      versionId: "version-001",
      fragmentId: "fragment-001",
      displayName: "synthetic.txt",
      version: 1,
      location: { kind: "TXT_LINES", startLine: 1, endLine: 2 },
      excerpt: "😀".repeat(600),
    }).success).toBe(true);
    expect(literatureSearchRequestSchema.safeParse({
      encounterId: "encounter-001",
      query: "😀".repeat(200),
      documentIds: ["document-001"],
    }).success).toBe(true);
  });
});
