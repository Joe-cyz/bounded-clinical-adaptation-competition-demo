import Link from "next/link";

import type {
  LiteratureDocumentWorkspaceItem,
  LiteratureWorkspaceView,
  ReferenceView,
} from "@/domain/reference";
import type { ModelReferenceView } from "@/application/model-reference-service";
import type { LiteratureParseStatus } from "@/domain/literature-parsing";
import type { AiReferenceDocumentOption } from "./model-reference-workspace";

import { LiteratureImportWorkspace } from "./literature-import-workspace";
import { LiteratureRetrievalWorkspace } from "./literature-retrieval-workspace";
import { ModelReferenceWorkspace } from "./model-reference-workspace";
import { ReferenceSummary } from "./reference-summary";
import { ReviewEntryForm } from "./review-entry-form";
import styles from "./reference-workspace.module.css";

type LiteratureWorkspaceDocument = LiteratureDocumentWorkspaceItem & {
  parseStatus: LiteratureParseStatus;
};

function ContextHeader({
  patientDisplayName,
  title,
  subtitle,
}: {
  patientDisplayName: string;
  title: string;
  subtitle: string;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.contextLine}>
        <strong>{patientDisplayName}</strong>
        <span className={styles.syntheticBadge}>合成病例</span>
        <span className={styles.readOnlyBadge}>只读</span>
      </div>
      <p className={styles.eyebrow}>当前接诊</p>
      <h1>{title}</h1>
      <p className={styles.pageSubtitle}>{subtitle}</p>
    </header>
  );
}

function ReferenceActions({ view }: { view: ReferenceView }) {
  return (
    <nav aria-label="AI参考操作" className={styles.actions}>
      <Link className={styles.secondaryButton} href={`/encounters/${view.encounterId}/record`}>
        返回病历
      </Link>
      {view.mode === "public-demo" ? (
        <Link className={styles.primaryButton} href={`/encounters/${view.encounterId}/review`}>
          进入诊疗复核
        </Link>
      ) : (
        <ReviewEntryForm
          encounterId={view.encounterId}
          currentRecordRevisionId={view.currentRecordRevisionId}
          expectedUpdatedAt={view.expectedUpdatedAt}
        />
      )}
    </nav>
  );
}

export function ReferenceWorkspace({
  availableDocuments,
  initialGeneralReference,
  literatureHref,
  patientDisplayName,
  view,
}: {
  availableDocuments: AiReferenceDocumentOption[];
  initialGeneralReference?: ModelReferenceView;
  literatureHref: string;
  patientDisplayName: string;
  view: ReferenceView;
}) {
  const { encounter, summary } = view;

  return (
    <main className={styles.page}>
      <ContextHeader
        patientDisplayName={patientDisplayName}
        subtitle="基于当前病历生成建议，可选资料。"
        title="AI参考"
      />

      <div className={styles.contextGrid} aria-label="接诊上下文">
        <div><span>专科</span><strong>{encounter.specialty}</strong></div>
        <div><span>就诊类型</span><strong>{encounter.visitType}</strong></div>
        <div><span>病历修订</span><strong>第 {encounter.revisionNumber} 版</strong></div>
      </div>

      {view.mode === "local-research" && (
        <ModelReferenceWorkspace
          availableDocuments={availableDocuments}
          encounterId={view.encounterId}
          expectedCurrentRecordRevisionId={view.currentRecordRevisionId}
          expectedUpdatedAt={view.expectedUpdatedAt}
          initialResult={initialGeneralReference}
          literatureHref={literatureHref}
        />
      )}

      <section aria-labelledby="record-summary-title" className={styles.surface}>
        <div className={styles.sectionHeading}>
          <h2 id="record-summary-title">病历摘要</h2>
        </div>
        <ReferenceSummary summary={summary} />
      </section>

      {view.mode === "public-demo" && (
        <section aria-labelledby="literature-entry-title" className={`${styles.surface} ${styles.literatureSurface}`}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>资料入口</p>
              <h2 id="literature-entry-title">资料</h2>
            </div>
            <span className={styles.pendingStatus}>尚未导入</span>
          </div>
          <p className={styles.sectionCopy}>本地资料导入仅在本地模式开放。</p>
          <Link className={styles.inlinePrimaryButton} href={literatureHref}>
            进入资料
          </Link>
        </section>
      )}

      <ReferenceActions view={view} />
    </main>
  );
}

function LiteraturePageHeader({ view, patientDisplayName }: { view: LiteratureWorkspaceView; patientDisplayName: string }) {
  const isPublicDemo = view.mode === "public-demo";
  return (
    <header className={styles.pageHeader}>
      <div className={styles.contextLine}>
        <strong>{patientDisplayName}</strong>
        <span className={styles.syntheticBadge}>合成病例</span>
        <span className={isPublicDemo ? styles.readOnlyBadge : styles.localLiteratureBadge}>
          {isPublicDemo ? "公开演示 · 只读" : "仅限本地比赛原型"}
        </span>
      </div>
      <h1>资料</h1>
      <p className={styles.pageSubtitle}>
        {isPublicDemo ? "本地资料导入仅在本地模式开放。" : "导入或检索本地资料。"}
      </p>
    </header>
  );
}

export function LiteratureWorkspace({
  documents,
  patientDisplayName,
  view,
}: {
  documents: LiteratureWorkspaceDocument[];
  patientDisplayName: string;
  view: LiteratureWorkspaceView;
}) {
  if (view.mode === "public-demo") {
    return (
      <main className={styles.page}>
        <LiteraturePageHeader patientDisplayName={patientDisplayName} view={view} />
        <section aria-labelledby="literature-public-title" className={styles.emptyState}>
          <p className={styles.eyebrow}>资料状态</p>
          <h2 id="literature-public-title">本地资料导入仅在本地模式开放</h2>
        </section>
        <nav aria-label="文献资料操作" className={styles.actions}>
          <Link className={styles.secondaryButton} href={`/encounters/${view.encounterId}/reference`}>
            返回AI参考
          </Link>
          <div className={styles.actionGroup}>
            <Link className={styles.secondaryButton} href={`/encounters/${view.encounterId}/record`}>
              返回病历
            </Link>
            <Link className={styles.primaryButton} href={`/encounters/${view.encounterId}/review`}>
              进入诊疗复核
            </Link>
          </div>
        </nav>
      </main>
    );
  }

  const hasReadyLiterature = documents.some((document) => document.parseStatus === "READY");
  const retrievalWorkspace = (
    <LiteratureRetrievalWorkspace
      documents={documents}
      encounterId={view.encounterId}
      encounterLabel={patientDisplayName}
      expectedCurrentRecordRevisionId={view.currentRecordRevisionId}
      expectedUpdatedAt={view.expectedUpdatedAt}
    />
  );
  const importWorkspace = <LiteratureImportWorkspace initialDocuments={documents} />;

  return (
    <main className={styles.page}>
      <LiteraturePageHeader patientDisplayName={patientDisplayName} view={view} />
      {hasReadyLiterature ? (
        <>
          {retrievalWorkspace}
          {importWorkspace}
        </>
      ) : (
        <>
          {importWorkspace}
          {retrievalWorkspace}
        </>
      )}

      <nav aria-label="文献资料操作" className={styles.actions}>
        <Link className={styles.secondaryButton} href={`/encounters/${view.encounterId}/reference`}>
          返回AI参考
        </Link>
        <div className={styles.actionGroup}>
          <Link className={styles.secondaryButton} href={`/encounters/${view.encounterId}/record`}>
            返回病历
          </Link>
          <ReviewEntryForm
            encounterId={view.encounterId}
            currentRecordRevisionId={view.currentRecordRevisionId}
            expectedUpdatedAt={view.expectedUpdatedAt}
          />
        </div>
      </nav>
    </main>
  );
}

export function ReferenceAccessError({
  encounterId,
  message,
  mode,
}: {
  encounterId: string;
  message: string;
  mode: "public-demo" | "local-research";
}) {
  return (
    <main className={styles.page}>
      <ContextHeader
        patientDisplayName={mode === "public-demo" ? "患者1" : "当前接诊"}
        subtitle="页面没有执行状态推进或写入。"
        title="当前页面无法打开"
      />
      <section aria-live="polite" className={styles.errorState} role="alert">
        <h2>AI参考暂不可用</h2>
        <p>{message}</p>
      </section>
      <nav aria-label="返回操作" className={styles.actions}>
        <Link className={styles.secondaryButton} href={mode === "public-demo" ? "/encounters/demo/record" : `/encounters/${encounterId}/record`}>
          返回病历
        </Link>
        {mode === "local-research" && (
          <Link className={styles.primaryButton} href="/encounters/new">
            返回接诊入口
          </Link>
        )}
      </nav>
    </main>
  );
}
