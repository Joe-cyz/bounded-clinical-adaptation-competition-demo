import { expect, test, type Locator, type Page } from "@playwright/test";

const physicianNavigation = [
  { label: "首页", href: "/" },
  { label: "病历记录", href: "/encounters/demo/record" },
  { label: "诊疗参考", href: "/encounters/demo/reference" },
  { label: "诊疗复核", href: "/encounters/demo/review" },
  { label: "项目说明", href: "/about" },
] as const;

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
        className: element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
  });

  expect(overflow).toEqual([]);
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

test.describe("PWR-01 doctor-first shell", () => {
  test("shows exactly five physician navigation items and a focused homepage", async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto("/");

    const navigation = page.getByRole("navigation", { name: "医生主导航" });
    const links = navigation.getByRole("link");
    await expect(links).toHaveCount(physicianNavigation.length);
    await expect(links).toHaveText(physicianNavigation.map(({ label }) => label));

    for (const { label, href } of physicianNavigation) {
      await expect(navigation.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
    }

    await expect(navigation.getByRole("link", { name: "首页", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("记录病历、查阅资料、结束前复核");
    await expect(page.getByText("从一次接诊开始，按日常顺序完成记录与复核。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "病历记录", level: 2 })).toBeVisible();
    await expect(page.getByText("记录病史与检查", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "诊疗参考", level: 2 })).toBeVisible();
    await expect(page.getByText("查阅资料与辅助判断", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "诊疗复核", level: 2 })).toBeVisible();
    await expect(page.getByText("确认遗漏项", { exact: true })).toBeVisible();
    await expect(page.getByText("合成患者-01", { exact: true })).toBeVisible();
    await expect(page.getByText("2026-08-21", { exact: true })).toBeVisible();
    await expect(page.getByText("病历待完善", { exact: true })).toBeVisible();
    await expect(page.locator('img[src*="physician-workflow-line-art.png"]')).toBeVisible();

    const visibleCopy = await page.locator("body").innerText();
    expect(visibleCopy).not.toMatch(
      /Workbench|Provider|Mock|Profiles|Feedback|Prompt|run ID|configuration key/iu,
    );
    await expectVisibleFocus(page.getByRole("link", { name: "开始接诊", exact: true }));
    expect(browserErrors).toEqual([]);
  });

  test("starts the walkthrough without POST or DeepSeek requests", async ({ page }) => {
    test.skip(publicDemo, "local-research only");
    const postRequests: string[] = [];
    const deepSeekRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
      if (request.url().includes("api.deepseek.com")) deepSeekRequests.push(request.url());
    });

    await page.goto("/");
    await page.getByRole("link", { name: "开始接诊", exact: true }).click();
    await expect(page).toHaveURL(/\/encounters\/new$/u);
    await expect(page.getByRole("heading", { name: "选择一次接诊", level: 1 })).toBeVisible();
    expect(postRequests).toEqual([]);
    expect(deepSeekRequests).toEqual([]);
  });

  test("keeps the public-demo reference page as a read-only clinical surface", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");

    const response = await page.goto("/encounters/demo/reference");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: "诊疗参考", level: 1 })).toBeVisible();
    await expect(page.getByText("合成患者-01", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "病历摘要", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "文献资料", level: 2 })).toBeVisible();
    await expect(page.getByText("尚未导入", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "进入文献资料", exact: true })).toHaveAttribute(
      "href",
      "/encounters/demo/reference/literature",
    );
    await expect(page.locator("main").locator("form, input, textarea, select")).toHaveCount(0);
    await expect(page.getByText("完整功能尚未接入，本页仅用于确认医生主线与页面跳转。")).toHaveCount(0);
  });

  test("keeps the public diagnostic review as a read-only PWR-09 surface", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");

    const response = await page.goto("/encounters/demo/review");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: "诊疗复核", level: 1 })).toBeVisible();
    await expect(page.getByText("合成患者-01", { exact: true })).toBeVisible();
    await expect(page.getByLabel("复核上下文").getByText("只读预览", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "必填项", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "待核对", level: 2 })).toBeVisible();
    await expect(page.locator("main").locator("form")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "返回诊疗参考", exact: true })).toBeVisible();
    await expect(page.getByText("完整功能尚未接入，本页仅用于确认医生主线与页面跳转。")).toHaveCount(0);
  });

  test("does not create a review on a local direct demo URL", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    const response = await page.goto("/encounters/demo/review");
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByRole("heading", { name: "当前页面无法打开", level: 1 })).toBeVisible();
    await expect(page.getByText("当前接诊不存在，请返回接诊入口。", { exact: true })).toBeVisible();
    await expect(page.locator("main").locator("form")).toHaveCount(0);
    await expect(page.getByText("完整功能尚未接入，本页仅用于确认医生主线与页面跳转。")).toHaveCount(0);
  });

  test("keeps the public-demo record page as a full read-only PWR-04 surface", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");

    const postRequests: string[] = [];
    const unsafeRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (request.method() === "POST") postRequests.push(url);
      if (url.includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech)/iu.test(new URL(url).pathname)) {
        unsafeRequests.push(url);
      }
    });

    await page.goto("/encounters/demo/record");
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
    await expect(page.getByText("合成患者-01", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "病史", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "检查", level: 2 })).toBeVisible();
    await expect(page.getByText("只读预览", { exact: true })).toHaveCount(1);

    const controls = page.locator("main input, main textarea, main select");
    expect(await controls.count()).toBeGreaterThan(0);
    expect(await controls.evaluateAll((elements) => elements.every((element) => (
      (element as HTMLInputElement).disabled || (element as HTMLInputElement).readOnly
    )))).toBe(true);

    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("当前为只读演示，未保存任何内容");
    await expect(page.getByRole("link", { name: "进入诊疗参考", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "进入诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(/\/encounters\/demo\/reference$/u);
    await expect(page.getByRole("heading", { name: "病历摘要", level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: "进入文献资料", exact: true })).toBeVisible();

    expect(postRequests).toEqual([]);
    expect(unsafeRequests).toEqual([]);
  });

  test("keeps existing research and governance routes available", async ({ page }) => {
    for (const path of ["/workbench", "/profiles", "/feedback", "/audit", "/evaluation"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBeLessThan(400);
      await expect(page.getByRole("navigation", { name: "研究与治理导航" })).toBeVisible();
      await expect(page.getByRole("link", { name: "返回医生首页", exact: true })).toHaveAttribute("href", "/");
      await expect(page.getByRole("navigation", { name: "医生主导航" })).toHaveCount(0);
    }
  });

  test("remains usable without horizontal overflow at required widths", async ({ page }) => {
    for (const viewport of [
      { width: 1488, height: 1057 },
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready);
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole("link", { name: "开始接诊", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "继续记录", exact: true })).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: `test-results/pwr-01/home-${viewport.width}x${viewport.height}.png`,
      });
    }
  });
});
