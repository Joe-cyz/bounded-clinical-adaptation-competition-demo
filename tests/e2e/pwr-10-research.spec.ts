import { expect, test, type Page } from "@playwright/test";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";

const researchNavigation = [
  "返回医生首页",
  "研究概览",
  "公平对照",
  "医生画像",
  "反馈审核",
  "治理与审计",
  "工程评测",
] as const;

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

async function expectResearchNavigation(page: Page, active: string): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "研究与治理导航" });
  await expect(navigation.getByRole("link")).toHaveCount(researchNavigation.length);
  await expect(navigation.getByRole("link")).toHaveText([...researchNavigation]);
  await expect(navigation.getByRole("link", { name: active, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "返回医生首页", exact: true })).not.toHaveAttribute("aria-current", "page");
}

function trackRequests(page: Page): { post: string[]; unsafe: string[] } {
  const post: string[] = [];
  const unsafe: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (request.method() === "POST") post.push(url);
    const parsed = new URL(url);
    if (
      parsed.hostname !== "127.0.0.1"
      && parsed.hostname !== "localhost"
    ) unsafe.push(url);
    if (url.includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech|provider)/iu.test(parsed.pathname)) {
      unsafe.push(url);
    }
  });
  return { post, unsafe };
}

test.describe("PWR-10 research relocation", () => {
  test("keeps the physician surface separate and exposes the new research routes", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const requests = trackRequests(page);

    await page.goto("/");
    const physicianNavigation = page.getByRole("navigation", { name: "医生主导航" });
    await expect(physicianNavigation.getByRole("link")).toHaveCount(5);
    await expect(physicianNavigation.getByRole("link")).toHaveText(["首页", "病历记录", "诊疗参考", "诊疗复核", "项目说明"]);
    await expect(page.getByRole("navigation", { name: "研究与治理导航" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "研究对照与验证证据", level: 2 })).toBeVisible();
    await expect(page.getByText("查看公平对照、治理记录和工程评测。", { exact: true })).toBeVisible();
    const pageSections = page.locator("main > section");
    await expect(pageSections.last()).toContainText("研究对照与验证证据");
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: "test-results/pwr-10/home-research-section-1366x1024.png",
    });

    await page.getByRole("link", { name: "进入研究页面", exact: true }).click();
    await expect(page).toHaveURL(/\/research$/u);
    await expect(page.getByRole("heading", { name: "研究与治理", level: 1 })).toBeVisible();
    await expect(page.getByText("集中查看公平对照、治理记录和工程评测。", { exact: true })).toBeVisible();
    await expect(page.getByText("仅合成数据", { exact: true })).toBeVisible();
    await expect(page.getByText("临床前原型", { exact: true })).toBeVisible();
    await expectResearchNavigation(page, "研究概览");
    await expect(page.getByRole("main")).not.toContainText(/Provider|Mock|run ID|规则 ID|Prompt/iu);

    const overviewLinks = page.getByRole("main").getByRole("link");
    await expect(overviewLinks).toHaveCount(5);
    await expect(overviewLinks.nth(0)).toHaveText("进入公平对照");
    await expect(overviewLinks.locator("strong")).toHaveText(["医生画像", "反馈审核", "治理与审计", "工程评测"]);

    for (const viewport of [
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/research");
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole("heading", { name: "研究与治理", level: 1 })).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: `test-results/pwr-10/research-${viewport.width}x${viewport.height}.png`,
      });
    }

    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto("/research");
    await page.getByRole("link", { name: "进入公平对照", exact: true }).click();
    await expect(page).toHaveURL(/\/research\/comparison$/u);
    await expect(page.getByRole("heading", { name: /运行一次公平对照/u })).toBeVisible();
    await expectResearchNavigation(page, "公平对照");
    await expect(page.getByRole("button", { name: "运行公平对照", exact: true })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: "test-results/pwr-10/comparison-1366x1024.png",
    });

    await page.setViewportSize({ width: 620, height: 1000 });
    await page.goto("/research/comparison");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: "test-results/pwr-10/comparison-620x1000.png",
    });

    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.goto("/workbench?caseId=legacy-case&anchor=evidence#legacy");
    await expect(page).toHaveURL(/\/workbench\?caseId=legacy-case&anchor=evidence#legacy$/u);
    await expect(page.getByRole("button", { name: "运行公平对照", exact: true })).toBeVisible();
    await expectResearchNavigation(page, "公平对照");
    await expectNoHorizontalOverflow(page);

    expect(requests.post).toEqual([]);
    expect(requests.unsafe).toEqual([]);
  });

  test("keeps research overview and comparison read-only in public-demo", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");
    const requests = trackRequests(page);

    await page.goto("/research");
    await expect(page.getByRole("heading", { name: "研究与治理", level: 1 })).toBeVisible();
    await expect(page.getByText("只读", { exact: true })).toBeVisible();
    await expectResearchNavigation(page, "研究概览");
    await expect(page.getByRole("main")).not.toContainText(/Provider|Mock|run ID|规则 ID|Prompt/iu);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: "test-results/pwr-10/research-public-demo-1366x1024.png",
    });

    await page.goto("/research/comparison");
    await expect(page.getByText("公开只读演示", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "运行公平对照", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Provider 入口")).toBeDisabled();
    await expectResearchNavigation(page, "公平对照");
    await expectNoHorizontalOverflow(page);

    await page.goto("/workbench?caseId=legacy-case&anchor=evidence#legacy");
    await expect(page.getByRole("button", { name: "运行公平对照", exact: true })).toBeDisabled();
    await expectResearchNavigation(page, "公平对照");
    await expectNoHorizontalOverflow(page);

    expect(requests.post).toEqual([]);
    expect(requests.unsafe).toEqual([]);
  });
});
