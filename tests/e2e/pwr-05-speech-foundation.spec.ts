import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";
const screenshotDirectory = resolve(process.cwd(), "test-results/pwr-05");

function trackUnsafeRequests(page: Page): { postRequests: string[]; externalRequests: string[] } {
  const postRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    const pathname = new URL(url).pathname;
    if (request.method() === "POST") postRequests.push(url);
    if (url.includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech)/iu.test(pathname)) {
      externalRequests.push(url);
    }
  });
  return { postRequests, externalRequests };
}

async function openLocalRecord(page: Page, fixture?: string): Promise<string> {
  await page.goto("/encounters/new");
  await page.getByRole("button", { name: "开始接诊", exact: true }).first().click();
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
  if (fixture) await page.goto(`${page.url()}?__pwr5Speech=${fixture}`);
  await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
  return page.url();
}

function speechPanel(page: Page) {
  return page.locator('[aria-labelledby="voice-title"]');
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

test.describe("PWR-05 speech foundation", () => {
  test("keeps the default runtime unconfigured and fail-closed", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const requests = trackUnsafeRequests(page);
    await page.addInitScript(() => {
      const navigatorWithCounter = navigator as Navigator & { __pwr5GetUserMediaCalls?: number };
      navigatorWithCounter.__pwr5GetUserMediaCalls = 0;
      if (navigator.mediaDevices?.getUserMedia) {
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (...args) => {
          navigatorWithCounter.__pwr5GetUserMediaCalls = (navigatorWithCounter.__pwr5GetUserMediaCalls ?? 0) + 1;
          return original(...args);
        };
      }
    });

    await openLocalRecord(page);
    requests.postRequests.length = 0;
    const panel = speechPanel(page);
    await expect(panel.getByText("语音未配置", { exact: true })).toBeVisible();
    const autoAssign = panel.getByRole("checkbox", { name: "自动归入病史" });
    await expect(autoAssign).toBeChecked();
    await expect(autoAssign).toBeDisabled();
    await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
    await expect(panel.getByText("识别结果", { exact: true })).toBeVisible();
    const resultDetails = panel.locator("details").first();
    await expect(resultDetails).toBeVisible();
    expect(await resultDetails.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    expect(await page.evaluate(() => (navigator as Navigator & { __pwr5GetUserMediaCalls?: number }).__pwr5GetUserMediaCalls)).toBe(0);
    expect(requests.postRequests).toEqual([]);
    expect(requests.externalRequests).toEqual([]);
  });

  test("exposes permission, recording, transcription and review states without external requests", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const requests = trackUnsafeRequests(page);
    await openLocalRecord(page, "permission-required");
    const panel = speechPanel(page);
    await expect(panel.getByText("需要麦克风权限", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "开始录音", exact: true }).click();
    await expect(panel.getByText("录音中", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "结束并识别", exact: true }).click();
    await expect(panel.getByText("正在转写，请稍候。", { exact: true })).toBeVisible();
    await expect(panel.getByText("待医生处理", { exact: true })).toBeVisible();
    await expect(panel.getByText("识别结果", { exact: true })).toBeVisible();
    expect(requests.externalRequests).toEqual([]);
  });

  test("keeps denied and failed paths recoverable without changing the record", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    await openLocalRecord(page, "permission-denied");
    const panel = speechPanel(page);
    await expect(panel.getByText("麦克风权限被拒绝", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "重新请求权限", exact: true }).click();
    await expect(panel.getByText("录音中", { exact: true })).toBeVisible();

    await page.goto(`${page.url().split("?")[0]}?__pwr5Speech=failed`);
    const failedPanel = speechPanel(page);
    await expect(failedPanel.getByText("语音转写失败，原病历内容未改变，仍可手动录入。", { exact: true })).toBeVisible();
    await failedPanel.getByRole("button", { name: "重新录制", exact: true }).click();
    await expect(failedPanel.getByText("录音中", { exact: true })).toBeVisible();
  });

  test("keeps recognition results collapsed until the physician opens them and accepts or ignores them", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const requests = trackUnsafeRequests(page);
    await openLocalRecord(page, "review");
    const panel = speechPanel(page);
    await expect(panel.getByText("离线语音可用", { exact: true })).toBeVisible();
    const details = panel.locator("details").filter({ hasText: "识别结果" }).first();
    expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    await details.locator("summary").click();
    const suggestion = panel.getByRole("textbox", { name: "语音建议 1", exact: true });
    const originalText = await suggestion.inputValue();
    const editableRecord = page.locator('input[name="editableRecord"]');
    expect(await editableRecord.inputValue()).not.toContain(originalText);
    await expect(panel.getByRole("textbox", { name: "语音建议 2", exact: true })).toBeVisible();

    await suggestion.fill("医生编辑后的合成语音建议：现病史待复核。");
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(editableRecord).toHaveValue(/医生编辑后的合成语音建议：现病史待复核。/u);
    await expect(panel.getByText("已写入", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(panel.getByText("已忽略", { exact: true })).toBeVisible();
    await expect(panel.getByText("识别结果已处理", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "再录一段", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "进入AI参考", exact: true }).click();
    await expect(page).toHaveURL(/\/reference$/u);
    await expect(page.getByRole("heading", { name: "AI参考", level: 1 })).toBeVisible();
    expect(requests.externalRequests).toEqual([]);
  });

  test("keeps the visible suggestion text authoritative when validation fails", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    await openLocalRecord(page, "review");
    const panel = speechPanel(page);
    await panel.locator("details").filter({ hasText: "识别结果" }).locator("summary").click();
    const suggestion = panel.getByRole("textbox", { name: "语音建议 1", exact: true });
    const editableRecord = page.locator('input[name="editableRecord"]');
    const originalRecord = await editableRecord.inputValue();

    await suggestion.fill("");
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(panel.getByRole("alert")).toContainText("语音建议不能为空");
    await expect(suggestion).toHaveValue("");
    await expect(editableRecord).toHaveValue(originalRecord);
    await expect(panel.getByText("已写入", { exact: true })).toHaveCount(0);

    await suggestion.fill("姓名：合成患者");
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(panel.getByRole("alert")).toContainText("疑似身份信息");
    await expect(editableRecord).toHaveValue(originalRecord);

    const latestText = "医生确认后的最新合成口述";
    await suggestion.fill(latestText);
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(editableRecord).toHaveValue(new RegExp(latestText, "u"));
    await expect(panel.getByText("已写入", { exact: true })).toBeVisible();
  });

  test("requires a target when automatic history assignment is turned off", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    await openLocalRecord(page, "review");
    const panel = speechPanel(page);
    await panel.locator("details").filter({ hasText: "识别结果" }).locator("summary").click();
    await panel.getByRole("checkbox", { name: "自动归入病史" }).uncheck();
    const target = panel.getByRole("combobox", { name: "语音建议 1归入栏目", exact: true });
    const editableRecord = page.locator('input[name="editableRecord"]');
    const originalRecord = await editableRecord.inputValue();
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(panel.getByRole("alert")).toContainText("请先选择归入栏目");
    await expect(editableRecord).toHaveValue(originalRecord);
    await target.selectOption("chiefComplaint");
    await panel.getByRole("button", { name: "写入", exact: true }).first().click();
    await expect(page.locator('input[name="editableRecord"]')).toHaveValue(/晨起乏力/u);
    await expect(panel.getByText("归入：主诉", { exact: true })).toBeVisible();
  });

  test("allows transcription cancellation and keeps late results from reopening the session", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const requests = trackUnsafeRequests(page);
    await openLocalRecord(page, "transcribing");
    requests.postRequests.length = 0;
    const panel = speechPanel(page);
    await expect(panel.getByText("正在转写，请稍候。", { exact: true })).toBeVisible();
    const cancel = panel.getByRole("button", { name: "取消", exact: true });
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(panel.getByText("本次语音已取消，原病历内容未改变。", { exact: true })).toBeVisible();
    await expect(panel.getByText("识别结果", { exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "重新录制", exact: true })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "重新录制", exact: true })).toHaveCount(1);
    await panel.getByRole("button", { name: "重新录制", exact: true }).click();
    await expect(panel.getByText("录音中", { exact: true })).toBeVisible();
    expect(requests.externalRequests).toEqual([]);
    expect(requests.postRequests).toEqual([]);
  });

  test("warns before reference when suggestions remain pending and offers return or ignore-and-continue", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    await openLocalRecord(page, "review");
    const panel = speechPanel(page);
    await expect(panel.getByText("待医生处理", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();

    const reference = page.getByRole("button", { name: "进入AI参考", exact: true });
    await reference.click();
    const prompt = panel.getByRole("status", { name: "未处理语音建议" });
    await expect(prompt).toContainText("仍有 2 条识别结果未处理");
    await expect(prompt).toBeFocused();
    await expect(page).toHaveURL(/\/record\?__pwr5Speech=review$/u);
    await panel.getByRole("button", { name: "返回处理", exact: true }).click();
    await expect(prompt).toHaveCount(0);
    await expect(reference).toBeFocused();

    await reference.click();
    await expect(prompt).toBeVisible();
    await panel.getByRole("button", { name: "忽略并继续", exact: true }).click();
    await expect(page).toHaveURL(/\/reference$/u);
  });

  test("makes the unprocessed prompt visible and keyboard-reachable at 620px", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    await page.setViewportSize({ width: 620, height: 1000 });
    await openLocalRecord(page, "review");
    const panel = speechPanel(page);
    await expect(panel.getByText("待医生处理", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();

    const reference = page.getByRole("button", { name: "进入AI参考", exact: true });
    await reference.click();
    const prompt = panel.getByRole("status", { name: "未处理语音建议" });
    await expect(prompt).toBeVisible();
    await expect(prompt).toBeFocused();
    const promptBox = await prompt.boundingBox();
    expect(promptBox).not.toBeNull();
    expect(promptBox!.y).toBeLessThanOrEqual(1000);
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: "返回处理", exact: true })).toBeFocused();
  });

  test("shows confidence states without filling in missing confidence", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    await openLocalRecord(page, "low-confidence");
    const panel = speechPanel(page);
    await expect(panel.getByText("低置信度 · 42%", { exact: true })).toBeVisible();
    await page.goto(`${page.url().split("?")[0]}?__pwr5Speech=no-confidence`);
    await expect(speechPanel(page).getByText("未提供置信度", { exact: true })).toBeVisible();
  });

  test("saves the three responsive PWR-05 screenshots without changing PWR-04 artifacts", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const recordUrl = await openLocalRecord(page);
    mkdirSync(screenshotDirectory, { recursive: true });
    for (const viewport of [
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(recordUrl);
      await page.evaluate(() => document.fonts.ready);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: resolve(screenshotDirectory, `record-${viewport.width}x${viewport.height}.png`),
      });
    }
  });

  test("keeps public-demo speech read-only before any provider, transaction, or audit work", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");
    const requests = trackUnsafeRequests(page);
    await page.goto("/encounters/demo/record");
    const panel = speechPanel(page);
    await expect(panel.getByText("只读演示不录音", { exact: true })).toBeVisible();
    const autoAssign = panel.getByRole("checkbox", { name: "自动归入病史" });
    await expect(autoAssign).toBeChecked();
    await expect(autoAssign).toBeDisabled();
    await expect(panel.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
    await page.goto("/encounters/demo/record?__pwr5Speech=review");
    await expect(speechPanel(page).getByText("只读演示不录音", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("当前为只读演示，未保存任何内容");
    expect(requests.postRequests).toEqual([]);
    expect(requests.externalRequests).toEqual([]);
  });
});
