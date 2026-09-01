import type { DatabaseSync } from "node:sqlite";

import {
  encounterSourceOf,
  type EncounterRecord,
} from "@/domain/encounter";
import {
  projectManualPatientDisplayName,
  projectPublicPatientDisplayName,
  projectSeededPatientDisplayName,
  PhysicianPatientDisplayNameError,
} from "@/domain/physician-patient-display-name";
import {
  PersistenceError,
  persistenceErrorCodes,
} from "@/infrastructure/sqlite/errors";
import { createEncounterRepository } from "@/infrastructure/sqlite/repositories/encounter-repository";
import { createManualSyntheticIntakeRepository } from "@/infrastructure/sqlite/repositories/manual-synthetic-intake-repository";

export const PHYSICIAN_PATIENT_DISPLAY_NAME_RULE_ID = "PHYSICIAN_PATIENT_DISPLAY_NAME_INVALID" as const;

function displayNameError(): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.DATA_CORRUPTION,
    "当前患者名称无法安全显示。",
    { fieldPath: "patientDisplayName", ruleId: PHYSICIAN_PATIENT_DISPLAY_NAME_RULE_ID },
  );
}

export function projectPhysicianPatientDisplayName(
  encounter: Pick<EncounterRecord, "source" | "caseId" | "caseVersion" | "demographicSnapshot">,
  database?: DatabaseSync,
): string {
  try {
    const source = encounterSourceOf(encounter);
    if (source.type === "SEEDED_SYNTHETIC") {
      return projectSeededPatientDisplayName(encounter.demographicSnapshot.displayLabel);
    }
    if (database === undefined) throw displayNameError();
    const ordinal = createManualSyntheticIntakeRepository(database)
      .getDisplayOrdinalByIntakeId(source.intakeId);
    if (ordinal === undefined) throw displayNameError();
    return projectManualPatientDisplayName(ordinal);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    if (error instanceof PhysicianPatientDisplayNameError) throw displayNameError();
    throw displayNameError();
  }
}

export function getPhysicianPatientDisplayName(
  encounterId: string,
  database?: DatabaseSync,
): string {
  if (encounterId === "demo") return projectPublicPatientDisplayName();
  if (database === undefined) throw displayNameError();
  const encounter = createEncounterRepository(database).getById(encounterId);
  if (!encounter) {
    throw new PersistenceError(
      persistenceErrorCodes.NOT_FOUND,
      "当前接诊不存在。",
      { fieldPath: "encounterId" },
    );
  }
  return projectPhysicianPatientDisplayName(encounter, database);
}
