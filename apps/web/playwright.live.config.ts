import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.COMPOSEBASTION_LIVE_BASE_URL ?? "http://127.0.0.1:18080";
const outputDir = process.env.COMPOSEBASTION_LIVE_OUTPUT_DIR ?? "../../test-results/playwright-live";

export default defineConfig({
  testDir: "./e2e-live",
  outputDir,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium-live", use: { ...devices["Desktop Chrome"] } }
  ]
});
