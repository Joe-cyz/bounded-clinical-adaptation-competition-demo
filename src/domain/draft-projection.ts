import type { EffectiveGenerationConfig } from "./effective-config";
import {
  generatedDraftSchema,
  type DraftSection,
  type GeneratedDraft,
  type ProviderDraftEnvelope,
  type SectionKey,
  type SyntheticCase,
} from "./schemas";

export const draftSectionTitles: Readonly<Record<SectionKey, string>> = {
  summary: "就诊摘要",
  problems: "已提供的问题列表",
  recentChanges: "近期变化",
  allergies: "过敏史",
  currentMedications: "当前用药",
  redFlags: "危险信号核查",
  missingInformation: "缺失或待确认信息",
  patientEducation: "患者沟通草稿",
  draftDisclaimer: "使用边界",
};

function explicitList(values: readonly string[], emptyLabel: string): string[] {
  return values.length > 0 ? [...values] : [emptyLabel];
}

/**
 * Produces the P0 deterministic section projection used by both the Mock
 * generator and the post-generation fact-boundary validator.
 */
export function projectCanonicalDraftSections(
  caseData: SyntheticCase,
  config: EffectiveGenerationConfig,
): DraftSection[] {
  const mandatory = new Set<SectionKey>(config.safety.mandatoryFields);
  const contentByKey: Readonly<Record<SectionKey, string[]>> = {
    summary: [caseData.patientSummary, `主诉/关注点：${caseData.chiefConcern}`],
    problems: explicitList(caseData.providedProblems, "未提供问题列表"),
    recentChanges: explicitList(caseData.recentChanges, "未提供近期变化"),
    allergies: explicitList(caseData.allergies, "未提供过敏史，需人工确认"),
    currentMedications: explicitList(caseData.currentMedications, "未提供当前用药，需人工确认"),
    redFlags: explicitList(caseData.redFlags, "未报告预设危险信号；仍需人工核查"),
    missingInformation: explicitList(caseData.missingInformation, "当前结构化病例未标记缺失项"),
    patientEducation: explicitList(caseData.patientEducationFacts, "暂无患者教育要点"),
    draftDisclaimer: [config.safety.draftDisclaimer],
  };

  return config.sectionOrder.map((key) => ({
    key,
    title: draftSectionTitles[key],
    content: [...contentByKey[key]],
    mandatory: mandatory.has(key),
  }));
}

/**
 * Adds only server-trusted metadata to a provider section envelope. The
 * provider's keys/order/content are preserved exactly so the existing output
 * safety validator can reject missing, duplicate, reordered or unsafe values.
 */
export function assembleCanonicalGeneratedDraft(
  envelope: ProviderDraftEnvelope,
  input: {
    runId: string;
    caseData: SyntheticCase;
    config: EffectiveGenerationConfig;
  },
): GeneratedDraft | undefined {
  const canonicalSections = projectCanonicalDraftSections(input.caseData, input.config);
  const canonicalByKey = new Map(canonicalSections.map((section) => [section.key, section]));
  const sections = envelope.sections.map((section) => {
    const canonical = canonicalByKey.get(section.key);
    if (!canonical) return undefined;
    return {
      key: section.key,
      title: canonical.title,
      content: [...section.content],
      mandatory: canonical.mandatory,
    };
  });
  if (sections.some((section) => section === undefined)) return undefined;

  const parsed = generatedDraftSchema.safeParse({
    runId: input.runId,
    mode: input.config.mode,
    caseId: input.caseData.id,
    caseVersion: input.caseData.version,
    safetyCoreVersion: input.config.safetyCoreRef.version,
    policyId: input.config.policyRef.id,
    policyVersion: input.config.policyRef.version,
    configurationKey: input.config.configurationKey,
    ...(input.config.profileRef ? { physicianProfileVersion: input.config.profileRef.version } : {}),
    sections,
  });
  return parsed.success ? parsed.data : undefined;
}
