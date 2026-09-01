import type { DatabaseSync } from "node:sqlite";

import {
  effectiveGenerationConfigSchema,
  generationRunRecordSchema,
  type GenerationRunRecord,
} from "@/domain/runtime-records";
import { providerMetadataSchema } from "@/domain/provider";
import { generatedDraftSchema, syntheticCaseSchema } from "@/domain/schemas";
import { PersistenceError, persistenceErrorCodes } from "../errors";
import {
  parseStoredJson,
  stableJsonStringify,
  validateRuntimeRecord,
} from "../record-validation";
import {
  databaseWriteError,
  invalidQueryLimit,
  isSqliteConstraintError,
  optionalRowString,
  requiredRowInteger,
  requiredRowString,
  type SqliteRow,
} from "../repository-utils";

export interface GenerationRunRepository {
  insert(record: GenerationRunRecord): void;
  getById(id: string): GenerationRunRecord | undefined;
  listByCase(caseId: string, limit?: number): GenerationRunRecord[];
}

function rowToRecord(row: SqliteRow): GenerationRunRecord {
  const outputSnapshotJson = optionalRowString(row, "output_draft_snapshot_json");
  const record = {
    schemaVersion: requiredRowString(row, "schema_version"),
    id: requiredRowString(row, "id"),
    status: requiredRowString(row, "status"),
    mode: requiredRowString(row, "mode"),
    caseId: requiredRowString(row, "case_id"),
    caseVersion: requiredRowString(row, "case_version"),
    datasetVersion: requiredRowString(row, "dataset_version"),
    safetyCoreId: requiredRowString(row, "safety_core_id"),
    safetyCoreVersion: requiredRowString(row, "safety_core_version"),
    policyId: requiredRowString(row, "policy_id"),
    policyVersion: requiredRowString(row, "policy_version"),
    ...(optionalRowString(row, "profile_id") ? { profileId: optionalRowString(row, "profile_id") } : {}),
    ...(row.profile_version === null || row.profile_version === undefined
      ? {}
      : { profileVersion: requiredRowInteger(row, "profile_version") }),
    configurationKey: requiredRowString(row, "configuration_key"),
    providerId: requiredRowString(row, "provider_id"),
    modelId: requiredRowString(row, "model_id"),
    promptVersion: requiredRowString(row, "prompt_version"),
    ...(optionalRowString(row, "provider_metadata_json")
      ? {
          providerMetadata: parseStoredJson(
            optionalRowString(row, "provider_metadata_json")!,
            providerMetadataSchema,
            "providerMetadata",
          ),
        }
      : {}),
    inputCaseSnapshot: parseStoredJson(
      requiredRowString(row, "input_case_snapshot_json"),
      syntheticCaseSchema,
      "inputCaseSnapshot",
    ),
    effectiveConfigSnapshot: parseStoredJson(
      requiredRowString(row, "effective_config_snapshot_json"),
      effectiveGenerationConfigSchema,
      "effectiveConfigSnapshot",
    ),
    ...(outputSnapshotJson
      ? {
          outputDraftSnapshot: parseStoredJson(
            outputSnapshotJson,
            generatedDraftSchema,
            "outputDraftSnapshot",
          ),
        }
      : {}),
    inputValidationSummary: parseStoredJson(
      requiredRowString(row, "input_validation_summary_json"),
      // Runtime summaries are intentionally open JSON objects, validated by the repository boundary.
      // The schema is imported through the record validator at insert/read time below.
      generationRunRecordSchema.shape.inputValidationSummary,
      "inputValidationSummary",
    ),
    outputValidationSummary: parseStoredJson(
      requiredRowString(row, "output_validation_summary_json"),
      generationRunRecordSchema.shape.outputValidationSummary,
      "outputValidationSummary",
    ),
    ...(optionalRowString(row, "error_type") ? { errorType: optionalRowString(row, "error_type") } : {}),
    ...(optionalRowString(row, "error_message") ? { errorMessage: optionalRowString(row, "error_message") } : {}),
    createdAt: requiredRowString(row, "created_at"),
  };

  return validateRuntimeRecord(generationRunRecordSchema, record);
}

export function createGenerationRunRepository(database: DatabaseSync): GenerationRunRepository {
  const insertStatement = database.prepare(`
    INSERT INTO generation_runs (
      id, schema_version, status, mode, case_id, case_version, dataset_version,
      safety_core_id, safety_core_version, policy_id, policy_version,
      profile_id, profile_version, configuration_key,
      provider_id, model_id, prompt_version,
      input_case_snapshot_json, effective_config_snapshot_json, output_draft_snapshot_json,
      input_validation_summary_json, output_validation_summary_json,
      error_type, error_message, provider_metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectByIdStatement = database.prepare("SELECT * FROM generation_runs WHERE id = ?");
  const selectByCaseStatement = database.prepare(`
    SELECT * FROM generation_runs
    WHERE case_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);

  return {
    insert(record) {
      const validated = validateRuntimeRecord(generationRunRecordSchema, record);
      try {
        insertStatement.run(
          validated.id,
          validated.schemaVersion,
          validated.status,
          validated.mode,
          validated.caseId,
          validated.caseVersion,
          validated.datasetVersion,
          validated.safetyCoreId,
          validated.safetyCoreVersion,
          validated.policyId,
          validated.policyVersion,
          validated.profileId ?? null,
          validated.profileVersion ?? null,
          validated.configurationKey,
          validated.providerId,
          validated.modelId,
          validated.promptVersion,
          stableJsonStringify(validated.inputCaseSnapshot),
          stableJsonStringify(validated.effectiveConfigSnapshot),
          validated.outputDraftSnapshot ? stableJsonStringify(validated.outputDraftSnapshot) : null,
          stableJsonStringify(validated.inputValidationSummary),
          stableJsonStringify(validated.outputValidationSummary),
          validated.errorType ?? null,
          validated.errorMessage ?? null,
          validated.providerMetadata ? stableJsonStringify(validated.providerMetadata) : null,
          validated.createdAt,
        );
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw new PersistenceError(
            persistenceErrorCodes.CONFLICT,
            "Generation run ID already exists.",
          );
        }
        throw databaseWriteError();
      }
    },

    getById(id) {
      const row = selectByIdStatement.get(id) as SqliteRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    listByCase(caseId, limit = 100) {
      if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) throw invalidQueryLimit();
      const rows = selectByCaseStatement.all(caseId, limit) as SqliteRow[];
      return rows.map(rowToRecord);
    },
  };
}
