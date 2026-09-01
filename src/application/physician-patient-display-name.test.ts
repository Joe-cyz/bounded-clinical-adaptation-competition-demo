import { afterEach, describe, expect, it } from "vitest";

import {
  projectManualPatientDisplayName,
  projectPublicPatientDisplayName,
  projectSeededPatientDisplayName,
} from "@/domain/physician-patient-display-name";
import { createManualSyntheticEncounter } from "./manual-synthetic-encounter-service";
import { getPhysicianPatientDisplayName } from "./physician-patient-display-name";
import { openRuntimeDatabase } from "@/infrastructure/sqlite/connection";
import { createManualSyntheticIntakeRepository } from "@/infrastructure/sqlite/repositories/manual-synthetic-intake-repository";
import type { DatabaseSync } from "node:sqlite";

function idFactory(suffix: string) {
  return (kind: "ENCOUNTER" | "INTAKE" | "DISPLAY" | "AUDIT"): string =>
    `pwr15-${kind.toLowerCase()}-${suffix}`;
}

function createInput(requestId: string) {
  return {
    creationRequestId: requestId,
    specialty: "普通内科" as const,
    visitType: "初诊" as const,
    sex: "FEMALE" as const,
    age: 42,
  };
}

describe("physician patient display name projection", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("projects seeded and public names without changing the stored label", () => {
    expect(projectSeededPatientDisplayName("合成患者-01")).toBe("患者1");
    expect(projectSeededPatientDisplayName("合成患者-24")).toBe("患者24");
    expect(projectPublicPatientDisplayName()).toBe("患者1");
    expect(() => projectSeededPatientDisplayName("合成患者-0")).toThrow();
    expect(() => projectManualPatientDisplayName(0)).toThrow();
  });

  it("assigns manual intakes by created_at then intake_id using a read-only query", () => {
    database = openRuntimeDatabase({ path: ":memory:", clock: () => "2026-08-31T00:00:00.000Z" });
    const first = createManualSyntheticEncounter(createInput("manual-request-pwr15-first"), {
      databaseFactory: () => database!,
      runtimeMode: "local-research",
      clock: () => "2026-08-31T00:00:00.000Z",
      idFactory: idFactory("first"),
    });
    const second = createManualSyntheticEncounter(createInput("manual-request-pwr15-second"), {
      databaseFactory: () => database!,
      runtimeMode: "local-research",
      clock: () => "2026-08-31T00:00:00.000Z",
      idFactory: idFactory("second"),
    });

    const repository = createManualSyntheticIntakeRepository(database);
    expect(repository.getDisplayOrdinalByIntakeId(first.intake.intakeId)).toBe(1);
    expect(repository.getDisplayOrdinalByIntakeId(second.intake.intakeId)).toBe(2);
    expect(repository.getDisplayOrdinalByIntakeId("missing-intake")).toBeUndefined();
    expect(getPhysicianPatientDisplayName(first.encounter.id, database)).toBe("患者1");
    expect(getPhysicianPatientDisplayName(second.encounter.id, database)).toBe("患者2");
    expect(getPhysicianPatientDisplayName(first.encounter.id, database)).toBe("患者1");
    expect(first.intake.displayLabel).toMatch(/^合成手工患者-/u);
    expect(second.intake.displayLabel).toMatch(/^合成手工患者-/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM manual_synthetic_intakes").get()).toEqual({ count: 2 });
  });
});
