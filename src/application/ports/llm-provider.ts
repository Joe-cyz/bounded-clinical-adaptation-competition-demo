import type { EffectiveGenerationConfig } from "@/domain/effective-config";
import type { SyntheticCase } from "@/domain/schemas";
import type { ProviderMetadata, ProviderOutputContract } from "@/domain/provider";

export type ProviderInput = {
  runId: string;
  caseData: SyntheticCase;
  config: EffectiveGenerationConfig;
};

export type ProviderUsage = {
  inputUnits?: number;
  outputUnits?: number;
};

export { providerMetadataSchema } from "@/domain/provider";
export type { ProviderMetadata, ProviderOutputContract } from "@/domain/provider";

export type ProviderResult =
  | {
      ok: true;
      raw: string;
      usage?: ProviderUsage;
      metadata?: ProviderMetadata;
    }
  | {
      ok: false;
      errorType: "TIMEOUT" | "AUTH" | "FORMAT" | "PROVIDER";
      message: string;
      metadata?: ProviderMetadata;
    };

export interface LLMProvider {
  readonly id: string;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly executionType?: "MOCK" | "REAL";
  readonly networkCall?: boolean;
  readonly outputContract?: ProviderOutputContract;
  generateDraft(input: ProviderInput): Promise<ProviderResult>;
}
