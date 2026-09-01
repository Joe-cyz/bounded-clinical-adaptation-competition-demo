import {
  getAvailableLiteratureDocumentWorkspaceItems,
  getLiteratureDocumentParseStatuses,
  getLiteratureWorkspaceView,
  referenceAccessMessage,
} from "@/application/reference-service";
import type {
  LiteratureDocumentWorkspaceItem,
  LiteratureWorkspaceView,
} from "@/domain/reference";
import type { LiteratureParseStatus } from "@/domain/literature-parsing";
import {
  LiteratureWorkspace,
  ReferenceAccessError,
} from "@/components/reference-workspace";
import { getDatabase } from "@/server/database";
import { getPhysicianPatientDisplayName } from "@/application/physician-patient-display-name";
import type { DatabaseSync } from "node:sqlite";

export const dynamic = "force-dynamic";

type LiteratureWorkspaceDocument = LiteratureDocumentWorkspaceItem & {
  parseStatus: LiteratureParseStatus;
};

export default async function LiteraturePage({
  params,
}: {
  params: Promise<{ encounterId: string }>;
  }) {
  const { encounterId } = await params;
  // Keep the read-only page gate independent from Provider configuration.
  const runtimeMode = process.env.APP_RUNTIME_MODE === "local-research" ? "local-research" : "public-demo";
  let view: LiteratureWorkspaceView | undefined;
  let patientDisplayName: string | undefined;
  let database: DatabaseSync | undefined;
  let documents: LiteratureWorkspaceDocument[] = [];
  let loadError: unknown;
  try {
    database = runtimeMode === "local-research" ? getDatabase() : undefined;
    view = getLiteratureWorkspaceView(encounterId, {
      runtimeMode,
      ...(database === undefined ? {} : { database }),
    });
    patientDisplayName = getPhysicianPatientDisplayName(encounterId, database);
    if (database !== undefined) {
      const availableDocuments = getAvailableLiteratureDocumentWorkspaceItems({ runtimeMode, database });
      const parseStatuses = getLiteratureDocumentParseStatuses({ runtimeMode, database });
      documents = availableDocuments.map((document) => ({
        ...document,
        parseStatus: parseStatuses[document.documentId] ?? "PENDING",
      }));
    }
  } catch (error) {
    loadError = error;
  }
  if (view !== undefined && patientDisplayName !== undefined) {
    return <LiteratureWorkspace documents={documents} patientDisplayName={patientDisplayName} view={view} />;
  }
  return (
    <ReferenceAccessError
      encounterId={encounterId}
      message={referenceAccessMessage(loadError, runtimeMode)}
      mode={runtimeMode}
    />
  );
}
