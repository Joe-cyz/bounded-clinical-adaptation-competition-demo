import type { DatabaseSync } from "node:sqlite";

import {
  modelReferenceStoredResultSchema,
  type ModelReferenceStoredResult,
  type ModelReferenceSupport,
} from "@/domain/model-reference";
import { dataCorruptionError } from "../errors";

export type ModelReferenceRun = {
  referenceId: string;
  referenceRequestId: string;
  requestFingerprint: string;
  encounterId: string;
  recordRevisionId: string;
  revisionNumber: number;
  kind: "GENERAL" | "LITERATURE_GROUNDED";
  evidenceLevel: "GENERAL_MODEL_NO_LOCAL_EVIDENCE" | "SELECTED_LOCAL_LITERATURE";
  question: string;
  documentsFingerprint: string;
  promptVersion: string;
  promptDigest?: string;
  providerId?: string;
  modelId?: string;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED" | "STALE";
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ModelReferenceItemRow = {
  id: string;
  referenceId: string;
  ordinal: number;
  kind: "NEEDS_VERIFICATION" | "CONSIDERATION_DIRECTION" | "ADDITIONAL_CHECK_OR_SOURCE";
  text: string;
  factIds: ModelReferenceStoredResult["items"][number]["factIds"];
};

export type ModelReferenceSupportRow = ModelReferenceSupport & {
  id: string;
  itemId: string;
  documentId: string;
  versionId: string;
  fragmentId: string;
};

export type ModelReferenceFollowUpRow = {
  followUpId: string;
  followUpRequestId: string;
  referenceId: string;
  itemId: string;
  encounterId: string;
  recordRevisionId: string;
  itemKind: "NEEDS_VERIFICATION";
  status: "SELECTED" | "CONSUMED" | "STALE";
  createdAt: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseFactIds(value: unknown): ModelReferenceItemRow["factIds"] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    const result = modelReferenceStoredResultSchema.shape.items.element.shape.factIds.safeParse(parsed);
    if (!result.success) throw new Error("invalid");
    return result.data;
  } catch {
    throw dataCorruptionError("modelReference.factIds");
  }
}

function parseRun(row: Record<string, unknown>): ModelReferenceRun {
  const status = row.status;
  const kind = row.kind;
  const evidenceLevel = row.evidence_level;
  if (typeof row.reference_id !== "string" || typeof row.reference_request_id !== "string"
    || typeof row.request_fingerprint !== "string" || typeof row.encounter_id !== "string"
    || typeof row.record_revision_id !== "string" || typeof row.revision_number !== "number"
    || (kind !== "GENERAL" && kind !== "LITERATURE_GROUNDED")
    || (evidenceLevel !== "GENERAL_MODEL_NO_LOCAL_EVIDENCE" && evidenceLevel !== "SELECTED_LOCAL_LITERATURE")
    || (status !== "IN_PROGRESS" && status !== "COMPLETED" && status !== "FAILED" && status !== "STALE")
    || typeof row.question !== "string" || typeof row.documents_fingerprint !== "string"
    || typeof row.prompt_version !== "string" || typeof row.created_at !== "string" || typeof row.updated_at !== "string") {
    throw dataCorruptionError("modelReference.run");
  }
  return {
    referenceId: row.reference_id,
    referenceRequestId: row.reference_request_id,
    requestFingerprint: row.request_fingerprint,
    encounterId: row.encounter_id,
    recordRevisionId: row.record_revision_id,
    revisionNumber: row.revision_number,
    kind,
    evidenceLevel,
    question: row.question,
    documentsFingerprint: row.documents_fingerprint,
    promptVersion: row.prompt_version,
    ...(optionalString(row.prompt_digest) === undefined ? {} : { promptDigest: optionalString(row.prompt_digest) }),
    ...(optionalString(row.provider_id) === undefined ? {} : { providerId: optionalString(row.provider_id) }),
    ...(optionalString(row.model_id) === undefined ? {} : { modelId: optionalString(row.model_id) }),
    status,
    ...(optionalString(row.failure_code) === undefined ? {} : { failureCode: optionalString(row.failure_code) }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(optionalString(row.completed_at) === undefined ? {} : { completedAt: optionalString(row.completed_at) }),
  };
}

export function createModelReferenceRepository(database: DatabaseSync) {
  function getByRequestId(referenceRequestId: string): ModelReferenceRun | undefined {
    const row = database.prepare("SELECT * FROM model_reference_runs WHERE reference_request_id = ? LIMIT 1").get(referenceRequestId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : parseRun(row);
  }

  function getById(referenceId: string): ModelReferenceRun | undefined {
    const row = database.prepare("SELECT * FROM model_reference_runs WHERE reference_id = ? LIMIT 1").get(referenceId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : parseRun(row);
  }

  function getLatestCompletedByEncounter(encounterId: string, kind: "GENERAL" | "LITERATURE_GROUNDED"): ModelReferenceRun | undefined {
    const row = database.prepare(`SELECT * FROM model_reference_runs
      WHERE encounter_id = ? AND kind = ? AND status = 'COMPLETED'
      ORDER BY completed_at DESC, reference_id DESC LIMIT 1`).get(encounterId, kind) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : parseRun(row);
  }

  function insertRun(run: ModelReferenceRun): void {
    database.prepare(`INSERT INTO model_reference_runs (
      reference_id, schema_version, reference_request_id, request_fingerprint, encounter_id, record_revision_id,
      revision_number, kind, evidence_level, question, documents_fingerprint, prompt_version, status,
      created_at, updated_at
    ) VALUES (?, '1.0.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.referenceId, run.referenceRequestId, run.requestFingerprint, run.encounterId, run.recordRevisionId,
      run.revisionNumber, run.kind, run.evidenceLevel, run.question, run.documentsFingerprint, run.promptVersion,
      run.status, run.createdAt, run.updatedAt,
    );
  }

  function markCompleted(input: { referenceId: string; promptDigest: string; providerId: string; modelId: string; completedAt: string }): void {
    database.prepare(`UPDATE model_reference_runs
      SET status = 'COMPLETED', prompt_digest = ?, provider_id = ?, model_id = ?, updated_at = ?, completed_at = ?
      WHERE reference_id = ? AND status = 'IN_PROGRESS'`).run(
      input.promptDigest, input.providerId, input.modelId, input.completedAt, input.completedAt, input.referenceId,
    );
  }

  function markFailed(referenceId: string, failureCode: string, updatedAt: string): void {
    database.prepare(`UPDATE model_reference_runs
      SET status = 'FAILED', failure_code = ?, updated_at = ?
      WHERE reference_id = ? AND status = 'IN_PROGRESS'`).run(failureCode, updatedAt, referenceId);
  }

  function insertItem(item: ModelReferenceItemRow): void {
    database.prepare(`INSERT INTO model_reference_items (item_id, reference_id, ordinal, kind, text, fact_ids_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(item.id, item.referenceId, item.ordinal, item.kind, item.text, JSON.stringify(item.factIds));
  }

  function insertSupport(support: ModelReferenceSupportRow): void {
    database.prepare(`INSERT INTO model_reference_supports
      (support_id, item_id, evidence_id, document_id, version_id, fragment_id, quote)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      support.id, support.itemId, support.evidenceId, support.documentId, support.versionId, support.fragmentId, support.quote,
    );
  }

  function listItems(referenceId: string): ModelReferenceItemRow[] {
    return (database.prepare("SELECT * FROM model_reference_items WHERE reference_id = ? ORDER BY ordinal ASC, item_id ASC").all(referenceId) as Array<Record<string, unknown>>).map((row) => {
      if (typeof row.item_id !== "string" || typeof row.reference_id !== "string" || typeof row.ordinal !== "number"
        || (row.kind !== "NEEDS_VERIFICATION" && row.kind !== "CONSIDERATION_DIRECTION" && row.kind !== "ADDITIONAL_CHECK_OR_SOURCE")
        || typeof row.text !== "string") throw dataCorruptionError("modelReference.items");
      return { id: row.item_id, referenceId: row.reference_id, ordinal: row.ordinal, kind: row.kind, text: row.text, factIds: parseFactIds(row.fact_ids_json) };
    });
  }

  function listSupports(referenceId: string): ModelReferenceSupportRow[] {
    return (database.prepare(`SELECT supports.* FROM model_reference_supports supports
      INNER JOIN model_reference_items items ON items.item_id = supports.item_id
      WHERE items.reference_id = ? ORDER BY items.ordinal ASC, supports.support_id ASC`).all(referenceId) as Array<Record<string, unknown>>).map((row) => {
      if (typeof row.support_id !== "string" || typeof row.item_id !== "string" || typeof row.evidence_id !== "string"
        || typeof row.document_id !== "string" || typeof row.version_id !== "string" || typeof row.fragment_id !== "string" || typeof row.quote !== "string") {
        throw dataCorruptionError("modelReference.supports");
      }
      return { id: row.support_id, itemId: row.item_id, evidenceId: row.evidence_id as ModelReferenceSupport["evidenceId"], quote: row.quote, documentId: row.document_id, versionId: row.version_id, fragmentId: row.fragment_id };
    });
  }

  function getFollowUpByRequestId(followUpRequestId: string): ModelReferenceFollowUpRow | undefined {
    const row = database.prepare("SELECT * FROM model_reference_followups WHERE follow_up_request_id = ? LIMIT 1").get(followUpRequestId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : parseFollowUp(row);
  }

  function getFollowUpByReferenceItem(referenceId: string, itemId: string): ModelReferenceFollowUpRow | undefined {
    const row = database.prepare("SELECT * FROM model_reference_followups WHERE reference_id = ? AND item_id = ? LIMIT 1").get(referenceId, itemId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : parseFollowUp(row);
  }

  function listSelectedFollowUps(encounterId: string, recordRevisionId: string): ModelReferenceFollowUpRow[] {
    return (database.prepare(`SELECT * FROM model_reference_followups
      WHERE encounter_id = ? AND record_revision_id = ? AND status = 'SELECTED'
      ORDER BY created_at ASC, follow_up_id ASC`).all(encounterId, recordRevisionId) as Array<Record<string, unknown>>).map(parseFollowUp);
  }

  function insertFollowUp(row: ModelReferenceFollowUpRow): void {
    database.prepare(`INSERT INTO model_reference_followups
      (follow_up_id, schema_version, follow_up_request_id, reference_id, item_id, encounter_id, record_revision_id, item_kind, status, created_at)
      VALUES (?, '1.0.0', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.followUpId, row.followUpRequestId, row.referenceId, row.itemId, row.encounterId,
      row.recordRevisionId, row.itemKind, row.status, row.createdAt,
    );
  }

  return {
    getByRequestId, getById, getLatestCompletedByEncounter, insertRun, markCompleted, markFailed, insertItem, insertSupport, listItems, listSupports,
    getFollowUpByRequestId, getFollowUpByReferenceItem, listSelectedFollowUps, insertFollowUp,
  };
}

function parseFollowUp(row: Record<string, unknown>): ModelReferenceFollowUpRow {
  if (typeof row.follow_up_id !== "string" || typeof row.follow_up_request_id !== "string" || typeof row.reference_id !== "string"
    || typeof row.item_id !== "string" || typeof row.encounter_id !== "string" || typeof row.record_revision_id !== "string"
    || row.item_kind !== "NEEDS_VERIFICATION" || (row.status !== "SELECTED" && row.status !== "CONSUMED" && row.status !== "STALE")
    || typeof row.created_at !== "string") throw dataCorruptionError("modelReference.followups");
  return {
    followUpId: row.follow_up_id,
    followUpRequestId: row.follow_up_request_id,
    referenceId: row.reference_id,
    itemId: row.item_id,
    encounterId: row.encounter_id,
    recordRevisionId: row.record_revision_id,
    itemKind: "NEEDS_VERIFICATION",
    status: row.status,
    createdAt: row.created_at,
  };
}
