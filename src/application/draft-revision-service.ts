import type { DatabaseSync } from "node:sqlite";

import {
  computeDraftDiff,
  draftRevisionRecordSchema,
  saveDraftRevisionRequestSchema,
  validateRevisionContent,
  normalizeDraftLines,
  type DraftRevisionRecord,
  type RevisionValidationIssue,
  type SaveDraftRevisionRequest,
} from "@/domain/draft-revisions";
import { generatedDraftSchema, sectionKeySchema } from "@/domain/schemas";
import { isoUtcTimestampSchema, type FeedbackEventRecord, type GenerationRunRecord, type JsonObject } from "@/domain/runtime-records";
import { type FeedbackProposal } from "@/domain/risk-gate";
import { classifyRevisionFeedback, feedbackEventFromProposal } from "./feedback-lifecycle-service";
import { createAuditEventRepository } from "@/infrastructure/sqlite/repositories/audit-event-repository";
import { createDraftRevisionRepository } from "@/infrastructure/sqlite/repositories/draft-revision-repository";
import { createFeedbackEventRepository } from "@/infrastructure/sqlite/repositories/feedback-event-repository";
import { createGenerationRunRepository } from "@/infrastructure/sqlite/repositories/generation-run-repository";
import { isPersistenceError, persistenceErrorCodes } from "@/infrastructure/sqlite/errors";
import { withTransaction } from "@/infrastructure/sqlite/transaction";
import { createRandomSystemId } from "./system-id";

export const REVISION_RULE_IDS = {
  INPUT_INVALID: "REVISION_INPUT_INVALID",
  GENERATION_RUN_NOT_FOUND: "REVISION_GENERATION_RUN_NOT_FOUND",
  RUN_NOT_EDITABLE: "REVISION_RUN_NOT_EDITABLE",
  SECTION_DUPLICATE: "REVISION_SECTION_DUPLICATE",
  SECTION_SET_INVALID: "REVISION_SECTION_SET_INVALID",
  SECTION_ORDER_INVALID: "REVISION_SECTION_ORDER_INVALID",
  SECTION_METADATA_INVALID: "REVISION_SECTION_METADATA_INVALID",
  SNAPSHOT_IMMUTABLE: "REVISION_SNAPSHOT_IMMUTABLE",
  MANDATORY_SECTION_EMPTY: "REVISION_MANDATORY_SECTION_EMPTY",
  MANDATORY_SECTION_REMOVED: "REVISION_MANDATORY_SECTION_REMOVED",
  DISCLAIMER_READONLY: "REVISION_DISCLAIMER_READONLY",
  PROHIBITED_ACTION: "REVISION_PROHIBITED_ACTION",
  SUSPECTED_PII: "REVISION_SUSPECTED_PII",
  SCHEMA_INVALID: "REVISION_SCHEMA_INVALID",
  NO_CHANGES: "REVISION_NO_CHANGES",
  VERSION_CONFLICT: "REVISION_VERSION_CONFLICT",
  ID_CONFLICT: "REVISION_ID_CONFLICT",
  DATA_CORRUPTION: "REVISION_DATA_CORRUPTION",
  PERSISTENCE_FAILED: "REVISION_PERSISTENCE_FAILED",
  TRANSPORT_ERROR: "REVISION_TRANSPORT_ERROR",
  VALIDATION_BLOCKED: "DRAFT_VALIDATION_BLOCKED",
  FEEDBACK_HIGH_RISK_BLOCKED: "FEEDBACK_HIGH_RISK_BLOCKED",
  RUNTIME_READ_ONLY: "PUBLIC_DEMO_READ_ONLY",
} as const;

export type RevisionRuleId = (typeof REVISION_RULE_IDS)[keyof typeof REVISION_RULE_IDS];

export type DraftRevisionSummary = {
  id: string;
  generationRunId: string;
  revisionNumber: number;
  editorId: string;
  createdAt: string;
  changedSectionCount: number;
  editBurdenRatio: number;
};

export type DraftRevisionFailure = {
  ok: false;
  ruleId: RevisionRuleId;
  message: string;
  details?: RevisionValidationIssue[];
  auditPersisted: boolean;
  riskLevel?: "HIGH";
  feedbackEvents?: FeedbackEventRecord[];
};

export type DraftRevisionSuccess = {
  ok: true;
  revision: DraftRevisionRecord;
  history: DraftRevisionSummary[];
  feedbackEvents: FeedbackEventRecord[];
};

export type SaveDraftRevisionResult = DraftRevisionSuccess | DraftRevisionFailure;

export type DraftRevisionIdKind = "REVISION" | "AUDIT" | "FEEDBACK";
export type DraftRevisionIdFactory = (kind: DraftRevisionIdKind) => string;
export type DraftRevisionClock = () => string;

export type DraftRevisionServiceDependencies = {
  database: DatabaseSync;
  clock?: DraftRevisionClock;
  idFactory?: DraftRevisionIdFactory;
};

const defaultIdFactory: DraftRevisionIdFactory = (kind) => createRandomSystemId(`draft-revision-${kind.toLowerCase()}`);
const controlledMessages = {
  input: "修订提交未通过服务端输入校验。",
  runNotFound: "未找到可编辑的生成运行。",
  runNotEditable: "只有 SUCCEEDED + BOUNDED 且包含输出快照的运行可编辑。",
  validation: "修订未通过安全校验，未保存编辑正文。",
  noChanges: "未检测到实际字段变化，未创建新修订。",
  conflict: "修订版本已变化，请重新载入后再保存。",
  corruption: "修订或生成运行数据损坏，未返回原始内容。",
  persistence: "修订与审计持久化失败，已回滚。",
} as const;

function nowIso(clock: DraftRevisionClock): string {
  const value = clock();
  return isoUtcTimestampSchema.safeParse(value).success ? value : new Date().toISOString();
}

function safeDetails(details: readonly RevisionValidationIssue[]): RevisionValidationIssue[] {
  return details.map((detail) => ({
    ruleId: detail.ruleId,
    ...(detail.fieldPath ? { fieldPath: detail.fieldPath } : {}),
  }));
}

function summaryOf(record: DraftRevisionRecord): DraftRevisionSummary {
  return {
    id: record.id,
    generationRunId: record.generationRunId,
    revisionNumber: record.revisionNumber,
    editorId: record.editorId,
    createdAt: record.createdAt,
    changedSectionCount: record.diffSummary.metrics.changedSectionCount,
    editBurdenRatio: record.diffSummary.metrics.editBurdenRatio,
  };
}

function detailsFor(ruleId: RevisionRuleId, fieldPath?: string): RevisionValidationIssue[] {
  return [{ ruleId, ...(fieldPath ? { fieldPath } : {}) }];
}

function persistValidationBlockedAudit(
  database: DatabaseSync,
  generationRunId: string,
  details: readonly RevisionValidationIssue[],
  idFactory: DraftRevisionIdFactory,
  clock: DraftRevisionClock,
): boolean {
  try {
    const ruleIds = [...new Set(details.map((detail) => detail.ruleId))];
    const eventMetadata: JsonObject = {
      generationRunId,
      ruleId: REVISION_RULE_IDS.VALIDATION_BLOCKED,
      ruleIds,
      details: safeDetails(details).map((detail) => ({
        ruleId: detail.ruleId,
        ...(detail.fieldPath ? { fieldPath: detail.fieldPath } : {}),
      })),
    };
    createAuditEventRepository(database).append({
      schemaVersion: "1.0.0",
      id: idFactory("AUDIT"),
      eventType: "DRAFT_VALIDATION_BLOCKED",
      actorId: "demo-physician",
      simulatedRole: "PHYSICIAN",
      entityType: "DRAFT_REVISION",
      entityId: generationRunId,
      metadata: eventMetadata,
      createdAt: nowIso(clock),
    });
    return true;
  } catch {
    return false;
  }
}

function blocked(
  database: DatabaseSync,
  generationRunId: string,
  details: readonly RevisionValidationIssue[],
  idFactory: DraftRevisionIdFactory,
  clock: DraftRevisionClock,
  message: string = controlledMessages.validation,
): DraftRevisionFailure {
  const auditPersisted = persistValidationBlockedAudit(database, generationRunId, details, idFactory, clock);
  return auditPersisted
    ? {
        ok: false,
        ruleId: (details[0]?.ruleId ?? REVISION_RULE_IDS.VALIDATION_BLOCKED) as RevisionRuleId,
        message,
        details: safeDetails(details),
        auditPersisted: true,
      }
    : {
        ok: false,
        ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED,
        message: controlledMessages.persistence,
        auditPersisted: false,
      };
}

function buildAfterSnapshot(
  beforeSnapshot: DraftRevisionRecord["beforeSnapshot"],
  sections: SaveDraftRevisionRequest["sections"],
): { ok: true; snapshot: DraftRevisionRecord["afterSnapshot"] } | { ok: false; details: RevisionValidationIssue[] } {
  const beforeKeys = beforeSnapshot.sections.map((section) => section.key);
  const submittedKeys = sections.map((section) => section.key);
  const details: RevisionValidationIssue[] = [];
  const add = (ruleId: RevisionRuleId, fieldPath?: string) => {
    if (!details.some((detail) => detail.ruleId === ruleId && detail.fieldPath === fieldPath)) {
      details.push({ ruleId, ...(fieldPath ? { fieldPath } : {}) });
    }
  };

  const seen = new Set<string>();
  for (const key of submittedKeys) {
    if (seen.has(key)) add(REVISION_RULE_IDS.SECTION_DUPLICATE, "sections");
    seen.add(key);
  }
  const beforeSet = new Set(beforeKeys);
  beforeSnapshot.sections.forEach((section, index) => {
    if (section.mandatory && !submittedKeys.includes(section.key)) {
      add(REVISION_RULE_IDS.MANDATORY_SECTION_REMOVED, `sections[${index}]`);
    }
  });
  if (submittedKeys.length !== beforeKeys.length || submittedKeys.some((key) => !beforeSet.has(key))) {
    if (!details.some((detail) => detail.ruleId === REVISION_RULE_IDS.MANDATORY_SECTION_REMOVED)) {
      add(REVISION_RULE_IDS.SECTION_SET_INVALID, "sections");
    }
  }
  const onlyMandatoryRemoval = details.length > 0
    && details.every((detail) => detail.ruleId === REVISION_RULE_IDS.MANDATORY_SECTION_REMOVED);
  if (details.length > 0 && !onlyMandatoryRemoval) return { ok: false, details };

  const trustedByKey = new Map(beforeSnapshot.sections.map((section) => [section.key, section]));
  const after = generatedDraftSchema.safeParse({
    ...beforeSnapshot,
    sections: sections.map((submittedSection) => ({
      ...trustedByKey.get(submittedSection.key)!,
      content: normalizeDraftLines(submittedSection.content),
    })),
  });
  if (!after.success) return { ok: false, details: detailsFor(REVISION_RULE_IDS.SCHEMA_INVALID, "afterSnapshot") };
  return { ok: true, snapshot: after.data };
}

function mapRevisionValidationDetails(details: readonly RevisionValidationIssue[]): RevisionValidationIssue[] {
  return details.map((detail) => {
    const ruleId = detail.ruleId === "REVISION_SCHEMA_INVALID"
      ? REVISION_RULE_IDS.SCHEMA_INVALID
      : detail.ruleId === "REVISION_PROHIBITED_ACTION"
        ? REVISION_RULE_IDS.PROHIBITED_ACTION
        : detail.ruleId === "REVISION_SUSPECTED_PII"
          ? REVISION_RULE_IDS.SUSPECTED_PII
          : detail.ruleId as RevisionRuleId;
    return {
      ruleId,
      ...(detail.fieldPath ? { fieldPath: detail.fieldPath } : {}),
      ...(detail.prohibitedAction ? { prohibitedAction: detail.prohibitedAction } : {}),
    };
  });
}

function feedbackRuleId(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 100) || "HIGH_RULE";
}

function stableHighRuleId(detail: RevisionValidationIssue): string {
  const fixed: Record<string, string> = {
    [REVISION_RULE_IDS.MANDATORY_SECTION_EMPTY]: "HIGH_MANDATORY_SECTION_EMPTY",
    [REVISION_RULE_IDS.MANDATORY_SECTION_REMOVED]: "HIGH_MANDATORY_SECTION_REMOVED",
    [REVISION_RULE_IDS.DISCLAIMER_READONLY]: "HIGH_DISCLAIMER_READONLY",
  };
  if (fixed[detail.ruleId]) return fixed[detail.ruleId];
  if (detail.ruleId === REVISION_RULE_IDS.PROHIBITED_ACTION && detail.prohibitedAction) {
    return `HIGH_PROHIBITED_${feedbackRuleId(detail.prohibitedAction)}`;
  }
  return feedbackRuleId(detail.ruleId);
}

function changedOperationCount(diffSummary: DraftRevisionRecord["diffSummary"]): number {
  return diffSummary.changedSections.reduce((sum, section) => (
    sum + ("operations" in section ? section.operations.length : section.lineChanges.length)
  ), 0);
}

function buildHighRiskProposals(
  run: GenerationRunRecord,
  beforeSnapshot: DraftRevisionRecord["beforeSnapshot"],
  afterSnapshot: DraftRevisionRecord["afterSnapshot"],
  diffSummary: DraftRevisionRecord["diffSummary"],
  details: readonly RevisionValidationIssue[],
  revisionNumber: number,
): FeedbackProposal[] {
  const highDetailIds = new Set<string>([
    REVISION_RULE_IDS.MANDATORY_SECTION_EMPTY,
    REVISION_RULE_IDS.MANDATORY_SECTION_REMOVED,
    REVISION_RULE_IDS.DISCLAIMER_READONLY,
    REVISION_RULE_IDS.PROHIBITED_ACTION,
  ]);
  const highDetails = details.filter((detail) => highDetailIds.has(detail.ruleId));
  const grouped = new Map<string, string[]>();
  for (const detail of highDetails) {
    const match = detail.fieldPath?.match(/sections\[(\d+)\]/u);
    const index = match ? Number(match[1]) : -1;
    const key = index >= 0 ? afterSnapshot.sections[index]?.key ?? beforeSnapshot.sections[index]?.key ?? "unknown" : "unknown";
    const ruleHits = grouped.get(key) ?? [];
    ruleHits.push(stableHighRuleId(detail));
    grouped.set(key, ruleHits);
  }
  if (grouped.size === 0) return [];
  return [...grouped.entries()].map(([field, ruleHits], index) => {
    const affectedField = sectionKeySchema.safeParse(field).success ? field as FeedbackProposal["affectedField"] : "unknown";
    const mandatoryEmpty = ruleHits.includes(feedbackRuleId(REVISION_RULE_IDS.MANDATORY_SECTION_EMPTY))
      || ruleHits.includes(feedbackRuleId(REVISION_RULE_IDS.MANDATORY_SECTION_REMOVED));
    return {
      proposalId: `high:${run.id}:${revisionNumber}:${index}`,
      eventType: "FEEDBACK_CLASSIFIED" as const,
      generationRunId: run.id,
      revisionNumber,
      profileId: run.profileId!,
      profileVersion: run.profileVersion!,
      rulesVersion: "feedback-rules-v1" as const,
      changeType: mandatoryEmpty ? "DELETE" as const : "REWRITE" as const,
      status: "REJECTED" as const,
      riskLevel: "HIGH" as const,
      decision: "REJECTED" as const,
      affectedField,
      ruleHits: [...new Set(ruleHits)],
      safetyReason: "该修订触及强制字段、免责声明或机构禁止动作，危险正文不会保存。",
      nextAllowedActions: [],
      evidence: {
        operationCount: changedOperationCount(diffSummary),
        addedLineCount: diffSummary.metrics.addedLineCount,
        removedLineCount: diffSummary.metrics.removedLineCount,
        addedCharacterCount: diffSummary.metrics.addedCharacterCount,
        removedCharacterCount: diffSummary.metrics.removedCharacterCount,
        orderChanged: diffSummary.orderChanged,
      },
    };
  });
}

function persistHighRiskFeedback(
  database: DatabaseSync,
  proposals: readonly FeedbackProposal[],
  details: readonly RevisionValidationIssue[],
  idFactory: DraftRevisionIdFactory,
  clock: DraftRevisionClock,
  generationRunId: string,
): { ok: true; events: FeedbackEventRecord[] } | { ok: false } {
  try {
    return withTransaction(database, () => {
      const events = proposals.map((proposal) => feedbackEventFromProposal(
        proposal,
        idFactory("FEEDBACK"),
        nowIso(clock),
      ));
      const feedbackRepository = createFeedbackEventRepository(database);
      for (const event of events) {
        feedbackRepository.append(event);
        createAuditEventRepository(database).append({
          schemaVersion: "1.0.0",
          id: idFactory("AUDIT"),
          eventType: "FEEDBACK_CLASSIFIED",
          actorId: "demo-physician",
          simulatedRole: "PHYSICIAN",
          entityType: "FEEDBACK_EVENT",
          entityId: event.id,
          metadata: {
            generationRunId: event.generationRunId,
            feedbackEventId: event.id,
            riskLevel: event.riskLevel,
            status: event.status,
            ruleIds: event.ruleHits,
            affectedField: event.affectedField,
            evidence: event.evidence,
          },
          createdAt: event.createdAt,
        });
      }
      createAuditEventRepository(database).append({
        schemaVersion: "1.0.0",
        id: idFactory("AUDIT"),
        eventType: "DRAFT_VALIDATION_BLOCKED",
        actorId: "demo-physician",
        simulatedRole: "PHYSICIAN",
        entityType: "DRAFT_REVISION",
        entityId: generationRunId,
        metadata: {
          generationRunId,
          ruleId: REVISION_RULE_IDS.FEEDBACK_HIGH_RISK_BLOCKED,
          ruleIds: [...new Set(details.map((detail) => detail.ruleId))],
          riskLevel: "HIGH",
          feedbackEventIds: events.map((event) => event.id),
        },
        createdAt: nowIso(clock),
      });
      return { ok: true as const, events };
    });
  } catch {
    return { ok: false };
  }
}

export function parseSaveDraftRevisionRequest(value: unknown): SaveDraftRevisionRequest | undefined {
  const result = saveDraftRevisionRequestSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function saveDraftRevision(
  request: unknown,
  dependencies: DraftRevisionServiceDependencies,
): SaveDraftRevisionResult {
  const idFactory = dependencies.idFactory ?? defaultIdFactory;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const parsedRequest = saveDraftRevisionRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return {
      ok: false,
      ruleId: REVISION_RULE_IDS.INPUT_INVALID,
      message: controlledMessages.input,
      auditPersisted: false,
    };
  }

  const input = parsedRequest.data;
  const generationRuns = createGenerationRunRepository(dependencies.database);
  const revisions = createDraftRevisionRepository(dependencies.database);
  let run;
  try {
    run = generationRuns.getById(input.generationRunId);
  } catch (error) {
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
      return { ok: false, ruleId: REVISION_RULE_IDS.DATA_CORRUPTION, message: controlledMessages.corruption, auditPersisted: false };
    }
    return { ok: false, ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED, message: controlledMessages.persistence, auditPersisted: false };
  }

  if (!run) {
    return blocked(
      dependencies.database,
      input.generationRunId,
      detailsFor(REVISION_RULE_IDS.GENERATION_RUN_NOT_FOUND),
      idFactory,
      clock,
      controlledMessages.runNotFound,
    );
  }
  if (run.status !== "SUCCEEDED" || run.mode !== "BOUNDED" || !run.outputDraftSnapshot) {
    return blocked(
      dependencies.database,
      input.generationRunId,
      detailsFor(REVISION_RULE_IDS.RUN_NOT_EDITABLE),
      idFactory,
      clock,
      controlledMessages.runNotEditable,
    );
  }

  let latest: DraftRevisionRecord | undefined;
  let previousHistory: DraftRevisionSummary[] = [];
  try {
    latest = revisions.getLatestByGenerationRun(input.generationRunId);
    previousHistory = revisions.listByGenerationRun(input.generationRunId).map(summaryOf);
  } catch (error) {
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
      return { ok: false, ruleId: REVISION_RULE_IDS.DATA_CORRUPTION, message: controlledMessages.corruption, auditPersisted: false };
    }
    return { ok: false, ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED, message: controlledMessages.persistence, auditPersisted: false };
  }

  const expectedPreviousRevision = input.expectedPreviousRevision ?? 0;
  if ((latest?.revisionNumber ?? 0) !== expectedPreviousRevision) {
    return blocked(
      dependencies.database,
      input.generationRunId,
      detailsFor(REVISION_RULE_IDS.VERSION_CONFLICT),
      idFactory,
      clock,
      controlledMessages.conflict,
    );
  }

  const beforeSnapshot = latest?.afterSnapshot ?? run.outputDraftSnapshot;
  const afterResult = buildAfterSnapshot(beforeSnapshot, input.sections);
  if (!afterResult.ok) {
    return blocked(dependencies.database, input.generationRunId, afterResult.details, idFactory, clock);
  }

  const afterSnapshot = afterResult.snapshot;
  const diffSummary = computeDraftDiff(beforeSnapshot, afterSnapshot);
  const validationDetails = mapRevisionValidationDetails(
    validateRevisionContent(beforeSnapshot, afterSnapshot, run.effectiveConfigSnapshot.safety),
  );
  if (validationDetails.length > 0) {
    const highRuleIds = new Set<string>([
      REVISION_RULE_IDS.MANDATORY_SECTION_EMPTY,
      REVISION_RULE_IDS.MANDATORY_SECTION_REMOVED,
      REVISION_RULE_IDS.DISCLAIMER_READONLY,
      REVISION_RULE_IDS.PROHIBITED_ACTION,
    ]);
    const onlyHighDetails = validationDetails.every((detail) => highRuleIds.has(detail.ruleId));
    if (onlyHighDetails) {
      const highProposals = buildHighRiskProposals(
        run,
        beforeSnapshot,
        afterSnapshot,
        diffSummary,
        validationDetails,
        expectedPreviousRevision + 1,
      );
      const highPersisted = persistHighRiskFeedback(
        dependencies.database,
        highProposals,
        validationDetails,
        idFactory,
        clock,
        input.generationRunId,
      );
      if (!highPersisted.ok) {
        return { ok: false, ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED, message: controlledMessages.persistence, auditPersisted: false };
      }
      return {
        ok: false,
        ruleId: (validationDetails[0]?.ruleId ?? REVISION_RULE_IDS.FEEDBACK_HIGH_RISK_BLOCKED) as RevisionRuleId,
        message: controlledMessages.validation,
        details: safeDetails(validationDetails),
        auditPersisted: true,
        riskLevel: "HIGH",
        feedbackEvents: highPersisted.events,
      };
    }
    return blocked(dependencies.database, input.generationRunId, validationDetails, idFactory, clock);
  }

  if (diffSummary.metrics.changedSectionCount === 0 && !diffSummary.orderChanged) {
    return blocked(
      dependencies.database,
      input.generationRunId,
      detailsFor(REVISION_RULE_IDS.NO_CHANGES),
      idFactory,
      clock,
      controlledMessages.noChanges,
    );
  }

  const revision = draftRevisionRecordSchema.parse({
    schemaVersion: "1.0.0",
    id: idFactory("REVISION"),
    generationRunId: input.generationRunId,
    revisionNumber: expectedPreviousRevision + 1,
    beforeSnapshot,
    afterSnapshot,
    diffSummary,
    editorId: "demo-physician",
    createdAt: nowIso(clock),
  });

  try {
    if (revisions.getById(revision.id)) {
      return blocked(
        dependencies.database,
        input.generationRunId,
        detailsFor(REVISION_RULE_IDS.ID_CONFLICT),
        idFactory,
        clock,
        controlledMessages.conflict,
      );
    }
  } catch (error) {
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
      return { ok: false, ruleId: REVISION_RULE_IDS.DATA_CORRUPTION, message: controlledMessages.corruption, auditPersisted: false };
    }
    return { ok: false, ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED, message: controlledMessages.persistence, auditPersisted: false };
  }

  const feedbackResult = classifyRevisionFeedback(revision, {
    generationRunId: run.id,
    profileId: run.profileId!,
    profileVersion: run.profileVersion!,
    prohibitedActions: run.effectiveConfigSnapshot.safety.prohibitedActions,
  });
  if (!feedbackResult.ok) {
    const highDetails = feedbackResult.proposals.flatMap((proposal) => proposal.ruleHits.map((ruleId) => ({
      ruleId,
      fieldPath: proposal.affectedField === "unknown" ? undefined : `sections.${proposal.affectedField}`,
    })));
    const highPersisted = persistHighRiskFeedback(
      dependencies.database,
      feedbackResult.proposals.map((proposal) => ({ ...proposal, draftRevisionId: undefined })),
      highDetails,
      idFactory,
      clock,
      input.generationRunId,
    );
    if (!highPersisted.ok) {
      return { ok: false, ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED, message: controlledMessages.persistence, auditPersisted: false };
    }
    return {
      ok: false,
      ruleId: REVISION_RULE_IDS.FEEDBACK_HIGH_RISK_BLOCKED,
      message: controlledMessages.validation,
      details: safeDetails(highDetails),
      auditPersisted: true,
      riskLevel: "HIGH",
      feedbackEvents: highPersisted.events,
    };
  }

  const feedbackEvents = feedbackResult.proposals.map((proposal) => feedbackEventFromProposal(
    proposal,
    idFactory("FEEDBACK"),
    revision.createdAt,
  ));

  const auditEvent = {
    schemaVersion: "1.0.0" as const,
    id: idFactory("AUDIT"),
    eventType: "REVISION_SAVED",
    actorId: "demo-physician",
    simulatedRole: "PHYSICIAN" as const,
    entityType: "DRAFT_REVISION",
    entityId: revision.id,
    beforeVersion: String(expectedPreviousRevision),
    afterVersion: String(revision.revisionNumber),
    metadata: {
      generationRunId: revision.generationRunId,
      revisionNumber: revision.revisionNumber,
      ruleIds: [],
      changedSectionCount: diffSummary.metrics.changedSectionCount,
      addedLineCount: diffSummary.metrics.addedLineCount,
      removedLineCount: diffSummary.metrics.removedLineCount,
      addedCharacterCount: diffSummary.metrics.addedCharacterCount,
      removedCharacterCount: diffSummary.metrics.removedCharacterCount,
      editBurdenRatio: diffSummary.metrics.editBurdenRatio,
    },
    createdAt: revision.createdAt,
  };

  try {
    withTransaction(dependencies.database, () => {
      revisions.append(revision, expectedPreviousRevision);
      const feedbackRepository = createFeedbackEventRepository(dependencies.database);
      for (const feedbackEvent of feedbackEvents) {
        feedbackRepository.append(feedbackEvent);
        createAuditEventRepository(dependencies.database).append({
          schemaVersion: "1.0.0",
          id: idFactory("AUDIT"),
          eventType: "FEEDBACK_CLASSIFIED",
          actorId: "demo-physician",
          simulatedRole: "PHYSICIAN",
          entityType: "FEEDBACK_EVENT",
          entityId: feedbackEvent.id,
          metadata: {
            generationRunId: feedbackEvent.generationRunId,
            draftRevisionId: feedbackEvent.draftRevisionId ?? null,
            feedbackEventId: feedbackEvent.id,
            riskLevel: feedbackEvent.riskLevel,
            status: feedbackEvent.status,
            ruleIds: feedbackEvent.ruleHits,
            affectedField: feedbackEvent.affectedField,
            evidence: feedbackEvent.evidence,
          },
          createdAt: feedbackEvent.createdAt,
        });
      }
      createAuditEventRepository(dependencies.database).append(auditEvent);
    });
  } catch (error) {
    const auditIdCollision = isPersistenceError(error)
      && error.code === persistenceErrorCodes.CONFLICT
      && error.message === "Audit event ID already exists.";
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.CONFLICT && !auditIdCollision) {
      return {
        ok: false,
        ruleId: REVISION_RULE_IDS.VERSION_CONFLICT,
        message: controlledMessages.conflict,
        auditPersisted: false,
      };
    }
    if (isPersistenceError(error) && error.code === persistenceErrorCodes.DATA_CORRUPTION) {
      return { ok: false, ruleId: REVISION_RULE_IDS.DATA_CORRUPTION, message: controlledMessages.corruption, auditPersisted: false };
    }
    return { ok: false, ruleId: REVISION_RULE_IDS.PERSISTENCE_FAILED, message: controlledMessages.persistence, auditPersisted: false };
  }

  return {
    ok: true,
    revision,
    history: [...previousHistory, summaryOf(revision)],
    feedbackEvents,
  };
}
