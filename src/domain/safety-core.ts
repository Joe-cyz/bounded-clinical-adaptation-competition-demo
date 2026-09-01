import { institutionalSafetyCore as loadedInstitutionalSafetyCore } from "@/data/seed-loader";
import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import type { EffectiveGenerationConfig } from "./effective-config";
import { projectCanonicalDraftSections } from "./draft-projection";
import {
  generatedDraftSchema,
  sectionKeySchema,
  type GeneratedDraft,
  type InstitutionalSafetyCore,
  type SectionKey,
  type SyntheticCase,
} from "./schemas";

export const institutionalSafetyCore = loadedInstitutionalSafetyCore;

export type ValidationIssue = {
  code: "MISSING_MANDATORY_SECTION" | "EMPTY_MANDATORY_SECTION" | "MISSING_DISCLAIMER";
  field: SectionKey;
  message: string;
};

export const OUTPUT_RULE_IDS = {
  FORMAT_INVALID: "OUTPUT_FORMAT_INVALID",
  SCHEMA_INVALID: "OUTPUT_SCHEMA_INVALID",
  SECTION_DUPLICATE: "OUTPUT_SECTION_DUPLICATE",
  SECTION_SET_INVALID: "OUTPUT_SECTION_SET_INVALID",
  SECTION_ORDER_INVALID: "OUTPUT_SECTION_ORDER_INVALID",
  SECTION_METADATA_INVALID: "OUTPUT_SECTION_METADATA_INVALID",
  FACT_BOUNDARY_VIOLATION: "OUTPUT_FACT_BOUNDARY_VIOLATION",
  PROHIBITED_ACTION: "OUTPUT_PROHIBITED_ACTION",
  SUSPECTED_PII: "OUTPUT_SUSPECTED_PII",
} as const;

export type OutputRuleId = (typeof OUTPUT_RULE_IDS)[keyof typeof OUTPUT_RULE_IDS];

export type OutputValidationIssue = {
  ruleId: OutputRuleId;
  fieldPath?: string;
  prohibitedAction?: string;
};

export type OutputValidationContext = {
  caseData: SyntheticCase;
  config: EffectiveGenerationConfig;
  expectedRunId?: string;
};

export type OutputValidationResult =
  | { ok: true }
  | { ok: false; issues: OutputValidationIssue[] };

type ProhibitedActionRule = {
  aliases: readonly string[];
  patterns: readonly RegExp[];
};

const prohibitedActionRules: Readonly<Record<string, ProhibitedActionRule>> = {
  "automatic-diagnosis": {
    aliases: ["automatic-diagnosis", "automatic diagnosis", "自动诊断", "自主诊断"],
    patterns: [/(?:自动|自主|直接|默认)\s*(?:诊断|确诊|下诊断|给出诊断)/u],
  },
  "automatic-prescription": {
    aliases: ["automatic-prescription", "automatic prescription", "自动处方", "自动开药"],
    patterns: [/(?:自动|自主|直接|默认)\s*(?:开药|处方|给药|用药建议|推荐(?:用药|药物|某药)?)/u],
  },
  "automatic-record-writeback": {
    aliases: ["automatic-record-writeback", "automatic record writeback", "自动写回", "自动回写"],
    patterns: [/(?:自动|自主|直接|默认)\s*(?:写回|回写|更新病历|写入病历|修改病历)/u],
  },
  "learning-from-unreviewed-edits": {
    aliases: ["learning-from-unreviewed-edits", "learning from unreviewed edits", "未经审核学习"],
    patterns: [
      /(?:自动|自主|直接|默认).{0,8}(?:学习|训练|更新画像|写入画像)/u,
      /未经(?:人工)?审核.{0,16}(?:学习|训练|更新画像|写入画像)/u,
    ],
  },
  "inventing-missing-facts": {
    aliases: ["inventing-missing-facts", "inventing missing facts", "编造缺失事实", "虚构缺失信息"],
    patterns: [
      /(?:编造|虚构|捏造|杜撰).{0,12}(?:缺失|不存在|未知|事实|信息|病史|数值|药物|剂量)/u,
      /(?:补写|猜测|假设).{0,8}(?:缺失|未知|事实|信息|病史|数值)/u,
    ],
  },
};

function normaliseAction(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
}

function findProhibitedActionRule(action: string): ProhibitedActionRule | undefined {
  const normalised = normaliseAction(action);
  return Object.values(prohibitedActionRules).find((rule) =>
    rule.aliases.some((alias) => normaliseAction(alias) === normalised),
  );
}

function isNegatedAction(text: string, matchIndex: number): boolean {
  const prefix = text.slice(Math.max(0, matchIndex - 14), matchIndex);
  return /(?:不|不得|不能|不可|禁止|拒绝|未|没有|无需|仅)\s*(?:提供|进行|执行|使用|自动|自主|直接|默认)?\s*$/u.test(prefix);
}

function containsPositivePattern(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);
  return match !== null && !isNegatedAction(text, match.index);
}

function safeSectionPath(index: number, field?: string): string {
  return field ? `sections[${index}].${field}` : `sections[${index}]`;
}

function addUniqueIssue(
  issues: OutputValidationIssue[],
  seen: Set<string>,
  issue: OutputValidationIssue,
): void {
  const key = `${issue.ruleId}:${issue.fieldPath ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  issues.push(issue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyOutputShapeFailure(candidate: unknown): OutputValidationIssue[] {
  if (!isRecord(candidate) || !Array.isArray(candidate.sections)) {
    return [{ ruleId: OUTPUT_RULE_IDS.SCHEMA_INVALID, fieldPath: "output" }];
  }

  const rawKeys = candidate.sections.map((section) => isRecord(section) ? section.key : undefined);
  const seen = new Set<string>();
  const issues: OutputValidationIssue[] = [];
  for (const key of rawKeys) {
    if (typeof key !== "string") continue;
    if (seen.has(key)) {
      if (!issues.some((issue) => issue.ruleId === OUTPUT_RULE_IDS.SECTION_DUPLICATE)) {
        issues.push({ ruleId: OUTPUT_RULE_IDS.SECTION_DUPLICATE, fieldPath: "sections" });
      }
    }
    seen.add(key);
    if (!sectionKeySchema.safeParse(key).success
      && !issues.some((issue) => issue.ruleId === OUTPUT_RULE_IDS.SECTION_SET_INVALID)) {
      issues.push({ ruleId: OUTPUT_RULE_IDS.SECTION_SET_INVALID, fieldPath: "sections" });
    }
  }

  return issues.length > 0
    ? issues
    : [{ ruleId: OUTPUT_RULE_IDS.SCHEMA_INVALID, fieldPath: "output" }];
}

export function validateProhibitedActionsInDraft(
  draft: Pick<GeneratedDraft, "sections">,
  safetyRules: Pick<InstitutionalSafetyCore, "prohibitedActions">,
): OutputValidationIssue[] {
  const outputText = draft.sections.flatMap((section) => [section.title, ...section.content]).join("\n");
  const issues: OutputValidationIssue[] = [];
  for (const action of safetyRules.prohibitedActions) {
    const rule = findProhibitedActionRule(action);
    if (!rule) continue;
    if (rule.patterns.some((pattern) => containsPositivePattern(outputText, pattern))) {
      issues.push({
        ruleId: OUTPUT_RULE_IDS.PROHIBITED_ACTION,
        fieldPath: "sections",
        prohibitedAction: action,
      });
      break;
    }
  }
  return issues;
}

export function validateDraft(
  draft: GeneratedDraft,
  safetyRules: Pick<InstitutionalSafetyCore, "mandatoryFields" | "draftDisclaimer"> = institutionalSafetyCore,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sections = new Map(draft.sections.map((section) => [section.key, section]));

  for (const field of safetyRules.mandatoryFields) {
    const section = sections.get(field);
    if (!section) {
      issues.push({
        code: "MISSING_MANDATORY_SECTION",
        field,
        message: `Mandatory section ${field} is missing.`,
      });
      continue;
    }

    if (section.content.length === 0 || section.content.every((line) => line.trim().length === 0)) {
      issues.push({
        code: "EMPTY_MANDATORY_SECTION",
        field,
        message: `Mandatory section ${field} must explicitly state its status.`,
      });
    }
  }

  const disclaimer = sections.get("draftDisclaimer");
  if (disclaimer && !disclaimer.content.includes(safetyRules.draftDisclaimer)) {
    issues.push({
      code: "MISSING_DISCLAIMER",
      field: "draftDisclaimer",
      message: "The required preclinical draft disclaimer is missing.",
    });
  }

  return issues;
}

/**
 * Validates provider output after parsing. It is deliberately deterministic:
 * the P0 Mock output must equal the case/config projection exactly, and no
 * provider text is returned in the result.
 */
export function validateGeneratedDraft(
  candidate: unknown,
  context: OutputValidationContext,
): OutputValidationResult {
  const parsed = generatedDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: classifyOutputShapeFailure(candidate),
    };
  }

  const draft = parsed.data;
  const expectedSections = projectCanonicalDraftSections(context.caseData, context.config);
  const expectedByKey = new Map(expectedSections.map((section) => [section.key, section]));
  const issues: OutputValidationIssue[] = [];
  const seenIssues = new Set<string>();

  if (
    (context.expectedRunId !== undefined && draft.runId !== context.expectedRunId)
    || draft.mode !== context.config.mode
    || draft.caseId !== context.caseData.id
    || draft.caseVersion !== context.caseData.version
    || draft.safetyCoreVersion !== context.config.safetyCoreRef.version
    || draft.policyId !== context.config.policyRef.id
    || draft.policyVersion !== context.config.policyRef.version
    || draft.configurationKey !== context.config.configurationKey
    || draft.physicianProfileVersion !== context.config.profileRef?.version
  ) {
    addUniqueIssue(issues, seenIssues, {
      ruleId: OUTPUT_RULE_IDS.SECTION_METADATA_INVALID,
      fieldPath: "output",
    });
  }

  const actualKeys = draft.sections.map((section) => section.key);
  const duplicateKeys = actualKeys.filter((key, index) => actualKeys.indexOf(key) !== index);
  if (duplicateKeys.length > 0) {
    addUniqueIssue(issues, seenIssues, {
      ruleId: OUTPUT_RULE_IDS.SECTION_DUPLICATE,
      fieldPath: "sections",
    });
  }

  const expectedKeys = expectedSections.map((section) => section.key);
  const actualSet = new Set(actualKeys);
  if (
    actualSet.size !== expectedKeys.length
    || expectedKeys.some((key) => !actualSet.has(key))
    || actualKeys.some((key) => !expectedByKey.has(key))
  ) {
    addUniqueIssue(issues, seenIssues, {
      ruleId: OUTPUT_RULE_IDS.SECTION_SET_INVALID,
      fieldPath: "sections",
    });
  }

  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    addUniqueIssue(issues, seenIssues, {
      ruleId: OUTPUT_RULE_IDS.SECTION_ORDER_INVALID,
      fieldPath: "sections",
    });
  }

  draft.sections.forEach((section, index) => {
    const expected = expectedByKey.get(section.key);
    if (!expected) return;

    if (section.title !== expected.title || section.mandatory !== expected.mandatory) {
      addUniqueIssue(issues, seenIssues, {
        ruleId: OUTPUT_RULE_IDS.SECTION_METADATA_INVALID,
        fieldPath: safeSectionPath(index),
      });
    }

    if (JSON.stringify(section.content) !== JSON.stringify(expected.content)) {
      addUniqueIssue(issues, seenIssues, {
        ruleId: OUTPUT_RULE_IDS.FACT_BOUNDARY_VIOLATION,
        fieldPath: safeSectionPath(index, "content"),
      });
    }
  });

  for (const issue of validateDraft(draft, context.config.safety)) {
    const mappedRule = issue.code === "MISSING_DISCLAIMER"
      ? OUTPUT_RULE_IDS.SECTION_METADATA_INVALID
      : issue.code === "MISSING_MANDATORY_SECTION"
        ? OUTPUT_RULE_IDS.SECTION_SET_INVALID
        : OUTPUT_RULE_IDS.FACT_BOUNDARY_VIOLATION;
    addUniqueIssue(issues, seenIssues, {
      ruleId: mappedRule,
      fieldPath: `sections.${issue.field}`,
    });
  }

  for (const issue of validateProhibitedActionsInDraft(draft, context.config.safety)) {
    addUniqueIssue(issues, seenIssues, issue);
  }

  for (const match of scanSuspectedPii(draft)) {
    addUniqueIssue(issues, seenIssues, {
      ruleId: OUTPUT_RULE_IDS.SUSPECTED_PII,
      fieldPath: match.fieldPath,
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}
