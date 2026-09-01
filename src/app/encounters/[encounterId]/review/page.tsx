import {
  getPreSignReviewView,
  reviewAccessMessage,
} from "@/application/pre-sign-review-service";
import type { PreSignReviewPageView } from "@/domain/pre-sign-review";
import {
  PreSignReviewWorkspace,
  ReviewAccessError,
} from "@/components/pre-sign-review-workspace";
import { getDatabase } from "@/server/database";
import { readRuntimeConfig } from "@/server/runtime-config";
import { getPhysicianPatientDisplayName } from "@/application/physician-patient-display-name";
import type { DatabaseSync } from "node:sqlite";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ encounterId: string }> }) {
  const { encounterId } = await params;
  const runtimeMode = readRuntimeConfig().runtimeMode;
  let view: PreSignReviewPageView | undefined;
  let patientDisplayName: string | undefined;
  let database: DatabaseSync | undefined;
  let loadError: unknown;
  try {
    database = runtimeMode === "local-research" ? getDatabase() : undefined;
    view = getPreSignReviewView(encounterId, {
      runtimeMode,
      ...(database === undefined ? {} : { database }),
    });
    patientDisplayName = getPhysicianPatientDisplayName(encounterId, database);
  } catch (error) {
    loadError = error;
  }
  if (view !== undefined && patientDisplayName !== undefined) {
    return <PreSignReviewWorkspace patientDisplayName={patientDisplayName} view={view} />;
  }
  return (
    <ReviewAccessError
      encounterId={encounterId}
      message={reviewAccessMessage(loadError, runtimeMode)}
      mode={runtimeMode}
    />
  );
}
