import "server-only";

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  createManualSyntheticInitialRecord,
  type ManualSyntheticRecordV1,
} from "@/domain/manual-synthetic-record";
import {
  createManualSyntheticSource,
  isServerIssuedManualSyntheticCreationRequestId,
  manualSyntheticEncounterCreatedAuditMetadataSchema,
  manualSyntheticIdempotencyResultSchema,
  manualSyntheticIntakeCreateRequestSchema,
  manualSyntheticIntakeSchema,
  type ManualSyntheticIntakeCreateRequest,
  type ManualSyntheticIntakeV1,
  type ManualSyntheticIdempotencyResult,
} from "@/domain/manual-synthetic-intake";
import { encounterRecordSchema, encounterSourceOf, type EncounterRecord } from "@/domain/encounter";
import { appRuntimeModeSchema, type AppRuntimeMode } from "@/domain/runtime-mode";
import { isoUtcTimestampSchema, type AuditEventRecord } from "@/domain/runtime-records";
import { medicalCalendarDateSchema } from "@/domain/medical-record";
import { assertRuntimeWriteAllowed, PUBLIC_DEMO_READ_ONLY, PUBLIC_DEMO_READ_ONLY_MESSAGE } from "@/server/runtime-config";
import {
  PersistenceError,
  dataCorruptionError,
  persistenceErrorCodes,
  validationError,
} from "@/infrastructure/sqlite/errors";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { createManualSyntheticIntakeRepository } from "@/infrastructure/sqlite/repositories/manual-synthetic-intake-repository";
import { stableJsonStringify, validateRuntimeRecord } from "@/infrastructure/sqlite/record-validation";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { createRandomSystemId } from "./system-id";

export const MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS = {
  INPUT_INVALID: "MANUAL_SYNTHETIC_INPUT_INVALID",
  CREATION_REQUEST_ID_INVALID: "MANUAL_SYNTHETIC_CREATION_REQUEST_ID_INVALID",
  ENCOUNTER_NOT_FOUND: "MANUAL_SYNTHETIC_ENCOUNTER_NOT_FOUND",
  INTAKE_NOT_FOUND: "MANUAL_SYNTHETIC_INTAKE_NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "MANUAL_SYNTHETIC_IDEMPOTENCY_CONFLICT",
  SOURCE_CORRUPTION: "MANUAL_SYNTHETIC_SOURCE_CORRUPTION",
  RUNTIME_READ_ONLY: PUBLIC_DEMO_READ_ONLY,
} as const;

export type ManualSyntheticEncounterIdKind = "ENCOUNTER" | "INTAKE" | "DISPLAY" | "AUDIT";
export type ManualSyntheticEncounterIdFactory = (kind: ManualSyntheticEncounterIdKind) => string;
export type ManualSyntheticEncounterClock = () => string;
export type ManualSyntheticCreationRequestIdVerifier = (value: string) => boolean;
export type ManualSyntheticEncounterDatabaseFactory = () => DatabaseSync;

export type ManualSyntheticEncounterServiceDependencies = {
  databaseFactory: ManualSyntheticEncounterDatabaseFactory;
  clock?: ManualSyntheticEncounterClock;
  idFactory?: ManualSyntheticEncounterIdFactory;
  runtimeMode?: AppRuntimeMode;
  env?: NodeJS.ProcessEnv;
  creationRequestIdVerifier?: ManualSyntheticCreationRequestIdVerifier;
  actorId?: string;
  simulatedRole?: AuditEventRecord["simulatedRole"];
};

export type ManualSyntheticEncounterCreationResult = {
  encounter: EncounterRecord;
  intake: ManualSyntheticIntakeV1;
  initialRecord: ManualSyntheticRecordV1;
  idempotencyResult: ManualSyntheticIdempotencyResult;
};

const defaultClock: ManualSyntheticEncounterClock = () => new Date().toISOString();
const defaultIdFactory: ManualSyntheticEncounterIdFactory = (kind) => createRandomSystemId(
  kind === "ENCOUNTER"
    ? "manual-encounter"
    : kind === "INTAKE"
      ? "manual-intake"
      : kind === "DISPLAY"
        ? "manual-display"
        : "manual-audit",
);

function trustedRuntimeMode(dependencies: ManualSyntheticEncounterServiceDependencies): AppRuntimeMode {
  if (dependencies.runtimeMode !== undefined) {
    const parsed = appRuntimeModeSchema.safeParse(dependencies.runtimeMode);
    if (!parsed.success) throw validationError("runtimeMode");
    return parsed.data;
  }
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

function assertWriteAllowed(dependencies: ManualSyntheticEncounterServiceDependencies): AppRuntimeMode {
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

function nowIso(clock: ManualSyntheticEncounterClock): string {
  const value = clock();
  if (!isoUtcTimestampSchema.safeParse(value).success) throw validationError("clock");
  return value;
}

function shanghaiCalendarDate(isoTimestamp: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(isoTimestamp));
  const fields = new Map(parts.map((part) => [part.type, part.value]));
  const date = `${fields.get("year")}-${fields.get("month")}-${fields.get("day")}`;
  const parsed = medicalCalendarDateSchema.safeParse(date);
  if (!parsed.success) throw validationError("clock");
  return parsed.data;
}

function ageBandOf(age: number): "CHILD" | "ADULT" | "OLDER_ADULT" {
  if (age < 18) return "CHILD";
  if (age < 65) return "ADULT";
  return "OLDER_ADULT";
}

function requestFingerprint(input: ManualSyntheticIntakeCreateRequest): string {
  return createHash("sha256").update(stableJsonStringify(input), "utf8").digest("hex");
}

function manualCaseReference(intake: ManualSyntheticIntakeV1): { caseId: string; caseVersion: string } {
  return {
    caseId: `manual-synthetic-case-${intake.intakeId}`,
    caseVersion: "manual-intake-1.0.0",
  };
}

function buildIntake(
  input: ManualSyntheticIntakeCreateRequest,
  createdAt: string,
  date: string,
  idFactory: ManualSyntheticEncounterIdFactory,
): ManualSyntheticIntakeV1 {
  return validateRuntimeRecord(manualSyntheticIntakeSchema, {
    schemaVersion: "1.0.0",
    intakeId: idFactory("INTAKE"),
    creationRequestId: input.creationRequestId,
    synthetic: true,
    displayLabel: `合成手工患者-${idFactory("DISPLAY")}`,
    specialty: input.specialty,
    visitType: input.visitType,
    sex: input.sex,
    age: input.age,
    visitDate: date,
    recordDate: date,
    createdAt,
  });
}

function buildEncounter(
  input: ManualSyntheticIntakeV1,
  createdAt: string,
  runtimeMode: AppRuntimeMode,
  idFactory: ManualSyntheticEncounterIdFactory,
): EncounterRecord {
  const reference = manualCaseReference(input);
  return validateRuntimeRecord(encounterRecordSchema, {
    schemaVersion: "1.0.0",
    id: idFactory("ENCOUNTER"),
    synthetic: true,
    caseId: reference.caseId,
    caseVersion: reference.caseVersion,
    status: "DRAFT",
    demographicSnapshot: {
      displayLabel: input.displayLabel,
      sex: input.sex,
      ageBand: ageBandOf(input.age),
    },
    createdAt,
    updatedAt: createdAt,
    runtimeMode,
    source: createManualSyntheticSource(input.intakeId),
  });
}

function buildCreatedAudit(
  dependencies: ManualSyntheticEncounterServiceDependencies,
  encounter: EncounterRecord,
  intake: ManualSyntheticIntakeV1,
): AuditEventRecord {
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const metadata = validateRuntimeRecord(manualSyntheticEncounterCreatedAuditMetadataSchema, {
    encounterId: encounter.id,
    intakeId: intake.intakeId,
    sourceType: "MANUAL_SYNTHETIC",
    intakeSchemaVersion: "1.0.0",
    encounterStatus: encounter.status,
    synthetic: true,
    runtimeMode: encounter.runtimeMode,
    createdAt: encounter.createdAt,
    idempotencyResult: "CREATED",
  });
  return {
    schemaVersion: "1.0.0",
    id: idFactory("AUDIT"),
    eventType: "ENCOUNTER_CREATED",
    actorId: dependencies.actorId ?? "manual-synthetic-encounter-service",
    simulatedRole: dependencies.simulatedRole ?? "SYSTEM",
    entityType: "ENCOUNTER",
    entityId: encounter.id,
    afterVersion: encounter.status,
    metadata,
    createdAt: encounter.createdAt,
  };
}

function assertRequestToken(input: ManualSyntheticIntakeCreateRequest, dependencies: ManualSyntheticEncounterServiceDependencies): void {
  const verifier = dependencies.creationRequestIdVerifier ?? isServerIssuedManualSyntheticCreationRequestId;
  if (!verifier(input.creationRequestId)) {
    throw new PersistenceError(
      persistenceErrorCodes.VALIDATION_FAILED,
      "Manual synthetic creation request token is invalid.",
      {
        fieldPath: "creationRequestId",
        ruleId: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.CREATION_REQUEST_ID_INVALID,
      },
    );
  }
}

function replayResult(
  stored: { intake: ManualSyntheticIntakeV1 },
  encounters: ReturnType<typeof createEncounterRepository>,
): ManualSyntheticEncounterCreationResult {
  const encounter = encounters.getByManualIntakeId(stored.intake.intakeId);
  if (!encounter) {
    throw dataCorruptionError("manualSyntheticEncounter");
  }
  const source = encounterSourceOf(encounter);
  if (source.type !== "MANUAL_SYNTHETIC" || source.intakeId !== stored.intake.intakeId) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Manual synthetic Encounter source binding is corrupted.",
      { ruleId: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.SOURCE_CORRUPTION },
    );
  }
  return {
    encounter,
    intake: stored.intake,
    initialRecord: createManualSyntheticInitialRecord({
      intake: stored.intake,
      caseId: encounter.caseId,
      caseVersion: encounter.caseVersion,
    }),
    idempotencyResult: "REPLAYED",
  };
}

export function issueManualSyntheticCreationRequestId(): string {
  return createRandomSystemId("manual-request");
}

export function createManualSyntheticEncounter(
  value: unknown,
  dependencies: ManualSyntheticEncounterServiceDependencies,
): ManualSyntheticEncounterCreationResult {
  // This must remain the first operation so public-demo cannot initialize a database write path.
  const runtimeMode = assertWriteAllowed(dependencies);
  const input = validateRuntimeRecord(manualSyntheticIntakeCreateRequestSchema, value);
  assertRequestToken(input, dependencies);
  const fingerprint = requestFingerprint(input);
  const clock = dependencies.clock ?? defaultClock;
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const database = dependencies.databaseFactory();
  const intakes = createManualSyntheticIntakeRepository(database);
  const encounters = createEncounterRepository(database);
  const audit = createAuditEventRepository(database);

  return withTransaction(database, () => {
    const existing = intakes.getByCreationRequestId(input.creationRequestId);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PersistenceError(
          persistenceErrorCodes.CONFLICT,
          "Manual synthetic creation request conflicts with an existing request.",
          {
            fieldPath: "creationRequestId",
            ruleId: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.IDEMPOTENCY_CONFLICT,
          },
        );
      }
      return replayResult(existing, encounters);
    }

    const createdAt = nowIso(clock);
    const date = shanghaiCalendarDate(createdAt);
    const intake = buildIntake(input, createdAt, date, idFactory);
    const encounter = buildEncounter(intake, createdAt, runtimeMode, idFactory);
    const initialRecord = createManualSyntheticInitialRecord({
      intake,
      caseId: encounter.caseId,
      caseVersion: encounter.caseVersion,
    });
    const auditRecord = buildCreatedAudit(dependencies, encounter, intake);

    intakes.insert(intake, fingerprint);
    encounters.insert(encounter);
    audit.append(auditRecord);

    return {
      encounter,
      intake,
      initialRecord,
      idempotencyResult: manualSyntheticIdempotencyResultSchema.parse("CREATED"),
    };
  });
}

export function getManualSyntheticEncounterInitialRecord(
  encounterId: string,
  dependencies: ManualSyntheticEncounterServiceDependencies,
): ManualSyntheticEncounterCreationResult {
  if (!encounterRecordSchema.shape.id.safeParse(encounterId).success) throw validationError("encounterId");
  const database = dependencies.databaseFactory();
  const encounters = createEncounterRepository(database);
  const intakes = createManualSyntheticIntakeRepository(database);
  const encounter = encounters.getById(encounterId);
  if (!encounter) {
    throw new PersistenceError(
      persistenceErrorCodes.NOT_FOUND,
      "The requested manual synthetic Encounter was not found.",
      { fieldPath: "encounterId", ruleId: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.ENCOUNTER_NOT_FOUND },
    );
  }
  const source = encounterSourceOf(encounter);
  if (source.type !== "MANUAL_SYNTHETIC") {
    throw new PersistenceError(
      persistenceErrorCodes.NOT_FOUND,
      "The requested Encounter is not a manual synthetic Encounter.",
      { fieldPath: "encounterId", ruleId: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.ENCOUNTER_NOT_FOUND },
    );
  }
  const stored = intakes.getByIntakeId(source.intakeId);
  if (!stored) {
    throw new PersistenceError(
      persistenceErrorCodes.DATA_CORRUPTION,
      "Manual synthetic intake is missing for the Encounter.",
      { ruleId: MANUAL_SYNTHETIC_ENCOUNTER_RULE_IDS.INTAKE_NOT_FOUND },
    );
  }
  const initialRecord = createManualSyntheticInitialRecord({
    intake: stored.intake,
    caseId: encounter.caseId,
    caseVersion: encounter.caseVersion,
  });
  return {
    encounter,
    intake: stored.intake,
    initialRecord,
    idempotencyResult: "REPLAYED",
  };
}
