import path from "node:path";

import { describe, expect, it } from "vitest";

import { readSpeechRuntimeConfig } from "./speech-runtime-config";

describe("speech runtime configuration", () => {
  it("keeps default and public-demo capability fail-closed", () => {
    expect(readSpeechRuntimeConfig({ NODE_ENV: "test", APP_RUNTIME_MODE: "local-research" }).capability.status).toBe("UNCONFIGURED");
    expect(readSpeechRuntimeConfig({ NODE_ENV: "test", APP_RUNTIME_MODE: "public-demo", SPEECH_PROVIDER: "local-whisper" }).capability).toEqual({
      status: "UNCONFIGURED",
      reason: "PUBLIC_DEMO_READ_ONLY",
    });
  });

  it("requires explicit absolute server paths with frozen resource names", () => {
    const missing = readSpeechRuntimeConfig({ NODE_ENV: "test", APP_RUNTIME_MODE: "local-research", SPEECH_PROVIDER: "local-whisper" });
    expect(missing.capability.status).toBe("UNCONFIGURED");

    const configured = readSpeechRuntimeConfig({
      NODE_ENV: "test",
      APP_RUNTIME_MODE: "local-research",
      SPEECH_PROVIDER: "local-whisper",
      SPEECH_LOCAL_WHISPER_EXECUTABLE_PATH: path.join("C:\\pwr06a", "whisper-cli.exe"),
      SPEECH_LOCAL_WHISPER_MODEL_PATH: path.join("C:\\pwr06a", "ggml-small.bin"),
      SPEECH_LOCAL_WHISPER_TEMP_ROOT: path.join("C:\\pwr06a", ".codex-tmp", "pwr-06a"),
    });
    expect(configured.capability).toEqual({ status: "READY" });
    expect(configured.localWhisper?.executablePath).toMatch(/whisper-cli\.exe$/u);

    const wrongName = readSpeechRuntimeConfig({
      NODE_ENV: "test",
      APP_RUNTIME_MODE: "local-research",
      SPEECH_PROVIDER: "local-whisper",
      SPEECH_LOCAL_WHISPER_EXECUTABLE_PATH: "C:\\pwr06a\\other.exe",
      SPEECH_LOCAL_WHISPER_MODEL_PATH: "C:\\pwr06a\\ggml-small.bin",
      SPEECH_LOCAL_WHISPER_TEMP_ROOT: "C:\\pwr06a\\.codex-tmp\\pwr-06a",
    });
    expect(wrongName.capability.status).toBe("UNCONFIGURED");
  });
});
