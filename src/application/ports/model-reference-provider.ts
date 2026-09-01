import type {
  GeneralClinicalReferencePromptVersion,
  GeneralModelReferenceOutput,
  LiteratureGroundedReferencePromptVersion,
  LiteratureGroundedModelReferenceOutput,
  ModelReferenceProviderRequest,
} from "@/domain/model-reference";

export type ModelReferenceProviderSuccess<T> = {
  ok: true;
  output: T;
  promptDigest: string;
};

export type ModelReferenceProviderFailure = {
  ok: false;
  code: "PROVIDER_NOT_ENABLED"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_RESPONSE_INVALID"
    | "PROVIDER_REQUEST_FAILED"
    | "PROVIDER_REQUEST_BUDGET_EXHAUSTED";
};

export type GeneralClinicalReferenceInput = Omit<ModelReferenceProviderRequest, "kind" | "promptVersion" | "evidence"> & {
  kind: "GENERAL";
  promptVersion: GeneralClinicalReferencePromptVersion;
  evidence: [];
};

export type LiteratureGroundedReferenceInput = Omit<ModelReferenceProviderRequest, "kind" | "promptVersion"> & {
  kind: "LITERATURE_GROUNDED";
  promptVersion: LiteratureGroundedReferencePromptVersion;
  evidence: [ModelReferenceProviderRequest["evidence"][number], ...ModelReferenceProviderRequest["evidence"]];
};

export interface ClinicalReferenceProvider {
  readonly id: string;
  readonly modelId: string;
  readonly promptVersion: GeneralClinicalReferencePromptVersion;
  generate(input: GeneralClinicalReferenceInput): Promise<ModelReferenceProviderSuccess<GeneralModelReferenceOutput> | ModelReferenceProviderFailure>;
}

export interface LiteratureAnswerProvider {
  readonly id: string;
  readonly modelId: string;
  readonly promptVersion: LiteratureGroundedReferencePromptVersion;
  generate(input: LiteratureGroundedReferenceInput): Promise<ModelReferenceProviderSuccess<LiteratureGroundedModelReferenceOutput> | ModelReferenceProviderFailure>;
}
