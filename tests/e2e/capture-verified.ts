import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type Page } from "@playwright/test";

export type CaptureView = "page-top" | "result-view";

type PixelVerification = {
  ok: boolean;
  ruleId: string;
  width: number;
  height: number;
  greenSampleMatches: number;
  darkBrandPixels: number;
  requiredDarkBrandPixels: number;
};

type DomVerification = {
  ok: boolean;
  reason: string;
};

const MAX_CAPTURE_ATTEMPTS = 3;

export async function waitForStableLayout(page: Page, restoreScroll = true): Promise<void> {
  await page.evaluate(async (shouldRestoreScroll) => {
    await document.fonts.ready;
    if (shouldRestoreScroll) window.scrollTo(0, 0);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }, restoreScroll);
}

async function verifyPageTopDom(page: Page): Promise<DomVerification> {
  const viewport = page.viewportSize();
  if (!viewport) return { ok: false, reason: "CAPTURE_VIEWPORT_UNAVAILABLE" };

  const scrollY = await page.evaluate(() => window.scrollY);
  if (scrollY !== 0) return { ok: false, reason: "CAPTURE_SCROLL_NOT_TOP" };

  const chrome = [
    ["global-boundary", page.locator(".global-boundary")],
    ["navigation-anchor", page.locator("[data-capture-navigation-anchor]").first()],
    ["navigation", page.locator("[data-capture-navigation]").first()],
  ] as const;

  for (const [name, locator] of chrome) {
    if (!(await locator.isVisible().catch(() => false))) {
      return { ok: false, reason: `CAPTURE_DOM_${name.toUpperCase()}_HIDDEN` };
    }
    const box = await locator.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      return { ok: false, reason: `CAPTURE_DOM_${name.toUpperCase()}_BOX_INVALID` };
    }
    if (
      box.x < -1
      || box.y < -1
      || box.x + box.width > viewport.width + 1
      || box.y + box.height > viewport.height + 1
    ) {
      return { ok: false, reason: `CAPTURE_DOM_${name.toUpperCase()}_OUT_OF_VIEW` };
    }
  }

  return { ok: true, reason: "CAPTURE_DOM_READY" };
}

async function verifyScreenshotPixels(
  page: Page,
  screenshot: Buffer,
  viewport: { width: number; height: number },
  requirePageTopChrome: boolean,
): Promise<PixelVerification> {
  const dataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  return page.evaluate(async ({ dataUrl: encodedScreenshot, expectedWidth, expectedHeight, requirePageTopChrome: shouldCheckChrome }) => {
    const invalid = (ruleId: string, width = 0, height = 0): PixelVerification => ({
      ok: false,
      ruleId,
      width,
      height,
      greenSampleMatches: 0,
      darkBrandPixels: 0,
      requiredDarkBrandPixels: 0,
    });

    let bitmap: ImageBitmap;
    try {
      const response = await fetch(encodedScreenshot);
      bitmap = await createImageBitmap(await response.blob());
    } catch {
      return invalid("CAPTURE_IMAGE_DECODE_INVALID");
    }

    const width = bitmap.width;
    const height = bitmap.height;
    if (width !== expectedWidth || height !== expectedHeight) {
      bitmap.close();
      return invalid("CAPTURE_VIEWPORT_INVALID", width, height);
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return invalid("CAPTURE_PIXEL_CONTEXT_INVALID", width, height);
    }
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    bitmap.close();

    if (!shouldCheckChrome) {
      return {
        ok: true,
        ruleId: "CAPTURE_PIXEL_DIMENSIONS_VERIFIED",
        width,
        height,
        greenSampleMatches: 0,
        darkBrandPixels: 0,
        requiredDarkBrandPixels: 0,
      };
    }

    const boundary = document.querySelector<HTMLElement>(".global-boundary");
    const brand = document.querySelector<HTMLElement>("[data-capture-navigation-anchor]");
    const navigation = document.querySelector<HTMLElement>("[data-capture-navigation]");
    if (!boundary || !brand || !navigation) return invalid("CAPTURE_CHROME_DOM_INVALID", width, height);

    const boundaryColor = getComputedStyle(boundary).backgroundColor
      .match(/\d+(?:\.\d+)?/g)
      ?.slice(0, 3)
      .map(Number);
    if (!boundaryColor || boundaryColor.length !== 3) {
      return invalid("CAPTURE_BOUNDARY_COLOR_INVALID", width, height);
    }
    const navigationColor = getComputedStyle(navigation).backgroundColor
      .match(/\d+(?:\.\d+)?/g)
      ?.slice(0, 3)
      .map(Number);
    if (!navigationColor || navigationColor.length !== 3) {
      return invalid("CAPTURE_NAVIGATION_COLOR_INVALID", width, height);
    }

    const boundaryBox = boundary.getBoundingClientRect();
    const samplePoints = [
      [4, 4],
      [Math.floor(width * 0.25), 4],
      [Math.floor(width * 0.75), 4],
      [width - 5, 4],
      [4, Math.max(1, Math.floor(boundaryBox.height / 2))],
    ];
    const greenSampleMatches = samplePoints.filter(([x, y]) => {
      const offset = (y * width + x) * 4;
      const distance = Math.abs(pixels[offset] - boundaryColor[0])
        + Math.abs(pixels[offset + 1] - boundaryColor[1])
        + Math.abs(pixels[offset + 2] - boundaryColor[2]);
      return distance <= 24;
    }).length;

    const brandBox = brand.getBoundingClientRect();
    const left = Math.max(0, Math.floor(brandBox.left));
    const right = Math.min(width, Math.ceil(brandBox.right));
    const top = Math.max(0, Math.floor(brandBox.top));
    const bottom = Math.min(height, Math.ceil(brandBox.bottom));
    const area = Math.max(1, (right - left) * (bottom - top));
    let darkBrandPixels = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * width + x) * 4;
        const luminance = 0.2126 * pixels[offset]
          + 0.7152 * pixels[offset + 1]
          + 0.0722 * pixels[offset + 2];
        const navigationDistance = Math.abs(pixels[offset] - navigationColor[0])
          + Math.abs(pixels[offset + 1] - navigationColor[1])
          + Math.abs(pixels[offset + 2] - navigationColor[2]);
        if (pixels[offset + 3] > 0 && luminance < 170 && navigationDistance > 24) {
          darkBrandPixels += 1;
        }
      }
    }
    const requiredDarkBrandPixels = Math.max(20, Math.floor(area * 0.002));

    if (greenSampleMatches < 3) {
      return {
        ok: false,
        ruleId: "CAPTURE_BOUNDARY_PIXEL_INVALID",
        width,
        height,
        greenSampleMatches,
        darkBrandPixels,
        requiredDarkBrandPixels,
      };
    }
    if (darkBrandPixels < requiredDarkBrandPixels) {
      return {
        ok: false,
        ruleId: "CAPTURE_BRAND_PIXEL_INVALID",
        width,
        height,
        greenSampleMatches,
        darkBrandPixels,
        requiredDarkBrandPixels,
      };
    }

    return {
      ok: true,
      ruleId: "CAPTURE_PIXEL_VERIFIED",
      width,
      height,
      greenSampleMatches,
      darkBrandPixels,
      requiredDarkBrandPixels,
    };
  }, {
    dataUrl,
    expectedWidth: viewport.width,
    expectedHeight: viewport.height,
    requirePageTopChrome,
  });
}

export async function captureVerified(
  page: Page,
  outputPath: string,
  view: CaptureView = "page-top",
): Promise<{ attempt: number; verification: PixelVerification }> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("CAPTURE_VIEWPORT_UNAVAILABLE");

  mkdirSync(dirname(outputPath), { recursive: true });
  try {
    unlinkSync(outputPath);
  } catch {
    // There may be no previous capture. A failed verification must still leave no stale file.
  }

  const failures: string[] = [];
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    if (view === "page-top") await page.evaluate(() => window.scrollTo(0, 0));
    await waitForStableLayout(page, view === "page-top");
    if (view === "page-top") {
      await page.waitForTimeout(1_000);
      const domVerification = await verifyPageTopDom(page);
      if (!domVerification.ok) {
        failures.push(`${attempt}:${domVerification.reason}`);
        continue;
      }
    }

    const screenshot = await page.screenshot({ animations: "disabled" });
    const verification = await verifyScreenshotPixels(page, screenshot, viewport, view === "page-top");
    if (verification.ok) {
      writeFileSync(outputPath, screenshot);
      console.log(
        `CAPTURE_VERIFIED · ${outputPath} · view=${view} · attempt=${attempt} · `
        + `green=${verification.greenSampleMatches}/${5} · dark=${verification.darkBrandPixels}`,
      );
      return { attempt, verification };
    }
    failures.push(
      `${attempt}:${verification.ruleId}:green=${verification.greenSampleMatches}:dark=${verification.darkBrandPixels}`,
    );
    if (attempt < MAX_CAPTURE_ATTEMPTS) await page.waitForTimeout(250);
  }

  try {
    unlinkSync(outputPath);
  } catch {
    // Keep the failure closed even if no output was created.
  }
  throw new Error(`CAPTURE_VERIFICATION_FAILED · ${failures.join(",")}`);
}
