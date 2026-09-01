import {
  literatureParseFailureCodeSchema,
  type LiteratureParseFailureCode,
} from "@/domain/literature-parsing";

export type ExtractedLiteraturePage = {
  pageNumber: number;
  text: string;
};

export type LiteratureTextExtractorPort = {
  extractPdf(bytes: Uint8Array, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ExtractedLiteraturePage[]>;
};

export class LiteratureParsingFailure extends Error {
  readonly code: LiteratureParseFailureCode;

  constructor(code: LiteratureParseFailureCode) {
    super("Literature parsing failed.");
    this.name = "LiteratureParsingFailure";
    this.code = literatureParseFailureCodeSchema.parse(code);
  }
}

export function isLiteratureParsingFailure(error: unknown): error is LiteratureParsingFailure {
  return error instanceof LiteratureParsingFailure;
}
