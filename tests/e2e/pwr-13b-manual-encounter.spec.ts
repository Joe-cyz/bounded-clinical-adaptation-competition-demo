import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";
const screenshotDirectory = "test-results/pwr-13b-ui-r2";
mkdirSync(screenshotDirectory, { recursive: true });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return [document.documentElement, document.body, ...Array.from(document.querySelectorAll("main, header, section, form"))]
      .filter((element) => element.scrollWidth > viewportWidth + 1)
      .map((element) => ({ tag: element.tagName, className: element.className }));
  });
  expect(overflow).toEqual([]);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: `${screenshotDirectory}/${name}.png`,
  });
}

const viewports = [
  { width: 1366, height: 1024 },
  { width: 980, height: 900 },
  { width: 620, height: 1000 },
];

async function expectSelectionEntryLayout(page: Page, viewport: { width: number; height: number }): Promise<void> {
  const layout = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll("main a")).find((candidate) => candidate.textContent?.trim() === "新建病例");
    const heading = document.querySelector("#case-list-title");
    const firstCaseButton = Array.from(document.querySelectorAll("main button")).find((candidate) => candidate.textContent?.trim() === "开始接诊");
    if (!link || !heading || !firstCaseButton) throw new Error("selection entry layout elements are missing");

    const linkRect = link.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const listRect = firstCaseButton.getBoundingClientRect();
    return {
      linkBeforeHeading: Boolean(link.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING),
      headingBeforeList: Boolean(heading.compareDocumentPosition(firstCaseButton) & Node.DOCUMENT_POSITION_FOLLOWING),
      linkTop: linkRect.top,
      headingTop: headingRect.top,
      listTop: listRect.top,
      linkLeft: linkRect.left,
      linkRight: linkRect.right,
      linkWidth: linkRect.width,
      linkHeight: linkRect.height,
    };
  });

  expect(layout.linkBeforeHeading).toBe(true);
  expect(layout.headingBeforeList).toBe(true);
  expect(layout.linkTop).toBeLessThan(layout.headingTop);
  expect(layout.headingTop).toBeLessThan(layout.listTop);
  if (viewport.width <= 620) {
    expect(layout.linkWidth).toBeGreaterThanOrEqual(viewport.width - 40);
    expect(layout.linkHeight).toBeGreaterThanOrEqual(52);
  } else {
    expect(layout.linkWidth).toBeGreaterThanOrEqual(240);
    expect(layout.linkWidth).toBeLessThanOrEqual(280);
    expect(layout.linkHeight).toBeGreaterThanOrEqual(52);
    expect(layout.linkRight).toBeLessThan(viewport.width / 2);
  }
}

test.describe("PWR-13B manual synthetic encounter", () => {
  test("keeps the seeded 24-case entry and completes a manual intake, record save, and refresh", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    const postRequests: string[] = [];
    const providerRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
      if (request.url().includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech)/iu.test(request.url())) {
        providerRequests.push(request.url());
      }
    });

    await page.goto("/encounters/new");
    await expect(page.getByRole("heading", { name: "选择一次接诊", level: 1 })).toBeVisible();
    await expect(page.getByText("24 例可选", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始接诊", exact: true })).toHaveCount(24);
    for (const viewport of viewports) {
      await page.goto("/encounters/new");
      const newEncounterLink = page.getByRole("link", { name: "新建病例", exact: true });
      await expect(newEncounterLink).toHaveCount(1);
      await expect(newEncounterLink).toHaveAttribute("href", "/encounters/new/manual");
      await expect(page.locator(".sectionHeading .primaryButton")).toHaveCount(0);
      await expect(page.getByText("新建模拟病例", { exact: true })).toHaveCount(0);
      await expect(page.getByText("新建并进入病历", { exact: true })).toHaveCount(0);
      await expect(page.getByText("空白 intake", { exact: true })).toHaveCount(0);
      await page.setViewportSize(viewport);
      await expectSelectionEntryLayout(page, viewport);
      await expectNoHorizontalOverflow(page);
      await capture(page, `selection-${viewport.width}x${viewport.height}`);
    }

    await page.goto("/encounters/new/manual");
    await expect(page.getByRole("heading", { name: "新建病例", level: 1, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "接诊信息", level: 2, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "创建病例", exact: true })).toBeVisible();
    await expect(page.getByText("新建模拟病例", { exact: true })).toHaveCount(0);
    await expect(page.getByText("创建并进入病历", { exact: true })).toHaveCount(0);
    await expect(page.getByText("手工 intake", { exact: true })).toHaveCount(0);
    await expect(page.locator("form")).toHaveCount(1);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto("/encounters/new/manual");
      await expect(page.getByRole("heading", { name: "接诊信息", level: 2, exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }

    await page.setViewportSize(viewports[0]);
    await page.goto("/encounters/new/manual");
    await page.locator('select[name="specialty"]').selectOption("普通内科");
    await page.locator('select[name="visitType"]').selectOption("初诊");
    await page.locator('select[name="sex"]').selectOption("FEMALE");
    await page.locator('input[name="age"]').fill("0");
    const createButton = page.getByRole("button", { name: "创建病例", exact: true });
    const postCountBeforeCreate = postRequests.length;
    await createButton.click();
    await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
    expect(postRequests.length - postCountBeforeCreate).toBe(1);

    const recordUrl = page.url();
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
    await expect(page.getByText("合成手工患者-", { exact: false })).toBeVisible();
    const demographics = page.locator('[aria-label="患者基本信息"]');
    await expect(demographics).toContainText("年龄");
    await expect(demographics).toContainText("0岁");
    await expect(demographics).toContainText("未知");
    await expect(demographics.locator("input, textarea, select, button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "进入诊疗参考", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "进入诊疗参考", exact: true })).toHaveCount(0);

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(recordUrl);
      await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "进入诊疗参考", exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    }

    await page.setViewportSize(viewports[0]);
    await page.goto(recordUrl);
    const chiefComplaint = page.getByRole("textbox", { name: "主诉", exact: true });
    await chiefComplaint.fill("头晕两天，待结合完整资料复核。");
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "进入诊疗参考", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "进入诊疗参考", exact: true })).toHaveCount(0);
    await expect(page.locator("#reference-form")).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("textbox", { name: "主诉", exact: true })).toHaveValue("头晕两天，待结合完整资料复核。");
    await expect(page.getByText("已保存 · 修订 #1", { exact: true }).first()).toBeVisible();
    expect(providerRequests).toEqual([]);
  });

  test("surfaces a controlled failure for a forged creation token", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    await page.goto("/encounters/new/manual");
    await page.locator('select[name="specialty"]').selectOption("普通内科");
    await page.locator('select[name="visitType"]').selectOption("初诊");
    await page.locator('select[name="sex"]').selectOption("MALE");
    await page.locator('input[name="age"]').fill("150");
    await page.locator('input[name="creationRequestId"]').evaluate((input) => {
      (input as HTMLInputElement).value = "client-forged-id";
    });
    await page.getByRole("button", { name: "创建病例", exact: true }).click();
    await expect(page.locator('p[role="alert"]')).toContainText("新建请求已失效");
    await expect(page).toHaveURL(/\/encounters\/new\/manual$/u);
    await page.setViewportSize({ width: 620, height: 1000 });
    await expectNoHorizontalOverflow(page);
  });

  test("keeps public-demo manual entry read-only with no form, POST, or provider request", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");

    const postRequests: string[] = [];
    const providerRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
      if (request.url().includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech)/iu.test(request.url())) {
        providerRequests.push(request.url());
      }
    });

    await page.goto("/encounters/new/manual");
    await expect(page.getByRole("heading", { name: "新建病例", level: 1, exact: true })).toBeVisible();
    await expect(page.getByText("公开演示中不能新建病例。", { exact: true })).toBeVisible();
    await expect(page.locator("main form, main input, main select, main button")).toHaveCount(0);
    await expect(page.getByText("数据库", { exact: false })).toHaveCount(0);
    await expect(page.getByText("审计事件", { exact: false })).toHaveCount(0);
    await expect(page.getByText("本地启动器", { exact: false })).toHaveCount(0);
    await expect(page.getByText("手工 intake", { exact: false })).toHaveCount(0);
    await page.setViewportSize(viewports[0]);
    await expectNoHorizontalOverflow(page);

    await page.getByRole("link", { name: "查看只读演示", exact: true }).click();
    await expect(page).toHaveURL("/encounters/demo/record");
    expect(postRequests).toEqual([]);
    expect(providerRequests).toEqual([]);
  });
});
