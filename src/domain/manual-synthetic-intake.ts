import { z } from "zod";

import { isoUtcTimestampSchema } from "./runtime-records";
import { appRuntimeModeSchema } from "./runtime-mode";
import { medicalCalendarDateSchema } from "./medical-record";
import {
  MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION,
  MANUAL_SYNTHETIC_SOURCE_TYPE,
  manualSyntheticEncounterSourceSchema,
} from "./encounter-source";

const serverControlledIdentifierSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const manualSyntheticSpecialtySchema = z.enum(["普通内科", "内分泌科"]);
export const manualSyntheticVisitTypeSchema = z.enum(["初诊", "慢病复诊"]);
export const manualSyntheticSexSchema = z.enum(["FEMALE", "MALE", "INTERSEX"]);
export const manualSyntheticAgeSchema = z.number().int().min(0).max(150);

/**
 * This token is created by the server before a manual intake is submitted.
 * Its format is deliberately opaque and contains no client business data.
 */
export const manualSyntheticCreationRequestIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^manual-request-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);

export const manualSyntheticIntakeCreateRequestSchema = z.object({
  creationRequestId: manualSyntheticCreationRequestIdSchema,
  specialty: manualSyntheticSpecialtySchema,
  visitType: manualSyntheticVisitTypeSchema,
  sex: manualSyntheticSexSchema,
  age: manualSyntheticAgeSchema,
}).strict();

export type ManualSyntheticIntakeCreateRequest = z.infer<typeof manualSyntheticIntakeCreateRequestSchema>;

export const manualSyntheticDisplayLabelSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^合成手工患者-[A-Za-z0-9][A-Za-z0-9-]*$/u);

export const manualSyntheticIntakeSchema = z.object({
  schemaVersion: z.literal(MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION),
  intakeId: serverControlledIdentifierSchema,
  creationRequestId: manualSyntheticCreationRequestIdSchema,
  synthetic: z.literal(true),
  displayLabel: manualSyntheticDisplayLabelSchema,
  specialty: manualSyntheticSpecialtySchema,
  visitType: manualSyntheticVisitTypeSchema,
  sex: manualSyntheticSexSchema,
  age: manualSyntheticAgeSchema,
  visitDate: medicalCalendarDateSchema,
  recordDate: medicalCalendarDateSchema,
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((intake, context) => {
  if (intake.recordDate < intake.visitDate) {
    context.addIssue({
      code: "custom",
      path: ["recordDate"],
      message: "Record date cannot precede visit date.",
    });
  }
});

export type ManualSyntheticIntakeV1 = z.infer<typeof manualSyntheticIntakeSchema>;

export const manualSyntheticIdempotencyResultSchema = z.enum(["CREATED", "REPLAYED"]);
export type ManualSyntheticIdempotencyResult = z.infer<typeof manualSyntheticIdempotencyResultSchema>;

export const manualSyntheticEncounterCreatedAuditMetadataSchema = z.object({
  encounterId: serverControlledIdentifierSchema,
  intakeId: serverControlledIdentifierSchema,
  sourceType: z.literal(MANUAL_SYNTHETIC_SOURCE_TYPE),
  intakeSchemaVersion: z.literal(MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION),
  encounterStatus: z.literal("DRAFT"),
  synthetic: z.literal(true),
  runtimeMode: appRuntimeModeSchema,
  createdAt: isoUtcTimestampSchema,
  idempotencyResult: z.literal("CREATED"),
}).strict();

export type ManualSyntheticEncounterCreatedAuditMetadata = z.infer<
  typeof manualSyntheticEncounterCreatedAuditMetadataSchema
>;

export const manualSyntheticSourceSchema = manualSyntheticEncounterSourceSchema;
export type ManualSyntheticSource = z.infer<typeof manualSyntheticSourceSchema>;

export function createManualSyntheticSource(intakeId: string): ManualSyntheticSource {
  return manualSyntheticSourceSchema.parse({
    type: MANUAL_SYNTHETIC_SOURCE_TYPE,
    intakeId,
    intakeSchemaVersion: MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION,
  });
}

export function isServerIssuedManualSyntheticCreationRequestId(value: string): boolean {
  return manualSyntheticCreationRequestIdSchema.safeParse(value).success;
}
