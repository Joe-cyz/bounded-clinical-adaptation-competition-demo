"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";

import type { ModelReferenceKind } from "@/domain/model-reference";

import styles from "./reference-workspace.module.css";

export type AiReferenceDocumentOption = {
  documentId: string;
  displayName: string;
  version: number;
};

export const GENERAL_DEFAULT_QUESTION = "请结合当前病历给出诊疗建议。";
export const CASE_OVERVIEW_QUESTION =
  "请结合当前已保存病历，对整个病例给出综合判断和诊疗建议。";

export type ReferenceQuestionState = {
  value: string;
  edited: boolean;
};

type ReferenceItem = {
  id: string;
  kind: "NEEDS_VERIFICATION" | "CONSIDERATION_DIRECTION" | "ADDITIONAL_CHECK_OR_SOURCE";
  text: string;
};

export type ReferenceResult = {
  referenceId: string;
  revisionNumber: number;
  kind: ModelReferenceKind;
  items: ReferenceItem[];
  stale: boolean;
  factSummaries?: Array<{ itemId: string; facts: Array<{ id: string; label: string; text: string }> }>;
  citations: Array<{ itemId: string; displayName: string; version: number; locationLabel: string; quote: string }>;
};

export function updateReferenceDocumentSelection(current: readonly string[], documentId: string, maximum = 3): string[] {
  const uniqueCurrent = [...new Set(current)];
  if (uniqueCurrent.includes(documentId)) return uniqueCurrent.filter((id) => id !== documentId);
  if (uniqueCurrent.length >= maximum) return uniqueCurrent;
  return [...uniqueCurrent, documentId];
}

export function referenceKindForDocuments(documentIds: readonly string[]): ModelReferenceKind {
  return documentIds.length === 0 ? "GENERAL" : "LITERATURE_GROUNDED";
}

export function transitionQuestionForDocuments(
  state: ReferenceQuestionState,
  previousDocumentCount: number,
  nextDocumentCount: number,
): ReferenceQuestionState {
  if (previousDocumentCount === 0 && nextDocumentCount > 0 && !state.edited && state.value === GENERAL_DEFAULT_QUESTION) {
    return { value: "", edited: false };
  }
  if (previousDocumentCount > 0 && nextDocumentCount === 0 && !state.edited && state.value.trim().length === 0) {
    return { value: GENERAL_DEFAULT_QUESTION, edited: false };
  }
  return state;
}

export function canSubmitReferenceQuestion(question: string): boolean {
  return question.trim().length > 0;
}

export function referenceResultHeadingTag(fixedMode: boolean): "h2" | "h4" {
  return fixedMode ? "h4" : "h2";
}

export function uniqueVisibleCitations(citations: ReferenceResult["citations"]): ReferenceResult["citations"] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = JSON.stringify([citation.displayName, citation.version, citation.locationLabel, citation.quote]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requestId(prefix: string): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function group(items: ReferenceItem[], kind: ReferenceItem["kind"]): ReferenceItem[] {
  return items.filter((item) => item.kind === kind);
}

function ItemList({ items }: { items: ReferenceItem[] }) {
  if (items.length === 0) return <p className={styles.modelReferenceEmpty}>暂无</p>;
  return <ul className={styles.modelReferenceList}>{items.map((item) => <li key={item.id}>{item.text}</li>)}</ul>;
}

function ResultHeading({ children, fixedMode, id }: { children: ReactNode; fixedMode: boolean; id: string }) {
  if (referenceResultHeadingTag(fixedMode) === "h4") return <h4 id={id}>{children}</h4>;
  return <h2 id={id}>{children}</h2>;
}

export function ModelReferenceWorkspace({
  encounterId,
  expectedUpdatedAt,
  expectedCurrentRecordRevisionId,
  initialResult,
  initialQuestion = GENERAL_DEFAULT_QUESTION,
  availableDocuments = [],
  fixedDocumentIds,
  literatureHref,
}: {
  encounterId: string;
  expectedUpdatedAt: string;
  expectedCurrentRecordRevisionId: string;
  initialResult?: ReferenceResult;
  initialQuestion?: string;
  availableDocuments?: AiReferenceDocumentOption[];
  fixedDocumentIds?: string[];
  literatureHref?: string;
}) {
  const fixedMode = fixedDocumentIds !== undefined;
  const fixedIds = fixedMode ? [...new Set(fixedDocumentIds)].slice(0, 3) : [];
  const availableIds = new Set(availableDocuments.map((document) => document.documentId));
  const [question, setQuestion] = useState(initialQuestion);
  const [questionEdited, setQuestionEdited] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>(() => fixedIds);
  const [result, setResult] = useState<ReferenceResult | undefined>(initialResult);
  const [notice, setNotice] = useState<"INSUFFICIENT" | undefined>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [followUps, setFollowUps] = useState<Set<string>>(() => new Set());
  const effectiveDocumentIds = fixedMode
    ? fixedIds
    : selectedDocumentIds.filter((documentId) => availableIds.has(documentId));
  const selectedCount = effectiveDocumentIds.length;

  function toggleDocument(documentId: string): void {
    if (fixedMode) return;
    const nextDocumentIds = updateReferenceDocumentSelection(selectedDocumentIds, documentId);
    setSelectedDocumentIds(nextDocumentIds);
    setQuestion((current) => transitionQuestionForDocuments(
      { value: current, edited: questionEdited },
      selectedDocumentIds.length,
      nextDocumentIds.length,
    ).value);
    setQuestionEdited((current) => transitionQuestionForDocuments(
      { value: question, edited: current },
      selectedDocumentIds.length,
      nextDocumentIds.length,
    ).edited);
    setResult(undefined);
    setNotice(undefined);
    setError(undefined);
  }

  async function generateWithQuestion(questionOverride: string): Promise<void> {
    const normalizedQuestion = questionOverride.trim();
    if (pendingRef.current || !canSubmitReferenceQuestion(normalizedQuestion)) return;
    const kind = referenceKindForDocuments(effectiveDocumentIds);
    pendingRef.current = true;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    setResult(undefined);
    try {
      const response = await fetch("/api/reference/model", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referenceRequestId: requestId("model-reference"),
          encounterId,
          expectedUpdatedAt,
          expectedCurrentRecordRevisionId,
          kind,
          question: normalizedQuestion,
          ...(kind === "LITERATURE_GROUNDED" ? { documentIds: effectiveDocumentIds } : {}),
        }),
      });
      const payload = await response.json() as { status?: string; reference?: ReferenceResult };
      if (payload.status === "INSUFFICIENT_EVIDENCE") {
        setNotice("INSUFFICIENT");
        return;
      }
      if (!response.ok || (payload.status !== "CREATED" && payload.status !== "REPLAYED") || payload.reference === undefined) {
        setError("生成失败，请重试。");
        return;
      }
      setResult(payload.reference);
    } catch {
      setError("生成失败，请重试。");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void generateWithQuestion(question);
  }

  async function selectFollowUp(itemId: string): Promise<void> {
    if (!result || result.stale || followUps.has(itemId)) return;
    try {
      const response = await fetch("/api/reference/model/follow-up", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          followUpRequestId: requestId("model-follow-up"),
          encounterId,
          referenceId: result.referenceId,
          itemId,
          expectedUpdatedAt,
        }),
      });
      if (!response.ok) throw new Error("failed");
      setFollowUps((current) => new Set([...current, itemId]));
    } catch {
      setError("加入复核失败，请重试。");
    }
  }

  const visibleCitations = result === undefined ? [] : uniqueVisibleCitations(result.citations);

  return (
    <section
      aria-label={fixedMode ? undefined : "AI参考"}
      aria-labelledby={fixedMode ? "embedded-model-reference-title" : undefined}
      className={styles.modelReferenceSurface}
    >
      {!fixedMode && (
        <fieldset aria-label="资料参考" className={styles.documentChooser}>
          <div className={styles.documentChooserHeader}>
            <span className={styles.documentChooserLabel}>资料参考</span>
            {literatureHref !== undefined && (
              <Link className={styles.documentImportLink} href={literatureHref}>导入资料</Link>
            )}
          </div>
          {availableDocuments.length === 0 ? (
            <p className={styles.modelReferenceEmpty}>暂无资料</p>
          ) : availableDocuments.map((document) => (
            <label className={styles.documentChoice} key={document.documentId}>
              <input
                checked={selectedDocumentIds.includes(document.documentId)}
                onChange={() => toggleDocument(document.documentId)}
                type="checkbox"
              />
              <span>{document.displayName} · 第 {document.version} 版</span>
            </label>
          ))}
        </fieldset>
      )}

      {fixedMode && <h3 className={styles.modelReferenceTitle} id="embedded-model-reference-title">AI参考</h3>}

      <button
        className={styles.caseReferenceButton}
        disabled={pending}
        onClick={() => { void generateWithQuestion(CASE_OVERVIEW_QUESTION); }}
        type="button"
      >
        {pending ? "生成中" : "病例参考"}
      </button>

      <form className={styles.modelReferenceForm} onSubmit={submitQuestion}>
        <label htmlFor={`model-reference-question-${fixedMode ? "grounded" : "main"}`}>具体问题</label>
        <textarea
          id={`model-reference-question-${fixedMode ? "grounded" : "main"}`}
          maxLength={200}
          onChange={(event) => {
            setQuestion(event.currentTarget.value);
            setQuestionEdited(true);
          }}
          placeholder={!fixedMode && selectedCount > 0 && !questionEdited ? "输入需要结合资料的问题" : undefined}
          value={question}
        />
        <button className={styles.literatureParseButton} disabled={pending || !canSubmitReferenceQuestion(question)} type="submit">
          {pending ? "生成中" : "提问"}
        </button>
      </form>

      {error !== undefined && <p aria-live="polite" className={styles.importFailure} role="alert">{error}</p>}
      {notice === "INSUFFICIENT" && (
        <p aria-live="polite" className={styles.modelReferenceEmpty}>资料不足，可补充资料；如需联网检索，请另行授权。本次未联网。</p>
      )}

      {result !== undefined && (
        <div className={styles.modelReferenceResult}>
          {result.stale && <p aria-live="polite" className={styles.importFailure}>病历或资料已更新，请重新生成。</p>}
          <section aria-labelledby={`reference-direction-${result.referenceId}`} className={styles.modelReferenceSection}>
            <ResultHeading fixedMode={fixedMode} id={`reference-direction-${result.referenceId}`}>诊疗建议</ResultHeading>
            <ItemList items={group(result.items, "CONSIDERATION_DIRECTION")} />
          </section>

          <section aria-labelledby={`reference-verify-${result.referenceId}`} className={styles.modelReferenceSection}>
            <ResultHeading fixedMode={fixedMode} id={`reference-verify-${result.referenceId}`}>待核实</ResultHeading>
            <ItemList items={group(result.items, "NEEDS_VERIFICATION")} />
            {!result.stale && group(result.items, "NEEDS_VERIFICATION").map((item) => (
              <button className={styles.followUpButton} disabled={followUps.has(item.id)} key={`followup-${item.id}`} onClick={() => { void selectFollowUp(item.id); }} type="button">
                {followUps.has(item.id) ? "已加入复核" : "加入复核"}
              </button>
            ))}
          </section>

          <section aria-labelledby={`reference-checks-${result.referenceId}`} className={styles.modelReferenceSection}>
            <ResultHeading fixedMode={fixedMode} id={`reference-checks-${result.referenceId}`}>建议检查</ResultHeading>
            <ItemList items={group(result.items, "ADDITIONAL_CHECK_OR_SOURCE")} />
          </section>

          <section aria-labelledby={`reference-citations-${result.referenceId}`} className={styles.modelReferenceSection}>
            <ResultHeading fixedMode={fixedMode} id={`reference-citations-${result.referenceId}`}>参考来源</ResultHeading>
            <p className={styles.modelReferenceEmpty}>当前病历 · 第 {result.revisionNumber} 版</p>
            {result.kind === "LITERATURE_GROUNDED" && visibleCitations.length > 0 ? (
              <ul className={styles.modelReferenceList}>
                {visibleCitations.map((citation) => (
                  <li data-testid="reference-source" key={`${citation.displayName}-${citation.version}-${citation.locationLabel}-${citation.quote}`}>
                    <strong>{citation.displayName} · 第 {citation.version} 版 · {citation.locationLabel}</strong>：{citation.quote}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.modelReferenceEmpty}>{result.kind === "GENERAL" ? "未选资料" : "暂无文献引用。"}</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
