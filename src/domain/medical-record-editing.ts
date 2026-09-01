import { z } from "zod";

import {
  auxiliaryExamsSchema,
  encounterRecordHistorySchema,
  medicalListFieldSchema,
  medicalRecordLimits,
  pendingInformationItemSchema,
  physicalExamSchema,
} from "./medical-record";
import type { EncounterRecordPayload } from "./manual-synthetic-record";

/**
 * PWR-04 accepts only the fields a physician can edit on the record page.
 * Identity, provenance, workflow and confirmation fields remain server-owned.
 */
export const medicalRecordEditablePayloadSchema = z.object({
  history: encounterRecordHistorySchema,
  physicalExam: physicalExamSchema,
  auxiliaryExams: auxiliaryExamsSchema,
  missingInformation: medicalListFieldSchema,
  pendingInformation: z.array(pendingInformationItemSchema).max(medicalRecordLimits.maxPendingInformationItems),
  patientEducationFacts: medicalListFieldSchema,
}).strict();

export type MedicalRecordEditablePayload = z.infer<typeof medicalRecordEditablePayloadSchema>;

export function editableMedicalRecordPayloadOf(record: EncounterRecordPayload): MedicalRecordEditablePayload {
  return {
    history: record.history,
    physicalExam: record.physicalExam,
    auxiliaryExams: record.auxiliaryExams,
    missingInformation: record.missingInformation,
    pendingInformation: record.pendingInformation,
    patientEducationFacts: record.patientEducationFacts,
  };
}
