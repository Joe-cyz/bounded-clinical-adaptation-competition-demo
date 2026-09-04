import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";
const evidenceRoot = resolve(process.cwd(), ".codex-tmp", "pwr-06b-a-r1-regression");
const screenshotDirectory = resolve(
  process.env.PWR06B_EVIDENCE_DIR ?? resolve(evidenceRoot, "evidence"),
);
const evidenceRelativePath = relative(evidenceRoot, screenshotDirectory);
if (!evidenceRelativePath || evidenceRelativePath.startsWith("..") || isAbsolute(evidenceRelativePath)) {
  throw new Error("PWR-06B-A evidence directory must stay under its dedicated temporary root.");
}

const localScreenshotNames = [
  "failure-620x1000.png",
  "permission-denied-620x1000.png",
  "ready-1366x1024.png",
  "ready-620x1000.png",
  "ready-980x900.png",
  "recording-1366x1024.png",
  "recording-620x1000.png",
  "recording-980x900.png",
  "review-1366x1024.png",
  "review-620x1000.png",
  "review-980x900.png",
  "transcribing-1366x1024.png",
].sort();
const allScreenshotNames = [...localScreenshotNames, "public-1366x1024.png"].sort();

type Viewport = { width: number; height: number };

function trackRequests(page: Page): { postRequests: string[]; providerRequests: string[] } {
  const postRequests: string[] = [];
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    const pathname = new URL(url).pathname;
    if (request.method() === "POST") postRequests.push(url);
    if (/(?:\/api\/speech|transcrib|asr)/iu.test(pathname) || url.includes("api.deepseek.com")) {
      providerRequests.push(url);
    }
  });
  return { postRequests, providerRequests };
}

async function installMicCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counterWindow = window as Window & { __pwr06bGetUserMediaCalls?: number };
    counterWindow.__pwr06bGetUserMediaCalls = 0;
    if (navigator.mediaDevices?.getUserMedia) {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => {
        counterWindow.__pwr06bGetUserMediaCalls = (counterWindow.__pwr06bGetUserMediaCalls ?? 0) + 1;
        return original(...args);
      };
    }
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll("body, header, main, section, article, form"))
      .filter((element) => element.scrollWidth > viewportWidth + 1)
      .map((element) => ({ tag: element.tagName, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  });
  expect(overflow).toEqual([]);
}

async function openSeededRecord(page: Page, fixture: string): Promise<void> {
  await page.goto("/encounters/new");
  await page.getByRole("button", { name: "开始接诊", exact: true }).first().click();
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
  await page.goto(`${page.url()}?__pwr5Speech=${fixture}`);
  await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
  await expect(voicePanel(page)).toBeVisible();
}

function voicePanel(page: Page) {
  return page.locator('[aria-labelledby="voice-title"]');
}

async function waitForStableLayout(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").toUpperCase();
}

function snapshotEvidenceDirectory(): Record<string, string> {
  mkdirSync(screenshotDirectory, { recursive: true });
  const entries = readdirSync(screenshotDirectory, { withFileTypes: true });
  const directories = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (directories.length > 0) throw new Error("PWR-06B-A evidence directory contains an unexpected subdirectory.");
  return Object.fromEntries(entries.map((entry) => [entry.name, sha256(resolve(screenshotDirectory, entry.name))]));
}

function assertBaselinePreserved(
  baseline: Record<string, string>,
  after: Record<string, string>,
  allowedOutputNames: readonly string[],
): void {
  const allowed = new Set(allowedOutputNames);
  const unauthorizedNewFiles = Object.keys(after).filter((name) => !(name in baseline) && !allowed.has(name));
  expect(unauthorizedNewFiles).toEqual([]);
  for (const [name, hash] of Object.entries(baseline)) {
    if (!allowed.has(name)) expect(after[name]).toBe(hash);
  }
}

test.afterAll(async () => {
  if (publicDemo && process.env.PWR06B_CLEANUP_EVIDENCE === "true") {
    const rootRelativePath = relative(process.cwd(), evidenceRoot);
    if (!rootRelativePath || rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
      throw new Error("PWR-06B-A cleanup root is outside the repository temporary root.");
    }
    await fs.rm(evidenceRoot, { recursive: true, force: true });
  }
});

async function saveScreenshot(page: Page, name: string): Promise<string> {
  await waitForStableLayout(page);
  await expectNoHorizontalOverflow(page);
  mkdirSync(screenshotDirectory, { recursive: true });
  const filePath = resolve(screenshotDirectory, name);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: filePath,
  });
  return sha256(filePath);
}

async function expectReadyState(panel: ReturnType<typeof voicePanel>): Promise<void> {
  await expect(panel.getByText("需要麦克风权限", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toBeVisible();
  await expect(panel.getByText("录音中", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("正在转写", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("待医生处理", { exact: true })).toHaveCount(0);
}

async function expectRecordingState(panel: ReturnType<typeof voicePanel>): Promise<void> {
  await expect(panel.getByText("录音中", { exact: true })).toBeVisible();
  await expect(panel.getByText(/00:\d{2} \/ 00:15 · 到时自动识别/u)).toBeVisible();
  await expect(panel.getByRole("progressbar", { name: "录音时长", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "结束并识别", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
}

async function expectTranscribingState(panel: ReturnType<typeof voicePanel>): Promise<void> {
  await expect(panel.getByText("正在转写，请稍候。", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "结束并识别", exact: true })).toHaveCount(0);
}

async function expectReviewState(panel: ReturnType<typeof voicePanel>): Promise<void> {
  await expect(panel.getByText("待医生处理", { exact: true })).toBeVisible();
  const details = panel.locator("details").filter({ hasText: "识别结果" }).first();
  await expect(details).toBeVisible();
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
  await expect(details).toHaveAttribute("open", "");
  await expect(panel.getByRole("textbox", { name: /语音建议/u }).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "写入", exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "忽略", exact: true }).first()).toBeVisible();
}

async function expectPermissionDeniedState(panel: ReturnType<typeof voicePanel>): Promise<void> {
  await expect(panel.getByText("麦克风权限被拒绝", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "重新请求权限", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
}

async function expectFailureState(panel: ReturnType<typeof voicePanel>): Promise<void> {
  await expect(panel.getByText("语音转写失败，原病历内容未改变，仍可手动录入。", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "重新录制", exact: true })).toBeVisible();
  await expect(panel.getByText("录音中", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("待医生处理", { exact: true })).toHaveCount(0);
}

async function captureSeededScreenshot(
  page: Page,
  fixture: string,
  name: string,
  viewport: Viewport,
  assertState: (panel: ReturnType<typeof voicePanel>) => Promise<void>,
): Promise<string> {
  await page.setViewportSize(viewport);
  await openSeededRecord(page, fixture);
  await assertState(voicePanel(page));
  return saveScreenshot(page, name);
}

async function capturePublicScreenshot(page: Page, name: string, viewport: Viewport): Promise<string> {
  await page.setViewportSize(viewport);
  await page.goto("/encounters/demo/record");
  const panel = voicePanel(page);
  await expect(panel.getByText("只读演示不录音", { exact: true })).toBeVisible();
  await expect(panel.getByText("识别结果（0）", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
  return saveScreenshot(page, name);
}

function expectDistinct(hashes: Record<string, string>, names: string[]): void {
  const values = names.map((name) => hashes[name]);
  expect(values.every(Boolean)).toBe(true);
  expect(new Set(values).size).toBe(names.length);
}

test.describe("PWR-06B-A local fake speech workflow", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(publicDemo, "local-research fake-provider suite only");
    await installMicCounter(page);
  });

  test("starts only from an explicit click, reaches review, and keeps capture fake", async ({ page }) => {
    const requests = trackRequests(page);
    await openSeededRecord(page, "permission-required");
    const panel = voicePanel(page);

    await expectReadyState(panel);
    expect(await page.evaluate(() => (window as Window & { __pwr06bGetUserMediaCalls?: number }).__pwr06bGetUserMediaCalls)).toBe(0);
    await panel.getByRole("button", { name: "开始录音", exact: true }).click();
    await expectRecordingState(panel);
    await panel.getByRole("button", { name: "结束并识别", exact: true }).click();
    await expectTranscribingState(panel);
    await expect(panel.getByText("待医生处理", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __pwr06bGetUserMediaCalls?: number }).__pwr06bGetUserMediaCalls)).toBe(0);
    expect(requests.postRequests.filter((url) => url.includes("/api/speech/")).length).toBe(0);
    expect(requests.providerRequests).toEqual([]);
  });

  test("writes and ignores review suggestions without changing source or adding server speech POST", async ({ page }) => {
    const requests = trackRequests(page);
    await openSeededRecord(page, "review");
    const panel = voicePanel(page);
    await panel.locator("details").filter({ hasText: "识别结果" }).locator("summary").click();
    const suggestion = panel.getByRole("textbox", { name: "语音建议 1", exact: true });
    await suggestion.fill("医生确认后的合成口述：现病史待复核。");
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(page.locator('input[name="editableRecord"]')).toHaveValue(/医生确认后的合成口述/u);
    await panel.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(panel.getByText("已忽略", { exact: true })).toBeVisible();
    expect(requests.postRequests.filter((url) => url.includes("/api/speech/")).length).toBe(0);
  });

  test("runs the same fake workflow on a manual synthetic record and preserves manual source", async ({ page }) => {
    await page.goto("/encounters/new/manual");
    await page.locator('select[name="specialty"]').selectOption("普通内科");
    await page.locator('select[name="visitType"]').selectOption("初诊");
    await page.locator('select[name="sex"]').selectOption("FEMALE");
    await page.locator('input[name="age"]').fill("30");
    await page.getByRole("button", { name: "创建病例", exact: true }).click();
    await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
    await page.goto(`${page.url()}?__pwr5Speech=review`);
    const panel = voicePanel(page);
    await expect(panel.getByText("待医生处理", { exact: true })).toBeVisible();
    await panel.locator("details").filter({ hasText: "识别结果" }).locator("summary").click();
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(page.locator('input[name="editableRecord"]')).toHaveValue(/晨起乏力/u);
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "进入AI参考", exact: true })).toBeVisible();
    await expect(page.locator("#reference-form")).toHaveCount(1);
  });

  test("keeps permission denied, failure, cancellation and manual editing recoverable", async ({ page }) => {
    await openSeededRecord(page, "permission-denied");
    const denied = voicePanel(page);
    await expectPermissionDeniedState(denied);
    await denied.getByRole("button", { name: "重新请求权限", exact: true }).click();
    await expectRecordingState(denied);

    await page.goto(`${page.url().split("?")[0]}?__pwr5Speech=failed`);
    const failed = voicePanel(page);
    await expectFailureState(failed);
    await page.getByRole("textbox", { name: "主诉", exact: true }).fill("失败后仍可手动录入。");
    await expect(page.getByRole("textbox", { name: "主诉", exact: true })).toHaveValue("失败后仍可手动录入。");

    await openSeededRecord(page, "transcribing");
    const transcribing = voicePanel(page);
    await expectTranscribingState(transcribing);
    await transcribing.getByRole("button", { name: "取消", exact: true }).click();
    await expect(transcribing.getByText("本次语音已取消，原病历内容未改变。", { exact: true })).toBeVisible();
  });

  test("has no horizontal overflow at the three required widths", async ({ page }) => {
    for (const viewport of [
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await openSeededRecord(page, "permission-required");
      await expectNoHorizontalOverflow(page);
    }
  });

  test("writes local fake visual state screenshots without touching prior evidence folders", async ({ page }) => {
    const baseline = snapshotEvidenceDirectory();
    test.info().annotations.push({
      type: "PWR-06B-A evidence baseline",
      description: Object.entries(baseline).map(([name, hash]) => `${name}:${hash}`).join(", ") || "empty",
    });
    const viewports = [
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ];
    const hashes: Record<string, string> = {};
    for (const viewport of viewports) {
      hashes[`ready-${viewport.width}x${viewport.height}.png`] = await captureSeededScreenshot(
        page,
        "permission-required",
        `ready-${viewport.width}x${viewport.height}.png`,
        viewport,
        expectReadyState,
      );
      hashes[`recording-${viewport.width}x${viewport.height}.png`] = await captureSeededScreenshot(
        page,
        "recording",
        `recording-${viewport.width}x${viewport.height}.png`,
        viewport,
        expectRecordingState,
      );
      hashes[`review-${viewport.width}x${viewport.height}.png`] = await captureSeededScreenshot(
        page,
        "review",
        `review-${viewport.width}x${viewport.height}.png`,
        viewport,
        expectReviewState,
      );
    }
    hashes["transcribing-1366x1024.png"] = await captureSeededScreenshot(
      page,
      "transcribing",
      "transcribing-1366x1024.png",
      { width: 1366, height: 1024 },
      expectTranscribingState,
    );
    hashes["permission-denied-620x1000.png"] = await captureSeededScreenshot(
      page,
      "permission-denied",
      "permission-denied-620x1000.png",
      { width: 620, height: 1000 },
      expectPermissionDeniedState,
    );
    hashes["failure-620x1000.png"] = await captureSeededScreenshot(
      page,
      "failed",
      "failure-620x1000.png",
      { width: 620, height: 1000 },
      expectFailureState,
    );

    expect(Object.keys(hashes).sort()).toEqual(localScreenshotNames);
    const after = snapshotEvidenceDirectory();
    assertBaselinePreserved(baseline, after, localScreenshotNames);
    for (const name of localScreenshotNames) expect(after[name]).toBeDefined();
    expectDistinct(hashes, [
      "ready-1366x1024.png",
      "recording-1366x1024.png",
      "transcribing-1366x1024.png",
      "review-1366x1024.png",
    ]);
    expectDistinct(hashes, [
      "ready-980x900.png",
      "recording-980x900.png",
      "review-980x900.png",
    ]);
    expectDistinct(hashes, [
      "ready-620x1000.png",
      "recording-620x1000.png",
      "review-620x1000.png",
      "permission-denied-620x1000.png",
      "failure-620x1000.png",
    ]);
  });
});

test.describe("PWR-06B-A public-demo boundary", () => {
  test("renders read-only speech state with zero microphone, POST and provider requests", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");
    const baseline = snapshotEvidenceDirectory();
    test.info().annotations.push({
      type: "PWR-06B-A evidence baseline",
      description: Object.entries(baseline).map(([name, hash]) => `${name}:${hash}`).join(", ") || "empty",
    });
    await installMicCounter(page);
    const requests = trackRequests(page);
    await page.goto("/encounters/demo/record");
    const panel = voicePanel(page);
    await expect(panel.getByText("只读演示不录音", { exact: true })).toBeVisible();
    await expect(panel.getByText("识别结果（0）", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("checkbox", { name: "自动归入病史" })).toBeDisabled();
    expect(await page.evaluate(() => (window as Window & { __pwr06bGetUserMediaCalls?: number }).__pwr06bGetUserMediaCalls)).toBe(0);
    expect(requests.postRequests).toEqual([]);
    expect(requests.providerRequests).toEqual([]);
    const publicHash = await capturePublicScreenshot(page, "public-1366x1024.png", { width: 1366, height: 1024 });
    const localNames = [
      "ready-1366x1024.png",
      "recording-1366x1024.png",
      "transcribing-1366x1024.png",
      "review-1366x1024.png",
    ];
    for (const name of localNames) {
      expect(publicHash).not.toBe(sha256(resolve(screenshotDirectory, name)));
    }
    const after = snapshotEvidenceDirectory();
    assertBaselinePreserved(baseline, after, ["public-1366x1024.png"]);
    expect(Object.keys(after).sort()).toEqual(allScreenshotNames);
  });
});
