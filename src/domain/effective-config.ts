import {
  institutionalSafetyCoreSchema,
  physicianProfileSchema,
  specialtyVisitPolicySchema,
  syntheticCaseSchema,
  type InstitutionalSafetyCore,
  type PhysicianProfile,
  type SectionKey,
  type SpecialtyVisitPolicy,
  type SyntheticCase,
} from "./schemas";
import {
  effectiveGenerationConfigSchema,
  type EffectiveGenerationConfig,
  type EffectivePresentation,
  type EffectiveVersionSummary,
} from "./runtime-records";

export type {
  CaseReference,
  EffectiveConfigProvenance,
  EffectiveGenerationConfig,
  EffectivePresentation,
  EffectiveSafetyRules,
  EffectiveVersionSummary,
  PolicyReference,
  ProfileReference,
  VersionedReference,
} from "./runtime-records";

export const CONFIG_RULE_IDS = {
  INPUT_INVALID: "CONFIG_INPUT_INVALID",
  POLICY_REQUIRED: "CONFIG_POLICY_REQUIRED",
  POLICY_NOT_APPROVED: "CONFIG_POLICY_NOT_APPROVED",
  POLICY_MISMATCH: "CONFIG_POLICY_MISMATCH",
  POLICY_AMBIGUOUS: "CONFIG_POLICY_AMBIGUOUS",
  PROFILE_REQUIRED: "CONFIG_PROFILE_REQUIRED",
  PROFILE_INACTIVE: "CONFIG_PROFILE_INACTIVE",
  SAFETY_INVARIANT_VIOLATION: "CONFIG_SAFETY_INVARIANT_VIOLATION",
  SHARED_CONFIG_MISMATCH: "CONFIG_SHARED_CONFIG_MISMATCH",
} as const;

export type ConfigRuleId = (typeof CONFIG_RULE_IDS)[keyof typeof CONFIG_RULE_IDS];
export type ConfigMode = "GENERIC" | "BOUNDED";

export type ConfigCompilationIssue = {
  ruleId: ConfigRuleId;
  message: string;
  fieldPath?: string;
};

export type CompileEffectiveConfigInput = {
  caseData: SyntheticCase;
  safetyCore: InstitutionalSafetyCore;
  policies: readonly SpecialtyVisitPolicy[];
  datasetVersion: string;
  mode: ConfigMode;
  profile?: PhysicianProfile;
};

export type ConfigCompilationResult =
  | { ok: true; config: EffectiveGenerationConfig }
  | { ok: false; issues: ConfigCompilationIssue[] };

export type CompileComparisonConfigsInput = Omit<CompileEffectiveConfigInput, "mode">;

export type SharedVersionSummary = Omit<EffectiveVersionSummary, "profileVersion">;

export type ComparisonCompilationResult =
  | {
      ok: true;
      generic: EffectiveGenerationConfig;
      bounded: EffectiveGenerationConfig;
      sharedVersionSummary: SharedVersionSummary;
    }
  | { ok: false; issues: ConfigCompilationIssue[] };

const allSectionKeys: SectionKey[] = [
  "summary",
  "problems",
  "recentChanges",
  "allergies",
  "currentMedications",
  "redFlags",
  "missingInformation",
  "patientEducation",
  "draftDisclaimer",
];

const genericPresentation: EffectivePresentation = {
  verbosity: "STANDARD",
  expandAbbreviations: true,
  educationTone: "PLAIN",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  ruleId: ConfigRuleId,
  message: string,
  fieldPath?: string,
): ConfigCompilationResult {
  return {
    ok: false,
    issues: [{ ruleId, message, ...(fieldPath ? { fieldPath } : {}) }],
  };
}

function stableUnique(values: readonly SectionKey[]): SectionKey[] {
  const seen = new Set<SectionKey>();
  const result: SectionKey[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function validateInputShape(input: unknown): ConfigCompilationIssue[] {
  if (!isRecord(input)) {
    return [{
      ruleId: CONFIG_RULE_IDS.INPUT_INVALID,
      message: "配置编译输入必须是显式对象。",
    }];
  }

  const caseResult = syntheticCaseSchema.safeParse(input.caseData);
  const safetyResult = institutionalSafetyCoreSchema.safeParse(input.safetyCore);
  const policiesResult = specialtyVisitPolicySchema.array().safeParse(input.policies);
  const profileResult = input.profile === undefined
    ? { success: true as const }
    : physicianProfileSchema.safeParse(input.profile);
  const hasValidDatasetVersion = typeof input.datasetVersion === "string" && input.datasetVersion.trim().length > 0;
  const hasValidMode = input.mode === "GENERIC" || input.mode === "BOUNDED";

  if (isRecord(input.safetyCore) && input.safetyCore.immutableForPhysician !== true) {
    return [{
      ruleId: CONFIG_RULE_IDS.SAFETY_INVARIANT_VIOLATION,
      message: "机构安全核心必须保持 immutableForPhysician: true。",
      fieldPath: "safetyCore.immutableForPhysician",
    }];
  }

  if (!caseResult.success || !safetyResult.success || !policiesResult.success || !profileResult.success) {
    return [{
      ruleId: CONFIG_RULE_IDS.INPUT_INVALID,
      message: "配置编译输入未通过版本化合成数据 Schema。",
    }];
  }

  if (!hasValidDatasetVersion) {
    return [{
      ruleId: CONFIG_RULE_IDS.INPUT_INVALID,
      message: "配置编译需要明确的数据集版本。",
      fieldPath: "datasetVersion",
    }];
  }

  if (!hasValidMode) {
    return [{
      ruleId: CONFIG_RULE_IDS.INPUT_INVALID,
      message: "配置编译模式必须是 GENERIC 或 BOUNDED。",
      fieldPath: "mode",
    }];
  }

  return [];
}

function findEffectivePolicy(
  policies: readonly SpecialtyVisitPolicy[],
  caseData: SyntheticCase,
): { policy: SpecialtyVisitPolicy } | ConfigCompilationIssue {
  if (policies.length === 0) {
    return {
      ruleId: CONFIG_RULE_IDS.POLICY_REQUIRED,
      message: "配置编译需要至少一个显式专科策略。",
      fieldPath: "policies",
    };
  }

  const matchingPolicies = policies.filter(
    (policy) => policy.specialty === caseData.specialty && policy.visitType === caseData.visitType,
  );

  if (matchingPolicies.length === 0) {
    return {
      ruleId: CONFIG_RULE_IDS.POLICY_MISMATCH,
      message: "没有专科和接诊类型同时匹配当前病例的策略。",
      fieldPath: "policy.specialty/visitType",
    };
  }

  const approvedPolicies = matchingPolicies.filter(
    (policy) => policy.approvalStatus === "APPROVED" && policy.approvalScope === "DEMO_ONLY",
  );

  if (approvedPolicies.length === 0) {
    return {
      ruleId: CONFIG_RULE_IDS.POLICY_NOT_APPROVED,
      message: "当前病例没有 APPROVED + DEMO_ONLY 的有效策略。",
      fieldPath: "policy.approvalStatus",
    };
  }

  if (approvedPolicies.length > 1) {
    return {
      ruleId: CONFIG_RULE_IDS.POLICY_AMBIGUOUS,
      message: "当前病例匹配多个 APPROVED + DEMO_ONLY 策略，已阻断编译。",
      fieldPath: "policy.id",
    };
  }

  return { policy: approvedPolicies[0] };
}

function validateSafetyInvariant(safetyCore: InstitutionalSafetyCore): ConfigCompilationIssue | undefined {
  if (!safetyCore.immutableForPhysician) {
    return {
      ruleId: CONFIG_RULE_IDS.SAFETY_INVARIANT_VIOLATION,
      message: "机构安全核心必须保持 immutableForPhysician: true。",
      fieldPath: "safetyCore.immutableForPhysician",
    };
  }

  if (!safetyCore.mandatoryFields.includes("draftDisclaimer")) {
    return {
      ruleId: CONFIG_RULE_IDS.SAFETY_INVARIANT_VIOLATION,
      message: "机构安全核心必须将 draftDisclaimer 保持为必填项。",
      fieldPath: "safetyCore.mandatoryFields",
    };
  }

  return undefined;
}

function buildConfigurationKey(
  input: CompileEffectiveConfigInput,
  policy: SpecialtyVisitPolicy,
): string {
  const profilePart = input.mode === "BOUNDED" && input.profile
    ? `|profile=${input.profile.id}@${input.profile.version}`
    : "";

  return [
    "effective-config@1.0.0",
    `dataset=${input.datasetVersion}`,
    `case=${input.caseData.id}@${input.caseData.version}`,
    `safety=${input.safetyCore.id}@${input.safetyCore.version}`,
    `policy=${policy.id}@${policy.version}`,
    `mode=${input.mode}`,
    profilePart.slice(1),
  ].filter(Boolean).join("|");
}

function compileValidInput(input: CompileEffectiveConfigInput): ConfigCompilationResult {
  const policyResult = findEffectivePolicy(input.policies, input.caseData);
  if ("ruleId" in policyResult) {
    return { ok: false, issues: [policyResult] };
  }

  const safetyIssue = validateSafetyInvariant(input.safetyCore);
  if (safetyIssue) return { ok: false, issues: [safetyIssue] };

  if (input.mode === "BOUNDED" && !input.profile) {
    return issue(
      CONFIG_RULE_IDS.PROFILE_REQUIRED,
      "BOUNDED 配置必须显式提供医生画像。",
      "profile",
    );
  }

  if (input.mode === "BOUNDED" && input.profile?.status !== "ACTIVE" && input.profile?.status !== "FROZEN") {
    return issue(
      CONFIG_RULE_IDS.PROFILE_INACTIVE,
      "BOUNDED 配置只允许使用 ACTIVE 或 FROZEN 医生画像。",
      "profile.status",
    );
  }

  const policy = policyResult.policy;
  const requiredSections = stableUnique([
    ...input.safetyCore.mandatoryFields,
    ...policy.requiredSections,
  ]);
  const sectionOrder = stableUnique([
    ...(input.mode === "BOUNDED" && input.profile ? input.profile.preferences.sectionOrder : []),
    ...(input.mode === "GENERIC" ? policy.informationPriority : []),
    ...(input.mode === "BOUNDED" ? policy.informationPriority : []),
    ...allSectionKeys,
  ]);
  const profileRef = input.mode === "BOUNDED" && input.profile
    ? { id: input.profile.id, version: input.profile.version }
    : undefined;
  const versionSummary: EffectiveVersionSummary = {
    datasetVersion: input.datasetVersion,
    caseVersion: input.caseData.version,
    safetyCoreVersion: input.safetyCore.version,
    policyVersion: policy.version,
    ...(profileRef ? { profileVersion: profileRef.version } : {}),
  };

  const candidate = {
      schemaVersion: "1.0.0",
      mode: input.mode,
      caseRef: {
        id: input.caseData.id,
        version: input.caseData.version,
        specialty: input.caseData.specialty,
        visitType: input.caseData.visitType,
      },
      safetyCoreRef: {
        id: input.safetyCore.id,
        version: input.safetyCore.version,
      },
      policyRef: {
        id: policy.id,
        version: policy.version,
        specialty: policy.specialty,
        visitType: policy.visitType,
        approvalScope: policy.approvalScope,
      },
      ...(profileRef ? { profileRef } : {}),
      requiredSections,
      sectionOrder,
      presentation: input.mode === "BOUNDED" && input.profile
        ? {
            verbosity: input.profile.preferences.verbosity,
            expandAbbreviations: input.profile.preferences.expandAbbreviations,
            educationTone: input.profile.preferences.educationTone,
          }
        : { ...genericPresentation },
      terminologyRules: { ...policy.terminologyRules },
      safety: {
        mandatoryFields: [...input.safetyCore.mandatoryFields],
        prohibitedActions: [...input.safetyCore.prohibitedActions],
        draftDisclaimer: input.safetyCore.draftDisclaimer,
        allowedEvidenceSources: [...input.safetyCore.allowedEvidenceSources],
        approvalRequirements: [...input.safetyCore.approvalRequirements],
      },
      provenance: {
        dataset: "VERSIONED_SYNTHETIC_SEED",
        case: "VERSIONED_SYNTHETIC_CASE",
        safetyCore: "INSTITUTIONAL_SAFETY_CORE",
        policy: "APPROVED_DEMO_ONLY_SPECIALTY_VISIT_POLICY",
        profile: profileRef ? "SYNTHETIC_PHYSICIAN_PROFILE" : "NOT_USED",
        sectionOrder: profileRef ? "PHYSICIAN_PROFILE" : "SPECIALTY_POLICY",
        requiredSections: "SAFETY_CORE_AND_SPECIALTY_POLICY",
        terminologyRules: "SPECIALTY_POLICY",
        presentation: profileRef ? "PHYSICIAN_PROFILE" : "GENERIC_DEFAULTS",
      },
      versionSummary,
      configurationKey: buildConfigurationKey(input, policy),
  };

  const parsed = effectiveGenerationConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return issue(
      CONFIG_RULE_IDS.SAFETY_INVARIANT_VIOLATION,
      "编译后的配置未通过运行时 Schema。",
    );
  }

  return { ok: true, config: parsed.data };
}

export function compileEffectiveConfig(input: CompileEffectiveConfigInput): ConfigCompilationResult {
  const inputIssues = validateInputShape(input);
  if (inputIssues.length > 0) return { ok: false, issues: inputIssues };
  return compileValidInput(input);
}

export function compileComparisonConfigs(
  input: CompileComparisonConfigsInput,
): ComparisonCompilationResult {
  const generic = compileEffectiveConfig({ ...input, mode: "GENERIC" });
  if (!generic.ok) return generic;

  const bounded = compileEffectiveConfig({ ...input, mode: "BOUNDED" });
  if (!bounded.ok) return bounded;

  const sharedVersionSummary: SharedVersionSummary = {
    datasetVersion: generic.config.versionSummary.datasetVersion,
    caseVersion: generic.config.versionSummary.caseVersion,
    safetyCoreVersion: generic.config.versionSummary.safetyCoreVersion,
    policyVersion: generic.config.versionSummary.policyVersion,
  };
  const genericShared = {
    caseRef: generic.config.caseRef,
    safetyCoreRef: generic.config.safetyCoreRef,
    policyRef: generic.config.policyRef,
    requiredSections: generic.config.requiredSections,
    terminologyRules: generic.config.terminologyRules,
    safety: generic.config.safety,
  };
  const boundedShared = {
    caseRef: bounded.config.caseRef,
    safetyCoreRef: bounded.config.safetyCoreRef,
    policyRef: bounded.config.policyRef,
    requiredSections: bounded.config.requiredSections,
    terminologyRules: bounded.config.terminologyRules,
    safety: bounded.config.safety,
  };

  if (JSON.stringify(genericShared) !== JSON.stringify(boundedShared)) {
    return {
      ok: false,
      issues: [{
        ruleId: CONFIG_RULE_IDS.SHARED_CONFIG_MISMATCH,
        message: "通用与受约束配置的病例、安全核心或策略条件不一致。",
      }],
    };
  }

  return {
    ok: true,
    generic: generic.config,
    bounded: bounded.config,
    sharedVersionSummary,
  };
}
