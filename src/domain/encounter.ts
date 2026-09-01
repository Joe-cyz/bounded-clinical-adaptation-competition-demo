import { z } from "zod";

import { appRuntimeModeSchema, type AppRuntimeMode } from "./runtime-mode";
import {
  isoUtcTimestampSchema,
  jsonObjectSchema,
} from "./runtime-records";
import {
  encounterSourceSchema,
  resolveEncounterSource,
  type EncounterSource,
} from "./encounter-source";

const schemaVersionSchema = z.literal("1.0.0");
const safeRuntimeIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const encounterStatusSchema = z.enum([
  "DRAFT",
  "RECORD_SAVED",
  "REFERENCE_VIEWED",
  "REVIEW_PENDING",
  "CONFIRMED",
]);
export type EncounterStatus = z.infer<typeof encounterStatusSchema>;

export const encounterStatusOrder = [
  "DRAFT",
  "RECORD_SAVED",
  "REFERENCE_VIEWED",
  "REVIEW_PENDING",
  "CONFIRMED",
] as const satisfies readonly EncounterStatus[];

export const encounterSexSchema = z.enum(["FEMALE", "MALE", "INTERSEX", "UNKNOWN", "NOT_STATED"]);
export const encounterAgeBandSchema = z.enum(["CHILD", "ADULT", "OLDER_ADULT", "UNKNOWN"]);

/**
 * PWR-02 deliberately keeps this snapshot smaller than the PWR-03 medical
 * record. The label must visibly identify a synthetic subject and the schema
 * has no patient-name, telephone, address or government-ID fields.
 */
export const demographicSnapshotSchema = z.object({
  displayLabel: z.string()
    .min(1)
    .max(80)
    .regex(/^(?:合成患者|合成病例|合成手工患者|Synthetic(?:[-_ ]?Patient)?)(?:[-_ ]?[A-Za-z0-9][A-Za-z0-9-]*)?$/u),
  sex: encounterSexSchema,
  ageBand: encounterAgeBandSchema,
}).strict();
export type DemographicSnapshot = z.infer<typeof demographicSnapshotSchema>;

function timestampMilliseconds(value: string): number {
  return Date.parse(value);
}

export const encounterRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: safeRuntimeIdSchema,
  synthetic: z.literal(true),
  caseId: safeRuntimeIdSchema,
  caseVersion: z.string().min(1).max(100),
  status: encounterStatusSchema,
  demographicSnapshot: demographicSnapshotSchema,
  currentRecordRevisionId: safeRuntimeIdSchema.optional(),
  createdAt: isoUtcTimestampSchema,
  updatedAt: isoUtcTimestampSchema,
  confirmedAt: isoUtcTimestampSchema.optional(),
  runtimeMode: appRuntimeModeSchema,
  source: encounterSourceSchema.optional(),
}).strict().superRefine((encounter, context) => {
  const addIssue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });

  if (timestampMilliseconds(encounter.updatedAt) < timestampMilliseconds(encounter.createdAt)) {
    addIssue(["updatedAt"], "Encounter updatedAt must not precede createdAt.");
  }

  if (encounter.status === "CONFIRMED" && encounter.confirmedAt === undefined) {
    addIssue(["confirmedAt"], "A confirmed Encounter requires confirmedAt.");
  }
  if (encounter.status !== "CONFIRMED" && encounter.confirmedAt !== undefined) {
    addIssue(["confirmedAt"], "Only a confirmed Encounter may have confirmedAt.");
  }
  if (encounter.confirmedAt !== undefined
    && timestampMilliseconds(encounter.confirmedAt) < timestampMilliseconds(encounter.updatedAt)) {
    addIssue(["confirmedAt"], "Encounter confirmedAt must not precede updatedAt.");
  }
  if (encounter.status !== "DRAFT" && encounter.currentRecordRevisionId === undefined) {
    addIssue(["currentRecordRevisionId"], "An Encounter after DRAFT requires its current record revision.");
  }
  if (encounter.source?.type === "SEEDED_SYNTHETIC"
    && (encounter.source.caseId !== encounter.caseId || encounter.source.caseVersion !== encounter.caseVersion)) {
    addIssue(["source"], "A seeded Encounter source must match the Encounter case reference.");
  }
});

export type EncounterRecord = z.infer<typeof encounterRecordSchema>;

export function encounterSourceOf(record: Pick<EncounterRecord, "source" | "caseId" | "caseVersion">): EncounterSource {
  return resolveEncounterSource(record);
}

/**
 * This is an opaque, versioned relationship row for PWR-02. PWR-03 will
 * define and validate the medical-record payload; this package does not
 * interpret it as a complete medical record or expose record editing.
 */
export const encounterRecordRevisionSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: safeRuntimeIdSchema,
  encounterId: safeRuntimeIdSchema,
  revisionNumber: z.number().int().positive().max(100_000),
  recordPayload: jsonObjectSchema,
  createdAt: isoUtcTimestampSchema,
}).strict();
export type EncounterRecordRevision = z.infer<typeof encounterRecordRevisionSchema>;

export const createEncounterRequestSchema = z.object({
  id: safeRuntimeIdSchema.optional(),
  caseId: safeRuntimeIdSchema,
  caseVersion: z.string().min(1).max(100),
  demographicSnapshot: demographicSnapshotSchema,
}).strict();
export type CreateEncounterRequest = z.infer<typeof createEncounterRequestSchema>;

export const transitionEncounterRequestSchema = z.object({
  encounterId: safeRuntimeIdSchema,
  expectedStatus: encounterStatusSchema,
  expectedUpdatedAt: isoUtcTimestampSchema,
  targetStatus: encounterStatusSchema,
  /** Used only to associate the first saved state with an existing revision row. */
  currentRecordRevisionId: safeRuntimeIdSchema.optional(),
}).strict();
export type TransitionEncounterRequest = z.infer<typeof transitionEncounterRequestSchema>;

const encounterAuditMetadataBaseShape = {
  encounterId: safeRuntimeIdSchema,
  caseId: safeRuntimeIdSchema,
  caseVersion: z.string().min(1).max(100),
  synthetic: z.literal(true),
  runtimeMode: appRuntimeModeSchema,
};

export const encounterAuditMetadataBaseSchema = z.object(encounterAuditMetadataBaseShape).strict();
export type EncounterAuditMetadataBase = z.infer<typeof encounterAuditMetadataBaseSchema>;

export const encounterCreatedAuditMetadataSchema = encounterAuditMetadataBaseSchema;
export type EncounterCreatedAuditMetadata = z.infer<typeof encounterCreatedAuditMetadataSchema>;

export const encounterStatusChangedAuditMetadataSchema = encounterAuditMetadataBaseSchema.extend({
  fromStatus: encounterStatusSchema,
  toStatus: encounterStatusSchema,
}).strict();
export type EncounterStatusChangedAuditMetadata = z.infer<typeof encounterStatusChangedAuditMetadataSchema>;

export const encounterAuditMetadataSchema = z.union([
  encounterCreatedAuditMetadataSchema,
  encounterStatusChangedAuditMetadataSchema,
]);
export type EncounterAuditMetadata = z.infer<typeof encounterAuditMetadataSchema>;

export type EncounterTransitionOptions = {
  currentRecordRevisionId?: string;
};

export type EncounterDomainErrorCode = "INVALID_TRANSITION" | "CONFLICT";

export class EncounterDomainError extends Error {
  readonly code: EncounterDomainErrorCode;

  constructor(code: EncounterDomainErrorCode, message: string) {
    super(message);
    this.name = "EncounterDomainError";
    this.code = code;
  }
}

export function createEncounterRecord(input: {
  id: string;
  caseId: string;
  caseVersion: string;
  demographicSnapshot: DemographicSnapshot;
  createdAt: string;
  runtimeMode: AppRuntimeMode;
  source?: EncounterSource;
}): EncounterRecord {
  return encounterRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: input.id,
    synthetic: true,
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    status: "DRAFT",
    demographicSnapshot: input.demographicSnapshot,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    runtimeMode: input.runtimeMode,
    ...(input.source === undefined ? {} : { source: input.source }),
  });
}

function nextStatusFor(status: EncounterStatus): EncounterStatus | undefined {
  const index = encounterStatusOrder.indexOf(status);
  return index >= 0 && index < encounterStatusOrder.length - 1
    ? encounterStatusOrder[index + 1]
    : undefined;
}

export function advanceEncounterStatus(
  record: EncounterRecord,
  targetStatus: EncounterStatus,
  updatedAt: string,
  options: EncounterTransitionOptions = {},
): EncounterRecord {
  const current = encounterRecordSchema.parse(record);
  const target = encounterStatusSchema.parse(targetStatus);

  if (current.status === "CONFIRMED") {
    throw new EncounterDomainError("CONFLICT", "A confirmed Encounter is terminal.");
  }
  if (target === current.status) {
    throw new EncounterDomainError("CONFLICT", "An Encounter status transition was already applied.");
  }
  if (nextStatusFor(current.status) !== target) {
    throw new EncounterDomainError("INVALID_TRANSITION", "Encounter status transitions must be sequential.");
  }
  if (timestampMilliseconds(updatedAt) < timestampMilliseconds(current.updatedAt)) {
    throw new EncounterDomainError("CONFLICT", "Encounter updatedAt cannot move backwards.");
  }

  const requestedRevisionId = options.currentRecordRevisionId;
  if (requestedRevisionId !== undefined && target !== "RECORD_SAVED") {
    if (requestedRevisionId !== current.currentRecordRevisionId) {
      throw new EncounterDomainError("CONFLICT", "The current record revision cannot change during this transition.");
    }
  }
  if (requestedRevisionId !== undefined
    && current.currentRecordRevisionId !== undefined
    && requestedRevisionId !== current.currentRecordRevisionId) {
    throw new EncounterDomainError("CONFLICT", "The current record revision is stale.");
  }

  const currentRecordRevisionId = requestedRevisionId ?? current.currentRecordRevisionId;
  if (target !== "DRAFT" && currentRecordRevisionId === undefined) {
    throw new EncounterDomainError("CONFLICT", "A saved Encounter state requires a current record revision.");
  }

  return encounterRecordSchema.parse({
    ...current,
    status: target,
    updatedAt,
    ...(currentRecordRevisionId === undefined ? {} : { currentRecordRevisionId }),
    ...(target === "CONFIRMED" ? { confirmedAt: updatedAt } : {}),
  });
}
