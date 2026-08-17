import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.COMPOSEBASTION_LIVE_BASE_URL ?? "http://127.0.0.1:18080";
const outputDir = process.env.COMPOSEBASTION_LIVE_OUTPUT_DIR ?? "../../test-results/playwright-live-qualification";
const jsonReport = process.env.COMPOSEBASTION_LIVE_JSON_REPORT ?? `${outputDir}/results.json`;
const mobileViewport = { width: 390, height: 844 };
const liveMatrixSafe = /@live-matrix-safe/;

export default defineConfig({
  testDir: "./e2e-live",
  outputDir,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["json", { outputFile: jsonReport }]],
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium-live",
      grep: liveMatrixSafe,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "chromium-live-mobile",
      grep: liveMatrixSafe,
      use: { ...devices["Desktop Chrome"], viewport: mobileViewport }
    },
    {
      name: "firefox-live-critical",
      grep: liveMatrixSafe,
      use: { ...devices["Desktop Firefox"] }
    },
    {
      name: "firefox-live-mobile-critical",
      grep: liveMatrixSafe,
      use: { ...devices["Desktop Firefox"], viewport: mobileViewport }
    },
    {
      name: "webkit-live-critical",
      grep: liveMatrixSafe,
      use: { ...devices["Desktop Safari"] }
    },
    {
      name: "webkit-live-mobile-critical",
      grep: liveMatrixSafe,
      use: { ...devices["Desktop Safari"], viewport: mobileViewport }
    }
  ]
});
