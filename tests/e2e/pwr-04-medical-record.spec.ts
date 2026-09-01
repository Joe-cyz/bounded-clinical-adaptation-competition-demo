import { expect, test, type Locator, type Page } from "@playwright/test";

const publicDemo = process.env.APP_RUNTIME_MODE === "public-demo";

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("header, main, section, article, form")),
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

async function chooseStatus(page: Page, label: string, option: string): Promise<void> {
  const summary = page.locator(`summary[aria-label="${label}状态"]`);
  const menu = summary.locator("..");
  const optionButton = menu.getByRole("button", { name: option, exact: true });
  if (!(await optionButton.isVisible())) await summary.click();
  await optionButton.click();
}

test.describe("PWR-04 medical record page", () => {
  test("creates and saves immutable medical record revisions before entering reference", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    const aiRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech)/iu.test(request.url())) {
        aiRequests.push(request.url());
      }
    });

    await page.goto("/encounters/new");
    await expect(page.getByRole("heading", { name: "选择一次接诊", level: 1 })).toBeVisible();
    await expect(page.getByText("24 例可选", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始接诊", exact: true })).toHaveCount(24);
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: "test-results/pwr-04/encounter-selection-1366x1024.png",
    });

    await page.getByRole("button", { name: "开始接诊", exact: true }).first().click();
    await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/record$/u);
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
    await expect(page.getByText("语音录入", { exact: true })).toBeVisible();
    await expect(page.getByText("未配置", { exact: true }).first()).toBeVisible();
    const demographics = page.locator('[aria-label="患者基本信息"]');
    await expect(demographics).toContainText("合成患者-01");
    await expect(demographics).toContainText("籍贯/居住地");
    await expect(demographics.locator("input, textarea, select, button")).toHaveCount(0);
    await expect(page.getByText("合成区域", { exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-label="病历工作表"] > section')).toHaveCount(3);
    await expect(page.locator('[aria-label="病历工作表"] [class*="fieldCard"]')).toHaveCount(0);
    await expect(page.locator('summary[aria-label="主诉状态"]')).toHaveCount(0);
    await expect(page.getByText("状态", { exact: true })).toHaveCount(0);
    await expect(page.locator('summary[aria-label="既往史状态"]')).toHaveText("未记录");
    await expect(page.getByRole("button", { name: "确认过敏史", exact: true })).toBeVisible();
    await expect(page.getByText("待确认", { exact: true }).first()).toBeVisible();
    const auxiliaryDateInputs = page.locator('input[type="date"][aria-label$="检查日期"]');
    await expect(auxiliaryDateInputs).toHaveCount(0);

    const chiefComplaint = page.getByRole("textbox", { name: "主诉", exact: true });
    await chiefComplaint.fill("");
    const chiefComplaintStatus = page.locator('summary[aria-label="主诉状态"]');
    await expect(chiefComplaintStatus).toHaveText("未记录");
    await expect(page.getByText("状态", { exact: true })).toHaveCount(0);
    await chooseStatus(page, "主诉", "不适用");
    await expect(page.locator('summary[aria-label="主诉状态"]')).toHaveText("不适用");
    await chiefComplaint.fill("医生补充的合成主诉：症状已重新核对。");
    await expect(page.locator('summary[aria-label="主诉状态"]')).toHaveCount(0);

    const problemFacts = page.getByRole("textbox", { name: "已提供的问题事实", exact: true });
    const problemFactsOriginalValue = await problemFacts.inputValue();
    await problemFacts.fill("");
    await expect(page.locator('summary[aria-label="已提供的问题事实状态"]')).toHaveText("未记录");
    await problemFacts.fill(problemFactsOriginalValue);
    await expect(page.locator('summary[aria-label="已提供的问题事实状态"]')).toHaveCount(0);

    const temperature = page.getByRole("spinbutton", { name: "体温", exact: true });
    const vitalDate = page.getByLabel("生命体征测量日期", { exact: true });
    await temperature.fill("36.5");
    await vitalDate.fill("2026-08-21");
    await temperature.fill("");
    await expect(vitalDate).toHaveValue("");
    await expect(vitalDate).toBeDisabled();
    await expect(page.locator('summary[aria-label="生命体征状态"]')).toHaveText("未记录");

    await chooseStatus(page, "实验室检查", "已有结果");
    const laboratoryResult = page.getByLabel("实验室检查结果", { exact: true });
    const laboratoryDate = page.getByLabel("实验室检查日期", { exact: true });
    await expect(laboratoryDate).toBeVisible();
    await laboratoryResult.fill("合成实验室结果待医生复核");
    await laboratoryDate.fill("2026-08-21");
    await laboratoryResult.fill("");
    await expect(page.getByLabel("实验室检查日期", { exact: true })).toHaveCount(0);
    await expect(page.locator('summary[aria-label="实验室检查状态"]')).toHaveText("未记录");
    await chooseStatus(page, "实验室检查", "不适用");
    await expect(page.locator('summary[aria-label="实验室检查状态"]')).toHaveText("不适用");
    await chooseStatus(page, "实验室检查", "已有结果");
    await laboratoryResult.fill("合成实验室结果待医生复核");
    await expect(laboratoryDate).toBeVisible();
    await laboratoryDate.fill("2026-08-21");

    const allergy = page.getByRole("textbox", { name: "过敏史", exact: true });
    const allergyOriginalValue = await allergy.inputValue();
    await page.getByRole("button", { name: "确认过敏史", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认过敏史", exact: true })).toHaveCount(0);
    await allergy.fill("");
    await expect(page.locator('summary[aria-label="过敏史状态"]')).toHaveText("未记录");
    await chooseStatus(page, "过敏史", "不适用");
    await expect(page.locator('summary[aria-label="过敏史状态"]')).toHaveText("不适用");
    await allergy.fill(allergyOriginalValue);
    await expect(page.locator('summary[aria-label="过敏史状态"]')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
    await chooseStatus(page, "实验室检查", "已有结果");
    await laboratoryResult.fill("合成实验室结果待医生复核");
    await expect(laboratoryDate).toBeVisible();
    await expect(auxiliaryDateInputs).toHaveCount(1);
    const recognitionDetails = page.locator("details").filter({ hasText: "识别结果" });
    await expect(recognitionDetails).toHaveCount(1);
    expect(await recognitionDetails.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    await expectVisibleFocus(page.getByRole("textbox", { name: "主诉", exact: true }));

    const recordUrl = page.url();
    await page.getByRole("textbox", { name: "主诉", exact: true }).fill("医生补充的合成主诉：晨起乏力，待结合完整资料复核。");
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #1 已保存。", { exact: true })).toBeVisible();
    await expect(page.getByText("已保存 · 修订 #1", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "进入诊疗参考", exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText("已保存 · 修订 #1", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "主诉", exact: true })).toHaveValue("医生补充的合成主诉：晨起乏力，待结合完整资料复核。");

    await page.getByRole("textbox", { name: "主诉", exact: true }).fill("医生再次补充的合成主诉：晨起乏力，持续时间已核对。");
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByText("修订 #2 已保存。", { exact: true })).toBeVisible();
    await expect(page.getByText("已保存 · 修订 #2", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "进入诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(/\/encounters\/[A-Za-z0-9._:-]+\/reference$/u);
    await expect(page.getByRole("heading", { name: "诊疗参考", level: 1 })).toBeVisible();
    await expect(page.getByText("合成患者-01", { exact: true })).toBeVisible();
    expect(aiRequests).toEqual([]);

    await page.goto(recordUrl);
    for (const viewport of [
      { width: 1366, height: 1024 },
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(recordUrl);
      await page.evaluate(() => document.fonts.ready);
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
      const boxes = await page.evaluate(() => {
        const sheet = document.querySelector('[aria-label="病历工作表"]')?.getBoundingClientRect();
        const voice = document.querySelector('[aria-labelledby="voice-title"]')?.getBoundingClientRect();
        return {
          sheetBottom: sheet?.bottom ?? 0,
          sheetRight: sheet?.right ?? 0,
          voiceTop: voice?.top ?? 0,
          voiceLeft: voice?.left ?? 0,
        };
      });
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      if (viewport.width === 1366) expect(pageHeight).toBeLessThan(2_000);
      if (viewport.width === 980) expect(pageHeight).toBeLessThan(2_200);
      if (viewport.width === 620) expect(pageHeight).toBeLessThan(3_000);
      if (viewport.width <= 980) {
        expect(boxes.voiceTop).toBeGreaterThanOrEqual(boxes.sheetBottom - 1);
      } else {
        expect(boxes.voiceLeft).toBeGreaterThan(boxes.sheetRight);
      }
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: `test-results/pwr-04/record-${viewport.width}x${viewport.height}.png`,
      });
    }
  });

  test("closes status menus on outside click, Escape, another menu, and selection", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    await page.goto("/encounters/new");
    await page.getByRole("button", { name: "开始接诊", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();

    const pastHistorySummary = page.locator('summary[aria-label="既往史状态"]');
    const pastHistoryMenu = pastHistorySummary.locator("..");
    await pastHistorySummary.click();
    await expect(pastHistoryMenu).toHaveJSProperty("open", true);
    await page.getByRole("heading", { name: "病史", exact: true }).click();
    await expect(pastHistoryMenu).toHaveJSProperty("open", false);
    await expect(pastHistoryMenu.getByRole("button", { name: "不适用", exact: true })).toBeHidden();

    const allergySummary = page.locator('summary[aria-label="过敏史状态"]');
    const allergyMenu = allergySummary.locator("..");
    await allergySummary.click();
    await expect(allergyMenu).toHaveJSProperty("open", true);
    await page.keyboard.press("Escape");
    await expect(allergyMenu).toHaveJSProperty("open", false);
    await expect(allergySummary).toBeFocused();

    const vitalSummary = page.locator('summary[aria-label="生命体征状态"]');
    const vitalMenu = vitalSummary.locator("..");
    await pastHistorySummary.click();
    await expect(pastHistoryMenu).toHaveJSProperty("open", true);
    await vitalSummary.click();
    await expect(pastHistoryMenu).toHaveJSProperty("open", false);
    await expect(vitalMenu).toHaveJSProperty("open", true);
    await expect(page.locator('details[class*="statusMenu"][open]')).toHaveCount(1);

    await pastHistorySummary.click();
    await expect(pastHistoryMenu).toHaveJSProperty("open", true);
    await pastHistoryMenu.getByRole("button", { name: "不适用", exact: true }).click();
    await expect(pastHistorySummary).toHaveText("不适用");
    await expect(pastHistoryMenu).toHaveJSProperty("open", false);
  });

  test("keeps public-demo medical records read-only without POST or audit-triggering actions", async ({ page }) => {
    test.skip(!publicDemo, "public-demo only");

    const postRequests: string[] = [];
    const aiRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
      if (request.url().includes("api.deepseek.com") || /(?:\/asr(?:\/|$)|transcrib|speech)/iu.test(request.url())) {
        aiRequests.push(request.url());
      }
    });

    await page.goto("/encounters/demo/record");
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();
    await expect(page.getByText("只读预览", { exact: true }).first()).toBeVisible();
    const controls = page.locator("main input, main textarea, main select");
    expect(await controls.count()).toBeGreaterThan(0);
    expect(await controls.evaluateAll((elements) =>
      elements.every((element) => (element as HTMLInputElement).disabled))).toBe(true);
    await page.getByRole("button", { name: "保存病历", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("当前为只读演示，未保存任何内容");
    expect(postRequests).toEqual([]);

    await page.getByRole("link", { name: "进入诊疗参考", exact: true }).click();
    await expect(page).toHaveURL(/\/encounters\/demo\/reference$/u);
    expect(aiRequests).toEqual([]);
  });

  test("keeps the record page operable at narrow widths and exposes keyboard focus", async ({ page }) => {
    test.skip(publicDemo, "local-research only");

    await page.goto("/encounters/new");
    await page.getByRole("button", { name: "开始接诊", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "病历记录", level: 1 })).toBeVisible();

    for (const viewport of [
      { width: 980, height: 900 },
      { width: 620, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => document.fonts.ready);
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole("textbox", { name: "主诉", exact: true })).toBeVisible();
      await expect(page.getByText("识别结果", { exact: true })).toBeVisible();
      const rowLayout = await page.locator('[aria-labelledby="history-title"] > div > div').first().evaluate((row) => {
        const children = Array.from(row.children).map((child) => child.getBoundingClientRect().top);
        return new Set(children).size;
      });
      expect(rowLayout).toBe(viewport.width === 620 ? 2 : 1);
      if (viewport.width === 620) {
        const actionWidths = await page.getByRole("button", { name: "保存病历", exact: true }).evaluate((button) => ({
          button: button.getBoundingClientRect().width,
          parent: button.parentElement?.getBoundingClientRect().width ?? 0,
          available: (button.parentElement?.clientWidth ?? 0)
            - Number.parseFloat(getComputedStyle(button.parentElement as Element).paddingLeft)
            - Number.parseFloat(getComputedStyle(button.parentElement as Element).paddingRight),
        }));
        expect(actionWidths.button).toBeGreaterThan(actionWidths.available - 2);
      }
    }
    await expectVisibleFocus(page.getByRole("button", { name: "保存病历", exact: true }));
  });
});
