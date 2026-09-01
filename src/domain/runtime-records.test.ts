import { describe, expect, it } from "vitest";

import { physicianProfiles, syntheticCases } from "@/data/seed-loader";
import { compileEffectiveConfig } from "./effective-config";
import {
  auditEventRecordSchema,
  effectiveGenerationConfigSchema,
  generationRunRecordSchema,
  isoUtcTimestampSchema,
  jsonValueSchema,
  physicianProfileVersionRecordSchema,
} from "./runtime-records";
import {
  fixtureAuditEvent,
  fixtureGenerationRun,
  fixtureProfileVersion,
} from "@/infrastructure/sqlite/test-fixtures";

describe("runtime record schemas", () => {
  it.each(syntheticCases)("accepts the compiled $id configuration snapshot", (caseData) => {
    const result = compileEffectiveConfig({
      caseData,
      safetyCore: {
        id: "institutional-safety-core",
        schemaVersion: "1.0.0",
        version: "0.1.0",
        immutableForPhysician: true,
        mandatoryFields: ["allergies", "currentMedications", "redFlags", "missingInformation", "draftDisclaimer"],
        prohibitedActions: ["automatic-diagnosis"],
        draftDisclaimer: "仅用于模拟研究，必须由人工复核。",
        allowedEvidenceSources: ["VERSIONED_SYNTHETIC_CASE_FACTS"],
        approvalRequirements: ["HUMAN_REVIEW_REQUIRED"],
      },
      policies: [{
        id: `policy-${caseData.id}`,
        schemaVersion: "1.0.0",
        version: "0.1.0",
        synthetic: true,
        specialty: caseData.specialty,
        visitType: caseData.visitType,
        approvalStatus: "APPROVED",
        approvalScope: "DEMO_ONLY",
        requiredSections: ["summary", "draftDisclaimer"],
        informationPriority: ["summary", "draftDisclaimer"],
        terminologyRules: {},
        approvedBy: "test-reviewer",
        sourceNote: "仅用于测试的合成策略。",
      }],
      datasetVersion: "0.1.0",
      mode: "GENERIC",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(effectiveGenerationConfigSchema.parse(result.config)).toEqual(result.config);
  });

  it("rejects a generic configuration that contains a profile reference", () => {
    const config = compileEffectiveConfig({
      caseData: syntheticCases[0],
      safetyCore: {
        id: "institutional-safety-core",
        schemaVersion: "1.0.0",
        version: "0.1.0",
        immutableForPhysician: true,
        mandatoryFields: ["draftDisclaimer"],
        prohibitedActions: ["automatic-diagnosis"],
        draftDisclaimer: "仅用于模拟研究，必须由人工复核。",
        allowedEvidenceSources: ["VERSIONED_SYNTHETIC_CASE_FACTS"],
        approvalRequirements: ["HUMAN_REVIEW_REQUIRED"],
      },
      policies: [],
      datasetVersion: "0.1.0",
      mode: "GENERIC",
      profile: physicianProfiles[0],
    });

    expect(config.ok).toBe(false);
  });

  it("supports recursive JSON values but not undefined values", () => {
    expect(jsonValueSchema.parse({ nested: ["text", 1, true, null, { key: "value" }] })).toEqual({
      nested: ["text", 1, true, null, { key: "value" }],
    });
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
  });

  it("accepts UTC Z timestamps and rejects local offsets or invalid dates", () => {
    expect(isoUtcTimestampSchema.safeParse("2026-08-19T00:00:00.000Z").success).toBe(true);
    expect(isoUtcTimestampSchema.safeParse("2026-08-19T08:00:00+08:00").success).toBe(false);
    expect(isoUtcTimestampSchema.safeParse("2026-02-30T00:00:00.000Z").success).toBe(false);
  });

  it("enforces successful and failed generation record branches", () => {
    const success = fixtureGenerationRun();
    expect(generationRunRecordSchema.parse(success)).toEqual(success);

    expect(() => generationRunRecordSchema.parse({
      ...success,
      status: "SUCCEEDED",
      outputDraftSnapshot: undefined,
      errorType: "OUTPUT_VALIDATION",
      errorMessage: "failed",
    })).toThrow();
    expect(() => generationRunRecordSchema.parse({
      ...success,
      status: "FAILED",
      outputDraftSnapshot: undefined,
      errorType: undefined,
      errorMessage: undefined,
    })).toThrow();
    expect(() => generationRunRecordSchema.parse({
      ...success,
      outputDraftSnapshot: { ...success.outputDraftSnapshot, runId: "different-run" },
    })).toThrow();
  });

  it("requires profile version continuity metadata at the record boundary", () => {
    expect(physicianProfileVersionRecordSchema.parse(fixtureProfileVersion(1))).toEqual(fixtureProfileVersion(1));
    expect(physicianProfileVersionRecordSchema.parse(fixtureProfileVersion(2, 1))).toEqual(fixtureProfileVersion(2, 1));
    expect(() => physicianProfileVersionRecordSchema.parse(fixtureProfileVersion(1, 0))).toThrow();
    expect(() => physicianProfileVersionRecordSchema.parse(fixtureProfileVersion(2))).toThrow();
  });

  it("requires audit metadata to be a JSON object", () => {
    expect(auditEventRecordSchema.parse(fixtureAuditEvent())).toEqual(fixtureAuditEvent());
    expect(() => auditEventRecordSchema.parse({ ...fixtureAuditEvent(), metadata: [] })).toThrow();
  });
});
