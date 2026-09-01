import { z } from "zod";

export const providerSelectionSchema = z.enum(["MOCK", "DEEPSEEK"]);
export type ProviderSelection = z.infer<typeof providerSelectionSchema>;

export const providerExecutionTypeSchema = z.enum(["MOCK", "REAL"]);
export type ProviderExecutionType = z.infer<typeof providerExecutionTypeSchema>;

export const providerOutputContractSchema = z.enum(["FULL_DRAFT", "SECTION_ENVELOPE"]);
export type ProviderOutputContract = z.infer<typeof providerOutputContractSchema>;

export const providerCapabilitySchema = z.object({
  executionType: providerExecutionTypeSchema,
  available: z.boolean(),
  modelId: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(200),
  networkCall: z.boolean(),
}).strict();

export const providerCapabilitiesSchema = z.object({
  runtimeMode: z.enum(["public-demo", "local-research"]),
  publicDemoReadOnly: z.boolean(),
  mock: providerCapabilitySchema,
  deepseek: providerCapabilitySchema,
  safetyNotice: z.string().min(1).max(500),
}).strict();
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerMetadataSchema = z.object({
  responseId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u).optional(),
  responseModelId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u).optional(),
  systemFingerprint: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u).optional(),
  finishReason: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/u).optional(),
  inputTokens: z.number().int().nonnegative().max(1_000_000).optional(),
  outputTokens: z.number().int().nonnegative().max(1_000_000).optional(),
  promptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  promptVersion: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u),
}).strict();
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;
