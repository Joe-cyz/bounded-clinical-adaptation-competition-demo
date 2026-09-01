import { z } from "zod";

const safeSourceIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const SEEDED_SYNTHETIC_SOURCE_TYPE = "SEEDED_SYNTHETIC" as const;
export const MANUAL_SYNTHETIC_SOURCE_TYPE = "MANUAL_SYNTHETIC" as const;
export const SEEDED_SYNTHETIC_SOURCE_DATASET_VERSION = "0.4.1" as const;
export const MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION = "1.0.0" as const;

export const seededSyntheticEncounterSourceSchema = z.object({
  type: z.literal(SEEDED_SYNTHETIC_SOURCE_TYPE),
  caseId: safeSourceIdSchema,
  caseVersion: z.string().min(1).max(100),
  sourceDatasetVersion: z.literal(SEEDED_SYNTHETIC_SOURCE_DATASET_VERSION),
}).strict();

export const manualSyntheticEncounterSourceSchema = z.object({
  type: z.literal(MANUAL_SYNTHETIC_SOURCE_TYPE),
  intakeId: safeSourceIdSchema,
  intakeSchemaVersion: z.literal(MANUAL_SYNTHETIC_INTAKE_SCHEMA_VERSION),
}).strict();

export const encounterSourceSchema = z.discriminatedUnion("type", [
  seededSyntheticEncounterSourceSchema,
  manualSyntheticEncounterSourceSchema,
]);

export type SeededSyntheticEncounterSource = z.infer<typeof seededSyntheticEncounterSourceSchema>;
export type ManualSyntheticEncounterSource = z.infer<typeof manualSyntheticEncounterSourceSchema>;
export type EncounterSource = z.infer<typeof encounterSourceSchema>;

/**
 * Legacy Encounter rows have no source column in their JSON/domain payload.
 * Their seeded meaning is restored explicitly from the persisted case
 * reference. No case-id prefix is inspected or inferred.
 */
export function parseEncounterSource(
  value: unknown,
  legacySeed: { caseId: string; caseVersion: string },
): EncounterSource {
  if (value === undefined) {
    return seededSyntheticEncounterSourceSchema.parse({
      type: SEEDED_SYNTHETIC_SOURCE_TYPE,
      caseId: legacySeed.caseId,
      caseVersion: legacySeed.caseVersion,
      sourceDatasetVersion: SEEDED_SYNTHETIC_SOURCE_DATASET_VERSION,
    });
  }
  return encounterSourceSchema.parse(value);
}

export function resolveEncounterSource(input: {
  source?: unknown;
  caseId: string;
  caseVersion: string;
}): EncounterSource {
  return parseEncounterSource(input.source, {
    caseId: input.caseId,
    caseVersion: input.caseVersion,
  });
}
