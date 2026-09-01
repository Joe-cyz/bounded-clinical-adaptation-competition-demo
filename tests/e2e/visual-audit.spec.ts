import { expect, test, type Locator, type Page } from "@playwright/test";

import { captureVerified, waitForStableLayout } from "./capture-verified";

const visualDirectory = process.env.VISUAL_AUDIT_OUTPUT_DIR ?? "test-results/visual-audit";
const productionCapture = visualDirectory.includes("visual-audit-production");

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const elements = [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("main, section")),
    ];
    return elements
      .filter((element) => element.scrollWidth > viewportWidth + 1)
      .map((element) => ({
        tag: element.tagName,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
  });

  expect(overflow).toEqual([]);
}

async function captureEvidence(page: Page, outputPath: string, view: "page-top" | "result-view" = "page-top") {
  await expectNoHorizontalOverflow(page);
  await captureVerified(page, outputPath, view);
}

async function expectNoNextDevelopmentIndicator(page: Page): Promise<void> {
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
  await expect(page.locator("[data-next-badge-root]")).toHaveCount(0);
}

type Box = { left: number; right: number; top: number; bottom: number; width: number };

function boxesOverlap(first: Box, second: Box): boolean {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
}

async function expectEvaluationLayout(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: /固定矩阵/iu });
  const actionGroup = page.getByTestId("evaluation-action-group");
  const actionButtons = page.getByTestId("evaluation-action-buttons");
  const safetyNote = page.getByTestId("evaluation-safety-note");
  const [headingBox, groupBox, buttonsBox, noteBox] = await Promise.all(
    [heading, actionGroup, actionButtons, safetyNote].map((locator) => locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    })),
  );
  expect(boxesOverlap(headingBox, groupBox)).toBe(false);
  expect(boxesOverlap(buttonsBox, noteBox)).toBe(false);
  expect(buttonsBox.width).toBeLessThanOrEqual(groupBox.width + 1);

  const buttonBoxes = await actionButtons.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
  }));
  for (let index = 1; index < buttonBoxes.length; index += 1) {
    expect(boxesOverlap(buttonBoxes[index - 1], buttonBoxes[index])).toBe(false);
  }
}

async function expectFocused(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((element) => document.activeElement === element)).toBe(true);
  const focusStyle = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  });
  expect(focusStyle.outlineStyle !== "none" || focusStyle.boxShadow !== "none").toBe(true);
}

async function expectVisiblePortion(locator: Locator, minimumRatio: number): Promise<void> {
  const viewport = locator.page().viewportSize();
  const box = await locator.boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  const visibleHeight = Math.max(0, Math.min(box!.y + box!.height, viewport!.height) - Math.max(box!.y, 0));
  expect(visibleHeight / box!.height).toBeGreaterThanOrEqual(minimumRatio);
}

function observeRunningButton(page: Page): Promise<boolean> {
  return page.evaluate(() => new Promise<boolean>((resolve) => {
    const button = document.querySelector("[data-testid=run-generation]");
    if (!(button instanceof HTMLButtonElement)) {
      resolve(false);
      return;
    }
    const controlsAreDisabled = () => button.disabled && Array.from(document.querySelectorAll("select")).every((element) => (element as HTMLSelectElement).disabled);
    if (controlsAreDisabled()) {
      resolve(true);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!controlsAreDisabled()) return;
      observer.disconnect();
      resolve(true);
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["disabled"] });
    window.setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, 2_000);
  }));
}

async function expectPageHeading(page: Page, heading: RegExp): Promise<void> {
  const pageHeading = page.getByRole("heading", { level: 1 });
  await expect(pageHeading).toHaveCount(1);
  await expect(pageHeading).toContainText(heading);
  if (productionCapture) await expectNoNextDevelopmentIndicator(page);
}

test.describe.serial("WP-13A browser and visual evidence", () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test("reaches the core pages and captures desktop evidence", async ({ page }) => {
    const pages: Array<[string, RegExp]> = [
      ["/", /记录病历、查阅资料、结束前复核/iu],
      ["/workbench", /运行一次公平对照/iu],
      ["/about", /实现状态、限制与数据政策/iu],
      ["/profiles", /合成医生画像生命周期/iu],
      ["/feedback", /反馈与审核队列/iu],
      ["/audit", /审计时间线/iu],
      ["/evaluation", /工程评测与安全导出/iu],
    ];

    for (const [path, heading] of pages) {
      await page.goto(path);
      await expectPageHeading(page, heading);
    }

    await page.goto("/");
    await captureEvidence(page, `${visualDirectory}/home-1366x768.png`);

    await page.goto("/profiles");
    await captureEvidence(page, `${visualDirectory}/profiles-1366x768.png`);

    await page.goto("/feedback");
    await captureEvidence(page, `${visualDirectory}/feedback-1366x768.png`);

    await page.goto("/audit");
    await captureEvidence(page, `${visualDirectory}/audit-1366x768.png`);

    await page.goto("/evaluation");
    await expect(page.getByRole("button", { name: "运行 Mock 24/72/144 评测" })).toBeVisible();
    const deepSeekButton = page.getByRole("button", { name: /DeepSeek 未启用/iu });
    if (process.env.APP_RUNTIME_MODE === "public-demo") {
      await expect(deepSeekButton).toHaveCount(0);
    } else {
      await expect(deepSeekButton).toBeDisabled();
    }
    await expectEvaluationLayout(page);
    await captureEvidence(page, `${visualDirectory}/evaluation-1366x768.png`);

    for (const viewport of [{ width: 980, height: 900 }, { width: 620, height: 900 }]) {
      await page.setViewportSize(viewport);
      await expectNoHorizontalOverflow(page);
      await expectEvaluationLayout(page);
    }

    await page.setViewportSize({ width: 620, height: 900 });
    await page.goto("/workbench");
    const navigationLinks = [
      page.getByRole("link", { name: "返回医生首页", exact: true }),
      page.getByRole("link", { name: "研究概览", exact: true }),
      page.getByRole("link", { name: "公平对照", exact: true }),
      page.getByRole("link", { name: "医生画像", exact: true }),
      page.getByRole("link", { name: "反馈审核", exact: true }),
      page.getByRole("link", { name: "治理与审计", exact: true }),
      page.getByRole("link", { name: "工程评测", exact: true }),
    ];
    for (const link of navigationLinks) {
      await page.keyboard.press("Tab");
      await expectFocused(link);
      const targetSize = await link.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      expect(targetSize.width).toBeGreaterThanOrEqual(24);
      expect(targetSize.height).toBeGreaterThanOrEqual(24);
    }

    if (process.env.APP_RUNTIME_MODE !== "public-demo") {
      const formControls = [
        page.getByLabel("模拟病例"),
        page.getByLabel("医生画像"),
        page.getByLabel("Provider 入口"),
        page.getByLabel("Mock 场景"),
        page.getByRole("button", { name: "运行公平对照", exact: true }),
      ];
      for (const control of formControls) {
        await page.keyboard.press("Tab");
        await expectFocused(control);
      }
    }
  });

  test("runs one Mock comparison, edits BOUNDED, and captures responsive states", async ({ page }) => {
    await page.goto("/workbench");
    await expectPageHeading(page, /运行一次公平对照/iu);
    if (process.env.APP_RUNTIME_MODE === "public-demo") {
      await expect(page.getByText(/PUBLIC_DEMO_READ_ONLY/u)).toBeVisible();
      await expect(page.getByLabel("模拟病例")).toBeDisabled();
      await expect(page.getByLabel("医生画像")).toBeDisabled();
      await expect(page.getByLabel("Provider 入口")).toBeDisabled();
      await expect(page.getByLabel("Mock 场景")).toBeDisabled();
      await expect(page.getByRole("button", { name: "运行公平对照", exact: true })).toBeDisabled();
      await expectNoHorizontalOverflow(page);
      for (const viewport of [{ width: 980, height: 900 }, { width: 620, height: 900 }]) {
        await page.setViewportSize(viewport);
        await expectNoHorizontalOverflow(page);
      }
      return;
    }
    await expect(page.getByText("运行模式：local-research", { exact: true })).toBeVisible();
    await expect(page.getByText("MOCK · 无网络、无密钥", { exact: true })).toBeVisible();
    await expect(page.getByText("公开只读演示", { exact: true })).toHaveCount(0);

    const caseSelect = page.getByLabel("模拟病例");
    const profileSelect = page.getByLabel("医生画像");
    const providerSelect = page.getByLabel("Provider 入口");
    const mockScenarioSelect = page.getByLabel("Mock 场景");
    const runButton = page.getByRole("button", { name: "运行公平对照", exact: true });

    await expect(caseSelect).toBeEnabled();
    await expect(profileSelect).toBeEnabled();
    await expect(providerSelect).toHaveValue("MOCK");
    await expect(providerSelect.locator("option[value=DEEPSEEK]")).toHaveJSProperty("disabled", true);
    await expect(page.getByText(/ACTIVE · v/iu)).toBeVisible();
    await expect(page.getByText("状态", { exact: true })).toBeVisible();
    await expect(page.getByText(/临床安全已验证/iu)).toHaveCount(0);
    await expect(caseSelect).toBeInViewport();
    await expect(profileSelect).toBeInViewport();
    await expect(providerSelect).toBeInViewport();
    await expect(mockScenarioSelect).toBeInViewport();
    await expect(runButton).toBeInViewport();
    const runButtonBox = await runButton.boundingBox();
    expect(runButtonBox).not.toBeNull();
    expect(runButtonBox!.y + runButtonBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);

    await captureEvidence(page, `${visualDirectory}/workbench-initial-1366x768.png`);
    await page.setViewportSize({ width: 980, height: 900 });
    await captureEvidence(page, `${visualDirectory}/workbench-initial-980x900.png`);
    await page.setViewportSize({ width: 620, height: 900 });
    await captureEvidence(page, `${visualDirectory}/workbench-initial-620x900.png`);
    await expectVisiblePortion(caseSelect, 0.5);
    await page.setViewportSize({ width: 1366, height: 768 });

    await runButton.focus();
    const focusStyle = await runButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
    });
    expect(focusStyle.outlineStyle !== "none" || focusStyle.boxShadow !== "none").toBe(true);
    let actionRequests = 0;
    const providerRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") {
        actionRequests += 1;
      }
      if (request.url().includes("api.deepseek.com")) providerRequests.push(request.url());
    });

    const runningButtonObserved = observeRunningButton(page);
    await runButton.press("Enter");
    expect(await runningButtonObserved).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.getByText("两侧成功", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(runButton).toBeEnabled();
    await expect(caseSelect).toBeEnabled();
    await expect(profileSelect).toBeEnabled();
    await expect(providerSelect).toBeEnabled();
    await expect(mockScenarioSelect).toBeEnabled();
    expect(actionRequests).toBe(1);
    expect(providerRequests).toEqual([]);
    await waitForStableLayout(page);
    await page.waitForTimeout(250);
    expect(actionRequests).toBe(1);

    await expect(page.getByText("结构与规则校验通过", { exact: true })).toHaveCount(2);
    await expect(page.getByText(/需人工复核/iu).first()).toBeVisible();
    await expect(page.getByText(/共享病例 .* 数据集 .* 安全核心 .* 策略/iu)).toBeVisible();
    await expect(page.getByText("终态", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "医院通用草稿", exact: true })).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "受约束适配草稿", exact: true })).toHaveCount(2);
    await expect(page.locator(".generation-attempt").getByText("两侧成功", { exact: true })).toHaveCount(2);

    const generationEvidence = page.locator("details.generation-evidence");
    await expect(generationEvidence).toHaveCount(2);
    await expect(generationEvidence.nth(0)).not.toHaveAttribute("open");
    await expect(generationEvidence.nth(1)).not.toHaveAttribute("open");

    const successAnchor = page.getByRole("heading", { name: "受约束适配草稿", exact: true }).last();
    await successAnchor.scrollIntoViewIfNeeded();
    await captureEvidence(page, `${visualDirectory}/workbench-success-1366x768.png`, "result-view");
    await page.setViewportSize({ width: 980, height: 900 });
    await successAnchor.scrollIntoViewIfNeeded();
    await captureEvidence(page, `${visualDirectory}/workbench-success-980x900.png`, "result-view");
    await page.setViewportSize({ width: 620, height: 900 });
    await successAnchor.scrollIntoViewIfNeeded();
    await captureEvidence(page, `${visualDirectory}/workbench-success-620x900.png`, "result-view");
    await page.setViewportSize({ width: 1366, height: 768 });

    await generationEvidence.nth(0).locator("summary").click();
    await generationEvidence.nth(1).locator("summary").click();
    const runIdLinks = generationEvidence.locator('a[href^="/audit?runId="]');
    await expect(runIdLinks).toHaveCount(2);
    const runIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const link = runIdLinks.nth(index);
      const text = (await link.textContent())?.trim() ?? "";
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^\/audit\?runId=[^&]+$/u);
      expect(text).toMatch(/^generation-run-[A-Za-z0-9._:-]+$/u);
      const decodedRunId = new URL(href!, page.url()).searchParams.get("runId");
      expect(decodedRunId).toBe(text);
      runIds.push(text);
    }
    expect(new Set(runIds).size).toBe(2);

    const configurationLabels = generationEvidence.locator("dt").filter({ hasText: "配置键" });
    await expect(configurationLabels).toHaveCount(2);
    const configurationKeys = await Promise.all(
      [0, 1].map((index) => configurationLabels.nth(index).locator("xpath=following-sibling::dd").textContent()),
    );
    expect(configurationKeys[0]).toBeTruthy();
    expect(configurationKeys[1]).toBeTruthy();
    expect(configurationKeys[0]).not.toBe(configurationKeys[1]);

    const editableSection = page.getByRole("textbox", { name: /修订内容$/iu }).first();
    const disclaimer = page.getByRole("textbox", { name: /使用边界修订内容/iu });
    await expect(editableSection).toBeEditable();
    await expect(disclaimer).toHaveJSProperty("readOnly", true);
    await editableSection.press("Control+End");
    await editableSection.press("Enter");
    await editableSection.type("E2E 结构化修订标记");
    await expect(page.getByRole("list", { name: "未保存字段级差异" })).toBeVisible();
    await expect(page.getByText("栏目顺序变化", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存结构化修订", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "保存结构化修订", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("修订历史", { exact: true })).toBeVisible();
    await expect(page.getByText("真实修订派生反馈", { exact: true })).toBeVisible();
    await expect(page.getByText(/尚未通过反馈门控，不会自动更新画像/iu)).toBeVisible();
  });

  test("blocks one deterministic format failure without retry or provider switch", async ({ page }) => {
    await page.goto("/workbench");
    await expectPageHeading(page, /运行一次公平对照/iu);
    if (process.env.APP_RUNTIME_MODE === "public-demo") {
      await expect(page.getByText(/PUBLIC_DEMO_READ_ONLY/u)).toBeVisible();
      await expect(page.getByLabel("Mock 场景")).toBeDisabled();
      await expect(page.getByRole("button", { name: "运行公平对照", exact: true })).toBeDisabled();
      return;
    }
    await page.getByLabel("Mock 场景").selectOption("INVALID_JSON");

    let actionRequests = 0;
    const providerRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") actionRequests += 1;
      if (request.url().includes("api.deepseek.com")) providerRequests.push(request.url());
    });

    const runButton = page.getByRole("button", { name: "运行公平对照", exact: true });
    await runButton.focus();
    const runningButtonObserved = observeRunningButton(page);
    await runButton.press("Space");
    expect(await runningButtonObserved).toBe(true);
    await page.keyboard.press("Space");
    await expect(page.getByText("运行失败", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("GENERATION_OUTPUT_RULE_BLOCKED", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("OUTPUT_FORMAT_INVALID", { exact: true }).first()).toBeVisible();
    await expect(page.getByLabel("Provider 入口")).toHaveValue("MOCK");
    await expect(page.getByText("失败运行和审计事件已原子写入。", { exact: true }).first()).toBeVisible();
    await waitForStableLayout(page);
    await page.waitForTimeout(250);
    expect(actionRequests).toBe(1);
    expect(providerRequests).toEqual([]);
  });
});
