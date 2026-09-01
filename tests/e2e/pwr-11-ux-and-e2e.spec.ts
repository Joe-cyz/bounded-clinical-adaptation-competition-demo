import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";
const evidenceDirectory = resolve(process.cwd(), "test-results/pwr-11");

mkdirSync(evidenceDirectory, { recursive: true });

function trackRequests(page: Page): { postRequests: string[]; unsafeRequests: string[] } {
  const postRequests: string[] = [];
  const unsafeRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    const pathname = new URL(url).pathname;
    if (request.method() === "POST") postRequests.push(url);
    if (url.includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech|provider)/iu.test(pathname)) {
      unsafeRequests.push(url);
    }
  });
  return { postRequests, unsafeRequests };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("header, nav, main, section, article, form")),
    ]
      .filter((element) => element.scrollWidth > viewportWidth + 1)
      .map((element) => ({
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
  });
  expect(overflow).toEqual([]);
}

async function expectPageHeightAtMost(page: Page, maximum: number): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeLessThanOrEqual(maximum);
}

async function expectVisibleFocus(locator: Locator): Promise<void> {
  await locator.focus();
  await expect(locator).toBeFocused();
  const focusStyle = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      boxShadow: style.boxShadow,
    };
  });
  expect(
    (focusStyle.outlineStyle !== "none" && focusStyle.outlineWidth > 0)
      || focusStyle.boxShadow !== "none",
  ).toBe(true);
}

async function chooseStatus(page: Page, label: string, option: string): Promise<void> {
  const summary = page.locator(`summary[aria-label="${label}状态"]`);
  if (await summary.count() === 0) return;
  const choice = summary.locator("..").getByRole("button", { name: option, exact: true });
  if (!(await choice.isVisible())) {
    await page.locator("details[open] > summary").evaluateAll((summaries) => {
      summaries.forEach((element) => (element as HTMLElement).click());
    });
    await summary.click();
  }
  await choice.click();
}

async function confirmPending(page: Page, label: string): Promise<void> {
  const button = page.getByRole("button", { name: `确认${label}`, exact: true });
  if (await button.count() > 0 && await button.isVisible()) await button.click();
}

async function createLocalEncounter(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("记录病历");
  const startLink = page.getByRole("link", { name: "开始接诊", exact: true });
  await expectVisibleFocus(startLink);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/encounters\/new$/u);
  await expect(page.getByRole("heading", { name: "选择一次接诊", level: 1 })).toBeVisible();

  const firstCase = page.getByRole("button", { name: "开始接诊", exact: true }).first();
  await expectVisibleFocus(firstCase);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
  await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
  return page.url();
}

async function saveRecord(page: Page, revisionNumber: number, useKeyboard = false): Promise<void> {
  const save = page.getByRole("button", { name: "保存病历", exact: true });
  if (useKeyboard) {
    await expectVisibleFocus(save);
    await page.keyboard.press("Enter");
  } else {
    await save.click();
  }
  await expect(page.getByText(`修订 #${revisionNumber} 已保存。`, { exact: true })).toBeVisible();
  await expect(page.getByText(`已保存 · 修订 #${revisionNumber}`, { exact: true }).first()).toBeVisible();
}

async function processReviewItems(page: Page): Promise<void> {
  const pending = page.locator('section[aria-labelledby="pending-title"]');
  const notApplicable = pending.locator('button[aria-label^="不适用："]:visible');
  while (await pending.isVisible()) {
    await expect(pending).toBeVisible();
    const action = notApplicable.first();
    if (!(await action.isVisible())) break;
    const before = await notApplicable.count();
    if (before === 0) break;
    await expect(action).toBeVisible();
    await action.click();
    const reason = page.getByRole("textbox", { name: /^不适用理由：/u }).last();
    await expect(reason).toBeFocused();
    await reason.fill("本次接诊未涉及");
    await page.getByRole("button", { name: /^确认不适用：/u }).last().click();
    await expect(notApplicable).toHaveCount(before - 1);
  }

  const checked = pending.locator('button[aria-label^="标记已核对："]:visible');
  while (await pending.isVisible()) {
    await expect(pending).toBeVisible();
    const action = checked.first();
    if (!(await action.isVisible())) break;
    const before = await checked.count();
    if (before === 0) break;
    await expect(action).toBeVisible();
    await action.click({ noWaitAfter: true });
    await expect(checked).toHaveCount(before - 1);
  }
}

async function expectRecordResponsive(page: Page, recordUrl: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width === 620 ? 1000 : 900 });
  await page.goto(recordUrl);
  await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const layout = await page.evaluate(() => {
    const sheet = document.querySelector('[aria-label="病历工作表"]')?.getBoundingClientRect();
    const voice = document.querySelector('[aria-labelledby="voice-title"]')?.getBoundingClientRect();
    return {
      sheetBottom: sheet?.bottom ?? 0,
      sheetRight: sheet?.right ?? 0,
      voiceTop: voice?.top ?? 0,
      voiceLeft: voice?.left ?? 0,
    };
  });
  if (width <= 980) {
    expect(layout.voiceTop).toBeGreaterThanOrEqual(layout.sheetBottom - 1);
  } else {
    expect(layout.voiceLeft).toBeGreaterThan(layout.sheetRight);
  }
}

async function expectPageResponsive(
  page: Page,
  url: string,
  heading: string,
  widths: number[] = [1366, 980, 620],
): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 620 ? 1000 : 900 });
    await page.goto(url);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
}

test.describe("PWR-11 physician workflow UX and E2E", () => {
  test("completes an isolated local-research physician journey from home to confirmation", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const requests = trackRequests(page);
    await page.setViewportSize({ width: 1366, height: 1024 });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("记录病历");
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/01-home-1366x1024.png` });
    const recordUrl = await createLocalEncounter(page);
    await expect(page.getByText("合成患者-01", { exact: true })).toBeVisible();
    await expect(page.locator('[aria-label="患者基本信息"] input, [aria-label="患者基本信息"] textarea, [aria-label="患者基本信息"] select, [aria-label="患者基本信息"] button')).toHaveCount(0);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/02-record-1366x1024.png` });

    await expectRecordResponsive(page, recordUrl, 980);
    await expectRecordResponsive(page, recordUrl, 620);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/03-record-620x1000.png` });
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto(recordUrl);
    await expect(page.getByText("语音未配置", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始录音", exact: true })).toHaveCount(0);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/04-speech-unconfigured-1366x1024.png` });

    await page.goto(`${recordUrl}?__pwr5Speech=review`);
    const speechPanel = page.locator('[aria-labelledby="voice-title"]');
    await expect(speechPanel.getByText("待医生处理", { exact: true })).toBeVisible();
    const recognitionDetails = speechPanel.locator("details").filter({ hasText: "识别结果" });
    await recognitionDetails.locator("summary").click();
    await expect(speechPanel.getByRole("textbox", { name: "语音建议 1", exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/05-speech-suggestions-expanded-1366x1024.png` });

    await page.goto(recordUrl);
    await page.getByRole("textbox", { name: "主诉", exact: true }).fill("医生补充的合成主诉：晨起乏力，已完成首次核对。");
    await saveRecord(page, 1, true);
    await page.getByRole("button", { name: "进入诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/reference$/u);
    const referenceUrl = page.url();
    await expect(page.getByRole("heading", { name: "诊疗参考", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "病历摘要", level: 2 })).toBeVisible();
    const expand = page.getByRole("button", { name: "展开", exact: true });
    if (await expand.count() > 0) {
      await expand.click();
      await expect(page.getByRole("button", { name: "收起", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "收起", exact: true }).click();
    }
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/06-reference-1366x1024.png` });
    await expectPageResponsive(page, referenceUrl, "诊疗参考");

    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto(referenceUrl);
    await page.getByRole("link", { name: "进入文献资料", exact: true }).click();
    await expect(page).toHaveURL(/\/reference\/literature$/u);
    const literatureUrl = page.url();
    await expect(page.getByRole("heading", { name: "文献资料", level: 1 })).toBeVisible();
    await expect(page.getByText("尚未导入文献，暂不能基于资料回答", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "导入资料", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "从资料中提问", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "查看引用", exact: true })).toBeDisabled();
    await expect(page.locator('input[type="file"], textarea, select, [contenteditable="true"]')).toHaveCount(0);
    await expectPageResponsive(page, literatureUrl, "文献资料");
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto(literatureUrl);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/07-literature-empty-1366x1024.png` });
    await page.getByRole("link", { name: "返回诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(referenceUrl);
    const reviewEntry = page.getByRole("button", { name: "进入诊疗复核", exact: true });
    await page.getByRole("link", { name: "返回病历", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(reviewEntry).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/review$/u);

    const blockedReviewUrl = page.url();
    await expect(page.getByRole("heading", { name: "诊疗复核", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "必填项", level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: "返回病历补充", exact: true })).toHaveCount(1);
    await expect(page.getByText("规则版本", { exact: true })).toHaveCount(0);
    await expect(page.getByText("有一项待补充信息", { exact: true })).toHaveCount(0);
    await expectPageResponsive(page, blockedReviewUrl, "诊疗复核");
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto(blockedReviewUrl);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/08-review-blocked-1366x1024.png` });

    await page.getByRole("link", { name: "返回病历补充", exact: true }).click();
    await expect(page).toHaveURL(/\/record$/u);
    await confirmPending(page, "过敏史");
    await confirmPending(page, "当前用药");
    await confirmPending(page, "危险信号");
    for (const label of ["实验室检查", "心电检查", "影像检查", "其他辅助检查", "既往史", "个人史", "家族史", "生命体征", "一般情况", "专科体格检查", "未检查/未知项"]) {
      await chooseStatus(page, label, "不适用");
    }
    const chiefComplaint = page.getByRole("textbox", { name: "主诉", exact: true });
    await chiefComplaint.fill(`${await chiefComplaint.inputValue()}（补充后重新复核）`);
    await saveRecord(page, 2);
    await page.getByRole("link", { name: "进入诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(referenceUrl);
    await page.getByRole("button", { name: "进入诊疗复核", exact: true }).click();
    await expect(page).toHaveURL(/\/review$/u);
    await expect(page.getByText("病历版本", { exact: true })).toBeVisible();
    await expect(page.getByText("第 2 版", { exact: true })).toBeVisible();
    await processReviewItems(page);
    await expect(page.getByText("必填项 0 项｜待核对 0 项", { exact: true })).toBeVisible();
    await expectPageHeightAtMost(page, 1200);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/09-review-ready-1366x1024.png` });

    const declaration = page.getByRole("checkbox", { name: "我已核对以上内容，并确认本次记录由医生最终负责。" });
    await declaration.focus();
    await expect(declaration).toBeFocused();
    await page.keyboard.press("Space");
    const confirm = page.getByRole("button", { name: "已核对，完成记录", exact: true });
    await expect(confirm).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: /诊疗复核.*记录已完成/u, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "记录已完成", level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "已核对，完成记录", exact: true })).toHaveCount(0);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/10-review-confirmed-1366x1024.png` });
    const confirmedUrl = page.url();
    await page.reload();
    await expect(page.getByRole("heading", { name: /诊疗复核.*记录已完成/u, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "已核对，完成记录", exact: true })).toHaveCount(0);
    await page.goto(confirmedUrl);
    await expect(page.getByRole("heading", { name: /诊疗复核.*记录已完成/u, level: 1 })).toBeVisible();

    expect(requests.postRequests.length).toBeGreaterThan(0);
    expect(requests.unsafeRequests).toEqual([]);
  });

  test("keeps the unprocessed speech guardrail keyboard-reachable and preserves the record", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const requests = trackRequests(page);
    const recordUrl = await createLocalEncounter(page);
    await page.goto(`${recordUrl}?__pwr5Speech=review`);
    const panel = page.locator('[aria-labelledby="voice-title"]');
    await expect(panel.getByText("待医生处理", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();
    const reference = page.getByRole("button", { name: "进入诊疗参考", exact: true });
    await reference.click();
    const prompt = panel.getByRole("status", { name: "未处理语音建议" });
    await expect(prompt).toBeFocused();
    await expect(prompt).toContainText("仍有 2 条识别结果未处理");
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name: "返回处理", exact: true })).toBeFocused();
    await panel.getByRole("button", { name: "返回处理", exact: true }).click();
    await expect(prompt).toHaveCount(0);
    await expect(reference).toBeFocused();
    await reference.click();
    await panel.getByRole("button", { name: "忽略并继续", exact: true }).click();
    await expect(page).toHaveURL(/\/reference$/u);
    expect(requests.unsafeRequests).toEqual([]);
  });

  test("keeps the public-demo journey readable and strictly read-only", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");
    const requests = trackRequests(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("记录病历");
    await page.getByRole("link", { name: "开始接诊", exact: true }).click();
    await expect(page).toHaveURL("/encounters/demo/record");
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
    const controls = page.locator("main input, main textarea, main select");
    expect(await controls.count()).toBeGreaterThan(0);
    expect(await controls.evaluateAll((elements) => elements.every((element) => (element as HTMLInputElement).disabled))).toBe(true);
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/11-public-readonly-1366x1024.png` });
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("当前为只读演示，未保存任何内容");
    await page.getByRole("link", { name: "进入诊疗参考", exact: true }).click();
    await expect(page.getByRole("heading", { name: "诊疗参考", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: "进入文献资料", exact: true }).click();
    await expect(page.getByRole("heading", { name: "文献资料", level: 1 })).toBeVisible();
    await expect(page.getByText("尚未导入文献，暂不能基于资料回答", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "导入资料", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "从资料中提问", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "查看引用", exact: true })).toBeDisabled();
    await expect(page.locator("input, textarea, select, form")).toHaveCount(0);
    await page.getByRole("link", { name: "进入诊疗复核", exact: true }).click();
    await expect(page).toHaveURL("/encounters/demo/review");
    await expect(page.getByRole("heading", { name: "诊疗复核", level: 1 })).toBeVisible();
    await expect(page.locator("main form")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "已核对，完成记录", exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(requests.postRequests).toEqual([]);
    expect(requests.unsafeRequests).toEqual([]);
  });

  test("keeps the research overview reachable without exposing it in physician navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "医生主导航" }).getByRole("link")).toHaveText([
      "首页",
      "病历记录",
      "诊疗参考",
      "诊疗复核",
      "项目说明",
    ]);
    await page.getByRole("link", { name: "进入研究页面", exact: true }).click();
    await expect(page).toHaveURL("/research");
    await expect(page.getByRole("heading", { name: "研究与治理", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "研究与治理导航" }).getByRole("link")).toHaveText([
      "返回医生首页",
      "研究概览",
      "公平对照",
      "医生画像",
      "反馈审核",
      "治理与审计",
      "工程评测",
    ]);
    await expectNoHorizontalOverflow(page);
    if (!publicDemo) {
      await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}/12-research-1366x1024.png` });
    }
  });
});
