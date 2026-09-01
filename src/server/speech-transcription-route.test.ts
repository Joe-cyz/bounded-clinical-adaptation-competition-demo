import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { encodePcm16Wav } from "@/infrastructure/speech/browser-audio-capture";
import { LOCAL_WHISPER_PROVIDER } from "@/infrastructure/speech/local-whisper-cli";
import {
  SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES,
  SpeechTranscriptionRegistry,
  createSpeechTranscriptionRouteHandlers,
  speechRouteErrorCodes,
} from "./speech-transcription-route";

function validAudio(durationSamples = 16_000): Uint8Array {
  const samples = new Float32Array(durationSamples);
  samples.fill(0.2);
  return encodePcm16Wav(samples);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function createConfig(tempRoot: string) {
  return {
    capability: { status: "READY" as const },
    localWhisper: {
      executablePath: path.join(tempRoot, "whisper-cli.exe"),
      modelPath: path.join(tempRoot, "ggml-small.bin"),
      tempRoot,
    },
  };
}

function requestFor(sessionId: string, bytes = validAudio(), extraEntries: Array<[string, string | Blob]> = []): Request {
  const form = new FormData();
  form.set("sessionId", sessionId);
  form.set("audio", new File([asArrayBuffer(bytes)], "recording.wav", { type: "audio/wav" }));
  for (const [key, value] of extraEntries) form.append(key, value);
  return new Request("http://localhost:3000/api/speech/transcriptions", {
    method: "POST",
    body: form,
    headers: { Origin: "http://localhost:3000", Host: "localhost:3000" },
  });
}

function fakeResult(sessionId: string, durationMs = 1_000) {
  return {
    provider: LOCAL_WHISPER_PROVIDER,
    transcript: {
      text: "合成口述：晨起乏力，持续两周，待医生复核。",
      durationMs,
      segments: [{
        id: `segment-${sessionId}`,
        text: "合成口述：晨起乏力，持续两周，待医生复核。",
        startMs: 0,
        endMs: durationMs,
        confidenceStatus: "NOT_PROVIDED" as const,
      }],
    },
    elapsedMs: 12,
    timings: { modelLoadMs: 1, melMs: 2, encodeMs: 3, decodeMs: 4, totalMs: 10 },
    input: { sizeBytes: validAudio().length, durationMs, sha256: "test-only" },
  };
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((entry) => /\.(wav|json|part)$/iu.test(entry));
}

describe("speech transcription route", () => {
  it("rejects public-demo before reading the multipart body or constructing a provider", async () => {
    const formData = vi.fn(async () => { throw new Error("body must not be read"); });
    const request = {
      headers: new Headers({ Origin: "http://localhost:3000", Host: "localhost:3000" }),
      formData,
    } as unknown as Request;
    const adapterFactory = vi.fn();
    const handlers = createSpeechTranscriptionRouteHandlers({
      readRuntimeConfig: () => ({ capability: { status: "UNCONFIGURED", reason: "PUBLIC_DEMO_READ_ONLY" } }),
      adapterFactory,
    });

    const response = await handlers.post(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, errorCode: "SPEECH_PUBLIC_DEMO_READ_ONLY" });
    expect(formData).not.toHaveBeenCalled();
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("rejects default and invalid-origin requests before provider or database work", async () => {
    const bodyRead = vi.fn(async () => { throw new Error("body must not be read"); });
    const defaultRequest = {
      headers: new Headers({ Origin: "http://localhost:3000", Host: "localhost:3000" }),
      formData: bodyRead,
    } as unknown as Request;
    const providerFactory = vi.fn();
    let databaseFactoryCalls = 0;
    const handlers = createSpeechTranscriptionRouteHandlers({
      readRuntimeConfig: () => ({ capability: { status: "UNCONFIGURED", reason: "PROVIDER_NOT_CONFIGURED" } }),
      adapterFactory: providerFactory,
    });

    const defaultResponse = await handlers.post(defaultRequest);
    const invalidOriginRequest = requestFor("speech-origin-001");
    invalidOriginRequest.headers.set("Origin", "http://evil.example");
    const invalidOriginResponse = await handlers.post(invalidOriginRequest);
    databaseFactoryCalls += 0;

    expect(defaultResponse.status).toBe(503);
    expect(invalidOriginResponse.status).toBe(403);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
    expect(databaseFactoryCalls).toBe(0);
  });

  it("validates exact multipart fields, MIME, size and strict WAV contract", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pwr-06b-a-route-")).catch(() => os.tmpdir());
    const adapterFactory = vi.fn();
    const handlers = createSpeechTranscriptionRouteHandlers({
      readRuntimeConfig: () => createConfig(tempRoot),
      adapterFactory,
    });
    try {
      const extraFieldResponse = await handlers.post(requestFor("speech-fields-001", validAudio(), [["extra", "x"]]));
      const wrongMimeForm = new FormData();
      wrongMimeForm.set("sessionId", "speech-mime-001");
      wrongMimeForm.set("audio", new File([asArrayBuffer(validAudio())], "recording.wav", { type: "audio/webm" }));
      const wrongMimeResponse = await handlers.post(new Request("http://localhost:3000/api/speech/transcriptions", {
        method: "POST",
        body: wrongMimeForm,
        headers: { Origin: "http://localhost:3000", Host: "localhost:3000" },
      }));
      const largeResponse = await handlers.post(requestFor("speech-large-001", new Uint8Array(SPEECH_TRANSCRIPTION_MAX_AUDIO_BYTES + 1)));
      const shortResponse = await handlers.post(requestFor("speech-short-001", validAudio(4_000)));
      const longResponse = await handlers.post(requestFor("speech-long-001", validAudio(16_000 * 15 + 1)));
      const wrongRate = validAudio();
      const wrongRateView = new DataView(wrongRate.buffer, wrongRate.byteOffset, wrongRate.byteLength);
      wrongRateView.setUint32(24, 8_000, true);
      wrongRateView.setUint32(28, 16_000, true);
      const wrongRateResponse = await handlers.post(requestFor("speech-rate-001", wrongRate));

      expect(extraFieldResponse.status).toBe(400);
      expect(wrongMimeResponse.status).toBe(400);
      expect(largeResponse.status).toBe(413);
      expect(shortResponse.status).toBe(400);
      expect(longResponse.status).toBe(400);
      expect(wrongRateResponse.status).toBe(400);
      expect(adapterFactory).not.toHaveBeenCalled();
    } finally {
      if (tempRoot !== os.tmpdir()) await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes a random server-owned file, calls only the injected adapter, returns a strict DTO and cleans input", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pwr-06b-a-route-")).catch(() => os.tmpdir());
    const seenPaths: string[] = [];
    const adapterFactory = vi.fn(() => ({
      transcribeFile: vi.fn(async (audioPath: string) => {
        seenPaths.push(audioPath);
        expect(path.basename(audioPath)).toMatch(/^speech-[a-f0-9]+\.wav$/u);
        return fakeResult("speech-success-001");
      }),
    }));
    const handlers = createSpeechTranscriptionRouteHandlers({
      readRuntimeConfig: () => createConfig(tempRoot),
      adapterFactory,
      randomId: () => "a1b2c3d4",
    });
    try {
      const response = await handlers.post(requestFor("speech-success-001"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ ok: true, sessionId: "speech-success-001", provider: LOCAL_WHISPER_PROVIDER });
      expect(body).not.toHaveProperty("audioPath");
      expect(JSON.stringify(body)).not.toContain(tempRoot);
      expect(adapterFactory).toHaveBeenCalledOnce();
      expect(seenPaths).toHaveLength(1);
      expect(await filesUnder(tempRoot)).toEqual([]);
    } finally {
      if (tempRoot !== os.tmpdir()) await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans the owned file when the injected adapter fails and returns no raw details", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pwr-06b-a-route-")).catch(() => os.tmpdir());
    const handlers = createSpeechTranscriptionRouteHandlers({
      readRuntimeConfig: () => createConfig(tempRoot),
      adapterFactory: () => ({ transcribeFile: async () => { throw new Error(`secret ${tempRoot}`); } }),
    });
    try {
      const response = await handlers.post(requestFor("speech-failure-001"));
      const text = await response.text();

      expect(response.status).toBe(502);
      expect(text).toContain("SPEECH_PROVIDER_FAILED");
      expect(text).not.toContain(tempRoot);
      expect(text).not.toContain("secret");
      expect(await filesUnder(tempRoot)).toEqual([]);
    } finally {
      if (tempRoot !== os.tmpdir()) await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate sessions and a second global session without overlapping provider work", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pwr-06b-a-route-")).catch(() => os.tmpdir());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = vi.fn();
    const handlers = createSpeechTranscriptionRouteHandlers({
      readRuntimeConfig: () => createConfig(tempRoot),
      adapterFactory: () => ({
        transcribeFile: async () => {
          started();
          await barrier;
          return fakeResult("speech-concurrent-001");
        },
      }),
    });
    try {
      const first = handlers.post(requestFor("speech-concurrent-001"));
      for (let attempt = 0; attempt < 20 && started.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const duplicate = await handlers.post(requestFor("speech-concurrent-001"));
      const other = await handlers.post(requestFor("speech-other-001"));
      release();
      const firstResponse = await first;

      expect(duplicate.status).toBe(409);
      expect(other.status).toBe(429);
      expect(firstResponse.status).toBe(200);
      expect(started).toHaveBeenCalledOnce();
      expect((await filesUnder(tempRoot))).toEqual([]);
    } finally {
      release?.();
      if (tempRoot !== os.tmpdir()) await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cancels an active adapter through AbortSignal and keeps DELETE idempotent", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pwr-06b-a-route-")).catch(() => os.tmpdir());
    let rejectAdapter!: (error: Error) => void;
    let signalSeen: AbortSignal | undefined;
    const handlers = createSpeechTranscriptionRouteHandlers({
      readRuntimeConfig: () => createConfig(tempRoot),
      adapterFactory: () => ({
        transcribeFile: async (_path: string, signal?: AbortSignal) => {
          signalSeen = signal;
          await new Promise<never>((_resolve, reject) => { rejectAdapter = reject; });
          throw new Error("unreachable");
        },
      }),
    });
    try {
      const post = handlers.post(requestFor("speech-cancel-001"));
      for (let attempt = 0; attempt < 20 && signalSeen === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const deleted = await handlers.cancel(requestFor("speech-cancel-001"), "speech-cancel-001");
      rejectAdapter(new Error("cancelled"));
      const postResponse = await post;
      const repeatDelete = await handlers.cancel(requestFor("speech-cancel-001"), "speech-cancel-001");

      expect(deleted.status).toBe(200);
      expect(signalSeen?.aborted).toBe(true);
      expect(postResponse.status).toBe(499);
      expect(repeatDelete.status).toBe(200);
      expect(JSON.stringify(await postResponse.clone().json())).not.toContain(tempRoot);
      expect(await filesUnder(tempRoot)).toEqual([]);
    } finally {
      rejectAdapter?.(new Error("cleanup"));
      if (tempRoot !== os.tmpdir()) await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses an isolated registry when explicitly injected and never obtains a database", () => {
    const first = new SpeechTranscriptionRegistry();
    const second = new SpeechTranscriptionRegistry();
    expect(first.claim("speech-registry-001").ok).toBe(true);
    expect(second.claim("speech-registry-001").ok).toBe(true);
    expect(speechRouteErrorCodes.BUSY).toBe("SPEECH_BUSY");
  });
});
