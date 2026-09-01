/** Test-only synthetic literature bytes. They contain no owner or clinical source text. */
export const SYNTHETIC_LITERATURE_FILENAME = "合成循环资料.pdf" as const;
export const SYNTHETIC_FAILURE_FILENAME = "合成解析失败资料.pdf" as const;

export function syntheticLiteraturePdf(pages: readonly string[]): Uint8Array {
  function utf16BeHex(value: string): string {
    return Array.from(value).map((character) => {
      const codePoint = character.codePointAt(0)!;
      if (codePoint > 0xffff) throw new Error("The synthetic PDF helper only supports BMP text.");
      return codePoint.toString(16).padStart(4, "0");
    }).join("").toUpperCase();
  }

  const characters = [...new Set(pages.flatMap((page) => Array.from(page)))];
  const mappings = characters.map((character) => {
    const code = character.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase();
    return `<${code}><${code}>`;
  });
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000><FFFF>
endcodespacerange
${mappings.length} beginbfchar
${mappings.join("\n")}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const pageNumbers = pages.map((_, index) => 3 + index);
  const fontNumber = 3 + pages.length;
  const cidFontNumber = fontNumber + 1;
  const descriptorNumber = fontNumber + 2;
  const cmapNumber = fontNumber + 3;
  const contentNumbers = pages.map((_, index) => cmapNumber + 1 + index);
  const objects = new Map<number, Buffer>();
  objects.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1"));
  objects.set(2, Buffer.from(`<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`, "latin1"));
  pages.forEach((_, index) => {
    const pageNumber = pageNumbers[index]!;
    objects.set(pageNumber, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumbers[index]} 0 R >>`, "latin1"));
  });
  objects.set(fontNumber, Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticFont /Encoding /Identity-H /DescendantFonts [${cidFontNumber} 0 R] /ToUnicode ${cmapNumber} 0 R >>`, "latin1"));
  objects.set(cidFontNumber, Buffer.from(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorNumber} 0 R /DW 1000 >>`, "latin1"));
  objects.set(descriptorNumber, Buffer.from("<< /Type /FontDescriptor /FontName /SyntheticFont /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>", "latin1"));
  objects.set(cmapNumber, Buffer.from(`<< /Length ${Buffer.byteLength(cmap, "latin1")} >>\nstream\n${cmap}\nendstream`, "latin1"));
  pages.forEach((page, index) => {
    const stream = `BT /F1 12 Tf 24 720 Td <${utf16BeHex(page)}> Tj ET`;
    objects.set(contentNumbers[index]!, Buffer.from(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`, "latin1"));
  });

  const maxObject = Math.max(...objects.keys());
  const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n%\u00FF\u00FF\u00FF\u00FF\n", "latin1")];
  const offsets = new Map<number, number>();
  for (let number = 1; number <= maxObject; number += 1) {
    const body = objects.get(number);
    if (!body) continue;
    offsets.set(number, chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    chunks.push(Buffer.from(`${number} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1"));
  }
  const xrefOffset = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const xref = [`xref\n0 ${maxObject + 1}\n`, `${String(0).padStart(10, "0")} 65535 f \n`];
  for (let number = 1; number <= maxObject; number += 1) {
    xref.push(`${String(offsets.get(number) ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  xref.push(`trailer\n<< /Size ${maxObject + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  chunks.push(Buffer.from(xref.join(""), "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}
