import { expect, test } from "@playwright/test";

const username = process.env.COMPOSEBASTION_LIVE_USERNAME;
const password = process.env.COMPOSEBASTION_LIVE_PASSWORD;
const expectedVersion = process.env.COMPOSEBASTION_LIVE_VERSION;

test("real API, database, Redis, worker, and browser are release-ready", async ({ page }) => {
  expect(username, "COMPOSEBASTION_LIVE_USERNAME must be set").toBeTruthy();
  expect(password, "COMPOSEBASTION_LIVE_PASSWORD must be set").toBeTruthy();
  expect(expectedVersion, "COMPOSEBASTION_LIVE_VERSION must be set").toBeTruthy();

  await page.goto("/");
  await page.getByLabel("Username or email").fill(username!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("heading", { name: "All Docker hosts" })).toBeVisible();

  const readyResponse = await page.request.get("/api/health/ready");
  expect(readyResponse.ok()).toBe(true);
  expect(await readyResponse.json()).toMatchObject({
    ok: true,
    checks: {
      database: { ok: true, required: true },
      redis: { ok: true, required: false },
      worker: { ok: true, required: true, available: true }
    }
  });

  const jobsResponse = await page.request.get("/api/jobs/status");
  expect(jobsResponse.ok()).toBe(true);
  expect(await jobsResponse.json()).toMatchObject({
    worker: { available: true, state: "active" }
  });

  const meResponse = await page.request.get("/api/auth/me");
  expect(meResponse.ok()).toBe(true);
  expect(await meResponse.json()).toMatchObject({ user: { username, role: "owner" } });

  await page.goto("/admin");
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.locator(".opsSummary", { hasText: "Readiness" })).toContainText("healthy");
  await expect(page.getByText("Worker", { exact: true }).locator("..")).toContainText("active");
  await expect(page.getByText("Worker heartbeat", { exact: true }).locator("..")).not.toContainText("No heartbeat observed");
  await expect(page.getByRole("heading", { name: "Readiness checks" })).toBeVisible();

  await page.getByRole("button", { name: "About" }).click();
  const about = page.locator(".adminPane");
  await expect(about.getByRole("heading", { name: "About ComposeBastion" })).toBeVisible();
  await expect(about.getByText(`v${expectedVersion}`)).toBeVisible();
  await expect(about.getByText("Source-available private use license", { exact: false })).toBeVisible();
  await expect(about.locator('[aria-label="Legal documents"]')).toBeVisible();
});
