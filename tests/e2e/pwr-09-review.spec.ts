import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";
const screenshotDirectory = process.env.PWR09_R1_EVIDENCE === "true" ? "test-results/pwr-09-r1" : "test-results/pwr-09";
const screenshotsEnabled = process.env.PWR09_SCREENSHOTS !== "false";
mkdirSync(screenshotDirectory, { recursive: true });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("header, nav, main, section, article, form")),
    ]
      .filter((element) => element.scrollWidth > viewportWidth + 1)
      .map((element) => ({ tag: element.tagName, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  });
  expect(overflow).toEqual([]);
}

async function expectPageHeightAtMost(page: Page, maximum: number): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeLessThanOrEqual(maximum);
}

async function capture(page: Page, path: string): Promise<void> {
  if (!screenshotsEnabled) return;
  await page.screenshot({ animations: "disabled", fullPage: true, path });
}

async function chooseStatus(page: Page, label: string, option: string): Promise<void> {
  const summary = page.locator(`summary[aria-label="${label}状态"]`);
  if (await summary.count() === 0) return;
  const menu = summary.locator("..");
  const choice = menu.getByRole("button", { name: option, exact: true });
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

async function createSavedReference(page: Page): Promise<void> {
  await page.goto("/encounters/new");
  await page.getByRole("button", { name: "开始接诊", exact: true }).first().click();
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
  await page.getByRole("button", { name: "保存病历", exact: true }).click();
  await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入诊疗参考", exact: true }).click();
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/reference$/u);
}

async function openReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "进入诊疗复核", exact: true }).click();
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/review$/u);
}

test.describe("PWR-09 pre-sign review", () => {
  test("enters through POST, blocks incomplete records, refreshes after a new revision, and confirms only after decisions", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const unsafeRequests: string[] = [];
    const postRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
      if (request.url().includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|provider|speech)/iu.test(request.url())) {
        unsafeRequests.push(request.url());
      }
    });

    await createSavedReference(page);
    await openReview(page);
    const blockedUrl = page.url();
    await expect(page.getByRole("heading", { name: "诊疗复核", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "必填项", level: 2 })).toBeVisible();
    const requiredSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "必填项", level: 2 }) });
    await expect(requiredSection.getByRole("link", { name: "返回病历补充", exact: true })).toHaveCount(1);
    await expect(requiredSection.getByRole("button", { name: "不适用", exact: true })).toHaveCount(0);
    await expect(page.getByText("完成前安全复核", { exact: true })).toHaveCount(1);
    await expect(page.getByText("规则版本", { exact: true })).toHaveCount(0);
    await expect(page.getByText("复核修订", { exact: true })).toHaveCount(0);
    await expect(page.getByText("非必填病史仍未记录", { exact: true })).toHaveCount(0);
    await expect(page.getByText("有一项待补充信息", { exact: true })).toHaveCount(0);

    for (const viewport of [
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(blockedUrl);
      await page.evaluate(() => document.fonts.ready);
      await expectNoHorizontalOverflow(page);
      await expectPageHeightAtMost(page, viewport.width === 1366 ? 1800 : viewport.width === 980 ? 1950 : 2400);
      await capture(page, `${screenshotDirectory}/review-blocked-${viewport.width}x${viewport.height}.png`);
    }

    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto(blockedUrl);
    await page.getByRole("link", { name: "返回病历补充", exact: true }).click();
    await expect(page).toHaveURL(/\/record$/u);

    await confirmPending(page, "过敏史");
    await confirmPending(page, "当前用药");
    await confirmPending(page, "危险信号");
    for (const label of ["实验室检查", "心电检查", "影像检查", "其他辅助检查", "既往史", "个人史", "家族史", "生命体征", "一般情况", "专科体格检查", "未检查/未知项"]) {
      await chooseStatus(page, label, "不适用");
    }
    const chiefComplaint = page.getByRole("textbox", { name: "主诉", exact: true });
    await chiefComplaint.fill(`${await chiefComplaint.inputValue()}（已复核）`);
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #2 已保存。", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "进入诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(/\/reference$/u);
    await openReview(page);

    await expect(page.getByRole("heading", { name: "诊疗复核", level: 1 })).toBeVisible();
    await expect(page.getByText("病历已有更新修订", { exact: true })).toHaveCount(0);
    const notApplicableButtons = page.getByRole("button", { name: /^不适用：/u });
    if (await notApplicableButtons.count() > 0) {
      const button = notApplicableButtons.first();
      const title = (await button.getAttribute("aria-label"))?.replace(/^不适用：/u, "");
      if (!title) throw new Error("review decision button is missing its accessible item title");
      const item = page.getByRole("article", { name: title, exact: true });
      const pendingCount = await page.getByRole("button", { name: /^标记已核对：/u }).count();
      await button.click();
      const reason = page.getByRole("textbox", { name: /^不适用理由：/u }).first();
      await expect(reason).toBeFocused();
      await reason.fill("本次接诊未涉及");
      await page.getByRole("button", { name: /^确认不适用：/u }).first().click();
      await expect(item.getByRole("button", { name: /^(标记已核对|不适用|确认不适用)：/u })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^标记已核对：/u })).toHaveCount(pendingCount - 1);
    }
    const pendingButtons = page.getByRole("button", { name: /^标记已核对：/u });
    for (let count = await pendingButtons.count(); count > 0; count = await pendingButtons.count()) {
      const button = pendingButtons.first();
      const title = (await button.getAttribute("aria-label"))?.replace(/^标记已核对：/u, "");
      if (!title) throw new Error("review decision button is missing its accessible item title");
      const item = page.getByRole("article", { name: title, exact: true });
      await button.click();
      await expect(item.getByRole("button", { name: /^标记已核对：/u })).toHaveCount(0);
      await expect(pendingButtons).toHaveCount(count - 1);
    }
    await expect(page.getByText(/必填项 0 项｜待核对 0 项/u)).toBeVisible();
    await expectPageHeightAtMost(page, 1200);
    await page.getByRole("checkbox", { name: "我已核对以上内容，并确认本次记录由医生最终负责。" }).check();
    await expect(page.getByRole("button", { name: "已核对，完成记录", exact: true })).toBeEnabled();
    await capture(page, `${screenshotDirectory}/review-ready-1366x1024.png`);
    await page.getByRole("button", { name: "已核对，完成记录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "记录已完成", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "已核对，完成记录", exact: true })).toHaveCount(0);
    await capture(page, `${screenshotDirectory}/review-confirmed-1366x1024.png`);
    expect(postRequests.length).toBeGreaterThan(0);
    expect(unsafeRequests).toEqual([]);
  });

  test("public-demo renders a read-only review without POST or external requests", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");
    const postRequests: string[] = [];
    const unsafeRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
      if (request.url().includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|provider|speech)/iu.test(request.url())) {
        unsafeRequests.push(request.url());
      }
    });

    await page.goto("/encounters/demo/review");
    await expect(page.getByRole("heading", { name: "诊疗复核", level: 1 })).toBeVisible();
    await expect(page.getByLabel("复核上下文").getByText("只读预览", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "必填项", level: 2 })).toBeVisible();
    await expect(page.locator("main form")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "已核对，完成记录", exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectPageHeightAtMost(page, 1500);
    await capture(page, `${screenshotDirectory}/review-public-demo-1366x1024.png`);
    expect(postRequests).toEqual([]);
    expect(unsafeRequests).toEqual([]);
  });
});
