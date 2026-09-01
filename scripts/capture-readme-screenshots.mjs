import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const outputDirectory = resolve(process.cwd(), "public", "screenshots");

const pages = [
  ["home", "/"],
  ["record", "/encounters/demo/record"],
  ["reference", "/encounters/demo/reference"],
  ["review", "/encounters/demo/review"],
];

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1366, height: 768 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

for (const [name, pathname] of pages) {
  await page.goto(`${baseUrl}${pathname}`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: resolve(outputDirectory, `${name}.jpg`),
    type: "jpeg",
    quality: 84,
    animations: "disabled",
  });
  console.log(`captured ${name}`);
}

await browser.close();
