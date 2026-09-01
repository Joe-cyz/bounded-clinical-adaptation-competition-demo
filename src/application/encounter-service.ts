import "server-only";

import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";

import { syntheticCases } from "@/data/seed-loader";
import {
  advanceEncounterStatus,
  createEncounterRecord,
  encounterCreatedAuditMetadataSchema,
  createEncounterRequestSchema,
  encounterRecordSchema,
  encounterStatusChangedAuditMetadataSchema,
  encounterStatusSchema,
  transitionEncounterRequestSchema,
  type CreateEncounterRequest,
  type EncounterRecord,
  type EncounterStatus,
  type TransitionEncounterRequest,
} from "@/domain/encounter";
import { isoUtcTimestampSchema, type AuditEventRecord, type JsonObject } from "@/domain/runtime-records";
import { type AppRuntimeMode } from "@/domain/runtime-mode";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import { isPersistenceError, persistenceErrorCodes, PersistenceError, validationError } from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRecordRevisionRepository } from "@/infrastructure/sqlite/repositories/encounter-record-revision-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { validateRuntimeRecord } from "@/infrastructure/sqlite/record-validation";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { createRandomSystemId } from "./system-id";

export const ENCOUNTER_SERVICE_RULE_IDS = {
  INPUT_INVALID: "ENCOUNTER_INPUT_INVALID",
  SYNTHETIC_CASE_REQUIRED: "ENCOUNTER_SYNTHETIC_CASE_REQUIRED",
  NOT_FOUND: "ENCOUNTER_NOT_FOUND",
  RECORD_REVISION_NOT_FOUND: "ENCOUNTER_RECORD_REVISION_NOT_FOUND",
  RECORD_REVISION_MISMATCH: "ENCOUNTER_RECORD_REVISION_MISMATCH",
  STATUS_CONFLICT: "ENCOUNTER_STATUS_CONFLICT",
  DATA_CORRUPTION: "ENCOUNTER_DATA_CORRUPTION",
  PERSISTENCE_FAILED: "ENCOUNTER_PERSISTENCE_FAILED",
  RUNTIME_READ_ONLY: PUBLIC_DEMO_READ_ONLY,
} as const;

export type EncounterIdKind = "ENCOUNTER" | "AUDIT";
export type EncounterIdFactory = (kind: EncounterIdKind) => string;
export type EncounterClock = () => string;
export type EncounterCaseReference = { id: string; version: string; synthetic: true };
export type EncounterCaseResolver = (caseId: string, caseVersion: string) => EncounterCaseReference | undefined;

export type EncounterServiceDependencies = {
  database: DatabaseSync;
  clock?: EncounterClock;
  idFactory?: EncounterIdFactory;
  /** Runtime mode is resolved by trusted server composition, never request input. */
  runtimeMode?: AppRuntimeMode;
  env?: NodeJS.ProcessEnv;
  caseResolver?: EncounterCaseResolver;
  actorId?: string;
  simulatedRole?: AuditEventRecord["simulatedRole"];
};

const defaultIdFactory: EncounterIdFactory = (kind) => createRandomSystemId(
  kind === "AUDIT" ? "encounter-audit" : "encounter",
);
const defaultClock: EncounterClock = () => new Date().toISOString();
const defaultCaseResolver: EncounterCaseResolver = (caseId, caseVersion) => {
  const match = syntheticCases.find((caseData) => caseData.id === caseId && caseData.version === caseVersion);
  return match?.synthetic === true
    ? { id: match.id, version: match.version, synthetic: true }
    : undefined;
};

function nowIso(clock: EncounterClock): string {
  const value = clock();
  if (!isoUtcTimestampSchema.safeParse(value).success) {
    throw validationError("clock");
  }
  return value;
}

function trustedRuntimeMode(dependencies: EncounterServiceDependencies): AppRuntimeMode {
  if (dependencies.runtimeMode !== undefined) return dependencies.runtimeMode;
  const gate = assertRuntimeWriteAllowed(dependencies.env);
  if (!gate.ok) {
    throw new PersistenceError(
      persistenceErrorCodes.RUNTIME_READ_ONLY,
      PUBLIC_DEMO_READ_ONLY_MESSAGE,
      { ruleId: PUBLIC_DEMO_READ_ONLY },
    );
  }
  return gate.runtimeMode;
}

function assertWriteAllowed(dependencies: EncounterServiceDependencies): AppRuntimeMode {
  const runtimeMode = trustedRuntimeMode(dependencies);
  if (runtimeMode === "public-demo") {
    throw new PersistenceError(
      persistenceErrorCodes.RUNTIME_READ_ONLY,
      PUBLIC_DEMO_READ_ONLY_MESSAGE,
      { ruleId: PUBLIC_DEMO_READ_ONLY },
    );
  }
  return runtimeMode;
}

function parseCreateRequest(value: unknown): CreateEncounterRequest {
  return validateRuntimeRecord(createEncounterRequestSchema, value);
}

function parseTransitionRequest(value: unknown): TransitionEncounterRequest {
  return validateRuntimeRecord(transitionEncounterRequestSchema, value);
}

type EncounterAuditEvent = {
  eventType: "ENCOUNTER_CREATED" | "ENCOUNTER_STATUS_CHANGED";
  entityId: string;
  beforeVersion?: string;
  afterVersion?: string;
  metadata: JsonObject;
  createdAt: string;
};

function auditEvent(
  dependencies: EncounterServiceDependencies,
  event: EncounterAuditEvent,
): AuditEventRecord {
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const metadata = event.eventType === "ENCOUNTER_CREATED"
    ? validateRuntimeRecord(encounterCreatedAuditMetadataSchema, event.metadata)
    : validateRuntimeRecord(encounterStatusChangedAuditMetadataSchema, event.metadata);
  return {
    schemaVersion: "1.0.0",
    id: idFactory("AUDIT"),
    eventType: event.eventType,
    actorId: dependencies.actorId ?? "encounter-service",
    simulatedRole: dependencies.simulatedRole ?? "SYSTEM",
    entityType: "ENCOUNTER",
    entityId: event.entityId,
    ...(event.beforeVersion === undefined ? {} : { beforeVersion: event.beforeVersion }),
    ...(event.afterVersion === undefined ? {} : { afterVersion: event.afterVersion }),
    metadata,
    createdAt: event.createdAt,
  };
}

function syntheticCaseOrThrow(
  input: CreateEncounterRequest,
  resolver: EncounterCaseResolver,
): EncounterCaseReference {
  const reference = resolver(input.caseId, input.caseVersion);
  if (!reference || reference.synthetic !== true) {
    throw new PersistenceError(
      persistenceErrorCodes.NOT_FOUND,
      "The requested synthetic case reference was not found.",
      { fieldPath: "caseId", ruleId: ENCOUNTER_SERVICE_RULE_IDS.SYNTHETIC_CASE_REQUIRED },
    );
  }
  return reference;
}

function mapTransitionError(error: unknown): never {
  if (error instanceof PersistenceError) throw error;
  if (error instanceof ZodError) {
    throw validationError("encounter");
  }
  if (error instanceof Error && error.name === "EncounterDomainError") {
    throw new PersistenceError(
      persistenceErrorCodes.CONFLICT,
      "Encounter status transition was rejected by the domain state machine.",
      { ruleId: ENCOUNTER_SERVICE_RULE_IDS.STATUS_CONFLICT },
    );
  }
  throw error;
}

function verifyRecordRevision(
  encounter: EncounterRecord,
  revisionId: string,
  dependencies: EncounterServiceDependencies,
): void {
  const revision = createEncounterRecordRevisionRepository(dependencies.database).getById(revisionId);
  if (!revision) {
    throw new PersistenceError(
      persistenceErrorCodes.NOT_FOUND,
      "The requested Encounter record revision was not found.",
      { fieldPath: "currentRecordRevisionId", ruleId: ENCOUNTER_SERVICE_RULE_IDS.RECORD_REVISION_NOT_FOUND },
    );
  }
  if (revision.encounterId !== encounter.id) {
    throw new PersistenceError(
      persistenceErrorCodes.CONFLICT,
      "The requested record revision belongs to another Encounter.",
      { fieldPath: "currentRecordRevisionId", ruleId: ENCOUNTER_SERVICE_RULE_IDS.RECORD_REVISION_MISMATCH },
    );
  }
}

function verifyLatestRecordRevision(
  encounter: EncounterRecord,
  revisionId: string,
  dependencies: EncounterServiceDependencies,
): void {
  const latest = createEncounterRecordRevisionRepository(dependencies.database).getLatestByEncounter(encounter.id);
  if (!latest) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Encounter has no persisted record revision.",
      { fieldPath: "currentRecordRevisionId", ruleId: ENCOUNTER_SERVICE_RULE_IDS.DATA_CORRUPTION },
    );
  }
  if (latest.id !== revisionId) {
    throw new PersistenceError(
      persistenceErrorCodes.CONFLICT,
      "Encounter record revision is not the latest revision.",
      { fieldPath: "currentRecordRevisionId", ruleId: ENCOUNTER_SERVICE_RULE_IDS.RECORD_REVISION_MISMATCH },
    );
  }
}

function verifyExistingCurrentRevision(
  encounter: EncounterRecord,
  dependencies: EncounterServiceDependencies,
): void {
  if (encounter.currentRecordRevisionId === undefined) return;
  try {
    verifyRecordRevision(encounter, encounter.currentRecordRevisionId, dependencies);
  } catch (error) {
    if (error instanceof PersistenceError && error.code === persistenceErrorCodes.NOT_FOUND) {
      throw new PersistenceError(
        persistenceErrorCodes.DATA_CORRUPTION,
        "Encounter current record revision is missing from persistence.",
        { fieldPath: "currentRecordRevisionId", ruleId: ENCOUNTER_SERVICE_RULE_IDS.DATA_CORRUPTION },
      );
    }
    throw error;
  }
}

export function createEncounter(
  value: unknown,
  dependencies: EncounterServiceDependencies,
): EncounterRecord {
  const runtimeMode = assertWriteAllowed(dependencies);
  const input = parseCreateRequest(value);
  const caseReference = syntheticCaseOrThrow(input, dependencies.caseResolver ?? defaultCaseResolver);
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;

  let record: EncounterRecord;
  try {
    record = validateRuntimeRecord(encounterRecordSchema, createEncounterRecord({
      id: input.id ?? idFactory("ENCOUNTER"),
      caseId: caseReference.id,
      caseVersion: caseReference.version,
      demographicSnapshot: input.demographicSnapshot,
      createdAt: nowIso(clock),
      runtimeMode,
    }));
  } catch (error) {
    if (error instanceof ZodError) throw validationError("encounter");
    throw error;
  }

  const audit = createAuditEventRepository(dependencies.database);
  const encounters = createEncounterRepository(dependencies.database);
  const metadata: JsonObject = {
    encounterId: record.id,
    caseId: record.caseId,
    caseVersion: record.caseVersion,
    synthetic: true,
    runtimeMode: record.runtimeMode,
  };
  const auditRecord = auditEvent(dependencies, {
    eventType: "ENCOUNTER_CREATED",
    entityId: record.id,
    afterVersion: record.status,
    metadata,
    createdAt: record.createdAt,
  });
  return withTransaction(dependencies.database, () => {
    encounters.insert(record);
    audit.append(auditRecord);
    return record;
  });
}

export function getEncounterById(
  id: string,
  dependencies: EncounterServiceDependencies,
): EncounterRecord | undefined {
  if (!encounterRecordSchema.shape.id.safeParse(id).success) throw validationError("encounterId");
  try {
    return createEncounterRepository(dependencies.database).getById(id);
  } catch (error) {
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
      throw new PersistenceError(
        persistenceErrorCodes.DATA_CORRUPTION,
        "Stored Encounter data is corrupted.",
        { ruleId: ENCOUNTER_SERVICE_RULE_IDS.DATA_CORRUPTION },
      );
    }
    throw error;
  }
}

export function transitionEncounter(
  value: unknown,
  dependencies: EncounterServiceDependencies,
): EncounterRecord {
  const runtimeMode = assertWriteAllowed(dependencies);
  const input = parseTransitionRequest(value);
  const clock = dependencies.clock ?? defaultClock;
  const encounters = createEncounterRepository(dependencies.database);
  const audit = createAuditEventRepository(dependencies.database);

  return withTransaction(dependencies.database, () => {
    const current = encounters.getById(input.encounterId);
    if (!current) {
      throw new PersistenceError(
        persistenceErrorCodes.NOT_FOUND,
        "The requested Encounter was not found.",
        { fieldPath: "encounterId", ruleId: ENCOUNTER_SERVICE_RULE_IDS.NOT_FOUND },
      );
    }
    if (current.runtimeMode !== runtimeMode) {
      throw new PersistenceError(
        persistenceErrorCodes.CONFLICT,
        "Encounter runtime mode does not match the trusted server runtime mode.",
        { ruleId: ENCOUNTER_SERVICE_RULE_IDS.STATUS_CONFLICT },
      );
    }
    if (current.status !== input.expectedStatus || current.updatedAt !== input.expectedUpdatedAt) {
      throw new PersistenceError(
        persistenceErrorCodes.CONFLICT,
        "Encounter status or version is stale; no transition was applied.",
        { ruleId: ENCOUNTER_SERVICE_RULE_IDS.STATUS_CONFLICT },
      );
    }

    verifyExistingCurrentRevision(current, dependencies);
    if (current.currentRecordRevisionId !== undefined) {
      verifyLatestRecordRevision(current, current.currentRecordRevisionId, dependencies);
    }
    if (input.currentRecordRevisionId !== undefined) {
      verifyRecordRevision(current, input.currentRecordRevisionId, dependencies);
      if (current.status === "DRAFT" && input.targetStatus === "RECORD_SAVED") {
        verifyLatestRecordRevision(current, input.currentRecordRevisionId, dependencies);
      }
    }

    let next: EncounterRecord;
    try {
      next = advanceEncounterStatus(
        current,
        input.targetStatus,
        nowIso(clock),
        input.currentRecordRevisionId === undefined
          ? {}
          : { currentRecordRevisionId: input.currentRecordRevisionId },
      );
    } catch (error) {
      return mapTransitionError(error);
    }

    const metadata: JsonObject = {
      encounterId: next.id,
      caseId: next.caseId,
      caseVersion: next.caseVersion,
      synthetic: true,
      runtimeMode: next.runtimeMode,
      fromStatus: current.status,
      toStatus: next.status,
    };
    const auditRecord = auditEvent(dependencies, {
      eventType: "ENCOUNTER_STATUS_CHANGED",
      entityId: next.id,
      beforeVersion: current.status,
      afterVersion: next.status,
      metadata,
      createdAt: next.updatedAt,
    });
    encounters.updateStatus(next, {
      status: input.expectedStatus,
      updatedAt: input.expectedUpdatedAt,
    });
    audit.append(auditRecord);
    return next;
  });
}

export function parseEncounterStatus(value: unknown): EncounterStatus | undefined {
  const parsed = encounterStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
