import {
  getAvailableLiteratureDocumentWorkspaceItems,
  getLiteratureDocumentParseStatuses,
  getReferenceView,
  referenceAccessMessage,
} from "@/application/reference-service";
import { createModelReferenceService, type ModelReferenceView } from "@/application/model-reference-service";
import type { ReferenceView } from "@/domain/reference";
import {
  ReferenceAccessError,
  ReferenceWorkspace,
} from "@/components/reference-workspace";
import type { AiReferenceDocumentOption } from "@/components/model-reference-workspace";
import { getDatabase } from "@/server/database";
import { createClinicalReferenceProvider, createLiteratureAnswerProvider } from "@/infrastructure/providers/model-reference-provider";
import { getPhysicianPatientDisplayName } from "@/application/physician-patient-display-name";
import type { DatabaseSync } from "node:sqlite";

export const dynamic = "force-dynamic";

export default async function ReferencePage({ params }: { params: Promise<{ encounterId: string }> }) {
  const { encounterId } = await params;
  // Deliberately read only the app mode here. PWR-08C must never read a
  // DeepSeek credential merely to render a read-only page.
  const runtimeMode = process.env.APP_RUNTIME_MODE === "local-research" ? "local-research" : "public-demo";
  let view: ReferenceView | undefined;
  let patientDisplayName: string | undefined;
  let database: DatabaseSync | undefined;
  let initialGeneralReference: ModelReferenceView | undefined;
  let availableDocuments: AiReferenceDocumentOption[] = [];
  let loadError: unknown;
  try {
    database = runtimeMode === "local-research" ? getDatabase() : undefined;
    view = getReferenceView(encounterId, {
      runtimeMode,
      ...(database === undefined ? {} : { database }),
    });
    patientDisplayName = getPhysicianPatientDisplayName(encounterId, database);
    if (database !== undefined) {
      const databaseForService = database;
      const documents = getAvailableLiteratureDocumentWorkspaceItems({ runtimeMode, database });
      const parseStatuses = getLiteratureDocumentParseStatuses({ runtimeMode, database });
      availableDocuments = documents
        .filter((document) => parseStatuses[document.documentId] === "READY")
        .map(({ documentId, displayName, version }) => ({ documentId, displayName, version }));
      initialGeneralReference = createModelReferenceService({
        databaseFactory: () => databaseForService,
        runtimeMode,
        clinicalProvider: createClinicalReferenceProvider(),
        literatureProvider: createLiteratureAnswerProvider(),
      }).getLatestForEncounter(encounterId, "GENERAL");
    }
  } catch (error) {
    loadError = error;
  }
  if (view !== undefined && patientDisplayName !== undefined) {
    return (
      <ReferenceWorkspace
        availableDocuments={availableDocuments}
        initialGeneralReference={initialGeneralReference}
        literatureHref={`/encounters/${encounterId}/reference/literature`}
        patientDisplayName={patientDisplayName}
        view={view}
      />
    );
  }
  return (
    <ReferenceAccessError
      encounterId={encounterId}
      message={referenceAccessMessage(loadError, runtimeMode)}
      mode={runtimeMode}
    />
  );
}
