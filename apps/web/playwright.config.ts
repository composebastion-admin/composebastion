import { defineConfig, devices } from "@playwright/test";

const previewPort = process.env.PLAYWRIGHT_PORT ?? "4174";
const previewUrl = `http://127.0.0.1:${previewPort}`;
const mobileViewport = { width: 390, height: 844 };
const criticalWorkflow = /@critical/;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: previewUrl,
    trace: "on-first-retry"
  },
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${previewPort}`,
    url: previewUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium-mobile",
      use: { ...devices["Desktop Chrome"], viewport: mobileViewport }
    },
    {
      name: "firefox-critical",
      grep: criticalWorkflow,
      use: { ...devices["Desktop Firefox"] }
    },
    {
      name: "firefox-mobile-critical",
      grep: criticalWorkflow,
      use: { ...devices["Desktop Firefox"], viewport: mobileViewport }
    },
    {
      name: "webkit-critical",
      grep: criticalWorkflow,
      use: { ...devices["Desktop Safari"] }
    },
    {
      name: "webkit-mobile-critical",
      grep: criticalWorkflow,
      use: { ...devices["Desktop Safari"], viewport: mobileViewport }
    }
  ]
});
