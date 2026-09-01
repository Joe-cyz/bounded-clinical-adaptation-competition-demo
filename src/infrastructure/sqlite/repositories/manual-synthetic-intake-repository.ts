import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import {
  manualSyntheticIntakeSchema,
  type ManualSyntheticIntakeV1,
} from "@/domain/manual-synthetic-intake";
import { PersistenceError, dataCorruptionError, persistenceErrorCodes } from "../errors";
import { validateRuntimeRecord } from "../record-validation";
import {
  databaseWriteError,
  isSqliteConstraintError,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

const requestFingerprintSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/u);

export type StoredManualSyntheticIntake = {
  intake: ManualSyntheticIntakeV1;
  requestFingerprint: string;
};

export interface ManualSyntheticIntakeRepository {
  insert(intake: ManualSyntheticIntakeV1, requestFingerprint: string): void;
  getByIntakeId(intakeId: string): StoredManualSyntheticIntake | undefined;
  getByCreationRequestId(creationRequestId: string): StoredManualSyntheticIntake | undefined;
  getDisplayOrdinalByIntakeId(intakeId: string): number | undefined;
}

function rowToStoredIntake(row: SqliteRow): StoredManualSyntheticIntake {
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    intakeId: requiredRowString(row, "intake_id"),
    creationRequestId: requiredRowString(row, "creation_request_id"),
    synthetic: requiredRowInteger(row, "synthetic") === 1,
    displayLabel: requiredRowString(row, "display_label"),
    specialty: requiredRowString(row, "specialty"),
    visitType: requiredRowString(row, "visit_type"),
    sex: requiredRowString(row, "sex"),
    age: requiredRowInteger(row, "age"),
    visitDate: requiredRowString(row, "visit_date"),
    recordDate: requiredRowString(row, "record_date"),
    createdAt: requiredRowString(row, "created_at"),
  };

  let intake: ManualSyntheticIntakeV1;
  try {
    intake = validateRuntimeRecord(manualSyntheticIntakeSchema, record);
  } catch {
    throw dataCorruptionError("manualSyntheticIntake");
  }

  const requestFingerprint = requiredRowString(row, "request_fingerprint");
  if (!requestFingerprintSchema.safeParse(requestFingerprint).success) {
    throw dataCorruptionError("requestFingerprint");
  }
  return { intake, requestFingerprint };
}

export function createManualSyntheticIntakeRepository(database: DatabaseSync): ManualSyntheticIntakeRepository {
  const insertStatement = database.prepare(`
    INSERT INTO manual_synthetic_intakes (
      intake_id, schema_version, creation_request_id, request_fingerprint,
      synthetic, display_label, specialty, visit_type, sex, age,
      visit_date, record_date, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIntakeIdStatement = database.prepare(
    "SELECT * FROM manual_synthetic_intakes WHERE intake_id = ?",
  );
  const selectByCreationRequestIdStatement = database.prepare(
    "SELECT * FROM manual_synthetic_intakes WHERE creation_request_id = ?",
  );
  const selectDisplayOrdinalStatement = database.prepare(`
    SELECT (
      SELECT COUNT(*)
      FROM manual_synthetic_intakes AS candidate
      WHERE candidate.created_at < target.created_at
        OR (candidate.created_at = target.created_at AND candidate.intake_id <= target.intake_id)
    ) AS display_ordinal
    FROM manual_synthetic_intakes AS target
    WHERE target.intake_id = ?
  `);

  return {
    insert(intake, requestFingerprint) {
      const validated = validateRuntimeRecord(manualSyntheticIntakeSchema, intake);
      if (!requestFingerprintSchema.safeParse(requestFingerprint).success) {
        throw new PersistenceError(
          persistenceErrorCodes.VALIDATION_FAILED,
          "Manual synthetic intake request fingerprint is invalid.",
          { fieldPath: "requestFingerprint" },
        );
      }
      try {
        insertStatement.run(
          validated.intakeId,
          validated.schemaVersion,
          validated.creationRequestId,
          requestFingerprint,
          validated.synthetic ? 1 : 0,
          validated.displayLabel,
          validated.specialty,
          validated.visitType,
          validated.sex,
          validated.age,
          validated.visitDate,
          validated.recordDate,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "Manual synthetic intake already exists or violates its constraints.",
          );
        }
        throw databaseWriteError();
      }
    },

    getByIntakeId(intakeId) {
      const row = selectByIntakeIdStatement.get(intakeId) as SqliteRow | undefined;
      return row ? rowToStoredIntake(row) : undefined;
    },

    getByCreationRequestId(creationRequestId) {
      const row = selectByCreationRequestIdStatement.get(creationRequestId) as SqliteRow | undefined;
      return row ? rowToStoredIntake(row) : undefined;
    },

    getDisplayOrdinalByIntakeId(intakeId) {
      const row = selectDisplayOrdinalStatement.get(intakeId) as SqliteRow | undefined;
      return row ? requiredRowInteger(row, "display_ordinal") : undefined;
    },
  };
}
