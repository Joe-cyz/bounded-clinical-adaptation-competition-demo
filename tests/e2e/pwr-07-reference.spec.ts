import { expect, test, type Page } from "@playwright/test";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("header, nav, main, section, article")),
    ]
      .filter((element) => element.scrollWidth > viewportWidth + 1)
      .map((element) => ({
        tag: element.tagName,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
  });

  expect(overflow).toEqual([]);
}

async function createSavedReference(page: Page): Promise<string> {
  await page.goto("/encounters/new");
  await page.getByRole("button", { name: "开始接诊", exact: true }).first().click();
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
  await page.getByRole("button", { name: "保存病历", exact: true }).click();
  await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入诊疗参考", exact: true }).click();
  await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/reference$/u);
  return page.url();
}

test.describe("PWR-07 reference and literature workspace", () => {
  test("local-research uses a saved record, keeps the summary deterministic, and exposes the literature empty state", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    const postRequests: string[] = [];
    const unsafeRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (request.method() === "POST") postRequests.push(url);
      if (url.includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech|provider)/iu.test(new URL(url).pathname)) {
        unsafeRequests.push(url);
      }
    });

    const referenceUrl = await createSavedReference(page);
    postRequests.length = 0;
    unsafeRequests.length = 0;

    await expect(page.getByRole("heading", { name: "诊疗参考", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "病历摘要", level: 2 })).toBeVisible();
    await expect(page.getByText("主诉：", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "文献资料", level: 2 })).toBeVisible();
    await expect(page.getByText("尚未导入", { exact: true })).toBeVisible();
    const expand = page.getByRole("button", { name: "展开", exact: true });
    if (await expand.count() > 0) {
      await expand.click();
      await expect(page.getByRole("button", { name: "收起", exact: true })).toBeVisible();
    }

    for (const viewport of [
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(referenceUrl);
      await page.evaluate(() => document.fonts.ready);
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole("heading", { name: "诊疗参考", level: 1 })).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: `test-results/pwr-07/reference-${viewport.width}x${viewport.height}.png`,
      });
    }

    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto(referenceUrl);
    await page.getByRole("link", { name: "进入文献资料", exact: true }).click();
    await expect(page).toHaveURL(/\/reference\/literature$/u);
    await expect(page.getByRole("heading", { name: "文献资料", level: 1 })).toBeVisible();
    await expect(page.getByText("仅限本地比赛原型", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "选择资料", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始导入", exact: true })).toHaveCount(0);
    await expect(page.getByText("尚未导入资料。", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(1);
    await expect(page.locator('textarea, select, [contenteditable="true"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: "test-results/pwr-07/literature-1366x1024.png",
    });

    await page.setViewportSize({ width: 620, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: "test-results/pwr-07/literature-620x1000.png",
    });

    await page.getByRole("link", { name: "返回诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(referenceUrl);
    await page.getByRole("button", { name: "进入诊疗复核", exact: true }).click();
    await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/review$/u);
    expect(postRequests.length).toBeGreaterThan(0);
    expect(unsafeRequests).toEqual([]);
  });

  test("public-demo exposes the precomputed read-only reference and empty literature workspace", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");

    const postRequests: string[] = [];
    const unsafeRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (request.method() === "POST") postRequests.push(url);
      if (url.includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech|provider)/iu.test(new URL(url).pathname)) {
        unsafeRequests.push(url);
      }
    });

    await page.goto("/encounters/demo/reference");
    await expect(page.getByRole("heading", { name: "诊疗参考", level: 1 })).toBeVisible();
    await expect(page.getByText("合成患者-01", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "病历摘要", level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: "进入文献资料", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "进入文献资料", exact: true }).click();
    await expect(page.getByText("本地资料导入仅在本地模式开放", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "选择资料", exact: true })).toHaveCount(0);
    await expect(page.locator("input, textarea, select, form")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "返回病历", exact: true })).toHaveAttribute(
      "href",
      "/encounters/demo/record",
    );
    await expect(page.getByRole("link", { name: "进入诊疗复核", exact: true })).toHaveAttribute(
      "href",
      "/encounters/demo/review",
    );
    expect(postRequests).toEqual([]);
    expect(unsafeRequests).toEqual([]);
  });

  test("local direct access to a missing Encounter remains controlled", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    const response = await page.goto("/encounters/missing-reference-001/reference/literature");
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByRole("heading", { name: "当前页面无法打开", level: 1 })).toBeVisible();
    await expect(page.getByText("当前接诊不存在，请返回接诊入口。", { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("SQL");
    await expect(page.locator("body")).not.toContainText("recordPayload");
  });
});
