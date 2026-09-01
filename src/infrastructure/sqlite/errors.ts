export const persistenceErrorCodes = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  SUSPECTED_PII: "SUSPECTED_PII",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PROFILE_VERSION_CONFLICT: "PROFILE_VERSION_CONFLICT",
  DATA_CORRUPTION: "DATA_CORRUPTION",
  RUNTIME_READ_ONLY: "RUNTIME_READ_ONLY",
  MIGRATION_FAILED: "MIGRATION_FAILED",
  MIGRATION_DRIFT: "MIGRATION_DRIFT",
  TRANSACTION_FAILED: "TRANSACTION_FAILED",
  LITERATURE_INVALID_REQUEST: "LITERATURE_INVALID_REQUEST",
  LITERATURE_REQUEST_TOO_LARGE: "LITERATURE_REQUEST_TOO_LARGE",
  LITERATURE_ORIGIN_REJECTED: "LITERATURE_ORIGIN_REJECTED",
  LITERATURE_CONTENT_TYPE_INVALID: "LITERATURE_CONTENT_TYPE_INVALID",
  LITERATURE_LENGTH_MISMATCH: "LITERATURE_LENGTH_MISMATCH",
  LITERATURE_FILE_TOO_LARGE: "LITERATURE_FILE_TOO_LARGE",
  LITERATURE_BATCH_TOO_LARGE: "LITERATURE_BATCH_TOO_LARGE",
  LITERATURE_UNSUPPORTED_FORMAT: "LITERATURE_UNSUPPORTED_FORMAT",
  LITERATURE_INVALID_FILENAME: "LITERATURE_INVALID_FILENAME",
  LITERATURE_INVALID_PDF: "LITERATURE_INVALID_PDF",
  LITERATURE_INVALID_TEXT: "LITERATURE_INVALID_TEXT",
  LITERATURE_STREAM_ABORTED: "LITERATURE_STREAM_ABORTED",
  LITERATURE_DUPLICATE_CONTENT: "LITERATURE_DUPLICATE_CONTENT",
  LITERATURE_REPLAYED: "LITERATURE_REPLAYED",
  LITERATURE_BATCH_CONFLICT: "LITERATURE_BATCH_CONFLICT",
  LITERATURE_VERSION_CONFLICT: "LITERATURE_VERSION_CONFLICT",
  LITERATURE_CLEANUP_FAILED: "LITERATURE_CLEANUP_FAILED",
  LITERATURE_STORAGE_FAILED: "LITERATURE_STORAGE_FAILED",
  LITERATURE_CONSISTENCY_FAILED: "LITERATURE_CONSISTENCY_FAILED",
  LITERATURE_EVIDENCE_AUTHORIZATION_REQUIRED: "LITERATURE_EVIDENCE_AUTHORIZATION_REQUIRED",
  LITERATURE_PARSE_INVALID_REQUEST: "LITERATURE_PARSE_INVALID_REQUEST",
  LITERATURE_PARSE_REQUEST_CONFLICT: "LITERATURE_PARSE_REQUEST_CONFLICT",
  LITERATURE_PARSE_IN_PROGRESS: "LITERATURE_PARSE_IN_PROGRESS",
  LITERATURE_PARSE_ENCRYPTED_PDF: "LITERATURE_PARSE_ENCRYPTED_PDF",
  LITERATURE_PARSE_NO_TEXT_LAYER: "LITERATURE_PARSE_NO_TEXT_LAYER",
  LITERATURE_PARSE_PAGES_EXCEEDED: "LITERATURE_PARSE_PAGES_EXCEEDED",
  LITERATURE_PARSE_PAGE_TEXT_EXCEEDED: "LITERATURE_PARSE_PAGE_TEXT_EXCEEDED",
  LITERATURE_PARSE_DOCUMENT_TEXT_EXCEEDED: "LITERATURE_PARSE_DOCUMENT_TEXT_EXCEEDED",
  LITERATURE_PARSE_FRAGMENTS_EXCEEDED: "LITERATURE_PARSE_FRAGMENTS_EXCEEDED",
  LITERATURE_PARSE_TIMEOUT: "LITERATURE_PARSE_TIMEOUT",
  LITERATURE_PARSE_CRASHED: "LITERATURE_PARSE_CRASHED",
  LITERATURE_PARSE_SHA_MISMATCH: "LITERATURE_PARSE_SHA_MISMATCH",
  LITERATURE_PARSE_UNSAFE_OBJECT_PATH: "LITERATURE_PARSE_UNSAFE_OBJECT_PATH",
  LITERATURE_PARSE_STORAGE_MISSING: "LITERATURE_PARSE_STORAGE_MISSING",
  LITERATURE_PARSE_INVALID_PDF: "LITERATURE_PARSE_INVALID_PDF",
  LITERATURE_PARSE_INVALID_TEXT: "LITERATURE_PARSE_INVALID_TEXT",
  LITERATURE_PARSE_UNSUPPORTED_FORMAT: "LITERATURE_PARSE_UNSUPPORTED_FORMAT",
  LITERATURE_PARSE_PUBLISH_FAILED: "LITERATURE_PARSE_PUBLISH_FAILED",
  LITERATURE_PARSE_CLEANUP_FAILED: "LITERATURE_PARSE_CLEANUP_FAILED",
} as const;

export type PersistenceErrorCode = (typeof persistenceErrorCodes)[keyof typeof persistenceErrorCodes];

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly fieldPath?: string;
  readonly ruleId?: string;

  constructor(
    code: PersistenceErrorCode,
    message: string,
    options: { fieldPath?: string; ruleId?: string } = {},
  ) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.fieldPath = options.fieldPath;
    this.ruleId = options.ruleId;
  }
}

export function isPersistenceError(error: unknown): error is PersistenceError {
  return error instanceof PersistenceError;
}

export function validationError(fieldPath?: string): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.VALIDATION_FAILED,
    "Runtime record failed validation.",
    fieldPath ? { fieldPath } : undefined,
  );
}

export function suspectedPiiError(fieldPath: string, ruleId: string): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.SUSPECTED_PII,
    "Runtime record was rejected by a suspected PII rule.",
    { fieldPath, ruleId },
  );
}

export function dataCorruptionError(fieldPath: string): PersistenceError {
  return new PersistenceError(
    persistenceErrorCodes.DATA_CORRUPTION,
    "Stored runtime record failed validation.",
    { fieldPath },
  );
}

export function sqliteConflictError(message: string): PersistenceError {
  return new PersistenceError(persistenceErrorCodes.CONFLICT, message);
}

const safeRuntimeFieldNames = new Set([
  "id",
  "schemaVersion",
  "status",
  "mode",
  "caseId",
  "caseVersion",
  "datasetVersion",
  "safetyCoreId",
  "safetyCoreVersion",
  "policyId",
  "policyVersion",
  "profileId",
  "profileVersion",
  "configurationKey",
  "inputCaseSnapshot",
  "effectiveConfigSnapshot",
  "outputDraftSnapshot",
  "inputValidationSummary",
  "outputValidationSummary",
  "errorType",
  "errorMessage",
  "createdAt",
  "caseRef",
  "safetyCoreRef",
  "policyRef",
  "profileRef",
  "requiredSections",
  "sectionOrder",
  "presentation",
  "terminologyRules",
  "safety",
  "provenance",
  "versionSummary",
  "specialty",
  "visitType",
  "approvalScope",
  "dataset",
  "case",
  "safetyCore",
  "policy",
  "profile",
  "requiredSections",
  "sectionOrder",
  "presentation",
  "terminologyRules",
  "mandatoryFields",
  "prohibitedActions",
  "draftDisclaimer",
  "allowedEvidenceSources",
  "approvalRequirements",
  "runId",
  "sections",
  "key",
  "title",
  "content",
  "mandatory",
  "preferences",
  "previousVersion",
  "sourceType",
  "source",
  "sourceDatasetVersion",
  "intakeId",
  "intakeSchemaVersion",
  "creationRequestId",
  "idempotencyResult",
  "requestFingerprint",
  "eventType",
  "actorId",
  "simulatedRole",
  "entityType",
  "entityId",
  "beforeVersion",
  "afterVersion",
  "metadata",
  "providerId",
  "modelId",
  "promptVersion",
  "synthetic",
  "displayName",
  "title",
  "patientSummary",
  "chiefConcern",
  "allergies",
  "currentMedications",
  "redFlags",
  "providedProblems",
  "recentChanges",
  "missingInformation",
  "patientEducationFacts",
  "sourceNote",
  "encounterId",
  "encounterStatus",
  "expectedStatus",
  "expectedUpdatedAt",
  "targetStatus",
  "currentRecordRevisionId",
  "recordPayload",
  "recordRevisionId",
  "revisionNumber",
  "demographicSnapshot",
  "displayLabel",
  "sex",
  "ageBand",
  "runtimeMode",
  "recordDataVersion",
  "contentReviewStatus",
  "physicianConfirmationStatus",
  "visitDate",
  "recordDate",
  "age",
  "intake",
  "initialRecord",
  "fromStatus",
  "toStatus",
]);

function safeRuntimeFieldSegment(segment: PropertyKey): string | undefined {
  if (typeof segment !== "string") return undefined;
  if (segment.length === 0 || segment.length > 64) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(segment)) return undefined;
  return safeRuntimeFieldNames.has(segment) ? segment : undefined;
}

export function safeSchemaFieldPath(path: readonly PropertyKey[]): string | undefined {
  if (path.length === 0) return undefined;

  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number" && Number.isInteger(segment) && segment >= 0 && segment <= 999_999) {
      return `${result}[${segment}]`;
    }

    const safeSegment = safeRuntimeFieldSegment(segment) ?? "[unknown-field]";
    return result.length === 0 ? safeSegment : `${result}.${safeSegment}`;
  }, "");
}
