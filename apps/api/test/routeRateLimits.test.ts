import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeFiles = new Map<string, string>();

function readRoute(file: string) {
  if (!routeFiles.has(file)) {
    routeFiles.set(file, readFileSync(new URL(`../src/routes/${file}`, import.meta.url), "utf8"));
  }
  return routeFiles.get(file)!;
}

function readSource(file: string) {
  if (!routeFiles.has(file)) {
    routeFiles.set(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
  }
  return routeFiles.get(file)!;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectRateLimit(file: string, method: string, path: string, limiter: string) {
  const source = readRoute(file);
  const routePattern = new RegExp(
    `app\\.${method}\\(\\s*["\`]${escapeRegExp(path)}["\`]\\s*,\\s*\\{[\\s\\S]{0,260}rateLimit:\\s*${limiter}`
  );
  expect(source, `${method.toUpperCase()} ${path} in ${file}`).toMatch(routePattern);
}

function expectSourceRateLimit(file: string, method: string, path: string, limiter: string) {
  const source = readSource(file);
  const routePattern = new RegExp(
    `app\\.${method}\\(\\s*["\`]${escapeRegExp(path)}["\`]\\s*,\\s*\\{[\\s\\S]{0,260}rateLimit:\\s*${limiter}`
  );
  expect(source, `${method.toUpperCase()} ${path} in ${file}`).toMatch(routePattern);
}

describe("sensitive route rate-limit coverage", () => {
  it("pins focused limits on expensive and sensitive API surfaces", () => {
    const routes = [
      ["hosts.ts", "post", "/api/hosts", "sensitiveMutationRateLimit"],
      ["hosts.ts", "post", "/api/hosts/:id/actions", "sensitiveMutationRateLimit"],
      ["files.ts", "get", "/api/hosts/:hostId/files/read", "hostFileRateLimit"],
      ["files.ts", "get", "/api/hosts/:hostId/files/exists", "hostFileRateLimit"],
      ["files.ts", "post", "/api/hosts/:hostId/files/write", "hostFileRateLimit"],
      ["backups.ts", "post", "/api/backups/:id/restore", "sensitiveMutationRateLimit"],
      ["backups.ts", "get", "/api/backups/:id/download", "downloadRateLimit"],
      ["config.ts", "post", "/api/config/export", "configBackupRateLimit"],
      ["config.ts", "post", "/api/config/import", "configBackupRateLimit"],
      ["containers.ts", "get", "/api/hosts/:hostId/containers/:containerId/logs-stream", "streamRateLimit"],
      ["containers.ts", "post", "/api/hosts/:hostId/containers/:containerId/exec", "sensitiveMutationRateLimit"],
      ["hostMetrics.ts", "get", "/api/hosts/:hostId/metrics-stream", "streamRateLimit"],
      ["registries.ts", "post", "/api/hosts/:hostId/registries/:registryId/login", "sensitiveMutationRateLimit"],
      ["jobs.ts", "post", "/api/jobs/:id/cancel", "sensitiveMutationRateLimit"],
      ["alerts.ts", "post", "/api/alerts/channels/:id/test", "sensitiveMutationRateLimit"],
      ["recoveryCenter.ts", "post", "/api/recovery/restore", "sensitiveMutationRateLimit"],
      ["demo.ts", "post", "/api/demo/seed", "sensitiveMutationRateLimit"]
    ] as const;

    for (const [file, method, path, limiter] of routes) {
      expectRateLimit(file, method, path, limiter);
    }

    expect(readRoute("hostTerminal.ts")).toContain("rateLimit: terminalRateLimit");
  });

  it("pins focused limits on authenticated read and health surfaces", () => {
    const routes = [
      ["alerts.ts", "get", "/api/alerts/channels", "authenticatedReadRateLimit"],
      ["alerts.ts", "get", "/api/alerts/channels/test-history", "authenticatedReadRateLimit"],
      ["alerts.ts", "get", "/api/alerts/channels/:id/test-history", "authenticatedReadRateLimit"],
      ["alerts.ts", "get", "/api/alerts/rules", "authenticatedReadRateLimit"],
      ["alerts.ts", "get", "/api/alerts/silences", "authenticatedReadRateLimit"],
      ["alerts.ts", "get", "/api/alerts/history", "authenticatedReadRateLimit"],
      ["backupSchedules.ts", "get", "/api/backup-schedules", "authenticatedReadRateLimit"],
      ["catalog.ts", "get", "/api/catalog/templates", "authenticatedReadRateLimit"],
      ["catalog.ts", "get", "/api/catalog/external", "authenticatedReadRateLimit"],
      ["auth.ts", "get", "/api/auth/setup-state", "authenticatedReadRateLimit"],
      ["auth.ts", "get", "/api/auth/sessions", "authenticatedReadRateLimit"],
      ["auth.ts", "get", "/api/auth/me", "authenticatedReadRateLimit"],
      ["favorites.ts", "get", "/api/favorite-images", "authenticatedReadRateLimit"],
      ["github.ts", "get", "/api/github/repos", "authenticatedReadRateLimit"],
      ["jobs.ts", "get", "/api/jobs", "authenticatedReadRateLimit"],
      ["jobs.ts", "get", "/api/jobs/status", "authenticatedReadRateLimit"],
      ["jobs.ts", "get", "/api/jobs/:id", "authenticatedReadRateLimit"],
      ["imageIntelligence.ts", "get", "/api/image-updates", "authenticatedReadRateLimit"],
      ["imageIntelligence.ts", "get", "/api/image-updates/preview", "authenticatedReadRateLimit"],
      ["imageIntelligence.ts", "get", "/api/image-scans", "authenticatedReadRateLimit"],
      ["registries.ts", "get", "/api/registries", "authenticatedReadRateLimit"],
      ["users.ts", "get", "/api/users", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/targets", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/readiness", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "post", "/api/recovery/profiles/lookup", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/profiles/:id", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/points", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/points/:id", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/schedules", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/migrations", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/migrations/:id", "authenticatedReadRateLimit"],
      ["recoveryCenter.ts", "get", "/api/recovery/targets/:id", "authenticatedReadRateLimit"]
    ] as const;

    for (const [file, method, path, limiter] of routes) {
      expectRateLimit(file, method, path, limiter);
    }

    const expensiveRoutes = [
      ["imageIntelligence.ts", "get", "/api/image-scanner/status", "expensiveReadRateLimit"],
      ["imageIntelligence.ts", "get", "/api/image-tags", "expensiveReadRateLimit"],
      ["recoveryCenter.ts", "post", "/api/recovery/analyze", "expensiveReadRateLimit"],
      ["recoveryCenter.ts", "post", "/api/recovery/readiness/analyze", "expensiveReadRateLimit"]
    ] as const;

    for (const [file, method, path, limiter] of expensiveRoutes) {
      expectRateLimit(file, method, path, limiter);
    }

    expectSourceRateLimit("server.ts", "get", "/api/health/db", "healthCheckRateLimit");
    expectSourceRateLimit("server.ts", "get", "/api/health/ready", "healthCheckRateLimit");
    expectSourceRateLimit("server.ts", "get", "/api/health/redis", "healthCheckRateLimit");
  });
});
