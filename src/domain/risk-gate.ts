import type { DraftLineOperation, DraftRevisionRecord } from "./draft-revisions";
import {
  feedbackRulesVersionSchema,
  type FeedbackChangeType,
  type FeedbackRiskLevel,
} from "./runtime-records";
import { sectionKeySchema, type MandatoryField, type SectionKey } from "./schemas";

export const FEEDBACK_RULES_VERSION = feedbackRulesVersionSchema.value;

export type RiskLevel = FeedbackRiskLevel;
export type FeedbackDecision = "CANDIDATE" | "HELD" | "REJECTED";

export type FeedbackInput = {
  id: string;
  changeType: FeedbackChangeType;
  affectedFields: string[];
  beforeText: string;
  afterText: string;
};

export type RiskGateResult = {
  riskLevel: RiskLevel;
  decision: FeedbackDecision;
  ruleHits: string[];
  rationale: string;
};

export type FeedbackProposal = {
  proposalId: string;
  eventType: "FEEDBACK_CLASSIFIED";
  generationRunId: string;
  draftRevisionId?: string;
  revisionNumber?: number;
  profileId: string;
  profileVersion: number;
  rulesVersion: typeof FEEDBACK_RULES_VERSION;
  changeType: FeedbackChangeType;
  status: "CANDIDATE" | "HELD_FOR_REVIEW" | "REJECTED";
  riskLevel: RiskLevel;
  decision: "PENDING" | "REJECTED";
  affectedField: SectionKey | "sectionOrder" | "unknown";
  ruleHits: string[];
  safetyReason: string;
  nextAllowedActions: Array<"CONFIRM_CANDIDATE" | "DISMISS_CANDIDATE" | "REVIEW_APPROVE" | "REVIEW_REJECT">;
  evidence: {
    operationCount: number;
    addedLineCount: number;
    removedLineCount: number;
    addedCharacterCount: number;
    removedCharacterCount: number;
    orderChanged: boolean;
  };
  candidatePatch?: { type: "sectionOrder"; sectionOrder: SectionKey[] };
};

export type FeedbackExtractionContext = {
  generationRunId: string;
  profileId: string;
  profileVersion: number;
  prohibitedActions?: readonly string[];
};

export type FeedbackExtractionResult =
  | { ok: true; proposals: FeedbackProposal[] }
  | { ok: false; ruleId: "FEEDBACK_HIGH_RISK_BLOCKED"; proposals: FeedbackProposal[] };

const hardProtectedFields = new Set<MandatoryField>([
  "allergies",
  "currentMedications",
  "redFlags",
  "missingInformation",
  "draftDisclaimer",
]);

const lowRiskFields = new Set(["sectionOrder", "verbosity", "expandAbbreviations", "educationTone", "displayPreferences"]);
const mediumRiskFields = new Set(["specialtyPriority", "testDisplayPriority", "sharedTerminology", "specialtyTemplate"]);

const legacyHighRiskPatterns = [
  { id: "HIGH-001", pattern: /(删除|省略|忽略).{0,8}(过敏|危险信号|禁忌|用药)/i },
  { id: "HIGH-002", pattern: /(默认|自动).{0,8}(诊断|处方|开药|药物|剂量)/i },
  { id: "HIGH-003", pattern: /(无需|不用).{0,8}(人工复核|医生确认|核查)/i },
  { id: "HIGH-004", pattern: /(remove|omit|ignore).{0,20}(allerg|red flag|contraindication|medication)/i },
  { id: "HIGH-005", pattern: /(default|automatic).{0,20}(diagnosis|prescription|drug|dose)/i },
];

const prohibitedActionPatterns: Record<string, RegExp> = {
  "automatic-diagnosis": /(?:自动|默认|直接|无需人工).{0,12}(?:诊断|diagnos)/iu,
  "automatic-prescription": /(?:自动|默认|直接|无需人工).{0,12}(?:处方|开药|用药|剂量|prescri|dose)/iu,
  "automatic-record-writeback": /(?:自动|直接|无需确认).{0,12}(?:写回|写入|病历|记录|系统|write.?back)/iu,
  "learning-from-unreviewed-edits": /(?:(?:未经|未).{0,8}(?:审核|门控|确认).{0,8}(?:学习|画像|偏好)|(?:自动|直接).{0,8}(?:学习|更新画像))/iu,
  "inventing-missing-facts": /(?:编造|虚构|捏造|补全|猜测).{0,12}(?:缺失|不存在|未提供|事实|数值|药物|剂量|诊断)/iu,
};

function safeRuleId(prefix: string, value: string): string {
  const suffix = value.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return `${prefix}_${suffix || "UNKNOWN"}`.slice(0, 100);
}

function isNegatedProhibitedAction(text: string, matchIndex: number): boolean {
  const prefix = text.slice(Math.max(0, matchIndex - 18), matchIndex);
  return /(?:不|不得|不能|不可|禁止|拒绝|未|没有|无需|仅|不会|不应)\s*(?:提供|进行|执行|使用|自动|自主|直接|默认)?\s*$/u.test(prefix);
}

function containsPositiveProhibitedPattern(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);
  return match !== null && !isNegatedProhibitedAction(text, match.index);
}

function prohibitedActionHits(text: string, prohibitedActions: readonly string[]): string[] {
  return prohibitedActions
    .filter((action) => {
      const pattern = prohibitedActionPatterns[action];
      return pattern ? containsPositiveProhibitedPattern(text, pattern) : false;
    })
    .map((action) => safeRuleId("HIGH_PROHIBITED", action));
}

function makeProposal(
  revision: DraftRevisionRecord,
  input: {
    proposalId: string;
    changeType: FeedbackChangeType;
    affectedField: FeedbackProposal["affectedField"];
    mandatory: boolean;
    afterIsEmpty: boolean;
    afterText: string;
    evidence: FeedbackProposal["evidence"];
    candidatePatch?: FeedbackProposal["candidatePatch"];
  },
  context: FeedbackExtractionContext,
): FeedbackProposal {
  const hardHits: string[] = [];
  if (input.affectedField === "draftDisclaimer") hardHits.push("HIGH_DISCLAIMER_READONLY");
  if (input.changeType === "DELETE" && hardProtectedFields.has(input.affectedField as MandatoryField)) {
    hardHits.push("HIGH_PROTECTED_FIELD_DELETE");
  }
  if (input.mandatory && input.afterIsEmpty) hardHits.push("HIGH_MANDATORY_SECTION_EMPTY");
  hardHits.push(...prohibitedActionHits(input.afterText, context.prohibitedActions ?? [
    "automatic-diagnosis",
    "automatic-prescription",
    "automatic-record-writeback",
    "learning-from-unreviewed-edits",
    "inventing-missing-facts",
  ]));

  const common = {
    eventType: "FEEDBACK_CLASSIFIED" as const,
    generationRunId: context.generationRunId,
    revisionNumber: revision.revisionNumber,
    profileId: context.profileId,
    profileVersion: context.profileVersion,
    rulesVersion: FEEDBACK_RULES_VERSION,
    changeType: input.changeType,
    affectedField: input.affectedField,
    evidence: input.evidence,
  };

  if (hardHits.length > 0) {
    return {
      ...common,
      proposalId: input.proposalId,
      status: "REJECTED",
      riskLevel: "HIGH",
      decision: "REJECTED",
      ruleHits: [...new Set(hardHits)],
      safetyReason: "该修改触及不可绕过的安全边界，拒绝保存危险修订或形成画像候选。",
      nextAllowedActions: [],
    };
  }

  if (input.changeType === "REORDER" && input.affectedField === "sectionOrder" && input.candidatePatch) {
    return {
      ...common,
      proposalId: input.proposalId,
      draftRevisionId: revision.id,
      status: "CANDIDATE",
      riskLevel: "LOW",
      decision: "PENDING",
      ruleHits: ["LOW_WHITELIST_SECTION_ORDER"],
      safetyReason: "仅改变栏目呈现顺序，属于明确白名单偏好；仍需模拟医生明确确认。",
      nextAllowedActions: ["CONFIRM_CANDIDATE", "DISMISS_CANDIDATE"],
      candidatePatch: input.candidatePatch,
    };
  }

  const knownField = input.affectedField !== "unknown";
  const isMedium = knownField && (
    input.changeType === "ADD"
    || input.changeType === "DELETE"
    || input.changeType === "REWRITE"
    || mediumRiskFields.has(input.affectedField)
  );
  if (isMedium) {
    return {
      ...common,
      proposalId: input.proposalId,
      draftRevisionId: revision.id,
      status: "HELD_FOR_REVIEW",
      riskLevel: "MEDIUM",
      decision: "PENDING",
      ruleHits: [mediumRiskFields.has(input.affectedField) ? safeRuleId("MEDIUM_FIELD", input.affectedField) : "MEDIUM_CONTENT_REVIEW"],
      safetyReason: "内容变化不能直接解释为医生偏好，需模拟审核者复核；批准也不会写入个人画像。",
      nextAllowedActions: ["REVIEW_APPROVE", "REVIEW_REJECT"],
    };
  }

  return {
    ...common,
    proposalId: input.proposalId,
    draftRevisionId: revision.id,
    status: "HELD_FOR_REVIEW",
    riskLevel: "UNCERTAIN",
    decision: "PENDING",
    ruleHits: ["UNCERTAIN_DEFAULT_REVIEW"],
    safetyReason: "当前内容无法可靠映射到安全白名单，默认进入审核，不自动解释为偏好。",
    nextAllowedActions: ["REVIEW_APPROVE", "REVIEW_REJECT"],
  };
}

function operationsForSection(section: DraftRevisionRecord["diffSummary"]["changedSections"][number]): DraftLineOperation[] {
  if ("operations" in section) return section.operations;
  return section.lineChanges.map((change) => ({
    operation: change.before !== undefined && change.after !== undefined
      ? "REWRITE" as const
      : change.before !== undefined ? "DELETE" as const : "ADD" as const,
    index: change.index,
    ...(change.before !== undefined ? { before: change.before } : {}),
    ...(change.after !== undefined ? { after: change.after } : {}),
  }));
}

export function extractFeedbackProposals(
  revision: DraftRevisionRecord,
  context: FeedbackExtractionContext,
): FeedbackExtractionResult {
  const beforeByKey = new Map(revision.beforeSnapshot.sections.map((section) => [section.key, section]));
  const afterByKey = new Map(revision.afterSnapshot.sections.map((section) => [section.key, section]));
  const proposals: FeedbackProposal[] = [];

  if (revision.diffSummary.orderChanged) {
    const afterOrder = revision.diffSummary.afterSectionOrder
      .filter((key): key is SectionKey => sectionKeySchema.safeParse(key).success);
    proposals.push(makeProposal(revision, {
      proposalId: `${revision.id}:section-order`,
      changeType: "REORDER",
      affectedField: "sectionOrder",
      mandatory: false,
      afterIsEmpty: false,
      afterText: "",
      evidence: {
        operationCount: 0,
        addedLineCount: 0,
        removedLineCount: 0,
        addedCharacterCount: 0,
        removedCharacterCount: 0,
        orderChanged: true,
      },
      candidatePatch: { type: "sectionOrder", sectionOrder: afterOrder },
    }, context));
  }

  for (const sectionDiff of revision.diffSummary.changedSections) {
    const beforeSection = beforeByKey.get(sectionDiff.key);
    const afterSection = afterByKey.get(sectionDiff.key);
    if (!beforeSection || !afterSection) continue;
    const operations = operationsForSection(sectionDiff);
    for (const [operationIndex, operation] of operations.entries()) {
      proposals.push(makeProposal(revision, {
        proposalId: `${revision.id}:${sectionDiff.key}:${operation.index}:${operationIndex}`,
        changeType: operation.operation,
        affectedField: sectionDiff.key,
        mandatory: beforeSection.mandatory,
        afterIsEmpty: afterSection.content.every((line) => line.trim().length === 0),
        afterText: operation.after ?? "",
        evidence: {
          operationCount: 1,
          addedLineCount: operation.after === undefined ? 0 : 1,
          removedLineCount: operation.before === undefined ? 0 : 1,
          addedCharacterCount: operation.after?.length ?? 0,
          removedCharacterCount: operation.before?.length ?? 0,
          orderChanged: false,
        },
      }, context));
    }
  }

  const highRisk = proposals.filter((proposal) => proposal.riskLevel === "HIGH");
  return highRisk.length > 0
    ? { ok: false, ruleId: "FEEDBACK_HIGH_RISK_BLOCKED", proposals: highRisk }
    : { ok: true, proposals };
}

/** Compatibility adapter for the original static demo contract. */
export function classifyFeedback(input: FeedbackInput): RiskGateResult {
  const combinedText = `${input.beforeText}\n${input.afterText}`;
  const patternHits = legacyHighRiskPatterns.filter(({ pattern }) => pattern.test(combinedText)).map(({ id }) => id);
  const protectedDeletion = input.changeType === "DELETE"
    && input.affectedFields.some((field) => hardProtectedFields.has(field as MandatoryField));

  if (protectedDeletion || patternHits.length > 0) {
    return {
      riskLevel: "HIGH",
      decision: "REJECTED",
      ruleHits: protectedDeletion ? ["HIGH-PROTECTED-FIELD", ...patternHits] : patternHits,
      rationale: "该修改可能削弱强制安全字段、临床决策边界或人工确认要求，禁止写入医生偏好。",
    };
  }

  const mediumHits = input.affectedFields.filter((field) => mediumRiskFields.has(field));
  if (mediumHits.length > 0) {
    return {
      riskLevel: "MEDIUM",
      decision: "HELD",
      ruleHits: mediumHits.map((field) => `MEDIUM-${field}`),
      rationale: "该修改可能改变专科重点或共享模板，需要授权审核后才能生效。",
    };
  }

  const lowRiskOnly = input.affectedFields.length > 0 && input.affectedFields.every((field) => lowRiskFields.has(field));
  if (lowRiskOnly && ["FORMAT", "REORDER", "REWRITE"].includes(input.changeType)) {
    return {
      riskLevel: "LOW",
      decision: "CANDIDATE",
      ruleHits: ["LOW-WHITELISTED-PREFERENCE"],
      rationale: "该修改仅涉及呈现或工作流程，可生成偏好候选，但仍需明确确认。",
    };
  }

  return {
    riskLevel: "UNCERTAIN",
    decision: "HELD",
      ruleHits: ["UNCERTAIN_DEFAULT_REVIEW"],
    rationale: "当前规则无法可靠判断影响范围，按中风险进入人工审核。",
  };
}
