import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /(visual-audit|physician-shell|pwr-04-medical-record|pwr-05-speech-foundation|pwr-06b-a-speech|pwr-07-reference|pwr-09-review|pwr-10-research|pwr-11-ux-and-e2e|pwr-13b-manual-encounter)\.spec\.ts/iu,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  outputDir: "test-results/playwright-runtime",
  use: {
    baseURL,
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    command: "pnpm dev -H 127.0.0.1 -p 3100",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      APP_RUNTIME_MODE: process.env.APP_RUNTIME_MODE ?? "local-research",
      LLM_PROVIDER: "mock",
      DEEPSEEK_ENABLED: "false",
      DEEPSEEK_API_KEY: "",
      DATABASE_PATH: ":memory:",
      PWR5_TEST_MODE: "true",
    },
  },
});
