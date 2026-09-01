import { describe, expect, it } from "vitest";

import { LiteratureParsingFailure } from "./literature-text-extractor";
import { UnpdfLiteratureTextExtractor } from "./unpdf-literature-text-extractor";
import { syntheticLiteraturePdf } from "@/test/synthetic-literature-fixtures";

describe("unpdf literature text extractor", () => {
  it("extracts Chinese text-layer pages sequentially with page numbers", async () => {
    const pages = await new UnpdfLiteratureTextExtractor().extractPdf(syntheticLiteraturePdf([
      "合成资料第一页：观察记录。",
      "合成资料第二页：复核提示。",
    ]));
    expect(pages).toEqual([
      { pageNumber: 1, text: "合成资料第一页：观察记录。" },
      { pageNumber: 2, text: "合成资料第二页：复核提示。" },
    ]);
  });

  it("converts malformed and empty text-layer PDFs to controlled failures", async () => {
    await expect(new UnpdfLiteratureTextExtractor().extractPdf(new TextEncoder().encode("not a PDF")))
      .rejects.toMatchObject({ code: "INVALID_PDF" });
    await expect(new UnpdfLiteratureTextExtractor().extractPdf(syntheticLiteraturePdf(["", ""])))
      .rejects.toMatchObject({ code: "NO_TEXT_LAYER" });
  });

  it("terminates on an already-aborted signal without starting a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new UnpdfLiteratureTextExtractor().extractPdf(syntheticLiteraturePdf(["合成资料"]), { signal: controller.signal }))
      .rejects.toBeInstanceOf(LiteratureParsingFailure);
  });
});
