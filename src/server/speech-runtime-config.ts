import "server-only";

import path from "node:path";

import { speechCapabilitySchema, type SpeechCapability } from "@/domain/speech";
import type { LocalWhisperCliConfig } from "@/infrastructure/speech/local-whisper-cli";
import {
  LOCAL_WHISPER_EXECUTABLE_NAME,
  LOCAL_WHISPER_MODEL_NAME,
} from "@/infrastructure/speech/local-whisper-cli";
import { readRuntimeConfig } from "./runtime-config";

const supportedConfigurationNames = new Set([
  "disabled",
  "local-whisper",
  "browser-experimental",
  "cloud",
]);

export type SpeechRuntimeConfig = {
  capability: SpeechCapability;
  localWhisper?: LocalWhisperCliConfig;
};

function unconfigured(reason: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_NOT_IMPLEMENTED" | "PUBLIC_DEMO_READ_ONLY"): SpeechCapability {
  return speechCapabilitySchema.parse({ status: "UNCONFIGURED", reason });
}

function configuredPath(value: string | undefined): string | undefined {
  if (!value || value.includes("\0") || !path.isAbsolute(value)) return undefined;
  return path.normalize(value);
}

function readLocalWhisperConfig(env: NodeJS.ProcessEnv): LocalWhisperCliConfig | undefined {
  const executablePath = configuredPath(env.SPEECH_LOCAL_WHISPER_EXECUTABLE_PATH);
  const modelPath = configuredPath(env.SPEECH_LOCAL_WHISPER_MODEL_PATH);
  const tempRoot = configuredPath(env.SPEECH_LOCAL_WHISPER_TEMP_ROOT);
  if (!executablePath || !modelPath || !tempRoot) return undefined;
  if (
    path.basename(executablePath).toLowerCase() !== LOCAL_WHISPER_EXECUTABLE_NAME
    || path.basename(modelPath) !== LOCAL_WHISPER_MODEL_NAME
  ) return undefined;
  return { executablePath, modelPath, tempRoot };
}

/**
 * Server-only speech gate. The provider is READY only when the operator has
 * explicitly selected local-whisper and supplied the fixed server paths. The
 * adapter performs the fixed SHA-256 checks immediately before spawn; paths
 * never enter a client DTO or come from a request.
 */
export function readSpeechRuntimeConfig(env: NodeJS.ProcessEnv = process.env): SpeechRuntimeConfig {
  const runtime = readRuntimeConfig(env);
  const requested = env.SPEECH_PROVIDER?.trim().toLowerCase();
  if (runtime.runtimeMode === "public-demo") {
    return { capability: unconfigured("PUBLIC_DEMO_READ_ONLY") };
  }
  if (requested === undefined || requested === "" || requested === "disabled") {
    return { capability: unconfigured("PROVIDER_NOT_CONFIGURED") };
  }
  if (requested !== "local-whisper") {
    return {
      capability: unconfigured(
        supportedConfigurationNames.has(requested) ? "PROVIDER_NOT_IMPLEMENTED" : "PROVIDER_NOT_CONFIGURED",
      ),
    };
  }
  const localWhisper = readLocalWhisperConfig(env);
  if (!localWhisper) return { capability: unconfigured("PROVIDER_NOT_CONFIGURED") };
  return {
    capability: speechCapabilitySchema.parse({ status: "READY" }),
    localWhisper,
  };
}
