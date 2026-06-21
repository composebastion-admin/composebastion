import { expect, test, type Page } from "@playwright/test";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Admin User",
  username: "admin",
  email: "admin@composebastion.local",
  role: "owner",
  isActive: true,
  createdAt: new Date(0).toISOString()
};

const host = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "prod-01",
  hostname: "prod-01.local",
  port: 22,
  username: "docker",
  connectionMode: "ssh",
  sshAuthType: "key",
  agentUrl: null,
  dockerSocketPath: "/var/run/docker.sock",
  tags: [],
  lastStatus: "online",
  lastSeenAt: new Date().toISOString(),
  lastError: null,
  dockerVersion: "27.0.0",
  composeVersion: "2.29.0",
  agentVersion: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

const fileHost = {
  ...host,
  id: "23232323-2323-4323-8323-232323232323",
  name: "files-02",
  hostname: "files-02.local",
  username: "deploy"
};

const app = {
  id: "44444444-4444-4444-8444-444444444444",
  hostId: host.id,
  hostName: host.name,
  hostHostname: host.hostname,
  name: "Web",
  source: "git",
  status: "running",
  imageReferences: ["nginx:latest"],
  ports: "8080:80",
  containerIds: ["web"],
  primaryContainerId: "web",
  stackId: "55555555-5555-4555-8555-555555555555",
  repositoryId: "12121212-3434-4567-8567-121212121212",
  repositoryUrl: "https://github.com/example/web",
  branch: "main",
  projectName: "web",
  sourceLink: null,
  update: {
    status: "update_available",
    kind: "git",
    currentVersion: "aaaaaaaaaaaa",
    availableVersion: "bbbbbbbbbbbb"
  },
  updatedAt: new Date(0).toISOString()
};

const containerResource = {
  id: "12121212-1212-4212-8212-121212121212",
  hostId: host.id,
  kind: "container",
  externalId: "web",
  name: "web",
  data: {
    ID: "web",
    Names: "web",
    Image: "nginx:latest",
    State: "running",
    Status: "Up 5 minutes",
    Ports: "0.0.0.0:8080->80/tcp",
    Size: "12MB"
  },
  updatedAt: new Date(0).toISOString()
};

const recoveryPoint = {
  id: "66666666-6666-4666-8666-666666666666",
  hostId: host.id,
  name: "Web snapshot",
  appIdentity: { kind: "compose", projectName: "web", label: "Web" },
  triggerKind: "manual",
  status: "completed",
  backupTargetId: null,
  legacyVolumeBackupId: null,
  artifactCount: 1,
  completedArtifactCount: 1,
  totalBytes: 1024,
  error: null,
  metadata: {},
  createdAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString(),
  lastDrillAt: new Date(0).toISOString(),
  lastDrillStatus: "completed",
  lastDrillError: null,
  lastSuccessfulDrillAt: new Date(0).toISOString()
};

const recoveryReadiness = {
  hostId: host.id,
  appIdentity: { kind: "stack", stackId: app.stackId, projectName: "web", label: "Web" },
  label: "Web",
  status: "ready",
  score: 97,
  reasons: [],
  recommendedCaptureMode: "hot",
  lastRecoveryPoint: {
    id: recoveryPoint.id,
    status: "completed",
    createdAt: recoveryPoint.createdAt,
    completedAt: recoveryPoint.completedAt,
    verified: true,
    artifactCount: 1,
    completedArtifactCount: 1,
    backupTargetId: null,
    localUsable: true,
    remoteUsable: false,
    error: null
  },
  lastDrill: {
    lastDrillAt: recoveryPoint.lastDrillAt,
    lastDrillStatus: recoveryPoint.lastDrillStatus,
    lastDrillError: recoveryPoint.lastDrillError,
    lastSuccessfulDrillAt: recoveryPoint.lastSuccessfulDrillAt,
    passed: true
  },
  profile: null,
  targetHealth: null,
  dataMounts: [{
    type: "volume",
    containerName: "web",
    source: "/var/lib/docker/volumes/web_data/_data",
    name: "web_data",
    destination: "/data",
    readOnly: false,
    included: true,
    warning: null
  }]
};

type MockApiOptions = {
  needsSetup?: boolean;
  hosts?: unknown[];
  role?: "owner" | "admin" | "operator" | "viewer";
  failChannelTest?: boolean;
};

async function mockApi(page: Page, options: MockApiOptions = {}) {
  const requests: string[] = [];
  const currentUser = { ...user, role: options.role ?? user.role };
  const hostList = options.hosts ?? [host];
  let channelTestFailed = false;
  let selectedGitRef = app.branch;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push(`${request.method()} ${path}`);
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body)
    });

    if (path === "/api/auth/setup-state") return json({ needsSetup: Boolean(options.needsSetup) });
    if (path === "/api/auth/me") return options.needsSetup ? json({ error: "Authentication required" }, 401) : json({ user: currentUser });
    if (path === "/api/auth/setup" || path === "/api/auth/login") return json({ user: currentUser });
    if (path === "/api/hosts") return json({ hosts: hostList });
    if (path === `/api/hosts/${host.id}/resources`) return json({ resources: [containerResource] });
    if (path === `/api/hosts/${fileHost.id}/resources`) return json({ resources: [] });
    if (path === `/api/hosts/${host.id}/containers/usage`) return json({ usage: [{ ID: "web", CPUPerc: "1.2%", MemPerc: "3.4%", MemUsage: "20MiB / 512MiB" }] });
    if (path === `/api/hosts/${fileHost.id}/containers/usage`) return json({ usage: [] });
    if (path === `/api/hosts/${host.id}/files`) return json({ directory: {
      path: url.searchParams.get("path") ?? "/home/docker",
      parent: null,
      entries: [{ name: "DemoApp", path: "/home/docker/DemoApp", type: "directory", size: 0, modified: "2026-06-18 10:00" }]
    } });
    if (path === `/api/hosts/${fileHost.id}/files`) return json({ directory: {
      path: url.searchParams.get("path") ?? "/home/deploy",
      parent: null,
      entries: [{ name: "OtherApp", path: "/home/deploy/OtherApp", type: "directory", size: 0, modified: "2026-06-18 10:05" }]
    } });
    if (path === `/api/hosts/${host.id}/containers/web/logs`) return json({ stdout: "server started\nready", stderr: "" });
    if (path === `/api/hosts/${host.id}/containers/web/stats`) return json({ stats: { CPUPerc: "1.2%", MemPerc: "3.4%", NetIO: "1kB / 2kB" } });
    if (path === `/api/hosts/${host.id}/containers/web/inspect`) return json({ inspect: {
      image: "nginx:latest",
      status: "running",
      restartPolicy: "unless-stopped",
      env: ["PUBLIC_URL=https://example.com", "SECRET=<redacted>"],
      mounts: [{ type: "volume", name: "web-data", destination: "/usr/share/nginx/html", readOnly: false }],
      networks: [{ name: "bridge", ipAddress: "172.17.0.2", aliases: ["web"] }],
      ports: [{ containerPort: "80", protocol: "tcp", hostIp: "0.0.0.0", hostPort: "8080" }],
      labels: { "com.composebastion.app": "web" }
    } });
    if (path === `/api/hosts/${host.id}/compose`) return json({ stacks: [] });
    if (path === "/api/hosts/metrics") return json([{
        hostId: host.id,
        name: host.name,
        online: true,
        specs: {
          hostId: host.id,
          cpuCores: 4,
          memTotalBytes: 8 * 1024 * 1024 * 1024,
          os: "Linux",
          arch: "x86_64",
          dockerVersion: "27.0.0",
          collectedAt: new Date().toISOString()
        },
        stats: {
          hostId: host.id,
          collectedAt: new Date().toISOString(),
          cpuPercent: 12,
          load: { one: 0.42, five: 0.3, fifteen: 0.2 },
          memory: { totalBytes: 8 * 1024 * 1024 * 1024, usedBytes: 3 * 1024 * 1024 * 1024, availableBytes: 5 * 1024 * 1024 * 1024 },
          swap: { totalBytes: 0, usedBytes: 0 },
          disks: [{ mount: "/", totalBytes: 1000, usedBytes: 420, usedPercent: 42 }],
          network: null,
          containers: { running: 2, total: 3 },
          uptimeSeconds: 123456
        }
      }]);
    if (path === "/api/backups") return json({ backups: [] });
    if (path === "/api/jobs") return json({
      jobs: [{
        id: "33333333-3333-4333-8333-333333333333",
        correlationId: "33333333-3333-4333-8333-333333333333",
        type: "host.sync",
        status: "failed",
        hostId: host.id,
        payload: {},
        result: null,
        progress: [],
        error: "sync failed",
        createdBy: currentUser.id,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString()
      }, {
        id: "34343434-3434-4434-8434-343434343434",
        correlationId: "34343434-3434-4434-8434-343434343434",
        type: "backup.drill",
        status: "queued",
        hostId: host.id,
        payload: {},
        result: null,
        progress: [{ id: "prepare", label: "Prepare", status: "running" }],
        error: null,
        createdBy: currentUser.id,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        startedAt: null,
        completedAt: null
      }],
      total: 2,
      limit: Number(url.searchParams.get("limit") ?? 40),
      offset: 0
    });
    if (path === "/api/jobs/status") return json({ worker: { queued: 0, running: 0, lastJobCompletedAt: new Date(0).toISOString() } });
    if (path === "/api/backups/health") return json({
      health: {
        windowMs: 7 * 24 * 60 * 60 * 1000,
        proofStaleMs: 30 * 24 * 60 * 60 * 1000,
        overall: {
          hostId: null,
          hostName: "All hosts",
          status: "healthy",
          newestSuccessfulBackupAt: null,
          newestSuccessfulBackupAgeMs: null,
          scheduleIntervalMs: null,
          staleSuccessfulBackup: false,
          totalSizeBytes: 0,
          recentFailureCount: 0,
          neverVerifiedCount: 0,
          neverDrilledCount: 0,
          staleVerifiedCount: 0,
          staleDrilledCount: 0
        },
        hosts: []
      }
    });
    if (path === "/api/health/ready") return json({ ok: true, checks: { database: { ok: true }, redis: { ok: true }, backups: { ok: true }, worker: { ok: true, queued: 0, running: 0 } } });
    if (path === "/api/favorite-images") return json({ images: [] });
    if (path === "/api/catalog/templates") return json({ templates: [] });
    if (path === "/api/catalog/external") return json({
      source: "awesome-selfhosted",
      sourceLabel: "Awesome-Selfhosted",
      sourceUrl: "https://github.com/awesome-selfhosted/awesome-selfhosted-data",
      fetchedAt: new Date(0).toISOString(),
      total: 1,
      candidates: [{
        id: "awesome-selfhosted:archivebox",
        name: "ArchiveBox",
        description: "Self-hosted web archive.",
        category: "utility",
        source: "awesome-selfhosted",
        sourceLabel: "Awesome-Selfhosted",
        websiteUrl: "https://archivebox.io/",
        docsUrl: "https://archivebox.io/",
        sourceCodeUrl: "https://github.com/ArchiveBox/ArchiveBox",
        demoUrl: null,
        licenses: ["MIT"],
        platforms: ["Docker"],
        tags: ["Archiving and Digital Preservation (DP)"],
        stargazersCount: 27000,
        updatedAt: "2026-06-01",
        latestRelease: { tag: "v0.9.6", publishedAt: "2026-05-01" },
        archived: false,
        importTemplate: {
          id: "awesome-archivebox",
          name: "ArchiveBox",
          description: "Self-hosted web archive.",
          category: "utility",
          composeYaml: "services:\n  app:\n    image: replace-with-official-image:latest",
          defaultEnv: { APP_PORT: "8080" },
          suggestedVolumes: ["archivebox_data"],
          suggestedPorts: ["8080:8080"],
          docsUrl: "https://archivebox.io/"
        }
      }]
    });
    if (path === "/api/github/repos") return json({ repositories: [] });
    if (path === "/api/apps") return json({ apps: [{ ...app, branch: selectedGitRef }] });
    if (path === `/api/apps/${app.id}/versions`) return json({
      versions: {
        repositoryUrl: app.repositoryUrl,
        selectedRef: selectedGitRef,
        currentCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        options: [
          {
            kind: "branch",
            name: "main",
            ref: "main",
            label: "main",
            commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            publishedAt: null,
            htmlUrl: null,
            selected: selectedGitRef === "main",
            deployed: true,
            updateAvailable: false
          },
          {
            kind: "branch",
            name: "dev",
            ref: "dev",
            label: "dev",
            commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            publishedAt: null,
            htmlUrl: null,
            selected: selectedGitRef === "dev",
            deployed: false,
            updateAvailable: true
          },
          {
            kind: "release",
            name: "Version 1.1",
            ref: "v1.1.0",
            label: "Version 1.1",
            commitSha: "cccccccccccccccccccccccccccccccccccccccc",
            publishedAt: new Date(0).toISOString(),
            htmlUrl: "https://github.com/example/web/releases/tag/v1.1.0",
            selected: selectedGitRef === "v1.1.0",
            deployed: false,
            updateAvailable: true
          }
        ]
      }
    });
    if (path === `/api/apps/${app.id}/version` && request.method() === "PUT") {
      selectedGitRef = (request.postDataJSON() as { ref?: string }).ref ?? selectedGitRef;
      return json({ app: { ...app, branch: selectedGitRef } });
    }
    if (path === "/api/auth/sessions") return json({ sessions: [{
      id: "abababab-abab-4bab-8bab-abababababab",
      ipAddress: "127.0.0.1",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      createdAt: new Date(0).toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      current: true
    }] });
    if (path === "/api/alerts/channels") return json({ channels: [{
      id: "77777777-7777-4777-8777-777777777777",
      name: "Ops email",
      type: "email",
      emailTo: "ops@example.com",
      webhookUrl: null,
      enabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }] });
    if (path === "/api/alerts/rules") return json({ rules: [{
      id: "88888888-8888-4888-8888-888888888888",
      name: "CPU sustained",
      condition: "host.cpu",
      hostId: host.id,
      containerId: null,
      channelId: "77777777-7777-4777-8777-777777777777",
      enabled: true,
      params: { comparator: "gte", threshold: 85, durationSeconds: 300 },
      breachingSince: null,
      lastState: "ok",
      lastCheckedAt: new Date(0).toISOString(),
      lastNotifiedAt: null,
      lastError: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }] });
    if (path === "/api/alerts/silences") return json({ silences: [{
      id: "99999999-9999-4999-8999-999999999999",
      name: "Maintenance",
      hostId: host.id,
      ruleId: null,
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "patch window",
      createdBy: currentUser.id,
      createdAt: new Date(0).toISOString()
    }] });
    if (path === "/api/alerts/history") return json({ events: [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ruleId: "88888888-8888-4888-8888-888888888888",
      hostId: host.id,
      channelId: "77777777-7777-4777-8777-777777777777",
      state: "ok",
      message: "CPU recovered",
      notified: true,
      silenced: false,
      error: null,
      createdAt: new Date(0).toISOString()
    }] });
    if (path === "/api/alerts/channels/77777777-7777-4777-8777-777777777777/test-history") return json({ events: [{
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      channelId: "77777777-7777-4777-8777-777777777777",
      status: "success",
      error: null,
      testedBy: currentUser.id,
      testedAt: new Date(0).toISOString()
    }] });
    if (path === "/api/alerts/channels/test-history") return json({ events: [channelTestFailed ? {
      id: "edededed-eded-4ded-8ded-edededededed",
      channelId: "77777777-7777-4777-8777-777777777777",
      status: "failed",
      error: "Webhook failed with 500",
      testedBy: currentUser.id,
      testedAt: new Date().toISOString()
    } : {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      channelId: "77777777-7777-4777-8777-777777777777",
      status: "success",
      error: null,
      testedBy: currentUser.id,
      testedAt: new Date(0).toISOString()
    }] });
    if (path === "/api/alerts/channels/77777777-7777-4777-8777-777777777777/test" && request.method() === "POST") {
      if (options.failChannelTest) {
        channelTestFailed = true;
        return json({ error: "Webhook failed with 500" }, 500);
      }
      return json({
        ok: true,
        event: {
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          channelId: "77777777-7777-4777-8777-777777777777",
          status: "success",
          error: null,
          testedBy: currentUser.id,
          testedAt: new Date().toISOString()
        }
      });
    }
    if (path === "/api/image-updates") return json({ updates: [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      hostId: host.id,
      imageReference: "nginx:latest",
      currentDigest: "sha256:local",
      remoteDigest: "sha256:remote",
      status: "update_available",
      riskNote: "Mutable tag",
      affectedContainers: [{ id: "web", name: "web" }],
      affectedStacks: [{ id: app.stackId, name: "Web" }],
      lastCheckedAt: new Date(0).toISOString(),
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0 }
    }] });
    if (path === "/api/image-scanner/status") return json({ status: {
      provider: "auto",
      effectiveProvider: "trivy",
      available: true,
      trivyVersion: "0.58.0",
      error: null,
      guidance: "Scanner ready."
    } });
    if (path === "/api/image-scans") return json({ scans: [] });
    if (path === `/api/hosts/${host.id}/image-cleanup`) return json({ candidates: [{
      imageId: "sha256:unused",
      reference: "nginx:old",
      repository: "nginx",
      tag: "old",
      size: "80.4MB",
      usedBy: [],
      eligible: true,
      reason: "unused tagged image"
    }, {
      imageId: "sha256:held",
      reference: "ghcr.io/composebastion-admin/demo-app:old",
      repository: "ghcr.io/composebastion-admin/demo-app",
      tag: "old",
      size: "560MB",
      usedBy: [{ id: "demoapp-old", name: "demoapp-old", state: "exited" }],
      eligible: false,
      reason: "held by stopped container demoapp-old"
    }] });
    if (path === "/api/image-tags") return json({ image: url.searchParams.get("image"), tags: ["latest", "main", "beta", "dev", "v0.9.7", "v0.9.6"] });
    if (path === "/api/image-updates/preview") return json({ preview: {
      hostId: host.id,
      imageReference: "nginx:latest",
      status: "update_available",
      currentDigest: "sha256:local",
      remoteDigest: "sha256:remote",
      riskNote: "Mutable tag",
      credentialHint: null,
      safeAction: "update_container",
      affectedContainers: [{ id: "web", name: "web" }],
      affectedStacks: [{ id: app.stackId, name: "Web" }],
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0 }
    } });
    if (path === "/api/recovery/readiness") return json({ readiness: [recoveryReadiness] });
    if (path === "/api/recovery/readiness/analyze") return json({ readiness: recoveryReadiness });
    if (path === "/api/recovery/points") return json({ points: [recoveryPoint] });
    if (path === "/api/recovery/targets") return json({ targets: [] });
    if (path === "/api/recovery/schedules") return json({ schedules: [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      hostId: host.id,
      name: "Nightly Web",
      appIdentity: { kind: "compose", projectName: "web", label: "Web" },
      backupTargetId: null,
      intervalMs: 24 * 60 * 60 * 1000,
      retentionCount: 7,
      nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
      lastRunAt: null,
      enabled: true,
      captureMode: "hot",
      createdBy: currentUser.id,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastDrillAt: new Date(0).toISOString(),
      lastDrillStatus: "completed",
      lastDrillError: null,
      lastSuccessfulDrillAt: new Date(0).toISOString()
    }] });
    if (path === "/api/recovery/migrations") return json({ runs: [] });
    if (["POST", "DELETE"].includes(request.method())) return json({ ok: true, job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "queued" } });
    return json({});
  });

  return { requests };
}

test("first-run setup reaches the dashboard", async ({ page }) => {
  await mockApi(page, { needsSetup: true, hosts: [] });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ComposeBastion" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("long-enough-password");
  await page.getByRole("button", { name: "Create Admin" }).click();
  await expect(page.getByRole("heading", { name: "All Docker hosts" })).toBeVisible();
  await expect(page.getByText("No hosts added").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Host", exact: true })).toBeVisible();
});

test("keyboard focus and theme toggle are visible", async ({ page }) => {
  await mockApi(page);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "prod-01" })).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: /Search hosts and resources/ })).toBeFocused();
  await page.getByRole("link", { name: /Admin/ }).click();
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("button", { name: /dark mode/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("reduced-motion mode keeps focus and contrast usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApi(page);
  await page.goto("/overview");
  const search = page.getByRole("searchbox", { name: /Search hosts and resources/ });
  await search.focus();
  await expect(search).toBeFocused();

  const focusVisible = await search.evaluate((element) => {
    const style = getComputedStyle(element.closest(".globalSearch") ?? element);
    return style.outlineStyle !== "none" || style.boxShadow !== "none";
  });
  expect(focusVisible).toBe(true);

  const transitionDurationMs = await search.evaluate((element) => {
    const raw = getComputedStyle(element).transitionDuration.split(",")[0]?.trim() ?? "0s";
    if (raw.endsWith("ms")) return Number.parseFloat(raw);
    if (raw.endsWith("s")) return Number.parseFloat(raw) * 1000;
    return Number.parseFloat(raw);
  });
  expect(transitionDurationMs).toBeLessThanOrEqual(0.01);

  const contrastRatio = await search.evaluate((element) => {
    const parseRgb = (value: string) => {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
    };
    const luminance = ([r, g, b]: number[]) => {
      const channels = [r, g, b].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const style = getComputedStyle(element);
    const shellStyle = getComputedStyle(element.closest(".globalSearch") ?? element);
    const color = parseRgb(style.color);
    const background = parseRgb(shellStyle.backgroundColor);
    if (!color || !background) return 0;
    const lighter = Math.max(luminance(color), luminance(background));
    const darker = Math.min(luminance(color), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
  });
  expect(contrastRatio).toBeGreaterThan(3);
});

test("operations panel exposes readiness, backup health, and failed jobs", async ({ page }) => {
  await mockApi(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.locator(".opsSummary strong", { hasText: "Readiness" })).toBeVisible();
  await expect(page.locator(".opsSummary strong", { hasText: "Backups" })).toBeVisible();
  await expect(page.getByText("sync failed")).toBeVisible();
  await expect(page.getByText(/Confirm SSH or agent connectivity/)).toBeVisible();
});

test("job actions expose recovery context and confirm focus return", async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Jobs" }).click();
  await expect(page.getByText(/Confirm SSH or agent connectivity/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => mock.requests).toContain("POST /api/jobs/33333333-3333-4333-8333-333333333333/retry");

  const cancelJobButton = page.getByRole("button", { name: "Cancel" }).first();
  await cancelJobButton.click();
  const dialog = page.getByRole("alertdialog", { name: "Cancel queued job" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cancelJobButton).toBeFocused();
});

test("alerts show silences and history", async ({ page }) => {
  await mockApi(page);
  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
  await expect(page.getByText("CPU sustained")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Maintenance" })).toBeVisible();
  await expect(page.getByText("CPU recovered")).toBeVisible();
  await expect(page.getByText("Channel Test History")).toBeVisible();
  await expect(page.getByRole("cell", { name: "success" })).toBeVisible();
});

test("failed alert channel tests refresh into history", async ({ page }) => {
  await mockApi(page, { failChannelTest: true });
  await page.goto("/alerts");
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.locator(".notice.error", { hasText: "Webhook failed with 500" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "failed", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Webhook failed with 500" })).toBeVisible();
});

test("viewer alerts avoid operator endpoints and show read-only history", async ({ page }) => {
  const mock = await mockApi(page, { role: "viewer" });
  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
  await expect(page.getByText("Channel Test History")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Maintenance" })).toBeVisible();
  await expect(page.getByText("CPU recovered")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Channel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Rule" })).toHaveCount(0);
  await expect.poll(() => mock.requests.filter((request) => [
    "GET /api/alerts/channels",
    "GET /api/alerts/rules",
    "POST /api/alerts/channels",
    "POST /api/alerts/rules",
    "POST /api/alerts/silences"
  ].includes(request))).toEqual([]);
});

test("active sessions are reachable from admin settings", async ({ page }) => {
  await mockApi(page);
  await page.goto("/admin");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible();
  await expect(page.getByText("This device")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out everywhere" })).toBeVisible();
});

test("mobile navigation opens and supports keyboard-visible links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await mockApi(page);
  await page.goto("/overview");
  await page.getByLabel("Open sidebar").click();
  await expect(page.getByLabel("Close sidebar")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /Dashboard/ })).toBeVisible();
});

test("mobile admin settings remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await mockApi(page);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.getByRole("heading", { name: "Readiness checks" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible();
});

test("host SSH terminal action opens a visible warning drawer", async ({ page }) => {
  await mockApi(page);
  await page.goto("/hosts");
  const terminalButton = page.locator('button[title="Open SSH terminal"]');
  await expect(terminalButton).toHaveCount(1);
  await terminalButton.click();
  const dialog = page.getByRole("dialog", { name: "Host SSH terminal for prod-01" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Privileged shell access")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open shell" })).toBeVisible();

  const box = await dialog.boundingBox();
  expect(box?.y ?? 9999).toBeLessThan(80);

  await dialog.getByRole("button", { name: "Open shell" }).click();
  const frame = dialog.locator(".hostTerminalFrame");
  const xterm = frame.locator(".terminal.xterm");
  await expect(frame).toBeVisible();
  await expect(xterm).toBeVisible();
  await page.waitForTimeout(100);

  const sizes = await frame.evaluate((node) => {
    const frameRect = node.getBoundingClientRect();
    const terminal = node.querySelector(".terminal.xterm");
    const terminalRect = terminal?.getBoundingClientRect();
    return {
      frameHeight: frameRect.height,
      terminalHeight: terminalRect?.height ?? 0
    };
  });
  expect(sizes.frameHeight).toBeGreaterThan(500);
  expect(sizes.terminalHeight).toBeGreaterThan(sizes.frameHeight * 0.85);
});

test("dedicated SSH route manages SSH connections", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ssh");
  await expect(page.getByRole("heading", { name: "SSH connections" })).toBeVisible();
  await expect(page.getByRole("link", { name: /SSH/ })).toBeVisible();
  await expect(page.getByText("docker@prod-01.local:22")).toBeVisible();
  await expect(page.getByText("Terminal ready")).toBeVisible();

  await page.getByRole("button", { name: "Add SSH connection" }).click();
  await expect(page.getByText("Add a Docker host reachable over SSH")).toBeVisible();
  await expect(page.getByText("SSH executor")).toBeVisible();
  await expect(page.getByText("Load Demo Workspace")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save SSH connection" })).toBeVisible();

  await page.locator(".sshAccessSurface").getByTitle("Open SSH terminal").click();
  await expect(page.getByRole("dialog", { name: "Host SSH terminal for prod-01" })).toBeVisible();
});

test("apps compatibility route renders the services experience", async ({ page }) => {
  await mockApi(page);
  await page.goto("/apps");
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  const versionRow = page.locator(".serviceVersionRow", { hasText: "Current" });
  await expect(versionRow).toBeVisible();
  await expect(versionRow).toContainText("Latest");
  await expect(page.getByText("Ready 97")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check updates" })).toBeVisible();
  await expect(page.getByText("No apps discovered yet")).toHaveCount(0);
});

test("services load GitHub versions and select a tracked ref", async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto("/apps");
  const versionButton = page.locator('button[title="GitHub versions for Web"]');
  await expect(versionButton).toHaveCount(1);
  await versionButton.click();
  await expect(page.getByRole("heading", { name: "GitHub versions for Web" })).toBeVisible();
  await page.getByRole("button", { name: "Load from GitHub" }).click();
  await expect(page.locator(".sourceVersionToolbar")).toContainText(/2 update candidates from 3 GitHub refs/);

  const devOption = page.locator(".sourceVersionOption", { hasText: "dev" });
  await expect(devOption).toHaveCount(1);
  await devOption.click();
  await expect(page.getByLabel("Branch or tag")).toHaveValue("dev");
  await expect.poll(() => mock.requests).toContain(`PUT /api/apps/${app.id}/version`);
});

test("services expose service-level image tag updates", async ({ page }) => {
  await mockApi(page);
  await page.goto("/services");
  await page.getByTitle("Update service image tags").click();
  const dialog = page.getByRole("dialog", { name: "Update images for Web" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Update Web images")).toBeVisible();
  await expect(dialog.getByText("latest")).toBeVisible();
  await expect(dialog.getByText("beta")).toBeVisible();
  await dialog.getByLabel("Filter tags for nginx").fill("v0.9");
  await expect(dialog.getByText("v0.9.7")).toBeVisible();
  await expect(dialog.getByText("main")).toHaveCount(0);
});

test("files route uses an in-panel host selector and resets paths", async ({ page }) => {
  await mockApi(page, { hosts: [host, fileHost] });
  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Host Files" }).first()).toBeVisible();
  await expect(page.getByLabel("Management scope")).toHaveCount(0);
  await expect(page.getByLabel("Host")).toHaveValue(host.id);
  await expect(page.locator("form.inlineForm input.monoText").first()).toHaveValue("/home/docker");
  await expect(page.getByText("DemoApp")).toBeVisible();

  await page.getByLabel("Host").selectOption(fileHost.id);
  await expect(page.getByLabel("Host")).toHaveValue(fileHost.id);
  await expect(page.locator("form.inlineForm input.monoText").first()).toHaveValue("/home/deploy");
  await expect(page.getByText("OtherApp")).toBeVisible();
});

test("images cleanup preview explains blocked stopped-container images", async ({ page }) => {
  await mockApi(page);
  await page.goto("/images");
  await page.getByRole("button", { name: "Clean unused" }).click();
  await expect(page.getByText("held by stopped container demoapp-old")).toBeVisible();
  await expect(page.getByText("ghcr.io/composebastion-admin/demo-app:old")).toBeVisible();
  await expect(page.getByLabel("Select nginx:old")).toBeChecked();
  await expect(page.getByLabel("Select ghcr.io/composebastion-admin/demo-app:old")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete selected" })).toBeEnabled();
});

test("migrate compatibility route renders the unified migrate app panel", async ({ page }) => {
  await mockApi(page, { hosts: [host, fileHost] });
  await page.goto("/migrate");
  await expect(page.getByRole("heading", { name: "Recovery Center" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Migrate app", exact: true })).toBeVisible();
  await expect(page.getByText("Safe move")).toBeVisible();
  await expect(page.getByText("Warm move")).toBeVisible();
  await expect(page.getByText("Clone to host")).toBeVisible();
  await page.getByText("Advanced direct clone tools").click();
  await expect(page.getByText("Clone volume data")).toBeVisible();
  await expect(page.getByText("Clone container definition")).toBeVisible();
});

test("catalog imports external discovery as a review draft", async ({ page }) => {
  await mockApi(page);
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("ArchiveBox")).toBeVisible();
  await page.getByRole("button", { name: "Import draft" }).click();
  await expect(page.getByRole("heading", { name: "Custom template" })).toBeVisible();
  await expect(page.getByPlaceholder("Template ID, e.g. home-assistant")).toHaveValue("awesome-archivebox");
  await expect(page.getByPlaceholder("Display name")).toHaveValue("ArchiveBox");
  await expect(page.locator(".composeEditor").first()).toContainText("replace-with-official-image:latest");
});

test("metrics route follows host scope", async ({ page }) => {
  await mockApi(page);
  await page.goto("/host-metrics");
  await expect(page.getByRole("heading", { name: "Fleet metrics" })).toBeVisible();
  await page.getByLabel("Management scope").selectOption("selected");
  await expect(page.getByRole("heading", { name: "prod-01 metrics" })).toBeVisible();
});

test("recovery points surface restore drill status", async ({ page }) => {
  await mockApi(page);
  await page.goto("/recovery");
  await expect(page.getByRole("heading", { name: "Recovery Center" })).toBeVisible();
  await expect(page.locator(".readinessSummaryPanel")).toContainText("Ready");
  await expect(page.locator(".readinessDetailPanel")).toContainText("Volume web_data -> /data");
  await expect(page.getByText(/Last passed|Passed/).first()).toBeVisible();
});

test("backups route renders recovery-owned backups with sparse backup pages", async ({ page }) => {
  await mockApi(page);
  await page.goto("/backups");
  await expect(page.getByRole("heading", { name: "Recovery Center" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Backups" })).toBeVisible();
  await expect(page.getByText("Create backup")).toBeVisible();
  await expect(page.getByText(/view failed to load|view failed to render/i)).toHaveCount(0);
});

test("recovery drill flow uses confirmation before enqueue", async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto("/recovery");
  await page.getByTitle("Run restore drill").click();
  const dialog = page.getByRole("alertdialog", { name: "Run restore drill" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Run drill" })).toBeFocused();
  await dialog.getByRole("button", { name: "Run drill" }).click();
  await expect.poll(() => mock.requests).toContain("POST /api/recovery/points/66666666-6666-4666-8666-666666666666/drill");
});

test("container detail drawer exposes logs, stats, inspect, and exec tabs", async ({ page }) => {
  await mockApi(page);
  await page.goto("/containers");
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  await page.getByTitle("Open logs, stats, and exec").click();
  await expect(page.getByRole("heading", { name: "web" })).toBeVisible();
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.getByText("server started")).toBeVisible();
  await page.getByRole("button", { name: "Stats", exact: true }).click();
  await expect(page.getByText("CPUPerc")).toBeVisible();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByText("SECRET=<redacted>")).toBeVisible();
  await page.getByRole("button", { name: "Exec", exact: true }).first().click();
  await expect(page.locator("form.inlineForm").getByRole("button", { name: "Exec" })).toBeVisible();
});

test("image update preview dialog opens before container updates", async ({ page }) => {
  await mockApi(page);
  await page.goto("/updates");
  await expect(page.getByRole("heading", { name: "Image Updates" })).toBeVisible();
  await expect(page.getByText(/Scanner: trivy/)).toBeVisible();
  const updateButton = page.getByTitle("Update container");
  await updateButton.click();
  const dialog = page.getByRole("dialog", { name: "Update container" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Close update preview")).toBeFocused();
  await expect(dialog.getByText("update_container")).toBeVisible();
  await expect(dialog.getByText("Mutable tag")).toBeVisible();
  await page.getByLabel("Close update preview").click();
  await expect(dialog).toHaveCount(0);
  await expect(updateButton).toBeFocused();
});
