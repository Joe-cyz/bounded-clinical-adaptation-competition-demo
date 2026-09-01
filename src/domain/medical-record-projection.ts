import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";

import {
  medicalRecordDraftProjectionSchema,
  medicalRecordErrorCodes,
  MedicalRecordValidationError,
  parseEncounterRecordV1,
  type EncounterRecordV1,
  type MedicalRecordDraftProjection,
} from "./medical-record";
import { generatedDraftSchema, type GeneratedDraft } from "./schemas";

function projectionError(code: typeof medicalRecordErrorCodes[keyof typeof medicalRecordErrorCodes], message: string): never {
  throw new MedicalRecordValidationError(code, message);
}

function parseBoundedDraft(input: unknown): GeneratedDraft {
  const result = generatedDraftSchema.safeParse(input);
  if (!result.success) {
    return projectionError(
      medicalRecordErrorCodes.PROJECTION_INVALID,
      "GeneratedDraft did not pass the existing versioned draft schema.",
    );
  }
  if (result.data.mode !== "BOUNDED") {
    return projectionError(
      medicalRecordErrorCodes.PROJECTION_MODE_UNSUPPORTED,
      "Only BOUNDED GeneratedDraft values can be projected into a medical record.",
    );
  }
  if (scanSuspectedPii(result.data).length > 0) {
    return projectionError(
      medicalRecordErrorCodes.PROJECTION_SUSPECTED_PII,
      "A GeneratedDraft containing suspected PII cannot be projected.",
    );
  }
  return result.data;
}

function buildProjection(record: EncounterRecordV1, draft: GeneratedDraft): MedicalRecordDraftProjection {
  if (draft.caseId !== record.caseId || draft.caseVersion !== record.caseVersion) {
    return projectionError(
      medicalRecordErrorCodes.PROJECTION_CASE_MISMATCH,
      "GeneratedDraft and medical record case references must match exactly.",
    );
  }

  const seenKeys = new Set<string>();
  const sections = draft.sections.flatMap((section) => {
    if (seenKeys.has(section.key)) {
      return projectionError(
        medicalRecordErrorCodes.PROJECTION_INVALID,
        "A GeneratedDraft with duplicate sections cannot be projected.",
      );
    }
    seenKeys.add(section.key);

    const content = section.content.filter((line) => line.trim().length > 0);
    if (content.length === 0) return [];
    return [{
      key: section.key,
      title: section.title,
      status: "PENDING_PHYSICIAN_CONFIRMATION" as const,
      content: [...content],
      mandatory: section.mandatory,
    }];
  });

  const result = medicalRecordDraftProjectionSchema.safeParse({
    source: "BOUNDED_GENERATED_DRAFT",
    runId: draft.runId,
    mode: draft.mode,
    caseId: draft.caseId,
    caseVersion: draft.caseVersion,
    sections,
  });
  if (!result.success) {
    return projectionError(
      medicalRecordErrorCodes.PROJECTION_INVALID,
      "The bounded GeneratedDraft could not be represented as a pending medical record projection.",
    );
  }
  return result.data;
}

/**
 * Keeps the old GeneratedDraft contract intact and adds an explicit, pending
 * projection to a validated record. It does not persist, change Encounter
 * state, create an audit event, or infer any clinical fact.
 */
export function projectBoundedGeneratedDraftToMedicalRecord(
  record: EncounterRecordV1,
  draft: unknown,
): EncounterRecordV1 {
  const parsedRecord = parseEncounterRecordV1(record);
  if (parsedRecord.draftProjection !== undefined) {
    return projectionError(
      medicalRecordErrorCodes.PROJECTION_INVALID,
      "A medical record with an existing draft projection cannot be silently replaced.",
    );
  }

  const parsedDraft = parseBoundedDraft(draft);
  const projection = buildProjection(parsedRecord, parsedDraft);
  return parseEncounterRecordV1({
    ...parsedRecord,
    draftProjection: projection,
  });
}

export const projectBoundedDraftToEncounterRecord = projectBoundedGeneratedDraftToMedicalRecord;
