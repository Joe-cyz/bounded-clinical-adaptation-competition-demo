/**
 * Physician-facing patient names are a presentation projection only. The
 * persisted synthetic display label remains the source-of-truth identifier
 * for binding and integrity checks.
 */
export const PUBLIC_PHYSICIAN_PATIENT_DISPLAY_NAME = "患者1" as const;

export class PhysicianPatientDisplayNameError extends Error {
  readonly code = "PHYSICIAN_PATIENT_DISPLAY_NAME_INVALID" as const;

  constructor() {
    super("患者展示名称无法安全生成。");
    this.name = "PhysicianPatientDisplayNameError";
  }
}

export function projectManualPatientDisplayName(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new PhysicianPatientDisplayNameError();
  }
  return `患者${ordinal}`;
}

export function projectSeededPatientDisplayName(displayLabel: string): string {
  const match = /^合成患者-(\d+)$/u.exec(displayLabel);
  if (!match) throw new PhysicianPatientDisplayNameError();
  const ordinal = Number(match[1]);
  return projectManualPatientDisplayName(ordinal);
}

export function projectPublicPatientDisplayName(): typeof PUBLIC_PHYSICIAN_PATIENT_DISPLAY_NAME {
  return PUBLIC_PHYSICIAN_PATIENT_DISPLAY_NAME;
}
