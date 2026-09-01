import { z } from "zod";

import { scanSuspectedPii } from "@/infrastructure/privacy/suspected-pii";
import { isoUtcTimestampSchema } from "./runtime-records";
import {
  draftOutputLimits,
  generatedDraftSchema,
  sectionKeySchema,
  type DraftSection,
  type GeneratedDraft,
} from "./schemas";
import { validateProhibitedActionsInDraft, type OutputValidationIssue } from "./safety-core";

const schemaVersionSchema = z.literal("1.0.0");
const safeRuntimeIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const draftRevisionSectionInputSchema = z.object({
  key: sectionKeySchema,
  content: z.array(z.string().max(draftOutputLimits.maxLineCharacters)).max(draftOutputLimits.maxSectionLines),
}).strict();

export type DraftRevisionSectionInput = z.infer<typeof draftRevisionSectionInputSchema>;

export const saveDraftRevisionRequestSchema = z.object({
  generationRunId: safeRuntimeIdSchema,
  expectedPreviousRevision: z.number().int().nonnegative().max(100_000).optional(),
  sections: z.array(draftRevisionSectionInputSchema).min(1).max(draftOutputLimits.maxSections),
}).strict();

export type SaveDraftRevisionRequest = z.infer<typeof saveDraftRevisionRequestSchema>;

export const draftLineChangeSchema = z.object({
  index: z.number().int().nonnegative().max(100_000),
  before: z.string().max(draftOutputLimits.maxLineCharacters).optional(),
  after: z.string().max(draftOutputLimits.maxLineCharacters).optional(),
}).strict().superRefine((change, context) => {
  if (change.before === undefined && change.after === undefined) {
    context.addIssue({ code: "custom", path: ["index"], message: "A line change must contain before or after text." });
  }
});

export type DraftLineChange = z.infer<typeof draftLineChangeSchema>;

export const draftLineOperationSchema = z.object({
  operation: z.enum(["ADD", "DELETE", "REWRITE"]),
  index: z.number().int().nonnegative().max(100_000),
  before: z.string().max(draftOutputLimits.maxLineCharacters).optional(),
  after: z.string().max(draftOutputLimits.maxLineCharacters).optional(),
}).strict().superRefine((operation, context) => {
  if (operation.operation === "ADD" && (operation.before !== undefined || operation.after === undefined)) {
    context.addIssue({ code: "custom", path: ["operation"], message: "ADD operations require after text only." });
  }
  if (operation.operation === "DELETE" && (operation.before === undefined || operation.after !== undefined)) {
    context.addIssue({ code: "custom", path: ["operation"], message: "DELETE operations require before text only." });
  }
  if (operation.operation === "REWRITE" && (operation.before === undefined || operation.after === undefined)) {
    context.addIssue({ code: "custom", path: ["operation"], message: "REWRITE operations require before and after text." });
  }
});

export type DraftLineOperation = z.infer<typeof draftLineOperationSchema>;

export const draftSectionDiffSchema = z.object({
  key: sectionKeySchema,
  field: z.literal("content"),
  operations: z.array(draftLineOperationSchema).min(1).max(draftOutputLimits.maxSectionLines * 2),
  addedLineCount: z.number().int().nonnegative().max(100_000),
  removedLineCount: z.number().int().nonnegative().max(100_000),
  addedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
  removedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
}).strict();

export type DraftSectionDiff = z.infer<typeof draftSectionDiffSchema>;

export const draftEditMetricsSchema = z.object({
  changedSectionCount: z.number().int().nonnegative().max(draftOutputLimits.maxSections),
  addedLineCount: z.number().int().nonnegative().max(100_000),
  removedLineCount: z.number().int().nonnegative().max(100_000),
  addedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
  removedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
  editBurdenRatio: z.number().finite().nonnegative().max(1),
}).strict();

export type DraftEditMetrics = z.infer<typeof draftEditMetricsSchema>;

const draftSectionDiffV1Schema = z.object({
  key: sectionKeySchema,
  field: z.literal("content"),
  lineChanges: z.array(draftLineChangeSchema).min(1).max(draftOutputLimits.maxSectionLines),
  addedLineCount: z.number().int().nonnegative().max(100_000),
  removedLineCount: z.number().int().nonnegative().max(100_000),
  addedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
  removedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
}).strict();

const draftEditMetricsV1Schema = z.object({
  changedSectionCount: z.number().int().nonnegative().max(draftOutputLimits.maxSections),
  addedLineCount: z.number().int().nonnegative().max(100_000),
  removedLineCount: z.number().int().nonnegative().max(100_000),
  addedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
  removedCharacterCount: z.number().int().nonnegative().max(draftOutputLimits.maxTotalCharacters),
  editBurdenRatio: z.number().finite().nonnegative().max(100_000),
}).strict();

const draftDiffSummaryV1Schema = z.object({
  schemaVersion: schemaVersionSchema,
  algorithmVersion: z.literal("line-index-v1"),
  newlineNormalization: z.literal("CRLF_AND_CR_TO_LF"),
  formulaVersion: z.literal("edit-burden-v1"),
  orderChanged: z.boolean(),
  beforeSectionOrder: z.array(sectionKeySchema).max(draftOutputLimits.maxSections),
  afterSectionOrder: z.array(sectionKeySchema).max(draftOutputLimits.maxSections),
  changedSections: z.array(draftSectionDiffV1Schema).max(draftOutputLimits.maxSections),
  metrics: draftEditMetricsV1Schema,
}).strict().superRefine((summary, context) => {
  if (summary.metrics.changedSectionCount !== summary.changedSections.length) {
    context.addIssue({
      code: "custom",
      path: ["metrics", "changedSectionCount"],
      message: "Changed section count must match the field-level diff.",
    });
  }
});

export const draftDiffSummarySchema = z.object({
  schemaVersion: schemaVersionSchema,
  algorithmVersion: z.literal("line-lcs-v2"),
  newlineNormalization: z.literal("CRLF_AND_CR_TO_LF"),
  formulaVersion: z.literal("edit-burden-v2"),
  orderChanged: z.boolean(),
  beforeSectionOrder: z.array(sectionKeySchema).max(draftOutputLimits.maxSections),
  afterSectionOrder: z.array(sectionKeySchema).max(draftOutputLimits.maxSections),
  changedSections: z.array(draftSectionDiffSchema).max(draftOutputLimits.maxSections),
  metrics: draftEditMetricsSchema,
}).strict().superRefine((summary, context) => {
  if (summary.metrics.changedSectionCount !== summary.changedSections.length) {
    context.addIssue({
      code: "custom",
      path: ["metrics", "changedSectionCount"],
      message: "Changed section count must match the field-level diff.",
    });
  }
});

export type DraftDiffSummary = z.infer<typeof draftDiffSummarySchema>;
export const draftRevisionDiffSummarySchema = z.union([draftDiffSummarySchema, draftDiffSummaryV1Schema]);
export type StoredDraftDiffSummary = z.infer<typeof draftRevisionDiffSummarySchema>;

const snapshotIdentityKeys = [
  "runId",
  "mode",
  "caseId",
  "caseVersion",
  "safetyCoreVersion",
  "policyId",
  "policyVersion",
  "configurationKey",
  "physicianProfileVersion",
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const draftRevisionRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(200),
  generationRunId: z.string().min(1).max(200),
  revisionNumber: z.number().int().positive().max(100_000),
  beforeSnapshot: generatedDraftSchema,
  afterSnapshot: generatedDraftSchema,
  diffSummary: draftRevisionDiffSummarySchema,
  editorId: z.string().min(1).max(200),
  createdAt: isoUtcTimestampSchema,
}).strict().superRefine((record, context) => {
  if (record.beforeSnapshot.runId !== record.generationRunId) {
    context.addIssue({ code: "custom", path: ["beforeSnapshot", "runId"], message: "Revision before snapshot must belong to the generation run." });
  }
  if (record.afterSnapshot.runId !== record.generationRunId) {
    context.addIssue({ code: "custom", path: ["afterSnapshot", "runId"], message: "Revision after snapshot must belong to the generation run." });
  }

  for (const key of snapshotIdentityKeys) {
    if (record.beforeSnapshot[key] !== record.afterSnapshot[key]) {
      context.addIssue({ code: "custom", path: ["afterSnapshot", key], message: "Revision references cannot change." });
      break;
    }
  }

  if (record.diffSummary.algorithmVersion === "line-lcs-v2"
    && stableJson(record.diffSummary) !== stableJson(computeDraftDiff(record.beforeSnapshot, record.afterSnapshot))) {
    context.addIssue({ code: "custom", path: ["diffSummary"], message: "Revision diff summary must match its snapshots." });
  }
});

export type DraftRevisionRecord = z.infer<typeof draftRevisionRecordSchema>;

export type RevisionValidationIssue = {
  ruleId: string;
  fieldPath?: string;
  prohibitedAction?: string;
};

export function normalizeDraftLines(content: readonly string[]): string[] {
  if (content.length === 0) return [];
  return content.join("\n").replace(/\r\n?/gu, "\n").split("\n");
}

function roundRatio(value: number): number {
  return Math.min(1, Math.max(0, Number(value.toFixed(4))));
}

type LineMatch = { beforeIndex: number; afterIndex: number };

function lcsMatches(beforeLines: readonly string[], afterLines: readonly string[]): LineMatch[] {
  const table = Array.from(
    { length: beforeLines.length + 1 },
    () => Array<number>(afterLines.length + 1).fill(0),
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? table[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }

  const matches: LineMatch[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      matches.push({ beforeIndex, afterIndex });
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    const deleteScore = table[beforeIndex + 1][afterIndex];
    const addScore = table[beforeIndex][afterIndex + 1];
    // Fixed tie rule: consume the before line first. This makes duplicate-line
    // inputs deterministic across runtimes and keeps insertion/deletion local.
    if (deleteScore >= addScore) beforeIndex += 1;
    else afterIndex += 1;
  }

  return matches;
}

function sectionDiff(before: DraftSection, after: DraftSection): DraftSectionDiff | undefined {
  const beforeLines = normalizeDraftLines(before.content);
  const afterLines = normalizeDraftLines(after.content);
  const matches = lcsMatches(beforeLines, afterLines);
  const operations: DraftLineOperation[] = [];
  let addedLineCount = 0;
  let removedLineCount = 0;
  let addedCharacterCount = 0;
  let removedCharacterCount = 0;
  let outputIndex = 0;

  const appendGap = (beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number) => {
    const beforeGap = beforeLines.slice(beforeStart, beforeEnd);
    const afterGap = afterLines.slice(afterStart, afterEnd);
    const pairedCount = Math.min(beforeGap.length, afterGap.length);

    for (let index = 0; index < pairedCount; index += 1) {
      const beforeLine = beforeGap[index];
      const afterLine = afterGap[index];
      operations.push({ operation: "REWRITE", index: outputIndex, before: beforeLine, after: afterLine });
      removedLineCount += 1;
      addedLineCount += 1;
      removedCharacterCount += beforeLine.length;
      addedCharacterCount += afterLine.length;
      outputIndex += 1;
    }
    for (let index = pairedCount; index < beforeGap.length; index += 1) {
      const beforeLine = beforeGap[index];
      operations.push({ operation: "DELETE", index: outputIndex, before: beforeLine });
      removedLineCount += 1;
      removedCharacterCount += beforeLine.length;
    }
    for (let index = pairedCount; index < afterGap.length; index += 1) {
      const afterLine = afterGap[index];
      operations.push({ operation: "ADD", index: outputIndex, after: afterLine });
      addedLineCount += 1;
      addedCharacterCount += afterLine.length;
      outputIndex += 1;
    }
  };

  let beforeCursor = 0;
  let afterCursor = 0;
  for (const match of matches) {
    appendGap(beforeCursor, match.beforeIndex, afterCursor, match.afterIndex);
    outputIndex += 1;
    beforeCursor = match.beforeIndex + 1;
    afterCursor = match.afterIndex + 1;
  }
  appendGap(beforeCursor, beforeLines.length, afterCursor, afterLines.length);

  if (operations.length === 0) return undefined;
  return {
    key: before.key,
    field: "content",
    operations,
    addedLineCount,
    removedLineCount,
    addedCharacterCount,
    removedCharacterCount,
  };
}

export function computeDraftDiff(before: GeneratedDraft, after: GeneratedDraft): DraftDiffSummary {
  const afterByKey = new Map(after.sections.map((section) => [section.key, section]));
  const changedSections = before.sections
    .map((section) => sectionDiff(section, afterByKey.get(section.key) ?? section))
    .filter((section): section is DraftSectionDiff => Boolean(section));
  const beforeSectionOrder = before.sections.map((section) => section.key);
  const afterSectionOrder = after.sections.map((section) => section.key);
  const metricsBase = changedSections.reduce(
    (metrics, section) => ({
      addedLineCount: metrics.addedLineCount + section.addedLineCount,
      removedLineCount: metrics.removedLineCount + section.removedLineCount,
      addedCharacterCount: metrics.addedCharacterCount + section.addedCharacterCount,
      removedCharacterCount: metrics.removedCharacterCount + section.removedCharacterCount,
    }),
    { addedLineCount: 0, removedLineCount: 0, addedCharacterCount: 0, removedCharacterCount: 0 },
  );
  const beforeCharacterCount = before.sections.reduce(
    (sum, section) => sum + normalizeDraftLines(section.content).reduce((sectionSum, line) => sectionSum + line.length, 0),
    0,
  );
  const afterCharacterCount = after.sections.reduce(
    (sum, section) => sum + normalizeDraftLines(section.content).reduce((sectionSum, line) => sectionSum + line.length, 0),
    0,
  );

  return draftDiffSummarySchema.parse({
    schemaVersion: "1.0.0",
    algorithmVersion: "line-lcs-v2",
    newlineNormalization: "CRLF_AND_CR_TO_LF",
    formulaVersion: "edit-burden-v2",
    orderChanged: beforeSectionOrder.some((key, index) => key !== afterSectionOrder[index])
      || beforeSectionOrder.length !== afterSectionOrder.length,
    beforeSectionOrder,
    afterSectionOrder,
    changedSections,
    metrics: {
      changedSectionCount: changedSections.length,
      ...metricsBase,
      editBurdenRatio: roundRatio(
        (metricsBase.addedCharacterCount + metricsBase.removedCharacterCount)
        / Math.max(1, beforeCharacterCount + afterCharacterCount),
      ),
    },
  });
}

export function validateRevisionContent(
  before: GeneratedDraft,
  after: GeneratedDraft,
  safetyRules: Parameters<typeof validateProhibitedActionsInDraft>[1],
): RevisionValidationIssue[] {
  const issues: RevisionValidationIssue[] = [];
  const add = (ruleId: string, fieldPath?: string, prohibitedAction?: string) => {
    if (!issues.some((issue) => issue.ruleId === ruleId && issue.fieldPath === fieldPath)) {
      issues.push({ ruleId, ...(fieldPath ? { fieldPath } : {}), ...(prohibitedAction ? { prohibitedAction } : {}) });
    }
  };

  const parsedAfter = generatedDraftSchema.safeParse(after);
  if (!parsedAfter.success) add("REVISION_SCHEMA_INVALID", "afterSnapshot");

  for (const key of snapshotIdentityKeys) {
    if (before[key] !== after[key]) add("REVISION_SNAPSHOT_IMMUTABLE", `afterSnapshot.${key}`);
  }

  const beforeKeys = before.sections.map((section) => section.key);
  const afterKeys = after.sections.map((section) => section.key);
  const beforeSet = new Set(beforeKeys);
  if (afterKeys.length !== beforeKeys.length || afterKeys.some((key) => !beforeSet.has(key))) {
    const missingMandatory = before.sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.mandatory && !afterKeys.includes(section.key));
    if (missingMandatory.length > 0) {
      missingMandatory.forEach(({ index }) => add("REVISION_MANDATORY_SECTION_REMOVED", `sections[${index}]`));
    } else {
      add("REVISION_SECTION_SET_INVALID", "sections");
    }
  }
  const beforeByKey = new Map(before.sections.map((section) => [section.key, section]));
  after.sections.forEach((afterSection, index) => {
    const beforeSection = beforeByKey.get(afterSection.key);
    if (!afterSection) return;
    if (!beforeSection) return;
    if (beforeSection.title !== afterSection.title || beforeSection.mandatory !== afterSection.mandatory) {
      add("REVISION_SECTION_METADATA_INVALID", `sections[${index}]`);
    }
    if (beforeSection.mandatory && afterSection.content.every((line) => line.trim().length === 0)) {
      add("REVISION_MANDATORY_SECTION_EMPTY", `sections[${index}].content`);
    }
    if (beforeSection.key === "draftDisclaimer" && JSON.stringify(beforeSection.content) !== JSON.stringify(afterSection.content)) {
      add("REVISION_DISCLAIMER_READONLY", `sections[${index}].content`);
    }
  });

  for (const match of scanSuspectedPii(after)) {
    add("REVISION_SUSPECTED_PII", match.fieldPath);
  }

  const prohibitedIssues: OutputValidationIssue[] = validateProhibitedActionsInDraft(after, safetyRules);
  for (const issue of prohibitedIssues) add("REVISION_PROHIBITED_ACTION", issue.fieldPath, issue.prohibitedAction);

  return issues;
}
