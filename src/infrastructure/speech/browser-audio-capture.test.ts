import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_AUDIO_MAX_DURATION_MS,
  BROWSER_AUDIO_SAMPLE_RATE,
  BrowserAudioCaptureError,
  createBrowserAudioCaptureAdapter,
  encodePcm16Wav,
  parsePcm16WavHeader,
  type BrowserAudioCaptureFailure,
} from "./browser-audio-capture";

class FakeTrack {
  stop = vi.fn();
}

class FakeStream {
  readonly track = new FakeTrack();

  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeRecorder {
  state: RecordingState = "inactive";
  readonly mimeType = "audio/webm;codecs=opus";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    this.state = "inactive";
    this.onstop?.();
  });
}

function audioBuffer(length: number, sampleRate: number, channels: number, amplitude = 0.25) {
  const channelData = Array.from({ length: channels }, (_, channel) => {
    const data = new Float32Array(length);
    if (amplitude !== 0) data.fill(channel === 0 ? amplitude : amplitude / 2);
    return data;
  });
  return {
    length,
    numberOfChannels: channels,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel: number) => channelData[channel],
  };
}

function createAudioFixture(options: {
  sampleRate?: number;
  length?: number;
  channels?: number;
  renderedLength?: number;
  renderedAmplitude?: number;
  decodeError?: boolean;
} = {}) {
  const sampleRate = options.sampleRate ?? 44_100;
  const length = options.length ?? sampleRate;
  const channels = options.channels ?? 2;
  const renderedLength = options.renderedLength ?? 16_000;
  const renderedAmplitude = options.renderedAmplitude ?? 0.25;
  const offlineArgs: number[] = [];
  let closed = 0;
  const createAudioContext = () => ({
    decodeAudioData: async () => {
      if (options.decodeError) throw new Error("decode failed");
      return audioBuffer(length, sampleRate, channels);
    },
    close: async () => { closed += 1; },
  });
  const createOfflineAudioContext = (_channels: number, outputLength: number, outputRate: number) => {
    offlineArgs.push(outputLength, outputRate);
    const mono = new Float32Array(length);
    return {
      createBuffer: () => ({ getChannelData: () => mono }),
      createBufferSource: () => ({
        buffer: undefined,
        connect: () => undefined,
        start: () => undefined,
      }),
      destination: {},
      startRendering: async () => audioBuffer(renderedLength, outputRate, 1, renderedAmplitude),
    };
  };
  return { createAudioContext, createOfflineAudioContext, offlineArgs, get closed() { return closed; } };
}

function createCapture(
  stream: FakeStream,
  recorder: FakeRecorder,
  fixture = createAudioFixture(),
  nowValues = [0, 1_000],
  scheduleTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> = (callback, delayMs) => setTimeout(callback, delayMs),
  onFailure?: (failure: BrowserAudioCaptureFailure) => void,
) {
  let nowIndex = 0;
  return createBrowserAudioCaptureAdapter({
    getUserMedia: vi.fn(async () => stream as unknown as MediaStream),
    createMediaRecorder: vi.fn(() => recorder as unknown as MediaRecorder),
    createAudioContext: fixture.createAudioContext,
    createOfflineAudioContext: fixture.createOfflineAudioContext,
    now: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)],
    scheduleTimeout,
    onFailure,
  });
}

describe("BrowserAudioCaptureAdapter", () => {
  it("fails closed without browser microphone APIs and does not request permission", async () => {
    const capture = createBrowserAudioCaptureAdapter();

    expect(capture.status).toBe("UNSUPPORTED");
    expect(await capture.start()).toBe("UNSUPPORTED");
  });

  it("requests permission only after start and emits a strict mono 16 kHz PCM16 WAV", async () => {
    const stream = new FakeStream();
    const recorder = new FakeRecorder();
    const fixture = createAudioFixture({ sampleRate: 44_100, channels: 2 });
    const capture = createCapture(stream, recorder, fixture);

    expect(recorder.start).not.toHaveBeenCalled();
    expect(await capture.start()).toBe("RECORDING");
    expect(recorder.start).toHaveBeenCalledOnce();
    const result = await capture.stop();
    const header = parsePcm16WavHeader(result.audioBytes);

    expect(result.mimeType).toBe("audio/wav");
    expect(result.sourceMimeType).toContain("audio/webm");
    expect(header).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      byteRate: 32_000,
      blockAlign: 2,
    });
    expect(fixture.offlineArgs).toEqual([16_000, 16_000]);
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(fixture.closed).toBe(1);
    expect(capture.status).toBe("READY");
  });

  it("rejects permission failure without retaining a stream", async () => {
    const onFailure = vi.fn();
    const capture = createBrowserAudioCaptureAdapter({
      getUserMedia: vi.fn(async () => { throw new Error("permission denied"); }),
      onFailure,
    });

    expect(await capture.start()).toBe("PERMISSION_DENIED");
    expect(onFailure).toHaveBeenCalledWith({ code: "SPEECH_PERMISSION_DENIED" });
    expect(capture.status).toBe("READY");
  });

  it.each([
    ["empty", { length: 0 }, "SPEECH_NO_AUDIO_DETECTED"],
    ["too short", { length: 4_000, sampleRate: 16_000, renderedLength: 4_000 }, "SPEECH_RECORDING_TOO_SHORT"],
    ["too long", { length: 16_000, sampleRate: 16_000, renderedLength: 16_000 * 16 }, "SPEECH_BROWSER_AUDIO_FAILED"],
    ["silent", { renderedAmplitude: 0 }, "SPEECH_NO_AUDIO_DETECTED"],
    ["decode failure", { decodeError: true }, "SPEECH_BROWSER_AUDIO_FAILED"],
  ] as const)("classifies and cleans tracks on %s audio failure", async (_label, options, failureReason) => {
    const stream = new FakeStream();
    const recorder = new FakeRecorder();
    const onFailure = vi.fn();
    const fixture = createAudioFixture(options);
    const capture = createCapture(stream, recorder, fixture, [0, 1_000], undefined, onFailure);
    await capture.start();

    const stopping = capture.stop();
    await expect(stopping).rejects.toMatchObject({ failureReason });
    await expect(stopping).rejects.toBeInstanceOf(BrowserAudioCaptureError);
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(fixture.closed).toBe(1);
    expect(onFailure).toHaveBeenCalledWith({ code: "SPEECH_PROVIDER_FAILED", failureReason });
    expect(capture.status).toBe("READY");
  });

  it("auto-stops at 15 seconds and releases microphone tracks", async () => {
    const stream = new FakeStream();
    const recorder = new FakeRecorder();
    let autoStop: (() => void) | undefined;
    const capture = createCapture(
      stream,
      recorder,
      createAudioFixture(),
      [0, BROWSER_AUDIO_MAX_DURATION_MS],
      (callback) => {
        autoStop = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
    );

    await capture.start();
    expect(autoStop).toBeDefined();
    autoStop!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it("cancels recording and releases tracks before a late recorder callback", async () => {
    const stream = new FakeStream();
    const recorder = new FakeRecorder();
    const capture = createCapture(stream, recorder);

    await capture.start();
    capture.cancel();

    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(capture.status).toBe("READY");
  });

  it("writes canonical WAV headers without depending on source sample rate", () => {
    const bytes = encodePcm16Wav(new Float32Array([0, 0.5, -0.5, 1]));
    expect(parsePcm16WavHeader(bytes)).toEqual({
      sampleRate: BROWSER_AUDIO_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      byteRate: 32_000,
      blockAlign: 2,
      dataBytes: 8,
    });
  });
});
