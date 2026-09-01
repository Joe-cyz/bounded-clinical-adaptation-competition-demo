import {
  findApprovedPolicies,
  institutionalSafetyCore,
  specialtyVisitPolicies,
} from "@/data/seed-loader";
import { scanSuspectedPii, suspectedPiiRuleIds, type SuspectedPiiType } from "@/infrastructure/privacy/suspected-pii";
import {
  type MandatoryField,
  syntheticCaseSchema,
  type SpecialtyVisitPolicy,
  type SyntheticCase,
} from "./schemas";

export const INPUT_RULE_IDS = {
  SCHEMA_INVALID: "INPUT_SCHEMA_INVALID",
  SYNTHETIC_REQUIRED: "INPUT_SYNTHETIC_REQUIRED",
  REQUIRED_FIELD_MISSING: "INPUT_REQUIRED_FIELD_MISSING",
  APPROVED_POLICY_REQUIRED: "INPUT_APPROVED_POLICY_REQUIRED",
  APPROVED_POLICY_AMBIGUOUS: "INPUT_APPROVED_POLICY_AMBIGUOUS",
  FIELD_UNKNOWN: "INPUT_FIELD_UNKNOWN",
  SUSPECTED_PII_NAME: suspectedPiiRuleIds.NAME,
  SUSPECTED_PII_PHONE: suspectedPiiRuleIds.PHONE,
  SUSPECTED_PII_ID_NUMBER: suspectedPiiRuleIds.ID_NUMBER,
  SUSPECTED_PII_EMAIL: suspectedPiiRuleIds.EMAIL,
  SUSPECTED_PII_ADDRESS: suspectedPiiRuleIds.ADDRESS,
} as const;

export type InputRuleId = (typeof INPUT_RULE_IDS)[keyof typeof INPUT_RULE_IDS];
export type InputValidationStatus = "PASS" | "BLOCKED";
export type InputIssueSeverity = "ERROR" | "WARNING";
export type InputIssueCategory = "SCHEMA" | "SYNTHETIC" | "COMPLETENESS" | "PRIVACY" | "POLICY";
export type InputFieldState = "PROVIDED" | "UNKNOWN" | "MISSING";

export type InputValidationIssue = {
  ruleId: InputRuleId;
  category: InputIssueCategory;
  severity: InputIssueSeverity;
  fieldPath?: string;
  message: string;
};

export type InputValidationResult = {
  status: InputValidationStatus;
  canGenerate: boolean;
  caseId?: string;
  fieldStates: Record<string, InputFieldState>;
  issues: InputValidationIssue[];
};

export type InputValidationOptions = {
  policies?: readonly SpecialtyVisitPolicy[];
};

type RequiredInputField = Exclude<MandatoryField, "draftDisclaimer">;

const requiredInputFields: RequiredInputField[] = institutionalSafetyCore.mandatoryFields.filter(
  (field): field is RequiredInputField => field !== "draftDisclaimer",
);

const unknownWhenEmpty = new Set<RequiredInputField>([
  "allergies",
  "currentMedications",
  "redFlags",
]);

const piiMessages: Record<SuspectedPiiType, string> = {
  NAME: "检测到疑似姓名格式，请仅使用项目版本化合成数据。",
  PHONE: "检测到疑似电话格式，请仅使用项目版本化合成数据。",
  ID_NUMBER: "检测到疑似身份证号格式，请仅使用项目版本化合成数据。",
  EMAIL: "检测到疑似邮箱格式，请仅使用项目版本化合成数据。",
  ADDRESS: "检测到疑似地址格式，请仅使用项目版本化合成数据。",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function getFieldState(rawCase: Record<string, unknown> | undefined, field: RequiredInputField): InputFieldState {
  if (!rawCase || !Object.prototype.hasOwnProperty.call(rawCase, field)) return "MISSING";

  const value = rawCase[field];
  if (!isStringArray(value)) return "MISSING";
  if (unknownWhenEmpty.has(field) && value.length === 0) return "UNKNOWN";
  return "PROVIDED";
}

function formatSchemaPath(path: PropertyKey[]): string | undefined {
  return path.length > 0 ? path.map(String).join(".") : undefined;
}

function normalizePiiFieldPath(fieldPath: string): string {
  if (fieldPath.startsWith("$.")) return fieldPath.slice(2);
  return fieldPath.startsWith("$") ? fieldPath.slice(1) : fieldPath;
}

function addIssue(
  target: InputValidationIssue[],
  issue: InputValidationIssue,
): void {
  target.push(issue);
}

function uniqueIssues(issues: InputValidationIssue[]): InputValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = [issue.ruleId, issue.category, issue.severity, issue.fieldPath ?? "", issue.message].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateCaseInput(
  rawCase: unknown,
  options: InputValidationOptions = {},
): InputValidationResult {
  const rawObject = isRecord(rawCase) ? rawCase : undefined;
  const schemaResult = syntheticCaseSchema.safeParse(rawCase);
  const errors: InputValidationIssue[] = [];
  const warnings: InputValidationIssue[] = [];
  const fieldStates = Object.fromEntries(
    requiredInputFields.map((field) => [field, getFieldState(rawObject, field)]),
  ) as Record<string, InputFieldState>;

  if (!schemaResult.success) {
    const nonSyntheticIssues = schemaResult.error.issues.filter((issue) => issue.path[0] !== "synthetic");
    if (nonSyntheticIssues.length > 0) {
      addIssue(errors, {
        ruleId: INPUT_RULE_IDS.SCHEMA_INVALID,
        category: "SCHEMA",
        severity: "ERROR",
        fieldPath: formatSchemaPath(nonSyntheticIssues[0].path),
        message: "病例输入不符合严格 Schema，已阻断生成。",
      });
    }
  }

  if (!rawObject || rawObject.synthetic !== true) {
    addIssue(errors, {
      ruleId: INPUT_RULE_IDS.SYNTHETIC_REQUIRED,
      category: "SYNTHETIC",
      severity: "ERROR",
      fieldPath: "synthetic",
      message: "病例必须明确声明 synthetic: true，才允许进入演示生成。",
    });
  }

  if (rawObject) {
    for (const field of requiredInputFields) {
      const state = fieldStates[field];
      if (state === "MISSING" && !Object.prototype.hasOwnProperty.call(rawObject, field)) {
        addIssue(errors, {
          ruleId: INPUT_RULE_IDS.REQUIRED_FIELD_MISSING,
          category: "COMPLETENESS",
          severity: "ERROR",
          fieldPath: field,
          message: `生成前必需字段 ${field} 缺失。`,
        });
      }

      if (state === "UNKNOWN") {
        addIssue(warnings, {
          ruleId: INPUT_RULE_IDS.FIELD_UNKNOWN,
          category: "COMPLETENESS",
          severity: "WARNING",
          fieldPath: field,
          message: `字段 ${field} 为空，状态为未知；不代表确认无异常。`,
        });
      }
    }
  }

  const piiMatches = scanSuspectedPii(rawCase);
  for (const match of piiMatches) {
    addIssue(errors, {
      ruleId: match.ruleId,
      category: "PRIVACY",
      severity: "ERROR",
      fieldPath: normalizePiiFieldPath(match.fieldPath),
      message: piiMessages[match.type],
    });
  }

  if (schemaResult.success) {
    const policies = options.policies ?? specialtyVisitPolicies;
    const matchingPolicies = findApprovedPolicies(
      policies,
      schemaResult.data.specialty,
      schemaResult.data.visitType,
    ).filter((policy) => policy.approvalScope === "DEMO_ONLY");

    if (matchingPolicies.length === 0) {
      addIssue(errors, {
        ruleId: INPUT_RULE_IDS.APPROVED_POLICY_REQUIRED,
        category: "POLICY",
        severity: "ERROR",
        fieldPath: "specialty",
        message: "未找到恰好一个 APPROVED + DEMO_ONLY 专科策略。",
      });
    } else if (matchingPolicies.length > 1) {
      addIssue(errors, {
        ruleId: INPUT_RULE_IDS.APPROVED_POLICY_AMBIGUOUS,
        category: "POLICY",
        severity: "ERROR",
        fieldPath: "specialty",
        message: "匹配到多个 APPROVED + DEMO_ONLY 专科策略，已阻断生成。",
      });
    }
  }

  const issues = uniqueIssues([...errors, ...warnings]);
  const canGenerate = issues.every((issue) => issue.severity !== "ERROR");
  const validCase = schemaResult.success ? (schemaResult.data as SyntheticCase) : undefined;
  const safeCaseId = validCase && !piiMatches.some((match) => normalizePiiFieldPath(match.fieldPath) === "id")
    ? validCase.id
    : undefined;

  return {
    status: canGenerate ? "PASS" : "BLOCKED",
    canGenerate,
    ...(safeCaseId ? { caseId: safeCaseId } : {}),
    fieldStates,
    issues,
  };
}
