export const suspectedPiiRuleIds = {
  NAME: "INPUT_SUSPECTED_PII_NAME",
  PHONE: "INPUT_SUSPECTED_PII_PHONE",
  ID_NUMBER: "INPUT_SUSPECTED_PII_ID_NUMBER",
  EMAIL: "INPUT_SUSPECTED_PII_EMAIL",
  ADDRESS: "INPUT_SUSPECTED_PII_ADDRESS",
} as const;

export type SuspectedPiiRuleId = (typeof suspectedPiiRuleIds)[keyof typeof suspectedPiiRuleIds];
export type SuspectedPiiType = "NAME" | "PHONE" | "ID_NUMBER" | "EMAIL" | "ADDRESS";

export type SuspectedPiiMatch = {
  ruleId: SuspectedPiiRuleId;
  type: SuspectedPiiType;
  fieldPath: string;
};

const detectors: ReadonlyArray<{
  ruleId: SuspectedPiiRuleId;
  type: SuspectedPiiType;
  pattern: RegExp;
}> = [
  {
    ruleId: suspectedPiiRuleIds.NAME,
    type: "NAME",
    pattern: /(?:患者|医生)?姓名\s*[:：]\s*[^\s,，。；;]{1,20}/u,
  },
  {
    ruleId: suspectedPiiRuleIds.PHONE,
    type: "PHONE",
    pattern: /(?:^|[^\d])(?:1[3-9]\d{9}|0\d{2,3}[-－\s]?\d{7,8})(?!\d)/u,
  },
  {
    ruleId: suspectedPiiRuleIds.ID_NUMBER,
    type: "ID_NUMBER",
    pattern: /(?:^|[^\d])\d{17}[\dXx](?!\d)/u,
  },
  {
    ruleId: suspectedPiiRuleIds.EMAIL,
    type: "EMAIL",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  },
  {
    ruleId: suspectedPiiRuleIds.ADDRESS,
    type: "ADDRESS",
    pattern: /(?:地址|住址)\s*[:：]\s*[^\s,，。；;]{4,}/u,
  },
];

const knownSafeFieldNames = new Set([
  "id",
  "schemaVersion",
  "version",
  "synthetic",
  "specialty",
  "visitType",
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
  "mandatoryFields",
  "sourceNote",
  "runId",
  "mode",
  "caseId",
  "caseVersion",
  "safetyCoreVersion",
  "policyId",
  "policyVersion",
  "configurationKey",
  "sections",
  "key",
  "content",
  "mandatory",
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
  "recordDataVersion",
  "sourceDatasetVersion",
  "contentReviewStatus",
  "sourceDescription",
  "physicianConfirmationStatus",
  "demographics",
  "displayLabel",
  "sex",
  "value",
  "items",
  "ageBand",
  "occupation",
  "ethnicity",
  "maritalStatus",
  "syntheticRegion",
  "visitDate",
  "admissionDate",
  "recordDate",
  "history",
  "chiefComplaint",
  "presentIllness",
  "problemFacts",
  "personalHistory",
  "familyHistory",
  "allergyHistory",
  "physicalExam",
  "vitalSigns",
  "generalCondition",
  "specialtyExam",
  "notExaminedOrUnknown",
  "auxiliaryExams",
  "laboratory",
  "electrocardiogram",
  "imaging",
  "other",
  "examinationDate",
  "result",
  "pendingInformation",
  "category",
  "status",
  "description",
  "patientEducationFacts",
  "draftProjection",
  "source",
  "title",
  "sections",
  "runtimeMode",
  "fromStatus",
  "toStatus",
]);

function safeFieldSegment(key: string): string | null {
  return knownSafeFieldNames.has(key) ? key : null;
}

function childPath(parentPath: string, key: string | number): string {
  if (typeof key === "number") return `${parentPath}[${key}]`;

  const safeSegment = safeFieldSegment(key);
  if (!parentPath) return safeSegment ?? "[unknown-field]";
  return safeSegment ? `${parentPath}.${safeSegment}` : `${parentPath}[unknown-field]`;
}

function scanValue(
  value: unknown,
  fieldPath: string,
  seen: WeakSet<object>,
  matches: SuspectedPiiMatch[],
): void {
  if (typeof value === "string") {
    for (const detector of detectors) {
      if (detector.pattern.test(value)) {
        matches.push({ ruleId: detector.ruleId, type: detector.type, fieldPath });
      }
    }
    return;
  }

  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, childPath(fieldPath, index), seen, matches));
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    scanValue(nestedValue, childPath(fieldPath, key), seen, matches);
  }
}

export function scanSuspectedPii(value: unknown): SuspectedPiiMatch[] {
  const matches: SuspectedPiiMatch[] = [];
  scanValue(value, "$", new WeakSet<object>(), matches);

  const unique = new Map<string, SuspectedPiiMatch>();
  for (const match of matches) {
    unique.set(`${match.ruleId}:${match.fieldPath}`, match);
  }

  const detectorOrder = new Map(detectors.map((detector, index) => [detector.ruleId, index]));
  return [...unique.values()].sort((left, right) => {
    const ruleOrder = detectorOrder.get(left.ruleId)! - detectorOrder.get(right.ruleId)!;
    if (ruleOrder !== 0) return ruleOrder;
    return left.fieldPath < right.fieldPath ? -1 : left.fieldPath > right.fieldPath ? 1 : 0;
  });
}
