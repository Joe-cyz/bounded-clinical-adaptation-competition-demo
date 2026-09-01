"use client";

import { useState } from "react";

import type { LiteratureDocumentWorkspaceItem } from "@/domain/reference";
import type {
  LiteratureCitationDto,
  LiteratureSearchResponse,
} from "@/domain/literature-parsing";
import type { LiteratureParseStatus } from "@/domain/literature-parsing";

import styles from "./reference-workspace.module.css";
import { ModelReferenceWorkspace } from "./model-reference-workspace";

type WorkspaceDocument = LiteratureDocumentWorkspaceItem & {
  parseStatus: LiteratureParseStatus;
};

function locationLabel(citation: LiteratureCitationDto): string {
  return citation.location.kind === "PDF_PAGE"
    ? `第 ${citation.location.pageNumber} 页`
    : `第 ${citation.location.startLine}—${citation.location.endLine} 行`;
}

function resultLocation(citation: LiteratureCitationDto): string {
  if (citation.location.kind === "PDF_PAGE") {
    return `PDF 第 ${citation.location.pageNumber} 页，页内字符 ${citation.location.startCodePoint}—${citation.location.endCodePoint}`;
  }
  return `TXT 第 ${citation.location.startLine}—${citation.location.endLine} 行`;
}

export function LiteratureRetrievalWorkspace({
  documents,
  encounterId,
  encounterLabel,
  expectedUpdatedAt,
  expectedCurrentRecordRevisionId,
}: {
  documents: WorkspaceDocument[];
  encounterId: string;
  encounterLabel: string;
  expectedUpdatedAt: string;
  expectedCurrentRecordRevisionId: string;
}) {
  const readyDocuments = documents.filter((document) => document.parseStatus === "READY");
  const readyDocumentIds = new Set(readyDocuments.map((document) => document.documentId));
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>(() => readyDocuments.slice(0, 1).map((document) => document.documentId));
  const activeSelectedDocumentIds = selectedDocumentIds.filter((documentId) => readyDocumentIds.has(documentId));
  const selectedForSearch = activeSelectedDocumentIds.length > 0
    ? activeSelectedDocumentIds
    : readyDocuments.slice(0, 1).map((document) => document.documentId);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<LiteratureSearchResponse>();
  const [error, setError] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [documentsExpanded, setDocumentsExpanded] = useState(false);

  function toggleDocument(documentId: string): void {
    setSelectedDocumentIds((current) => {
      if (current.includes(documentId)) return current.filter((id) => id !== documentId);
      if (current.length >= 3) return current;
      return [...current, documentId];
    });
    setResponse(undefined);
    setError(undefined);
  }

  async function submitSearch(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (searching || selectedForSearch.length === 0 || query.trim().length === 0) return;
    setSearching(true);
    setResponse(undefined);
    setError(undefined);
    try {
      const result = await fetch("/api/literature/search", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encounterId, query, documentIds: selectedForSearch }),
      });
      const payload = await result.json() as LiteratureSearchResponse | { errorCode?: string };
      if (!result.ok || !("status" in payload) || !Array.isArray(payload.results)) throw new Error("search failed");
      setResponse(payload);
    } catch {
      setError("检索未完成，请检查所选资料后重试。");
    } finally {
      setSearching(false);
    }
  }

  if (readyDocuments.length === 0) {
    return (
      <section aria-label="文献检索说明" className={styles.searchDeferred}>
        <p className={styles.searchDeferredText}>资料解析完成后可用。</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="literature-search-title" className={styles.searchSurface}>
      <div className={styles.sectionHeading}>
        <h2 id="literature-search-title">资料检索</h2>
      </div>
      <div className={styles.documentSelectionControl}>
        <span className={styles.documentSelectionStatus}>已选 {selectedForSearch.length} 份</span>
        <button
          aria-controls="literature-document-choices"
          aria-expanded={documentsExpanded}
          className={styles.documentSelectionToggle}
          onClick={() => setDocumentsExpanded((current) => !current)}
          type="button"
        >
          {documentsExpanded ? "收起" : "选择资料"}
        </button>
      </div>
      {documentsExpanded && (
        <fieldset className={styles.documentChooser} id="literature-document-choices">
          <legend>资料参考</legend>
          {readyDocuments.map((document) => (
            <label className={styles.documentChoice} key={document.documentId}>
              <input
                checked={selectedForSearch.includes(document.documentId)}
                onChange={() => toggleDocument(document.documentId)}
                type="checkbox"
              />
              <span>{document.displayName} · 第 {document.version} 版</span>
            </label>
          ))}
        </fieldset>
      )}
      <form className={styles.searchForm} onSubmit={(event) => { void submitSearch(event); }}>
        <label htmlFor="literature-query">问题</label>
        <div className={styles.searchControls}>
          <input
            id="literature-query"
            maxLength={200}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="输入问题或关键词"
            value={query}
          />
          <button className={styles.literatureParseButton} disabled={searching || selectedForSearch.length === 0 || query.trim().length === 0} type="submit">
            {searching ? "检索中" : "检索"}
          </button>
        </div>
      </form>
      {error !== undefined && <p aria-live="polite" className={styles.importFailure} role="alert">{error}</p>}
      {response?.status === "INSUFFICIENT_EVIDENCE" && (
         <p aria-live="polite" className={styles.searchEmpty}>资料不足，可补充资料；如需联网检索，请另行授权。本次未联网。</p>
      )}
      {response?.status === "RESULTS" && (
        <>
          <ol aria-label="文献检索结果" className={styles.searchResultList}>
            {response.results.map((result) => (
              <li className={styles.searchResult} key={result.citation.fragmentId}>
                <div className={styles.searchResultHeading}>
                  <strong>{result.citation.displayName}</strong>
                  <span>第 {result.citation.version} 版 · {locationLabel(result.citation)}</span>
                </div>
                <p>{result.citation.excerpt}</p>
                <details>
                   <summary>查看来源</summary>
                  <dl className={styles.citationDetails}>
                    <div><dt>接诊</dt><dd>{encounterLabel}</dd></div>
                    <div><dt>资料版本</dt><dd>{result.citation.displayName} · 第 {result.citation.version} 版</dd></div>
                    <div><dt>定位</dt><dd>{resultLocation(result.citation)}</dd></div>
                    <div><dt>原文摘录</dt><dd>{result.citation.excerpt}</dd></div>
                  </dl>
                </details>
              </li>
            ))}
          </ol>
          <ModelReferenceWorkspace
             fixedDocumentIds={selectedForSearch}
            encounterId={encounterId}
            expectedCurrentRecordRevisionId={expectedCurrentRecordRevisionId}
            expectedUpdatedAt={expectedUpdatedAt}
            initialQuestion={query}
          />
        </>
      )}
    </section>
  );
}
