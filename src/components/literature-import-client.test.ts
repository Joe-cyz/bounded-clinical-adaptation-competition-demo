import { describe, expect, it } from "vitest";

import {
  createLiteratureRequestId,
  validateLiteratureSelection,
} from "./literature-import-client";

function file(name: string, type = "application/pdf", bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("literature import client metadata validation", () => {
  it("accepts one to three locally declared PDF or TXT files without reading their bodies", () => {
    const result = validateLiteratureSelection([
      file("pathology.pdf"),
      file("notes.txt", "text/plain"),
    ]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.files).toHaveLength(2);
    expect(result.files.map((candidate) => candidate.declaredMime)).toEqual(["application/pdf", "text/plain"]);
  });

  it("rejects an empty selection, unsupported names, incompatible MIME types and duplicate names", () => {
    expect(validateLiteratureSelection([])).toMatchObject({ ok: false, message: "请选择 1 至 3 份 PDF 或 TXT 资料。" });
    expect(validateLiteratureSelection([file("notes.exe")])).toMatchObject({ ok: false, message: "仅支持 PDF 或 TXT 资料。" });
    expect(validateLiteratureSelection([file("notes.pdf", "text/plain")])).toMatchObject({ ok: false, message: "资料类型与文件名称不一致，请重新选择。" });
    expect(validateLiteratureSelection([file("same.pdf"), file("same.pdf")])).toMatchObject({ ok: false, message: "请不要重复选择同一份资料。" });
  });

  it("rejects unsafe and empty files before any upload request can be constructed", () => {
    expect(validateLiteratureSelection([file("../pathology.pdf")])).toMatchObject({ ok: false, message: "资料名称不符合要求，请重新选择文件。" });
    expect(validateLiteratureSelection([file("empty.pdf", "application/pdf", 0)])).toMatchObject({ ok: false, message: "不能导入空文件。" });
  });

  it("creates opaque, bounded request identifiers only when an import is explicitly started", () => {
    expect(createLiteratureRequestId()).toMatch(/^literature-request-[0-9a-f-]{36}$/u);
  });
});
