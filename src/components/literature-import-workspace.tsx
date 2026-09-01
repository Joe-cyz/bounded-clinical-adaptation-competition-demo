"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { LiteratureDocumentWorkspaceItem } from "@/domain/reference";
import type { LiteratureParseStatus } from "@/domain/literature-parsing";

import {
  createLiteratureRequestId,
  formatLiteratureSize,
  friendlyImportFailure,
  type SelectedLiteratureFile,
  validateLiteratureSelection,
} from "./literature-import-client";
import styles from "./reference-workspace.module.css";

type ImportPhase = "idle" | "importing" | "completed" | "failed" | "cancelled";

type ImportRun = {
  controller: AbortController;
  batchId?: string;
  cancelled: boolean;
  deleteSent: boolean;
};

type CreateBatchResponse = {
  ok: true;
  batchId: string;
  items: Array<{ itemId: string; clientFileId: string }>;
};

type WorkspaceDocument = LiteratureDocumentWorkspaceItem & {
  parseStatus: LiteratureParseStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readSuccess(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("literature import request failed");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.ok !== true) throw new Error("literature import response was rejected");
  return payload;
}

function createResponse(value: Record<string, unknown>): CreateBatchResponse | undefined {
  if (typeof value.batchId !== "string" || !Array.isArray(value.items)) return undefined;
  const items = value.items.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.itemId !== "string"
      || typeof candidate.clientFileId !== "string") return undefined;
    return { itemId: candidate.itemId, clientFileId: candidate.clientFileId };
  });
  if (items.some((item) => item === undefined)) return undefined;
  return { ok: true, batchId: value.batchId, items: items as Array<{ itemId: string; clientFileId: string }> };
}

function formatImportedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(new Date(value));
}

function parseStatusLabel(document: WorkspaceDocument): string {
  if (document.parseStatus === "READY") return "可使用";
  if (document.parseStatus === "PARSING") return "解析中";
  if (document.parseStatus === "FAILED") return "解析失败";
  return document.pendingStatus;
}

export function LiteratureImportWorkspace({
  initialDocuments,
}: {
  initialDocuments: WorkspaceDocument[];
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runRef = useRef<ImportRun | undefined>(undefined);
  const startLockRef = useRef(false);
  const [selectedFiles, setSelectedFiles] = useState<SelectedLiteratureFile[]>([]);
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [message, setMessage] = useState<string>();
  const [parseStatusByDocument, setParseStatusByDocument] = useState<Record<string, LiteratureParseStatus>>(
    () => ({}),
  );
  const [parsingDocumentId, setParsingDocumentId] = useState<string>();
  const [parseMessage, setParseMessage] = useState<string>();

  const importing = phase === "importing";
  const hasSelectedFiles = selectedFiles.length > 0;
  const hasImportedDocuments = initialDocuments.length > 0;
  const hasReadyDocuments = initialDocuments.some((document) => (
    (parseStatusByDocument[document.documentId] ?? document.parseStatus) === "READY"
  ));

  useEffect(() => () => {
    runRef.current?.controller.abort();
  }, []);

  function resetFileInput(): void {
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function selectFiles(): void {
    if (importing) return;
    fileInputRef.current?.click();
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    if (importing) return;
    const result = validateLiteratureSelection(event.currentTarget.files ?? []);
    if (!result.ok) {
      setSelectedFiles([]);
      setPhase("idle");
      setMessage(result.message);
      resetFileInput();
      return;
    }
    setSelectedFiles(result.files);
    setPhase("idle");
    setMessage(undefined);
  }

  function isCurrentRun(run: ImportRun): boolean {
    return runRef.current === run && !run.cancelled;
  }

  async function cancelKnownBatchOnce(run: ImportRun): Promise<void> {
    if (!run.batchId || run.deleteSent) return;
    run.deleteSent = true;
    try {
      await fetch(`/api/literature/import-batches/${encodeURIComponent(run.batchId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
    } catch {
      // The server owns cleanup for failed and aborted streams. Never retry here.
    }
  }

  function markCancelled(run: ImportRun): void {
    run.cancelled = true;
    run.controller.abort();
    setPhase("cancelled");
    setMessage("已取消本次导入。");
    setSelectedFiles([]);
    resetFileInput();
    void cancelKnownBatchOnce(run);
  }

  function cancelImport(): void {
    const run = runRef.current;
    if (!run || !importing) return;
    markCancelled(run);
  }

  async function startImport(): Promise<void> {
    if (startLockRef.current || importing || selectedFiles.length === 0) return;
    startLockRef.current = true;
    const run: ImportRun = { controller: new AbortController(), cancelled: false, deleteSent: false };
    runRef.current = run;
    setPhase("importing");
    setMessage("正在安全导入资料，请稍候。已选择的资料将依次处理。");

    try {
      const creationResponse = await fetch("/api/literature/import-batches", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: run.controller.signal,
        body: JSON.stringify({
          requestId: createLiteratureRequestId(),
          files: selectedFiles.map((selection) => ({
            clientFileId: selection.clientFileId,
            originalFilename: selection.file.name,
            declaredExtension: selection.declaredExtension,
            declaredMime: selection.declaredMime,
            expectedSizeBytes: selection.file.size,
            intent: "CREATE_DOCUMENT",
          })),
        }),
      });
      const creation = createResponse(await readSuccess(creationResponse));
      if (!creation || creation.items.length !== selectedFiles.length) throw new Error("invalid create response");
      run.batchId = creation.batchId;
      if (!isCurrentRun(run)) {
        await cancelKnownBatchOnce(run);
        return;
      }

      const itemByClientFileId = new Map(creation.items.map((item) => [item.clientFileId, item.itemId]));
      for (const selection of selectedFiles) {
        const itemId = itemByClientFileId.get(selection.clientFileId);
        if (!itemId) throw new Error("missing upload item");
        const uploadResponse = await fetch(
          `/api/literature/import-batches/${encodeURIComponent(creation.batchId)}/files/${encodeURIComponent(itemId)}`,
          {
            method: "PUT",
            credentials: "same-origin",
            headers: { "Content-Type": selection.declaredMime },
            signal: run.controller.signal,
            body: selection.file,
          },
        );
        await readSuccess(uploadResponse);
        if (!isCurrentRun(run)) {
          await cancelKnownBatchOnce(run);
          return;
        }
      }

      const completionResponse = await fetch(
        `/api/literature/import-batches/${encodeURIComponent(creation.batchId)}/complete`,
        {
          method: "POST",
          credentials: "same-origin",
          signal: run.controller.signal,
        },
      );
      await readSuccess(completionResponse);
      if (!isCurrentRun(run)) return;

      setSelectedFiles([]);
      resetFileInput();
      setPhase("completed");
      setMessage("资料已安全导入，等待后续解析。");
      router.refresh();
    } catch {
      if (run.cancelled || run.controller.signal.aborted) {
        await cancelKnownBatchOnce(run);
        return;
      }
      if (runRef.current === run) {
        setSelectedFiles([]);
        resetFileInput();
        setPhase("failed");
        setMessage(friendlyImportFailure());
      }
    } finally {
      if (runRef.current === run) startLockRef.current = false;
    }
  }

  async function parseDocument(document: WorkspaceDocument): Promise<void> {
    const currentStatus = parseStatusByDocument[document.documentId] ?? document.parseStatus;
    if (parsingDocumentId !== undefined || currentStatus === "READY" || currentStatus === "PARSING") return;
    setParsingDocumentId(document.documentId);
    setParseMessage(undefined);
    setParseStatusByDocument((current) => ({ ...current, [document.documentId]: "PARSING" }));
    try {
      const response = await fetch(
        `/api/literature/documents/${encodeURIComponent(document.documentId)}/parse`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parseRequestId: `parse-${globalThis.crypto.randomUUID()}`,
          }),
        },
      );
      const payload = await response.json() as { ok?: boolean; parseStatus?: LiteratureParseStatus };
      if (!response.ok || payload.ok !== true) throw new Error("parse request failed");
      if (payload.parseStatus === "PARSING") {
        setParseStatusByDocument((current) => ({ ...current, [document.documentId]: "PARSING" }));
      } else {
        setParseStatusByDocument((current) => ({ ...current, [document.documentId]: "READY" }));
      }
      router.refresh();
    } catch {
      setParseStatusByDocument((current) => ({ ...current, [document.documentId]: "FAILED" }));
      setParseMessage("解析失败，可重新解析。");
    } finally {
      setParsingDocumentId(undefined);
    }
  }

  return (
    <>
      <section
        aria-labelledby="literature-import-title"
        className={`${styles.importSurface} ${hasReadyDocuments ? styles.importSurfaceSecondary : ""}`}
      >
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>本地资料</p>
            <h2 id="literature-import-title">导入资料</h2>
          </div>
        </div>
        <p className={styles.sectionCopy}>
          {hasImportedDocuments
            ? hasReadyDocuments
              ? "继续导入其他资料，或查看已解析资料的详细信息。"
              : "当前资料可先解析，解析完成后才能开始检索。"
            : "选择负责人提供的本地资料，导入后将在后续流程中解析。"}
        </p>
        <input
          accept=".pdf,.txt,application/pdf,text/plain"
          aria-hidden="true"
          className={styles.visuallyHidden}
          data-testid="literature-file-input"
          multiple
          onChange={handleFileChange}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
        <div className={styles.importActions}>
          {hasSelectedFiles && !importing && (
            <button className={styles.literatureStartButton} onClick={() => { void startImport(); }} type="button">
              开始导入
            </button>
          )}
          <button
            className={hasSelectedFiles
              ? styles.literatureReselectButton
              : hasImportedDocuments
                ? styles.literatureContinueButton
                : styles.literaturePrimaryButton}
            disabled={importing}
            onClick={selectFiles}
            type="button"
          >
            {hasSelectedFiles ? "重新选择" : hasImportedDocuments ? "继续导入资料" : "选择资料"}
          </button>
          {importing && (
            <button className={styles.secondaryButton} onClick={cancelImport} type="button">
              取消导入
            </button>
          )}
        </div>

        {hasSelectedFiles && (
          <ul aria-label="已选择资料" className={styles.selectedFileList}>
            {selectedFiles.map((selection) => (
              <li key={selection.clientFileId}>
                <strong>{selection.file.name}</strong>
                <span>{formatLiteratureSize(selection.file.size)}</span>
              </li>
            ))}
          </ul>
        )}

        {message !== undefined && (
          <p
            aria-live="polite"
            className={phase === "failed" ? styles.importFailure : styles.importMessage}
            role={phase === "failed" ? "alert" : undefined}
          >
            {message}
          </p>
        )}
      </section>

      <section aria-labelledby="imported-literature-title" className={styles.surface}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>资料状态</p>
            <h2 id="imported-literature-title">已导入资料</h2>
          </div>
        </div>
        {initialDocuments.length === 0 ? (
          <p className={styles.sectionCopy}>尚未导入资料。</p>
        ) : (
          <ul aria-label="已导入资料列表" className={styles.importedDocumentList}>
            {initialDocuments.map((document) => {
              const parseStatus = parseStatusByDocument[document.documentId] ?? document.parseStatus;
              const displayDocument = { ...document, parseStatus };
              return (
              <li className={styles.importedDocumentItem} key={document.documentId}>
                <div className={styles.documentSummaryRow}>
                  <div className={styles.documentSummary}>
                    <strong>{document.displayName}</strong>
                    <span className={styles.documentSummaryMeta}>第 {document.version} 版 · {document.format}</span>
                  </div>
                  <span className={parseStatus === "FAILED" ? styles.failureStatus : parseStatus === "READY" ? styles.readyStatus : styles.pendingStatus}>
                    {parseStatusLabel(displayDocument)}
                  </span>
                </div>
                <details className={styles.documentDetails}>
                  <summary>查看资料详情</summary>
                  <dl className={styles.documentMetadata}>
                    <div><dt>版本</dt><dd>第 {document.version} 版</dd></div>
                    <div><dt>格式</dt><dd>{document.format}</dd></div>
                    <div><dt>大小</dt><dd>{formatLiteratureSize(document.sizeBytes)}</dd></div>
                    <div><dt>导入时间</dt><dd>{formatImportedAt(document.importedAt)}</dd></div>
                    <div className={styles.documentSafety}><dt>资料范围</dt><dd>合成资料，仅用于本地原型测试</dd></div>
                  </dl>
                </details>
                <div className={styles.documentActions}>
                  {(parseStatus === "PENDING" || parseStatus === "FAILED") && (
                    <button
                      className={styles.literatureParseButton}
                      disabled={parsingDocumentId !== undefined}
                      onClick={() => { void parseDocument(displayDocument); }}
                      type="button"
                    >
                      {parseStatus === "FAILED" ? "重新解析" : "解析资料"}
                    </button>
                  )}
                  {parseStatus === "PARSING" && <span className={styles.importMessage}>正在解析资料，请稍候。</span>}
                </div>
              </li>
              );
            })}
          </ul>
        )}
        {parseMessage !== undefined && <p aria-live="polite" className={styles.importFailure} role="alert">{parseMessage}</p>}
      </section>
    </>
  );
}
