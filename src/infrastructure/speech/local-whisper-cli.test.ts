import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildLocalWhisperArgs,
  createLocalWhisperCliAdapter,
  localWhisperErrorCodes,
  LOCAL_WHISPER_EXECUTABLE_SHA256,
  LOCAL_WHISPER_MODEL_SHA256,
  LOCAL_WHISPER_TIMEOUT_MS,
  parseWhisperJson,
  parseWhisperTimings,
  sha256File,
  type LocalWhisperExecution,
  type LocalWhisperSpawn,
  type LocalWhisperSpawnOptions,
} from "./local-whisper-cli";

const SYNTHETIC_TEXT = "这是用于本地语音识别验证的虚构中文内容。今天患者没有真实身份信息，仅记录一般的接诊描述和随访安排。";

type Fixture = Readonly<{
  root: string;
  tempRoot: string;
  audioPath: string;
  executablePath: string;
  modelPath: string;
}>;

function createWav(durationMs = 1_000, sampleRate = 16_000): Buffer {
  const dataSize = Math.floor((sampleRate * durationMs) / 1_000) * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwr-06a-local-whisper-"));
  const tempRoot = path.join(root, "pwr-06a");
  const runtimeRoot = path.join(root, "runtime");
  await fs.mkdir(path.join(tempRoot, "input"), { recursive: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  const audioPath = path.join(tempRoot, "input", "synthetic.wav");
  const executablePath = path.join(runtimeRoot, "whisper-cli.exe");
  const modelPath = path.join(runtimeRoot, "ggml-small.bin");
  await fs.writeFile(audioPath, createWav());
  await fs.writeFile(executablePath, "test executable placeholder");
  await fs.writeFile(modelPath, "test model placeholder");
  return { root, tempRoot, audioPath, executablePath, modelPath };
}

function createAdapter(fixture: Fixture, spawnProcess: LocalWhisperSpawn, extraDependencies: Record<string, unknown> = {}) {
  return createLocalWhisperCliAdapter({
    executablePath: fixture.executablePath,
    modelPath: fixture.modelPath,
    tempRoot: fixture.tempRoot,
  }, {
    spawnProcess,
    createOutputId: () => "fixed-output-id",
    sha256File: async (filePath: string) => path.basename(filePath) === "whisper-cli.exe"
      ? LOCAL_WHISPER_EXECUTABLE_SHA256
      : LOCAL_WHISPER_MODEL_SHA256,
    ...extraDependencies,
  });
}

function createJsonSpawn(jsonText?: string, exitCode = 0): Readonly<{
  spawnProcess: LocalWhisperSpawn;
  terminate: ReturnType<typeof vi.fn>;
  calls: ReturnType<typeof vi.fn>;
}> {
  const terminate = vi.fn();
  const calls = vi.fn();
  const spawnProcess = ((executablePath: string, args: readonly string[], options: LocalWhisperSpawnOptions): LocalWhisperExecution => {
    calls(executablePath, args, options);
    const outputIndex = args.indexOf("-of");
    const outputBasePath = args[outputIndex + 1];
    const absoluteOutputBasePath = path.isAbsolute(outputBasePath)
      ? outputBasePath
      : path.resolve(options.cwd, outputBasePath);
    const completion = (jsonText === undefined
      ? Promise.resolve()
      : fs.writeFile(`${absoluteOutputBasePath}.json`, jsonText, "utf8"))
      .then(() => ({
        exitCode,
        signal: null,
        stdout: "whisper_print_timings: load time = 2.50 ms\nwhisper_print_timings: mel time = 3.50 ms\nwhisper_print_timings: encode time = 4.50 ms\nwhisper_print_timings: decode time = 5.50 ms\nwhisper_print_timings: total time = 9.00 ms\n",
        stderr: "",
        processError: false,
      }));
    return { completion, terminate };
  }) as LocalWhisperSpawn;
  return { spawnProcess, terminate, calls };
}

let fixture: Fixture;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  await fs.rm(fixture.root, { recursive: true, force: true });
});

describe("local whisper CLI adapter", () => {
  it("maps supported JSON to the existing strict transcript shape and cleans every temporary file", async () => {
    const fake = createJsonSpawn(JSON.stringify({
      transcription: [{
        offsets: { from: 0, to: 700 },
        text: "你好，世界。",
      }],
    }));
    const adapter = createAdapter(fixture, fake.spawnProcess);

    const result = await adapter.transcribeFile(fixture.audioPath);

    expect(result.provider).toEqual({
      providerType: "LOCAL_WHISPER",
      providerVersion: "whisper.cpp@v1.9.2",
      networkUsed: false,
      retainedAudio: false,
    });
    expect(result.transcript.text).toBe("你好，世界。");
    expect(result.transcript.segments[0]).toEqual({
      id: "local-whisper-segment-1",
      text: "你好，世界。",
      startMs: 0,
      endMs: 700,
      confidenceStatus: "NOT_PROVIDED",
    });
    expect(result.transcript.segments[0]).not.toHaveProperty("confidence");
    expect(result.input.durationMs).toBe(1_000);
    expect(result.input.sizeBytes).toBeGreaterThan(44);
    expect(result.timings).toEqual({
      modelLoadMs: 2.5,
      melMs: 3.5,
      encodeMs: 4.5,
      decodeMs: 5.5,
      totalMs: 9,
    });
    expect(await sha256File(fixture.executablePath)).toBe(
      "09cadf07cf1c54fa29b2a87a3abdaea01b9620852efaf7e7555233b6b294e58a",
    );
    expect(await fileExists(fixture.audioPath)).toBe(false);
    expect(await fileExists(path.join(fixture.tempRoot, "output", "local-whisper-fixed-output-id.json"))).toBe(false);
  });

  it("parses every CLI timing metric independently", () => {
    expect(parseWhisperTimings([
      "whisper_print_timings: load time = 10.25 ms",
      "whisper_print_timings: mel time = 20.50 ms",
      "whisper_print_timings: encode time = 30.75 ms",
      "whisper_print_timings: decode time = 40.00 ms",
      "whisper_print_timings: total time = 101.50 ms",
    ].join("\n"))).toEqual({
      modelLoadMs: 10.25,
      melMs: 20.5,
      encodeMs: 30.75,
      decodeMs: 40,
      totalMs: 101.5,
    });
  });

  it("rejects a fixed executable digest mismatch before spawn and cleans the owned WAV", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess, {
      sha256File: async (filePath: string) => path.basename(filePath) === "whisper-cli.exe"
        ? "0000000000000000000000000000000000000000000000000000000000000000"
        : LOCAL_WHISPER_MODEL_SHA256,
    });

    const error = await adapter.transcribeFile(fixture.audioPath).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: localWhisperErrorCodes.INVALID_CONFIG });
    expect(fake.calls).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(fixture.root);
    expect(String(error)).not.toContain("0000000000000000");
    expect((error as Error).stack).toBeUndefined();
    expect(await fileExists(fixture.audioPath)).toBe(false);
  });

  it("rejects a fixed model digest mismatch before spawn and cleans the owned WAV", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess, {
      sha256File: async (filePath: string) => path.basename(filePath) === "whisper-cli.exe"
        ? LOCAL_WHISPER_EXECUTABLE_SHA256
        : "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    });

    const error = await adapter.transcribeFile(fixture.audioPath).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: localWhisperErrorCodes.INVALID_CONFIG });
    expect(fake.calls).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(fixture.root);
    expect(String(error)).not.toContain("ffffffffffffffff");
    expect((error as Error).stack).toBeUndefined();
    expect(await fileExists(fixture.audioPath)).toBe(false);
  });

  it("uses a correct injected digest to allow spawn", async () => {
    const fake = createJsonSpawn(JSON.stringify({
      transcription: [{ offsets: { from: 0, to: 100 }, text: "可执行" }],
    }));
    const adapter = createAdapter(fixture, fake.spawnProcess, {
      sha256File: vi.fn(async (filePath: string) => path.basename(filePath) === "whisper-cli.exe"
        ? LOCAL_WHISPER_EXECUTABLE_SHA256
        : LOCAL_WHISPER_MODEL_SHA256),
    });

    await adapter.transcribeFile(fixture.audioPath);

    expect(fake.calls).toHaveBeenCalledOnce();
  });

  it("rejects non-16 kHz WAV input and cleans each owned file", async () => {
    for (const sampleRate of [8_000, 44_100]) {
      await fs.writeFile(fixture.audioPath, createWav(1_000, sampleRate));
      const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
      const adapter = createAdapter(fixture, fake.spawnProcess);

      await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
        code: localWhisperErrorCodes.INVALID_INPUT,
      });
      expect(fake.calls).not.toHaveBeenCalled();
      expect(await fileExists(fixture.audioPath)).toBe(false);
    }
  });

  it("returns cleanup failure instead of masking it as an operation result", async () => {
    const terminate = vi.fn();
    const spawnProcess = ((_: string, args: readonly string[], options: LocalWhisperSpawnOptions): LocalWhisperExecution => {
      const outputIndex = args.indexOf("-of");
      const outputBasePath = path.resolve(options.cwd, args[outputIndex + 1]);
      const completion = fs.mkdir(`${outputBasePath}.json`, { recursive: true }).then(() => ({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        processError: false,
      }));
      return { completion, terminate };
    }) as LocalWhisperSpawn;
    const adapter = createAdapter(fixture, spawnProcess);

    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.CLEANUP_FAILED,
    });
    expect(await fileExists(fixture.audioPath)).toBe(false);
    await fs.rm(path.join(fixture.tempRoot, "output"), { recursive: true, force: true });
  });

  it("cleans a pseudo-WAV and an oversize WAV after ownership", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess);

    await fs.writeFile(fixture.audioPath, Buffer.alloc(0));
    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(await fileExists(fixture.audioPath)).toBe(false);

    await fs.writeFile(fixture.audioPath, Buffer.from("not a wav", "utf8"));
    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(await fileExists(fixture.audioPath)).toBe(false);

    await fs.writeFile(fixture.audioPath, Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(await fileExists(fixture.audioPath)).toBe(false);
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("rejects a forged byte rate or block alignment and cleans the owned WAV", async () => {
    const forgedByteRate = createWav();
    forgedByteRate.writeUInt32LE(16_000, 28);
    await fs.writeFile(fixture.audioPath, forgedByteRate);
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess);

    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(await fileExists(fixture.audioPath)).toBe(false);
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("retains an outside file when an outside path, symlink, or hard link is rejected", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess);
    const outsidePath = path.join(fixture.root, "outside-safe.wav");
    await fs.writeFile(outsidePath, createWav());
    const outsideBefore = await fs.readFile(outsidePath);

    await expect(adapter.transcribeFile(path.join(fixture.tempRoot, "..", "outside-safe.wav"))).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    const hardLinkPath = path.join(fixture.tempRoot, "input", "outside-hardlink.wav");
    await fs.link(outsidePath, hardLinkPath);
    await expect(adapter.transcribeFile(hardLinkPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    const symlinkPath = path.join(fixture.tempRoot, "input", "outside-symlink.wav");
    try {
      await fs.symlink(outsidePath, symlinkPath, "file");
      await expect(adapter.transcribeFile(symlinkPath)).rejects.toMatchObject({
        code: localWhisperErrorCodes.INVALID_INPUT,
      });
    } catch (error) {
      if (process.platform !== "win32") {
        throw error;
      }
    }

    expect(Buffer.compare(await fs.readFile(outsidePath), outsideBefore)).toBe(0);
    expect(await fileExists(outsidePath)).toBe(true);
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("exposes the frozen streaming SHA utility without using a client override", async () => {
    const digest = await sha256File(fixture.modelPath);
    expect(digest).toBe("c89efcd5f3a2b9505ef53b9c1c818619a98f292b94e7a84395fda8c5767fc232");
  });

  it("keeps the strict schema confidence absent", async () => {
    const fake = createJsonSpawn(JSON.stringify({
      transcription: [{ offsets: { from: 0, to: 100 }, text: "无伪造置信度" }],
    }));
    const adapter = createAdapter(fixture, fake.spawnProcess);

    const result = await adapter.transcribeFile(fixture.audioPath);

    expect(result.transcript.segments[0].confidenceStatus).toBe("NOT_PROVIDED");
    expect(result.transcript.segments[0]).not.toHaveProperty("confidence");
  });

  it("passes an argument array with CPU, Chinese, JSON and no prompt or translation", async () => {
    const fake = createJsonSpawn(JSON.stringify({
      transcription: [{ offsets: { from: 0, to: 600 }, text: "测试" }],
    }));
    const adapter = createAdapter(fixture, fake.spawnProcess);

    await adapter.transcribeFile(fixture.audioPath);

    expect(fake.calls).toHaveBeenCalledOnce();
    const [, args, options] = fake.calls.mock.calls[0] as [string, readonly string[], LocalWhisperSpawnOptions];
    expect(args).toEqual([
      "-m", path.relative(path.dirname(fixture.executablePath), fixture.modelPath),
      "-f", path.relative(path.dirname(fixture.executablePath), fixture.audioPath),
      "-l", "zh",
      "-oj",
      "-of", path.relative(path.dirname(fixture.executablePath), path.join(fixture.tempRoot, "output", "local-whisper-fixed-output-id")),
      "-ng",
    ]);
    expect(args).not.toContain("--prompt");
    expect(args).not.toContain("-tr");
    expect(options).toMatchObject({ shell: false, windowsHide: true, cwd: path.dirname(fixture.executablePath) });
  });

  it("accepts the CLI timestamp form and preserves ordered segments", () => {
    const transcript = parseWhisperJson(JSON.stringify({
      transcription: [
        { timestamps: { from: "00:00:00,000", to: "00:00:00,450" }, text: "第一句" },
        { timestamps: { from: "00:00:00.450", to: "00:00:00.900" }, text: "第二句" },
      ],
    }), 1_000);

    expect(transcript.text).toBe("第一句第二句");
    expect(transcript.segments.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[0, 450], [450, 900]]);
  });

  it("rejects an invalid JSON result without exposing raw output", async () => {
    const secretOutput = "full transcript should never be in the error";
    const fake = createJsonSpawn(secretOutput);
    const adapter = createAdapter(fixture, fake.spawnProcess);

    const error = await adapter.transcribeFile(fixture.audioPath).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: localWhisperErrorCodes.OUTPUT_INVALID });
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secretOutput);
    expect(String(error)).not.toContain(fixture.root);
    expect((error as Error).stack).toBeUndefined();
  });

  it("rejects empty text, missing timing, overlapping and out-of-bounds segments", async () => {
    const cases = [
      { transcription: [{ offsets: { from: 0, to: 500 }, text: "   " }] },
      { transcription: [{ text: "无时间" }] },
      { transcription: [
        { offsets: { from: 0, to: 600 }, text: "前" },
        { offsets: { from: 500, to: 800 }, text: "后" },
      ] },
      { transcription: [{ offsets: { from: 0, to: 1_500 }, text: "越界" }] },
    ];

    for (const value of cases) {
      await fs.writeFile(fixture.audioPath, createWav());
      const fake = createJsonSpawn(JSON.stringify(value));
      const adapter = createAdapter(fixture, fake.spawnProcess);
      await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
        code: localWhisperErrorCodes.OUTPUT_INVALID,
      });
    }
  });

  it("rejects non-WAV and oversize input before starting the process", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess);

    await fs.writeFile(fixture.audioPath, Buffer.from("not a wav", "utf8"));
    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(fake.calls).not.toHaveBeenCalled();

    await fs.writeFile(fixture.audioPath, Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("rejects paths outside the fixed temp root and traversal-equivalent redirects", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess);
    const outsidePath = path.join(fixture.root, "outside.wav");
    await fs.writeFile(outsidePath, createWav());

    await expect(adapter.transcribeFile(path.join(fixture.tempRoot, "input", "..", "..", "outside.wav"))).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(fake.calls).not.toHaveBeenCalled();
    expect(await fileExists(outsidePath)).toBe(true);
  });

  it("rejects hard-link equivalent redirects and symlinks when the platform permits them", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应执行" }] }));
    const adapter = createAdapter(fixture, fake.spawnProcess);
    const outsidePath = path.join(fixture.root, "outside-hardlink.wav");
    const hardLinkPath = path.join(fixture.tempRoot, "input", "hardlink.wav");
    await fs.writeFile(outsidePath, createWav());
    await fs.link(outsidePath, hardLinkPath);
    await expect(adapter.transcribeFile(hardLinkPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });

    const symlinkPath = path.join(fixture.tempRoot, "input", "symlink.wav");
    try {
      await fs.symlink(outsidePath, symlinkPath, "file");
    } catch (error) {
      if (process.platform !== "win32") {
        throw error;
      }
      return;
    }
    await expect(adapter.transcribeFile(symlinkPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.INVALID_INPUT,
    });
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("normalizes nonzero process exits and removes output files", async () => {
    const fake = createJsonSpawn(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 100 }, text: "不应使用" }] }), 7);
    const adapter = createAdapter(fixture, fake.spawnProcess);

    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.PROCESS_FAILED,
    });
    expect(await fileExists(fixture.audioPath)).toBe(false);
    expect(await fileExists(path.join(fixture.tempRoot, "output", "local-whisper-fixed-output-id.json"))).toBe(false);
  });

  it("terminates a timed-out process using the fixed 180 second deadline", async () => {
    const terminate = vi.fn();
    const calls = vi.fn();
    const spawnProcess = ((executablePath: string, args: readonly string[], options: unknown): LocalWhisperExecution => {
      void executablePath;
      void args;
      void options;
      calls();
      return { completion: new Promise(() => undefined), terminate };
    }) as LocalWhisperSpawn;
    const scheduleTimeout = vi.fn((callback: () => void, delayMs: number) => {
      if (delayMs === 180_000 || delayMs === 2_000) {
        callback();
      }
      return {} as ReturnType<typeof setTimeout>;
    });
    const adapter = createAdapter(fixture, spawnProcess, {
      scheduleTimeout,
      cancelTimeout: vi.fn(),
    });

    await expect(adapter.transcribeFile(fixture.audioPath)).rejects.toMatchObject({
      code: localWhisperErrorCodes.TIMEOUT,
    });
    expect(calls).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 180_000);
  });

  it("terminates and cleans up on cancellation without waiting for a sleep-based race", async () => {
    const terminate = vi.fn();
    const controller = new AbortController();
    const spawnProcess = ((executablePath: string, args: readonly string[], options: unknown): LocalWhisperExecution => {
      void executablePath;
      void args;
      void options;
      return {
        completion: new Promise(() => undefined),
        terminate,
      };
    }) as LocalWhisperSpawn;
    const scheduleTimeout = vi.fn((callback: () => void, delayMs: number) => {
      if (delayMs === 2_000) {
        callback();
      }
      return {} as ReturnType<typeof setTimeout>;
    });
    const adapter = createAdapter(fixture, spawnProcess, {
      scheduleTimeout,
      cancelTimeout: vi.fn(),
    });
    const pending = adapter.transcribeFile(fixture.audioPath, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: localWhisperErrorCodes.CANCELLED });
    expect(terminate).toHaveBeenCalledOnce();
    expect(await fileExists(fixture.audioPath)).toBe(false);
  });

  it("exports the frozen invocation shape without a client-provided command or prompt", () => {
    const args = buildLocalWhisperArgs({
      modelPath: fixture.modelPath,
      audioPath: fixture.audioPath,
      outputBasePath: path.join(fixture.tempRoot, "output", "fixed"),
    });
    expect(args).toEqual([
      "-m", fixture.modelPath,
      "-f", fixture.audioPath,
      "-l", "zh",
      "-oj",
      "-of", path.join(fixture.tempRoot, "output", "fixed"),
      "-ng",
    ]);
  });
});

function longestCommonSubsequenceLength(left: string, right: string): number {
  const previous = new Array<number>(right.length + 1).fill(0);
  for (const leftCharacter of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const above = previous[index];
      previous[index] = leftCharacter === right[index - 1]
        ? diagonal + 1
        : Math.max(previous[index], previous[index - 1]);
      diagonal = above;
    }
  }
  return previous[right.length];
}

const realSmoke = process.env.PWR_06A_REAL_SMOKE === "1" ? describe : describe.skip;

realSmoke("authorized local whisper real smoke", () => {
  it("transcribes the fixed synthetic Chinese WAV once and reports only safe summaries", async () => {
    const executablePath = process.env.PWR_06A_EXECUTABLE_PATH;
    const modelPath = process.env.PWR_06A_MODEL_PATH;
    const tempRoot = process.env.PWR_06A_TEMP_ROOT;
    const audioPath = process.env.PWR_06A_AUDIO_PATH;
    const expectedText = process.env.PWR_06A_EXPECTED_TEXT ?? SYNTHETIC_TEXT;
    if (!executablePath || !modelPath || !tempRoot || !audioPath) {
      throw new Error("PWR-06A real smoke requires absolute local paths.");
    }

    expect(await sha256File(executablePath)).toBe(LOCAL_WHISPER_EXECUTABLE_SHA256);
    expect(await sha256File(modelPath)).toBe(LOCAL_WHISPER_MODEL_SHA256);
    const adapter = createLocalWhisperCliAdapter({ executablePath, modelPath, tempRoot });
    const result = await adapter.transcribeFile(audioPath);
    const matchedChars = longestCommonSubsequenceLength(expectedText, result.transcript.text);
    const charDifference = expectedText.length + result.transcript.text.length - (2 * matchedChars);
    const expectedInputSha256 = process.env.PWR_06A_EXPECTED_AUDIO_SHA256;
    if (expectedInputSha256 !== undefined) {
      expect(result.input.sha256).toBe(expectedInputSha256);
    }
    const outputEntries = await fs.readdir(path.join(tempRoot, "output")).catch(() => [] as string[]);
    console.log(JSON.stringify({
      status: "PASS",
      provider: result.provider.providerType,
      providerVersion: result.provider.providerVersion,
      networkUsed: result.provider.networkUsed,
      retainedAudio: result.provider.retainedAudio,
      inputChars: expectedText.length,
      outputChars: result.transcript.text.length,
      matchedChars,
      charDifference,
      inputSha256: result.input.sha256,
      elapsedMs: result.elapsedMs,
      timings: result.timings,
      inputDurationMs: result.input.durationMs,
      inputSizeBytes: result.input.sizeBytes,
    }));
    expect(result.provider.providerType).toBe("LOCAL_WHISPER");
    expect(result.provider.providerVersion).toBe("whisper.cpp@v1.9.2");
    expect(result.provider.networkUsed).toBe(false);
    expect(result.provider.retainedAudio).toBe(false);
    expect(result.transcript.text).toMatch(/[\u3400-\u9fff]/u);
    expect(matchedChars).toBeGreaterThanOrEqual(12);
    expect(await fileExists(audioPath)).toBe(false);
    expect(outputEntries.filter((entry) => /\.(json|txt|vtt|srt|lrc|csv|wts)$/iu.test(entry))).toHaveLength(0);
  }, LOCAL_WHISPER_TIMEOUT_MS + 5_000);
});
