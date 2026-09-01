import type { AppRuntimeMode } from "./runtime-mode";

export type SpeechTestFlow =
  | "permission-required"
  | "permission-denied"
  | "recording"
  | "transcribing"
  | "review"
  | "expanded"
  | "low-confidence"
  | "no-confidence"
  | "failed"
  | "cancelled";

export type SpeechPanelTestFixture = {
  flow: SpeechTestFlow;
  expanded?: boolean;
};

export function readSpeechTestFixture(
  value: unknown,
  runtimeMode: AppRuntimeMode,
  testModeEnabled: boolean,
): SpeechPanelTestFixture | undefined {
  if (runtimeMode !== "local-research" || !testModeEnabled || typeof value !== "string") return undefined;

  switch (value) {
    case "permission-required":
    case "permission-denied":
    case "recording":
    case "transcribing":
    case "review":
    case "low-confidence":
    case "no-confidence":
    case "failed":
    case "cancelled":
      return { flow: value, expanded: value === "low-confidence" || value === "no-confidence" };
    case "expanded":
      return { flow: "expanded", expanded: true };
    default:
      return undefined;
  }
}
