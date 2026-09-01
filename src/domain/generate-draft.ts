import {
  generatedDraftSchema,
  type GeneratedDraft,
  type SyntheticCase,
} from "./schemas";
import type { EffectiveGenerationConfig } from "./effective-config";
import { projectCanonicalDraftSections } from "./draft-projection";
import { validateGeneratedDraft } from "./safety-core";

export function generateDraft(
  caseData: SyntheticCase,
  config: EffectiveGenerationConfig,
  runId: string,
): GeneratedDraft {
  if (
    config.caseRef.id !== caseData.id
    || config.caseRef.version !== caseData.version
    || config.caseRef.specialty !== caseData.specialty
    || config.caseRef.visitType !== caseData.visitType
  ) {
    throw new Error("Generated draft configuration does not match the selected case.");
  }

  const sections = projectCanonicalDraftSections(caseData, config);

  const draft = generatedDraftSchema.parse({
    runId,
    mode: config.mode,
    caseId: caseData.id,
    caseVersion: caseData.version,
    safetyCoreVersion: config.safetyCoreRef.version,
    policyId: config.policyRef.id,
    policyVersion: config.policyRef.version,
    configurationKey: config.configurationKey,
    physicianProfileVersion: config.profileRef?.version,
    sections,
  });

  const validation = validateGeneratedDraft(draft, { caseData, config });
  if (!validation.ok) {
    throw new Error(`Draft failed output validation: ${validation.issues.map((issue) => issue.ruleId).join(", ")}`);
  }

  return draft;
}
