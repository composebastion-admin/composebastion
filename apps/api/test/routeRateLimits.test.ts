import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeFiles = new Map<string, string>();

function readRoute(file: string) {
  if (!routeFiles.has(file)) {
    routeFiles.set(file, readFileSync(new URL(`../src/routes/${file}`, import.meta.url), "utf8"));
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
});
