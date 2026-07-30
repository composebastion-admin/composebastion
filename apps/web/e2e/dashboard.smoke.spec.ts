import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const packageJson = require("../../../package.json") as { version: string };

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

const volumeResource = {
  id: "13131313-1313-4313-8313-131313131313",
  hostId: host.id,
  kind: "volume",
  externalId: "web-data",
  name: "web-data",
  data: { Name: "web-data", Driver: "local", Scope: "local" },
  updatedAt: new Date(0).toISOString()
};

const networkResource = {
  id: "14141414-1414-4414-8414-141414141414",
  hostId: host.id,
  kind: "network",
  externalId: "web-network",
  name: "web-network",
  data: { Name: "web-network", Driver: "bridge", Scope: "local" },
  updatedAt: new Date(0).toISOString()
};

const imageResource = {
  id: "24242424-2424-4424-8424-242424242424",
  hostId: host.id,
  kind: "image",
  externalId: "sha256:nginx",
  name: "nginx:latest",
  data: {
    ID: "sha256:nginx",
    Repository: "nginx",
    Tag: "latest",
    Digest: "sha256:nginx",
    CreatedSince: "2 days ago",
    Size: "80MB"
  },
  updatedAt: new Date(0).toISOString()
};

const composeStack = {
  id: "15151515-1515-4515-8515-151515151515",
  hostId: host.id,
  name: "Web stack",
  projectName: "web",
  composeYaml: "services:\n  web:\n    image: nginx:latest\n",
  env: "",
  status: "running",
  domains: [],
  tlsDesired: false,
  updatePolicyEnabled: false,
  sourceType: "ui",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

const composeVersion = {
  id: "25252525-2525-4525-8525-252525252525",
  stackId: composeStack.id,
  versionNumber: 1,
  composeYaml: "services:\n  web:\n    image: nginx:1.26\n",
  env: "",
  source: "ui",
  note: "Known good",
  createdBy: user.id,
  createdAt: new Date(0).toISOString()
};

const backup = {
  id: "26262626-2626-4626-8626-262626262626",
  hostId: host.id,
  kind: "volume",
  volumeName: volumeResource.name,
  sourcePath: null,
  archivePath: "/var/lib/composebastion/backups/web-data.tar.gz",
  sizeBytes: 1024,
  checksum: "a".repeat(64),
  status: "completed",
  error: null,
  encryption: "none",
  backupTargetId: null,
  remoteObjectKey: null,
  remoteStatus: null,
  remoteError: null,
  localCacheStatus: "present",
  verifiedAt: new Date(0).toISOString(),
  verificationStatus: "verified",
  lastDrillAt: new Date(0).toISOString(),
  lastDrillStatus: "completed",
  lastDrillError: null,
  createdBy: user.id,
  createdAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString()
};

const deploymentAnalysis = {
  id: "19191919-1919-4919-8919-191919191919",
  hostId: host.id,
  sourceId: null,
  sourceType: "git",
  sourceInput: "http://10.0.21.40:3000/kobuslabs/linuxclitogui",
  sourceLocator: "http://10.0.21.40:3000/kobuslabs/linuxclitogui",
  status: "ready",
  displayName: "linuxclitogui",
  projectName: "linuxclitogui",
  branch: "main",
  composePath: "docker-compose.yml",
  workingDir: "/srv/composebastion/deployments/linuxclitogui",
  composeYaml: "services:\n  app:\n    image: 10.0.21.40:3000/kobuslabs/linuxclitogui:latest\n    ports:\n      - 8080:8080\n",
  env: "",
  summary: {
    services: [{
      name: "app",
      image: "10.0.21.40:3000/kobuslabs/linuxclitogui:latest",
      build: null,
      ports: ["8080:8080"],
      volumes: []
    }],
    composeCandidates: ["docker-compose.yml"],
    dockerfileGenerated: false,
    trackedEnvFile: false
  },
  variables: [],
  warnings: [],
  blockers: [],
  registryIssues: [],
  error: null,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  deployedAt: null
};

const deploymentSource = {
  id: "20202020-2020-4020-8020-202020202020",
  sourceType: "git",
  name: "linuxclitogui",
  sourceLocator: "http://10.0.21.40:3000/kobuslabs/linuxclitogui",
  branch: "main",
  composePath: "docker-compose.yml",
  workingDir: "/srv/composebastion/deployments/linuxclitogui",
  projectName: "linuxclitogui",
  defaultHostId: host.id,
  targetHostIds: [host.id],
  safeEnvironment: {},
  hasCredential: false,
  metadata: {},
  lastDeployedAt: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

const managedUser = {
  id: "16161616-1616-4616-8616-161616161616",
  name: "Managed Operator",
  username: "managed-operator",
  email: "managed@example.com",
  role: "operator",
  isActive: true,
  createdAt: new Date(0).toISOString()
};

const registry = {
  id: "17171717-1717-4717-8717-171717171717",
  name: "Private registry",
  url: "https://registry.example.com",
  username: "robot",
  insecure: false,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

const s3RecoveryTarget = {
  id: "27272727-2727-4727-8727-272727272727",
  name: "Client object storage",
  type: "s3",
  kind: "s3",
  enabled: true,
  config: {},
  endpoint: "https://s3.example.test",
  region: "eu-west-1",
  bucket: "composebastion",
  prefix: "client-a",
  forcePathStyle: true,
  basePath: null,
  provider: null,
  rcloneProvider: null,
  remotePath: null,
  remoteName: null,
  localCachePolicy: "keep",
  healthStatus: "healthy",
  healthCheckedAt: new Date(0).toISOString(),
  healthError: null,
  hasCredentials: true,
  hasSecretAccessKey: true,
  hasGenericConfig: false,
  hasGenericCredentials: false,
  accessKeyId: "ACCESS-KEY",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

const smbRecoveryTarget = {
  ...s3RecoveryTarget,
  id: "28282828-2828-4828-8828-282828282828",
  name: "Client SMB",
  type: "rclone",
  kind: "rclone",
  endpoint: null,
  region: null,
  bucket: null,
  prefix: null,
  forcePathStyle: false,
  provider: "smb",
  rcloneProvider: "smb",
  remotePath: "backups/client-a",
  remoteName: "composebastion",
  localCachePolicy: "remote_only",
  hasSecretAccessKey: false,
  hasGenericCredentials: true,
  accessKeyId: null,
  config: {
    provider: "smb",
    smb: {
      server: "nas.internal",
      share: "backups",
      subPath: "client-a",
      domain: "WORKGROUP",
      username: "backup",
      port: 445
    }
  }
};

const migrationPlanRun = {
  id: "18181818-1818-4818-8818-181818181818",
  planRunId: null,
  sourceHostId: host.id,
  targetHostId: fileHost.id,
  sourceAppIdentity: { kind: "stack", stackId: app.stackId, projectName: app.projectName, label: app.name },
  mode: "plan",
  status: "completed",
  recoveryPointId: null,
  plan: {
    sourceHostId: host.id,
    targetHostId: fileHost.id,
    sourceAppIdentity: { kind: "stack", stackId: app.stackId, projectName: app.projectName, label: app.name },
    intent: { strategy: "clone", options: { stopSource: false, remapPorts: true, networkMode: "clone" } },
    sourceFingerprint: "a".repeat(64),
    targetFingerprint: "b".repeat(64),
    steps: [],
    warnings: [],
    estimatedArtifacts: 3,
    estimatedVolumes: 1,
    estimatedHostFolders: 0,
    checks: {
      sourceHostAvailable: true,
      targetHostAvailable: true,
      sourceDockerAvailable: true,
      targetDockerAvailable: true,
      sourceComposeAvailable: true,
      targetComposeAvailable: true
    },
    portConflicts: [],
    volumeCollisions: [],
    nameCollisions: [],
    missingNetworks: [],
    networkConflicts: [],
    estimatedDataBytes: 1024,
    blockingIssues: []
  },
  error: null,
  createdAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString()
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

const recoveryProfile = {
  id: "29292929-2929-4929-8929-292929292929",
  hostId: host.id,
  appIdentity: recoveryReadiness.appIdentity,
  name: "Web recovery",
  includePaths: ["/srv/web"],
  excludePatterns: ["*.tmp"],
  restorePaths: { "/srv/web": "/srv/web-restored" },
  preCaptureCommand: null,
  postCaptureCommand: null,
  captureMode: "hot",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

type MockApiOptions = {
  needsSetup?: boolean;
  requiresLogin?: boolean;
  hosts?: unknown[];
  hostsReady?: Promise<void>;
  role?: "owner" | "admin" | "operator" | "viewer";
  failChannelTest?: boolean;
  appOverride?: Record<string, unknown>;
  containerImage?: string;
  imageTags?: string[];
  githubRepositories?: unknown[];
  resources?: unknown[];
  composeStacks?: unknown[];
  deploymentSources?: unknown[];
  deploymentAnalysis?: Record<string, unknown>;
  users?: unknown[];
  registries?: unknown[];
  jobs?: unknown[];
  selfUpdateAvailable?: boolean;
  migrationPlanRun?: unknown;
  cancelJobReady?: Promise<void>;
  containerUpdateReady?: Promise<void>;
  failContainerUpdate?: boolean;
  failUpdatePreview?: boolean;
  usageSnapshot?: Record<string, unknown>[];
  usageSnapshotFallbackReady?: Promise<void>;
  usageStreamStats?: Record<string, unknown>;
  sessions?: unknown[];
  auditEvents?: unknown[];
  auditTotal?: number;
  recoveryTargets?: unknown[];
  recoverySchedules?: unknown[];
  backups?: unknown[];
  composeVersions?: unknown[];
  channelCreateReady?: Promise<void>;
  recoveryAnalysis?: Record<string, unknown>;
  favoriteImages?: unknown[];
  catalogTemplates?: unknown[];
  failures?: Record<string, { status?: number; error: string }>;
};

const unhandledApiRequests: string[] = [];
const unexpectedPageErrors: string[] = [];
const unexpectedConsoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  unhandledApiRequests.length = 0;
  unexpectedPageErrors.length = 0;
  unexpectedConsoleErrors.length = 0;
  page.on("pageerror", (error) => unexpectedPageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of")) {
      unexpectedConsoleErrors.push(message.text());
    }
  });
});

test.afterEach(async ({ page }) => {
  // Let fire-and-forget dashboard refreshes reach the explicit route mocks
  // before the page closes, especially in WebKit where navigation settles
  // before every secondary request has been scheduled.
  await page.waitForTimeout(100);
  expect(unhandledApiRequests, "all mocked API requests must have an explicit method-aware handler").toEqual([]);
  expect(unexpectedPageErrors, "the page must not emit uncaught exceptions or unhandled rejections").toEqual([]);
  expect(unexpectedConsoleErrors, "the browser console must not emit errors").toEqual([]);
});

function allowedMockMethods(path: string): ReadonlySet<string> {
  const rules: Array<[RegExp, readonly string[]]> = [
    [/^\/api\/auth\/(?:setup|login)$/, ["POST"]],
    [/^\/api\/auth\/(?:logout|logout-all)$/, ["POST"]],
    [/^\/api\/auth\/sessions\/[^/]+$/, ["DELETE"]],
    [/^\/api\/apps\/[^/]+\/(?:name|version)$/, ["PUT"]],
    [/^\/api\/alerts\/(?:channels|rules|silences)$/, ["GET", "POST"]],
    [/^\/api\/alerts\/channels\/test-history$/, ["GET"]],
    [/^\/api\/alerts\/(?:channels|rules|silences)\/[^/]+$/, ["DELETE"]],
    [/^\/api\/alerts\/channels\/[^/]+\/test$/, ["POST"]],
    [/^\/api\/config\/(?:export|import)$/, ["POST"]],
    [/^\/api\/compose\/[^/]+$/, ["PUT", "DELETE"]],
    [/^\/api\/compose\/[^/]+\/(?:deploy|stop|remove|rollback)$/, ["POST"]],
    [/^\/api\/hosts$/, ["GET", "POST"]],
    [/^\/api\/github\/repos\/[^/]+\/(?:deploy|test-host-access)$/, ["POST"]],
    [/^\/api\/deploy\/analyses$/, ["POST"]],
    [/^\/api\/deploy\/analyses\/[^/]+\/deploy$/, ["POST"]],
    [/^\/api\/hosts\/metrics$/, ["GET"]],
    [/^\/api\/hosts\/[^/]+\/compose$/, ["GET", "POST"]],
    [/^\/api\/hosts\/[^/]+$/, ["PUT", "DELETE"]],
    [/^\/api\/hosts\/[^/]+\/actions$/, ["POST"]],
    [/^\/api\/hosts\/[^/]+\/registries\/[^/]+\/login$/, ["POST"]],
    [/^\/api\/backups$/, ["GET", "POST"]],
    [/^\/api\/backups\/health$/, ["GET"]],
    [/^\/api\/backups\/[^/]+$/, ["DELETE"]],
    [/^\/api\/backups\/[^/]+\/(?:restore|restore-host-path|verify|drill)$/, ["POST"]],
    [/^\/api\/backup-schedules$/, ["GET", "POST"]],
    [/^\/api\/backup-schedules\/[^/]+$/, ["DELETE"]],
    [/^\/api\/catalog\/templates$/, ["GET", "POST"]],
    [/^\/api\/catalog\/templates\/[^/]+$/, ["DELETE"]],
    [/^\/api\/catalog\/deploy$/, ["POST"]],
    [/^\/api\/favorite-images$/, ["GET", "POST"]],
    [/^\/api\/favorite-images\/[^/]+$/, ["DELETE"]],
    [/^\/api\/image-scans$/, ["GET", "POST"]],
    [/^\/api\/jobs\/[^/]+\/(?:cancel|retry)$/, ["POST"]],
    [/^\/api\/migrations\/(?:volume-clone|container-clone)$/, ["POST"]],
    [/^\/api\/recovery\/analyze$/, ["POST"]],
    [/^\/api\/recovery\/readiness\/analyze$/, ["POST"]],
    [/^\/api\/recovery\/points$/, ["GET", "POST"]],
    [/^\/api\/recovery\/points\/[^/]+\/drill$/, ["POST"]],
    [/^\/api\/recovery\/points\/[^/]+\/verify$/, ["POST"]],
    [/^\/api\/recovery\/restore$/, ["POST"]],
    [/^\/api\/recovery\/profiles$/, ["PUT"]],
    [/^\/api\/recovery\/profiles\/[^/]+$/, ["GET", "DELETE"]],
    [/^\/api\/recovery\/migrations\/plan$/, ["POST"]],
    [/^\/api\/recovery\/schedules$/, ["GET", "POST"]],
    [/^\/api\/recovery\/schedules\/[^/]+$/, ["DELETE"]],
    [/^\/api\/recovery\/targets$/, ["GET", "POST"]],
    [/^\/api\/recovery\/targets\/[^/]+$/, ["GET", "PATCH", "DELETE"]],
    [/^\/api\/recovery\/targets\/[^/]+\/test$/, ["POST"]],
    [/^\/api\/registries$/, ["GET", "POST"]],
    [/^\/api\/registries\/[^/]+$/, ["DELETE"]],
    [/^\/api\/self-update\/config$/, ["PUT"]],
    [/^\/api\/self-update\/(?:check|start)$/, ["POST"]],
    [/^\/api\/users$/, ["GET", "POST"]],
    [/^\/api\/users\/[^/]+$/, ["PUT", "DELETE"]]
  ];
  const matched = rules.find(([pattern]) => pattern.test(path));
  return new Set(matched?.[1] ?? ["GET"]);
}

async function mockApi(page: Page, options: MockApiOptions = {}) {
  const requests: string[] = [];
  const requestBodies: Record<string, unknown[]> = {};
  const currentUser = { ...user, role: options.role ?? user.role };
  const hostList = options.hosts ?? [host];
  let appData = { ...app, ...(options.appOverride ?? {}) } as typeof app & Record<string, any>;
  const currentContainerResource = {
    ...containerResource,
    data: {
      ...containerResource.data,
      Image: options.containerImage ?? containerResource.data.Image
    }
  };
  let channelTestFailed = false;
  let selectedGitRef = appData.branch;
  let deploymentFinished = false;
  let authenticated = !options.needsSetup && !options.requiresLogin;
  let usageSnapshotRequests = 0;
  const analyzedDeployment = options.deploymentAnalysis ?? deploymentAnalysis;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const requestKey = `${request.method()} ${path}`;
    requests.push(requestKey);
    if (request.method() !== "GET" && request.postData()) {
      try {
        (requestBodies[requestKey] ??= []).push(request.postDataJSON());
      } catch {
        (requestBodies[requestKey] ??= []).push(request.postData());
      }
    }
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body)
    });

    if (!allowedMockMethods(path).has(request.method())) {
      unhandledApiRequests.push(requestKey);
      return json({ error: `Unhandled mocked API request: ${requestKey}` }, 501);
    }
    const forcedFailure = options.failures?.[requestKey];
    if (forcedFailure) {
      return json({ error: forcedFailure.error }, forcedFailure.status ?? 500);
    }

    if (path === "/api/auth/setup-state") return json({ needsSetup: Boolean(options.needsSetup) });
    if (path === "/api/auth/me") return authenticated ? json({ user: currentUser }) : json({ error: "Authentication required" }, 401);
    if (path === "/api/auth/setup" || path === "/api/auth/login") {
      authenticated = true;
      return json({ user: currentUser });
    }
    if (path === "/api/hosts" && request.method() === "POST") {
      return json({
        host,
        job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "host.check", status: "queued" }
      });
    }
    if (path === "/api/hosts") {
      if (options.hostsReady) await options.hostsReady;
      return json({ hosts: hostList });
    }
    if (path === `/api/hosts/${host.id}/resources`) return json({ resources: options.resources ?? [currentContainerResource] });
    if (path === `/api/hosts/${fileHost.id}/resources`) return json({ resources: [] });
    if (path === `/api/hosts/${host.id}/containers/usage`) {
      usageSnapshotRequests += 1;
      if (usageSnapshotRequests > 1) await options.usageSnapshotFallbackReady;
      return json({
        usage: options.usageSnapshot ?? [{ ID: "web", CPUPerc: "1.2%", MemPerc: "3.4%", MemUsage: "20MiB / 512MiB" }]
      });
    }
    if (path === `/api/hosts/${fileHost.id}/containers/usage`) return json({ usage: [] });
    if (path === `/api/hosts/${host.id}/containers/usage-stream`) return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({
        stats: options.usageStreamStats ?? {
          ID: "web",
          CPUPerc: "1.2%",
          MemPerc: "3.4%",
          MemUsage: "20MiB / 512MiB"
        }
      })}\n\n`
    });
    if (path === `/api/hosts/${fileHost.id}/containers/usage-stream`) return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": ping\n\n"
    });
    const metricsMatch = /^\/api\/hosts\/([^/]+)\/metrics$/.exec(path);
    const metricsStreamMatch = /^\/api\/hosts\/([^/]+)\/metrics-stream$/.exec(path);
    const metricsHostId = metricsMatch?.[1] ?? metricsStreamMatch?.[1];
    if (metricsHostId && (hostList as Array<{ id: string }>).some((item) => item.id === metricsHostId)) {
      const stats = {
        hostId: metricsHostId,
        collectedAt: new Date().toISOString(),
        cpuPercent: 12,
        load: { one: 0.42, five: 0.3, fifteen: 0.2 },
        memory: { totalBytes: 8 * 1024 * 1024 * 1024, usedBytes: 3 * 1024 * 1024 * 1024, availableBytes: 5 * 1024 * 1024 * 1024 },
        swap: { totalBytes: 0, usedBytes: 0 },
        disks: [{ mount: "/", totalBytes: 1000, usedBytes: 420, usedPercent: 42 }],
        network: null,
        containers: { running: 2, total: 3 },
        uptimeSeconds: 123456
      };
      if (metricsStreamMatch) return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ stats })}\n\n`
      });
      return json({
        specs: {
          hostId: metricsHostId,
          cpuCores: 4,
          memTotalBytes: 8 * 1024 * 1024 * 1024,
          os: "Linux",
          arch: "x86_64",
          dockerVersion: "27.0.0",
          collectedAt: new Date().toISOString()
        },
        stats
      });
    }
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
    if (path === `/api/hosts/${host.id}/compose` && request.method() === "POST") return json({ stack: composeStack });
    if (path === `/api/hosts/${host.id}/compose`) return json({ stacks: options.composeStacks ?? [] });
    if (path === `/api/hosts/${fileHost.id}/compose`) return json({ stacks: [] });
    if (path === `/api/compose/${composeStack.id}/versions`) return json({ versions: options.composeVersions ?? [] });
    if (path === `/api/compose/${composeStack.id}/versions/diff`) return json({
      fromVersionNumber: 1,
      toVersionNumber: 2,
      composeChanges: [{ type: "+", line: 3, text: "image: nginx:latest" }],
      envChanged: false
    });
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
    if (path === "/api/backups" && request.method() === "POST") return json({
      job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "volume.backup", status: "queued" }
    });
    if (path === "/api/backups") {
      const backupRows = options.backups ?? [];
      return json({
        backups: backupRows,
        total: backupRows.length,
        limit: Number(url.searchParams.get("limit") ?? 40),
        offset: Number(url.searchParams.get("offset") ?? 0),
        hasMore: false
      });
    }
    if (path === "/api/backup-schedules" && request.method() === "POST") return json({ ok: true });
    if (path === "/api/backup-schedules") return json({ schedules: [] });
    if (path === "/api/jobs") {
      const defaultJobs = [{
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
      }];
      const jobRows = options.jobs ?? defaultJobs;
      return json({
      jobs: jobRows,
      total: jobRows.length,
      limit: Number(url.searchParams.get("limit") ?? 40),
      offset: 0
    });
    }
    if (path === "/api/jobs/status") return json({ worker: {
      queued: 0,
      running: 0,
      lastJobCompletedAt: new Date(0).toISOString(),
      available: true,
      activeWorkers: 1,
      lastHeartbeatAt: new Date(0).toISOString(),
      state: "active"
    } });
    if (path === "/api/jobs/34343434-3434-4434-8434-343434343434/cancel" && request.method() === "POST") {
      await options.cancelJobReady;
      return json({ ok: true });
    }
    if (path === "/api/jobs/dddddddd-dddd-4ddd-8ddd-dddddddddddd") return json({
      job: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        correlationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        type: "git.cloneDeploy",
        status: "completed",
        hostId: host.id,
        payload: {},
        result: {},
        progress: [],
        error: null,
        createdBy: currentUser.id,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString()
      }
    });
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
    if (path === "/api/health") return json({ ok: true, version: "1.0.6", revision: null, buildDate: null });
    if (path === "/api/self-update") return json({
      configured: true,
      config: {
        hostId: host.id,
        workingDir: "/srv/composebastion",
        composeFile: "docker-compose.image.yml",
        versionMode: "latest",
        targetVersion: "latest"
      },
      runtime: { version: "1.0.6", revision: null, buildDate: null },
      latest: { version: options.selfUpdateAvailable ? "1.0.7" : "1.0.6", checkedAt: new Date(0).toISOString(), error: null },
      updateAvailable: Boolean(options.selfUpdateAvailable),
      lastJob: null
    });
    if (path === "/api/self-update/config" && request.method() === "PUT") return json({ config: request.postDataJSON() });
    if (path === "/api/self-update/check" && request.method() === "POST") return json({
      latest: { version: "1.0.7", checkedAt: new Date().toISOString(), error: null }
    });
    if (path === "/api/self-update/start" && request.method() === "POST") return json({
      job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "system.self_update", status: "queued" }
    });
    if (path === "/api/users" && request.method() === "POST") return json({ user: managedUser });
    if (path === "/api/users") return json({ users: options.users ?? [currentUser] });
    if (/^\/api\/users\/[^/]+$/.test(path)) return json({ ok: true, user: managedUser });
    if (path === "/api/registries" && request.method() === "POST") return json({ registry });
    if (path === "/api/registries") return json({ registries: options.registries ?? [] });
    if (/^\/api\/registries\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/config/export") return json({
      backup: {
        format: "composebastion-config",
        version: 1,
        encrypted: true,
        payload: "redacted-fixture"
      }
    });
    if (path === "/api/config/import") return json({
      imported: { hosts: 1, registries: 1, repositories: 1, stacks: 1 }
    });
    if (path === "/api/favorite-images" && request.method() === "POST") return json({
      image: { id: "30303030-3030-4030-8030-303030303030", image: "nginx:latest", name: "nginx", notes: "" }
    });
    if (path === "/api/favorite-images") return json({ images: options.favoriteImages ?? [] });
    if (/^\/api\/favorite-images\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/catalog/templates" && request.method() === "POST") {
      return json({ template: { ...(request.postDataJSON() as Record<string, unknown>), source: "custom" } });
    }
    if (path === "/api/catalog/templates") return json({ templates: options.catalogTemplates ?? [] });
    if (/^\/api\/catalog\/templates\/[^/]+$/.test(path) && request.method() === "DELETE") return json({ ok: true });
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
    if (path === "/api/github/repos") return json({ repositories: options.githubRepositories ?? [] });
    if (path === "/api/deployment-sources") {
      return json({ sources: deploymentFinished ? [deploymentSource] : (options.deploymentSources ?? []) });
    }
    if (path === "/api/deploy/analyses" && request.method() === "POST") {
      return json({
        analysis: analyzedDeployment,
        job: {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          type: "deploy.analyze",
          status: "queued"
        }
      });
    }
    if (path === `/api/deploy/analyses/${analyzedDeployment.id}`) {
      return json({
        analysis: deploymentFinished
          ? { ...analyzedDeployment, status: "deployed", sourceId: deploymentSource.id, deployedAt: new Date(0).toISOString() }
          : analyzedDeployment
      });
    }
    if (path === `/api/deploy/analyses/${analyzedDeployment.id}/deploy` && request.method() === "POST") {
      deploymentFinished = true;
      return json({
        analysis: { ...analyzedDeployment, status: "deployed", sourceId: deploymentSource.id, deployedAt: new Date(0).toISOString() },
        job: {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          type: "deploy.execute",
          status: "queued"
        }
      });
    }
    if (path === "/api/apps") return json({ apps: [{ ...appData, branch: selectedGitRef }] });
    if (path === `/api/apps/${appData.id}/name` && request.method() === "PUT") {
      appData = { ...appData, name: (request.postDataJSON() as { name?: string }).name ?? appData.name };
      return json({ app: appData });
    }
    if (path === `/api/apps/${appData.id}/versions`) return json({
      versions: {
        repositoryUrl: appData.repositoryUrl,
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
    if (path === `/api/apps/${appData.id}/version` && request.method() === "PUT") {
      selectedGitRef = (request.postDataJSON() as { ref?: string }).ref ?? selectedGitRef;
      return json({ app: { ...appData, branch: selectedGitRef } });
    }
    if (path === `/api/compose/${composeStack.id}` && request.method() === "PUT") {
      return json({ stack: { ...composeStack, ...(request.postDataJSON() as Record<string, unknown>) } });
    }
    if (path === "/api/auth/sessions") return json({ sessions: options.sessions ?? [{
      id: "abababab-abab-4bab-8bab-abababababab",
      ipAddress: "127.0.0.1",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      createdAt: new Date(0).toISOString(),
      lastSeenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      current: true
    }] });
    if (/^\/api\/auth\/sessions\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/auth/logout-all") return json({ ok: true });
    if (path === "/api/alerts/channels" && request.method() === "POST") {
      await options.channelCreateReady;
      return json({ ok: true });
    }
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
    if (/^\/api\/alerts\/(?:channels|rules|silences)\/[^/]+$/.test(path) && request.method() === "DELETE") {
      return json({ ok: true });
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
      affectedStacks: [{ id: appData.stackId, name: "Web" }],
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
    if (path === "/api/image-scans" && request.method() === "POST") return json({ ok: true });
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
    if (path === "/api/image-tags") return json({ image: url.searchParams.get("image"), tags: options.imageTags ?? ["latest", "main", "beta", "dev", "v0.9.7", "v0.9.6"] });
    if (path === "/api/image-updates/preview") {
      if (options.failUpdatePreview) {
        return json({ error: "Update preview failed intentionally" }, 500);
      }
      return json({ preview: {
      hostId: host.id,
      imageReference: "nginx:latest",
      status: "update_available",
      currentDigest: "sha256:local",
      remoteDigest: "sha256:remote",
      riskNote: "Mutable tag",
      credentialHint: null,
      safeAction: "update_container",
      affectedContainers: [{ id: "web", name: "web" }],
      affectedStacks: [{ id: appData.stackId, name: "Web" }],
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0 }
      } });
    }
    if (path === `/api/hosts/${host.id}/actions` && request.method() === "POST") {
      const payload = request.postDataJSON() as { type?: string } | null;
      if (payload?.type === "container.update") {
        await options.containerUpdateReady;
        if (options.failContainerUpdate) return json({ error: "Container update failed intentionally" }, 500);
        return json({ ok: true, job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "queued" } });
      }
      return json({ ok: true, job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "queued" } });
    }
    if (path === "/api/recovery/analyze") return json({
      analysis: options.recoveryAnalysis ?? {
        ...recoveryReadiness,
        status: "ready",
        recommendedCaptureMode: "hot",
        warnings: [],
        blockers: []
      }
    });
    if (path === "/api/recovery/readiness") return json({ readiness: [recoveryReadiness] });
    if (path === "/api/recovery/readiness/analyze") return json({ readiness: recoveryReadiness });
    if (path === "/api/recovery/points" && request.method() === "POST") return json({ point: recoveryPoint });
    if (path === "/api/recovery/points") return json({ points: [recoveryPoint] });
    if (path === "/api/recovery/profiles" && request.method() === "PUT") return json({ profile: recoveryProfile });
    if (/^\/api\/recovery\/profiles\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/recovery/targets" && request.method() === "POST") return json({ target: s3RecoveryTarget });
    if (path === "/api/recovery/targets") return json({ targets: options.recoveryTargets ?? [] });
    if (/^\/api\/recovery\/targets\/[^/]+\/test$/.test(path)) return json({ ok: true });
    if (/^\/api\/recovery\/targets\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/recovery/schedules") return json({ schedules: options.recoverySchedules ?? [{
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
    if (/^\/api\/recovery\/schedules\/[^/]+$/.test(path)) return json({ ok: true });
    if (path === "/api/recovery/migrations") return json({ runs: [] });
    if (path === "/api/recovery/migrations/plan" && request.method() === "POST") {
      return json({ run: options.migrationPlanRun ?? migrationPlanRun });
    }
    if (path === "/api/recovery/restore" && request.method() === "POST") {
      return json({ job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", type: "recovery.restore", status: "queued" } });
    }
    if (path === "/api/audit") return json({
      events: options.auditEvents ?? [{
        id: "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1",
        userId: currentUser.id,
        hostId: host.id,
        action: "registry.login",
        targetKind: "registry",
        targetId: registry.id,
        details: { username: "[redacted]", password: "[redacted]" },
        createdAt: new Date(0).toISOString()
      }],
      total: options.auditTotal ?? 1,
      limit: Number(url.searchParams.get("limit") ?? 50),
      offset: Number(url.searchParams.get("offset") ?? 0)
    });
    if (/^\/api\/hosts\/[^/]+$/.test(path)) return json({ ok: true, host });
    if (/^\/api\/compose\/[^/]+$/.test(path) && request.method() === "DELETE") return json({ ok: true });
    if (/^\/api\/backups\/[^/]+$/.test(path) && request.method() === "DELETE") return json({ ok: true });
    if (/^\/api\/backup-schedules\/[^/]+$/.test(path) && request.method() === "DELETE") return json({ ok: true });
    if (request.method() === "POST") return json({ ok: true, job: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "queued" } });
    unhandledApiRequests.push(requestKey);
    return json({ error: `Unhandled mocked API request: ${requestKey}` }, 501);
  });

  return { requests, requestBodies, unhandledApiRequests };
}

async function gotoApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

test("first-run setup reaches the dashboard", { tag: ["@critical", "@setup"] }, async ({ page }) => {
  await mockApi(page, { needsSetup: true, hosts: [] });
  await gotoApp(page, "/");
  await expect(page.getByRole("heading", { name: "ComposeBastion" })).toBeVisible();
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("long-enough-password");
  await page.getByRole("button", { name: "Create Admin" }).click();
  await expect(page.getByRole("heading", { name: "All Docker hosts" })).toBeVisible();
  await expect(page.getByText("No hosts added").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Host", exact: true })).toBeVisible();
});

test("login reaches the dashboard through the signed-out screen", { tag: ["@critical", "@login"] }, async ({ page }) => {
  const mock = await mockApi(page, { requiresLogin: true });
  await gotoApp(page, "/");
  await expect(page.getByRole("heading", { name: "ComposeBastion" })).toBeVisible();
  await page.getByLabel("Username or email").fill("admin");
  await page.getByLabel("Password").fill("long-enough-password");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("heading", { name: "All Docker hosts" })).toBeVisible();
  await expect.poll(() => mock.requests).toContain("POST /api/auth/login");
});

test("keyboard focus and theme toggle are visible", { tag: ["@critical", "@navigation"] }, async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/overview");
  await expect(page.getByRole("heading", { name: "prod-01" })).toBeVisible();
  await expect(page.locator(".globalSearch")).toHaveCSS("display", "grid");
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: /Search hosts and resources/ })).toBeFocused();
  const openSidebar = page.getByRole("button", { name: "Open sidebar" });
  if ((page.viewportSize()?.width ?? 1_440) <= 980) {
    await openSidebar.click();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  }
  await page.getByRole("link", { name: /Admin/ }).click();
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("button", { name: /dark mode/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("reduced-motion mode keeps focus and contrast usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockApi(page);
  await gotoApp(page, "/overview");
  await expect(page.locator(".globalSearch")).toHaveCSS("display", "grid");
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

test("operations panel exposes readiness, backup health, and failed jobs", { tag: ["@critical", "@admin"] }, async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/admin");
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.locator(".opsSummary strong", { hasText: "Readiness" })).toBeVisible();
  await expect(page.locator(".opsSummary")).toContainText("active · 1 active");
  await expect(page.locator(".opsSummary strong", { hasText: "Worker heartbeat" })).toBeVisible();
  await expect(page.locator(".opsSummary strong", { hasText: "Backups" })).toBeVisible();
  await expect(page.getByText("sync failed")).toBeVisible();
  await expect(page.getByText(/Confirm SSH or agent connectivity/)).toBeVisible();
});

test("job actions expose recovery context and confirm focus return", async ({ page }) => {
  let releaseCancel!: () => void;
  const cancelReady = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const mock = await mockApi(page, { cancelJobReady: cancelReady });
  await gotoApp(page, "/admin");
  await page.getByRole("button", { name: "Jobs" }).click();
  await expect(page.getByText(/Confirm SSH or agent connectivity/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => mock.requests).toContain("POST /api/jobs/33333333-3333-4333-8333-333333333333/retry");

  const cancelJobButton = page.getByRole("button", { name: "Cancel" }).first();
  await cancelJobButton.click();
  const dialog = page.getByRole("alertdialog", { name: "Cancel queued job" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Confirm" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cancelJobButton).toBeFocused();

  await cancelJobButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cancelJobButton).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Operation jobs" })).toBeFocused();
  releaseCancel();
  await expect(cancelJobButton).toBeEnabled();
});

test("high-impact deletion flows require exact typed confirmation", async ({ page }) => {
  await mockApi(page, {
    resources: [containerResource, volumeResource, networkResource],
    composeStacks: [composeStack]
  });

  await gotoApp(page, "/volumes");
  await page.getByTitle("Remove volume").click();
  let dialog = page.getByRole("alertdialog", { name: "Permanently remove volume" });
  const volumeInput = dialog.getByRole("textbox");
  await expect(volumeInput).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Remove volume" })).toBeDisabled();
  await volumeInput.fill("wrong-volume");
  await expect(dialog.getByRole("button", { name: "Remove volume" })).toBeDisabled();
  await volumeInput.fill(volumeResource.name);
  await expect(dialog.getByRole("button", { name: "Remove volume" })).toBeEnabled();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Prune", exact: true }).click();
  dialog = page.getByRole("alertdialog", { name: "Prune volumes" });
  await dialog.getByRole("textbox").fill(host.name);
  await expect(dialog.getByRole("button", { name: "Prune" })).toBeEnabled();
  await page.keyboard.press("Escape");

  await gotoApp(page, "/compose");
  await page.getByTitle("Advanced deployment settings").click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  dialog = page.getByRole("alertdialog", { name: "Remove service from Docker" });
  await expect(dialog.getByRole("button", { name: "Compose down" })).toBeEnabled();
  await page.keyboard.press("Escape");

  await gotoApp(page, "/admin");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Backup passphrase").fill("qualification-passphrase");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  dialog = page.getByRole("alertdialog", { name: "Import configuration" });
  await expect(dialog.getByRole("button", { name: "Import configuration" })).toBeDisabled();
  await dialog.getByRole("textbox").fill("IMPORT");
  await expect(dialog.getByRole("button", { name: "Import configuration" })).toBeEnabled();
  await page.keyboard.press("Escape");
});

test("destructive network, alert, registry, user, and self-update actions use danger dialogs", async ({ page }) => {
  await mockApi(page, {
    resources: [containerResource, networkResource],
    registries: [registry],
    users: [user, managedUser],
    selfUpdateAvailable: true
  });

  const expectDangerDialog = async (name: string) => {
    const dialog = page.getByRole("alertdialog", { name });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  };

  await gotoApp(page, "/networks");
  await page.getByTitle("Remove network").click();
  await expectDangerDialog("Remove network");

  await gotoApp(page, "/alerts");
  await page.getByRole("row", { name: /CPU sustained/ }).locator("button.danger").click();
  await expectDangerDialog("Delete alert rule");

  await gotoApp(page, "/admin");
  await page.getByRole("button", { name: "Registries" }).click();
  await page.getByRole("row", { name: /Private registry/ }).locator("button.danger").click();
  await expectDangerDialog("Delete registry");

  await page.getByRole("button", { name: "Users" }).click();
  await page.getByRole("row", { name: /Managed Operator/ }).locator("button.danger").click();
  await expectDangerDialog("Delete user");

  await page.getByRole("button", { name: "Operations" }).click();
  await page.getByRole("button", { name: "Update to latest version v1.0.7" }).click();
  const updateDialog = page.getByRole("alertdialog", { name: "Restart ComposeBastion" });
  await expect(updateDialog).toContainText("Update from v1.0.6 to v1.0.7");
  await expect(updateDialog).toContainText("app and worker will restart");
  await expectDangerDialog("Restart ComposeBastion");
});

test("alerts show silences and history", { tag: ["@critical", "@alerts"] }, async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/alerts");
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
  await expect(page.getByText("CPU sustained")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Maintenance" })).toBeVisible();
  await expect(page.getByText("CPU recovered")).toBeVisible();
  await expect(page.getByText("Channel Test History")).toBeVisible();
  await expect(page.getByRole("cell", { name: "success" })).toBeVisible();
});

test("failed alert channel tests refresh into history", async ({ page }) => {
  await mockApi(page, { failChannelTest: true });
  await gotoApp(page, "/alerts");
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.locator(".notice.error", { hasText: "Webhook failed with 500" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "failed", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Webhook failed with 500" })).toBeVisible();
});

test("viewer alerts avoid operator endpoints and show read-only history", async ({ page }) => {
  const mock = await mockApi(page, { role: "viewer" });
  await gotoApp(page, "/alerts");
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

test("viewer direct restricted routes redirect without issuing mutation requests", { tag: ["@critical", "@rbac"] }, async ({ page }) => {
  const mock = await mockApi(page, { role: "viewer" });
  await gotoApp(page, "/deploy");
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("link", { name: /Deploy/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Host", exact: true })).toHaveCount(0);
  await expect(page.locator('button[title="Open SSH terminal"]')).toHaveCount(0);
  await expect.poll(() => mock.requests.filter((request) => request === "GET /api/github/repos")).toEqual([]);
  await expect.poll(() => mock.requests.filter((request) => /^(POST|PUT|PATCH|DELETE) /.test(request))).toEqual([]);
});

test("operator sees Docker controls but not terminal or administrator-only sections", { tag: ["@critical", "@rbac"] }, async ({ page }) => {
  const mock = await mockApi(page, { role: "operator" });
  await gotoApp(page, "/hosts");
  await expect(page.getByRole("button", { name: "Host", exact: true })).toBeVisible();
  await expect(page.locator('button[title="Open SSH terminal"]')).toHaveCount(0);
  const openSidebar = page.getByRole("button", { name: "Open sidebar" });
  if (await openSidebar.isVisible()) await openSidebar.click();
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("button", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Audit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Registries" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Config Backup" })).toHaveCount(0);
  await expect.poll(() => mock.requests.filter((request) => request.includes("/api/config/"))).toEqual([]);
});

test("owner sees terminal and administrator-only sections", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/hosts");
  await expect(page.locator('button[title="Open SSH terminal"]')).toHaveCount(1);
  await gotoApp(page, "/admin");
  await expect(page.getByRole("button", { name: "Users" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audit" })).toBeVisible();
});

test("active sessions are reachable from admin settings", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/admin");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Config Backup" })).toBeVisible();
  await expect(page.getByText("This device")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out everywhere" })).toBeVisible();
});

test("admin about shows V1 licensing details", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/admin");
  await page.getByRole("button", { name: "About" }).click();
  await expect(page.getByRole("heading", { name: "About ComposeBastion" })).toBeVisible();
  await expect(page.locator(".adminPane").getByText(`v${packageJson.version}`)).toBeVisible();
  await expect(page.getByText("Copyright (c) 2026 ComposeBastion Admin. All rights reserved.")).toBeVisible();
  await expect(page.getByRole("link", { name: "support@composebastion.com" })).toBeVisible();
});

test("configuration export and import remain encrypted, validated, and confirmed", { tag: ["@critical", "@admin"] }, async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/settings");
  const passphrase = "qualification-passphrase";
  await page.getByLabel("Backup passphrase").fill(passphrase);

  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("status")).toContainText("Config export ready");
  const backupText = page.getByRole("textbox", { name: "Encrypted config JSON", exact: true });
  await expect(backupText).toHaveValue(/"encrypted": true/);
  expect(mock.requestBodies["POST /api/config/export"]?.at(-1)).toEqual({ passphrase });

  await backupText.fill(JSON.stringify({
    format: "composebastion-config",
    version: 1,
    encrypted: true,
    payload: "ciphertext"
  }));
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Import configuration" });
  await dialog.getByRole("textbox").fill("IMPORT");
  await dialog.getByRole("button", { name: "Import configuration" }).click();
  await expect(page.getByRole("status")).toContainText("Imported 4 records");
  expect(mock.requestBodies["POST /api/config/import"]?.at(-1)).toEqual({
    passphrase,
    backup: {
      format: "composebastion-config",
      version: 1,
      encrypted: true,
      payload: "ciphertext"
    }
  });
});

test("session revocation confirms the exact secondary session", { tag: ["@critical", "@admin"] }, async ({ page }) => {
  const secondarySession = {
    id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    ipAddress: "192.0.2.44",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    createdAt: new Date(0).toISOString(),
    lastSeenAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    current: false
  };
  const mock = await mockApi(page, {
    sessions: [{
      ...secondarySession,
      id: "abababab-abab-4bab-8bab-abababababab",
      ipAddress: "127.0.0.1",
      current: true
    }, secondarySession]
  });
  await gotoApp(page, "/settings");
  const secondaryRow = page.locator(".sessionRow", { hasText: "192.0.2.44" });
  await secondaryRow.getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Revoke session" });
  await expect(dialog).toContainText("iOS device");
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/auth/sessions/${secondarySession.id}`);
});

test("alert channel creation sends only the credential field for its selected channel type", { tag: ["@critical", "@alerts"] }, async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/alerts");

  await page.getByLabel("Channel name").fill("Primary email");
  await page.getByLabel("Email recipient").fill("alerts@example.com");
  await page.getByRole("button", { name: "Save Channel" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/alerts/channels"]?.length ?? 0).toBe(1);
  expect(mock.requestBodies["POST /api/alerts/channels"]?.[0]).toEqual({
    name: "Primary email",
    type: "email",
    emailTo: "alerts@example.com",
    enabled: true
  });

  await expect(page.getByLabel("Channel name")).toHaveValue("");
  await page.getByLabel("Channel type").selectOption("webhook");
  await page.getByLabel("Channel name").fill("Primary webhook");
  await page.getByLabel("Webhook URL").fill("https://hooks.example.test/composebastion");
  await page.getByRole("button", { name: "Save Channel" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/alerts/channels"]?.length ?? 0).toBe(2);
  expect(mock.requestBodies["POST /api/alerts/channels"]?.[1]).toEqual({
    name: "Primary webhook",
    type: "webhook",
    webhookUrl: "https://hooks.example.test/composebastion",
    enabled: true
  });
});

test("alert channel validation blocks malformed input and busy state prevents duplicate submission", async ({ page }) => {
  let releaseCreate!: () => void;
  const channelCreateReady = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const mock = await mockApi(page, { channelCreateReady });
  await gotoApp(page, "/alerts");

  await page.getByLabel("Channel name").fill("Invalid email");
  const email = page.getByLabel("Email recipient");
  await email.fill("not-an-email");
  await page.getByRole("button", { name: "Save Channel" }).click();
  expect(await email.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(false);
  expect(mock.requestBodies["POST /api/alerts/channels"] ?? []).toHaveLength(0);

  await email.fill("alerts@example.com");
  const save = page.getByRole("button", { name: "Save Channel" });
  await save.click();
  await expect.poll(() => mock.requestBodies["POST /api/alerts/channels"]?.length ?? 0).toBe(1);
  await expect(save).toBeDisabled();
  await save.click({ force: true });
  expect(mock.requestBodies["POST /api/alerts/channels"]).toHaveLength(1);

  releaseCreate();
  await expect(page.getByLabel("Channel name")).toHaveValue("");
});

test("alert channel API errors are rendered without an unhandled rejection", async ({ page }) => {
  await mockApi(page, {
    failures: {
      "POST /api/alerts/channels": { status: 503, error: "SMTP receiver is unavailable" }
    }
  });
  await gotoApp(page, "/alerts");
  await page.getByLabel("Channel name").fill("Unavailable email");
  await page.getByLabel("Email recipient").fill("alerts@example.com");
  await page.getByRole("button", { name: "Save Channel" }).click();
  await expect(page.getByRole("alert")).toContainText("SMTP receiver is unavailable");
});

test("registry and user mutation failures are visible without unhandled browser errors", { tag: ["@critical", "@admin"] }, async ({ page }) => {
  const mock = await mockApi(page, {
    registries: [registry],
    users: [user, managedUser],
    failures: {
      "POST /api/registries": { status: 422, error: "Registry credentials were rejected" },
      "POST /api/users": { status: 409, error: "A user with that email already exists" }
    }
  });

  await gotoApp(page, "/registries");
  await page.getByLabel("Registry name").fill("Broken registry");
  await page.getByLabel("Registry URL").fill("https://broken.example.test");
  await page.getByRole("button", { name: "Save Registry" }).click();
  await expect(page.getByRole("alert")).toContainText("Registry credentials were rejected");

  await page.getByRole("row", { name: /Private registry/ }).getByRole("button", { name: "Login" }).click();
  await expect.poll(() => mock.requests).toContain(`POST /api/hosts/${host.id}/registries/${registry.id}/login`);

  await gotoApp(page, "/users");
  await page.getByLabel(`Role for ${managedUser.email}`).selectOption("viewer");
  await expect.poll(() => mock.requestBodies[`PUT /api/users/${managedUser.id}`]?.at(-1)).toEqual({ role: "viewer" });

  await page.getByLabel("User email").fill("managed@example.com");
  await page.getByLabel("Temporary password").fill("temporary-password");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("alert")).toContainText("A user with that email already exists");
});

test("audit and job panels expose filtering, detail, pagination, and contained action errors", async ({ page }) => {
  const auditEvents = Array.from({ length: 50 }, (_, index) => ({
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    userId: user.id,
    hostId: host.id,
    action: index === 0 ? "config.import" : "host.sync",
    targetKind: index === 0 ? "config" : "host",
    targetId: index === 0 ? null : host.id,
    details: index === 0 ? { passphrase: "[redacted]", imported: 4 } : { status: "completed" },
    createdAt: new Date(index * 1000).toISOString()
  }));
  await mockApi(page, {
    auditEvents,
    auditTotal: 75,
    failures: {
      "POST /api/jobs/33333333-3333-4333-8333-333333333333/retry": {
        status: 409,
        error: "This job is not eligible for retry"
      }
    }
  });

  await gotoApp(page, "/audit");
  await page.getByLabel("Filter audit events").fill("config.import");
  await expect(page.getByRole("cell", { name: "config.import" })).toBeVisible();
  await page.getByText("View redacted details").click();
  await expect(page.locator("code", { hasText: '"passphrase":"[redacted]"' })).toBeVisible();
  await page.getByRole("button", { name: "Older events" }).click();
  await expect(page.getByText("51-75 of 75")).toBeVisible();

  await gotoApp(page, "/jobs");
  await page.getByLabel("Filter jobs").fill("sync failed");
  await expect(page.getByText("1 matching")).toBeVisible();
  await page.getByText("Job details").click();
  await expect(page.getByText("Created by")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert")).toContainText("This job is not eligible for retry");
});

test("recovery target secrets stay redacted and schedules remain confirmation-protected", { tag: ["@critical", "@backup-restore"] }, async ({ page }) => {
  const mock = await mockApi(page, {
    recoveryTargets: [s3RecoveryTarget, smbRecoveryTarget]
  });
  await gotoApp(page, "/recovery-targets");

  const s3Row = page.getByRole("row", { name: /Client object storage/ });
  await s3Row.getByTitle("Edit target").click();
  await expect(page.getByPlaceholder("Secret access key (leave blank to keep)")).toHaveValue("");
  await expect(page.getByText("Clear saved S3 credentials and disable target")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await s3Row.getByTitle("Test target").click();
  await expect.poll(() => mock.requests).toContain(`POST /api/recovery/targets/${s3RecoveryTarget.id}/test`);

  const smbRow = page.getByRole("row", { name: /Client SMB/ });
  await smbRow.getByTitle("Edit target").click();
  await expect(page.getByPlaceholder("Password (leave blank to keep)")).toHaveValue("");
  await expect(page.getByText("Clear saved password")).toBeVisible();

  await gotoApp(page, "/recovery-schedules");
  await page.getByRole("row", { name: /Nightly Web/ }).locator("button.danger").click();
  const dialog = page.getByRole("alertdialog", { name: "Delete schedule" });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain("DELETE /api/recovery/schedules/cccccccc-cccc-4ccc-8ccc-cccccccccccc");
});

test("network and volume controls submit explicit create, backup, remove, and prune contracts", async ({ page }) => {
  const mock = await mockApi(page, {
    resources: [containerResource, volumeResource, networkResource]
  });
  const actionKey = `POST /api/hosts/${host.id}/actions`;
  const actionBodies = () => (mock.requestBodies[actionKey] ?? []) as Array<{ type?: string; payload?: unknown }>;
  const actionBody = (type: string) => actionBodies().find((body) => body.type === type);

  await gotoApp(page, "/networks");
  await page.getByPlaceholder("Network name").fill("qualification-net");
  await page.locator("form.stack").filter({ has: page.getByPlaceholder("Network name") }).locator("select").selectOption("overlay");
  await page.getByPlaceholder("Subnet, optional").fill("10.44.0.0/24");
  await page.getByRole("button", { name: "Create" }).click();
  await expect.poll(() => actionBody("network.create")).toEqual({
    type: "network.create",
    payload: {
      name: "qualification-net",
      driver: "overlay",
      subnet: "10.44.0.0/24",
      labels: {}
    }
  });

  await page.getByTitle("Remove network").click();
  await page.getByRole("alertdialog", { name: "Remove network" }).getByRole("button", { name: "Remove network" }).click();
  await expect.poll(() => actionBody("network.remove")).toEqual({
    type: "network.remove",
    payload: { networkId: networkResource.externalId }
  });

  await page.getByRole("button", { name: "Prune Unused" }).click();
  await page.getByRole("alertdialog", { name: "Prune networks" }).getByRole("button", { name: "Prune" }).click();
  await expect.poll(() => actionBody("network.prune")).toEqual({ type: "network.prune", payload: {} });

  await gotoApp(page, "/volumes");
  await page.getByPlaceholder("Volume name").fill("qualification-volume");
  await page.getByRole("button", { name: "Create" }).click();
  await expect.poll(() => actionBody("volume.create")).toEqual({
    type: "volume.create",
    payload: { name: "qualification-volume", labels: {} }
  });

  await page.getByTitle("Back up volume").click();
  await expect.poll(() => mock.requestBodies["POST /api/backups"]?.at(-1)).toEqual({
    hostId: host.id,
    volumeName: volumeResource.name
  });

  await page.getByTitle("Remove volume").click();
  let dialog = page.getByRole("alertdialog", { name: "Permanently remove volume" });
  await dialog.getByRole("textbox").fill(volumeResource.name);
  await dialog.getByRole("button", { name: "Remove volume" }).click();
  await expect.poll(() => actionBody("volume.remove")).toEqual({
    type: "volume.remove",
    payload: { volumeName: volumeResource.name, force: false }
  });

  await page.getByRole("button", { name: "Prune", exact: true }).click();
  dialog = page.getByRole("alertdialog", { name: "Prune volumes" });
  await dialog.getByRole("textbox").fill(host.name);
  await dialog.getByRole("button", { name: "Prune" }).click();
  await expect.poll(() => actionBody("volume.prune")).toEqual({ type: "volume.prune", payload: {} });
});

test("image controls wire scan, pull, favorite, run, cleanup, prune, and confirmed removal", async ({ page }) => {
  const favoriteImage = {
    id: "30303030-3030-4030-8030-303030303030",
    image: "nginx:latest",
    name: "Nginx",
    notes: "Qualification fixture",
    createdAt: new Date(0).toISOString()
  };
  const mock = await mockApi(page, {
    resources: [containerResource, imageResource, networkResource],
    favoriteImages: [favoriteImage]
  });
  const actionKey = `POST /api/hosts/${host.id}/actions`;
  const actionBodies = () => (mock.requestBodies[actionKey] ?? []) as Array<{ type?: string; payload?: unknown }>;
  const actionBody = (type: string) => actionBodies().find((body) => body.type === type);
  await gotoApp(page, "/images");

  const imageRow = page.locator(".imagesTable tbody tr", { hasText: "nginx" });
  await imageRow.getByTitle("Scan image").click();
  await expect.poll(() => mock.requestBodies["POST /api/image-scans"]?.at(-1)).toEqual({
    hostId: host.id,
    imageReference: "nginx:latest"
  });

  await imageRow.getByTitle("Pull latest").click();
  await expect.poll(() => actionBody("image.pull")).toEqual({
    type: "image.pull",
    payload: { image: "nginx:latest" }
  });

  await imageRow.getByTitle("Add to favorites").click();
  await expect.poll(() => mock.requestBodies["POST /api/favorite-images"]?.at(-1)).toEqual({ image: "nginx:latest" });

  await imageRow.getByTitle("Run image").click();
  const runDrawer = page.locator(".compactDrawer", { hasText: "Run image" });
  await expect(runDrawer.getByPlaceholder("Image, e.g. nginx:alpine")).toHaveValue("nginx:latest");
  await runDrawer.getByPlaceholder("Container name").fill("qualification-nginx");
  await runDrawer.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => actionBody("container.run")).toMatchObject({
    type: "container.run",
    payload: {
      image: "nginx:latest",
      name: "qualification-nginx",
      restartPolicy: "unless-stopped",
      ports: [],
      env: [],
      volumes: []
    }
  });

  await page.getByRole("button", { name: "Clean unused" }).click();
  await expect(page.getByLabel("Select nginx:old")).toBeChecked();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await page.getByRole("alertdialog", { name: "Clean unused images" }).getByRole("button", { name: "Delete selected" }).click();
  await expect.poll(() => actionBody("image.cleanup")).toEqual({
    type: "image.cleanup",
    payload: {
      targets: [{ imageId: "sha256:unused", reference: "nginx:old" }]
    }
  });

  await page.getByRole("button", { name: "Prune dangling" }).click();
  await page.getByRole("alertdialog", { name: "Prune dangling layers" }).getByRole("button", { name: "Prune" }).click();
  await expect.poll(() => actionBody("image.prune")).toEqual({
    type: "image.prune",
    payload: { all: false }
  });

  await imageRow.getByTitle("Remove image").click();
  const removeDialog = page.getByRole("alertdialog", { name: "Remove image" });
  await expect(removeDialog).toContainText("nginx:latest");
  await removeDialog.getByRole("button", { name: "Remove image" }).click();
  await expect.poll(() => actionBody("image.remove")).toEqual({
    type: "image.remove",
    payload: { imageId: imageResource.externalId, force: false }
  });

  await page.getByRole("button", { name: "Saved images" }).click();
  await page.getByTitle("Remove favorite").click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/favorite-images/${favoriteImage.id}`);
});

test("image favorite add and delete failures remain contained and visible", async ({ page }) => {
  const favoriteImage = {
    id: "30303030-3030-4030-8030-303030303030",
    image: "nginx:latest",
    name: "Nginx",
    notes: "",
    createdAt: new Date(0).toISOString()
  };
  await mockApi(page, {
    resources: [imageResource],
    favoriteImages: [favoriteImage],
    failures: {
      "POST /api/favorite-images": { status: 503, error: "Favorite storage is unavailable" },
      [`DELETE /api/favorite-images/${favoriteImage.id}`]: { status: 409, error: "Favorite is in use" }
    }
  });
  await gotoApp(page, "/images");

  const imageRow = page.locator(".imagesTable tbody tr", { hasText: "nginx" });
  await imageRow.getByTitle("Add to favorites").click();
  await expect(page.locator(".toast-error", { hasText: "Favorite storage is unavailable" })).toBeVisible();

  await page.getByRole("button", { name: "Saved images" }).click();
  await page.getByTitle("Remove favorite").click();
  await expect(page.locator(".toast-error", { hasText: "Favorite is in use" })).toBeVisible();
});

test("container run and every bulk lifecycle control submit job-backed action bodies", async ({ page }) => {
  const mock = await mockApi(page, {
    resources: [containerResource, imageResource, networkResource]
  });
  const actionKey = `POST /api/hosts/${host.id}/actions`;
  const actionBodies = () => (mock.requestBodies[actionKey] ?? []) as Array<{ type?: string; payload?: unknown }>;

  await gotoApp(page, "/containers");
  await page.getByRole("button", { name: "Run container" }).click();
  await page.getByRole("button", { name: "Create Container" }).click();
  await page.getByPlaceholder("Image, e.g. nginx:alpine").fill("alpine:3.21");
  await page.getByPlaceholder("Container name").fill("qualification-alpine");
  await page.getByPlaceholder("Ports, one per line: 8080:80/tcp").fill("18080:80/tcp");
  await page.getByPlaceholder("Environment, one per line: KEY=value").fill("MODE=test");
  await page.locator("form.composeForm").filter({ has: page.getByPlaceholder("Container name") }).getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => actionBodies().find((body) => body.type === "container.run")).toMatchObject({
    type: "container.run",
    payload: {
      image: "alpine:3.21",
      name: "qualification-alpine",
      ports: [{ hostPort: 18080, containerPort: 80, protocol: "tcp" }],
      env: [{ key: "MODE", value: "test" }]
    }
  });

  for (const item of [
    { title: "Start selected", dialog: "Start selected containers", confirm: "Start", type: "container.start" },
    { title: "Stop selected", dialog: "Stop selected containers", confirm: "Stop", type: "container.stop" },
    { title: "Restart selected", dialog: "Restart selected containers", confirm: "Restart", type: "container.restart" }
  ]) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
    const prior = actionBodies().filter((body) => body.type === item.type).length;
    await page.getByLabel("Select row").click();
    await page.getByTitle(item.title, { exact: true }).click();
    await page.getByRole("alertdialog", { name: item.dialog }).getByRole("button", { name: item.confirm }).click();
    await expect.poll(() => actionBodies().filter((body) => body.type === item.type).length).toBe(prior + 1);
    expect(actionBodies().filter((body) => body.type === item.type).at(-1)).toEqual({
      type: item.type,
      payload: { containerId: containerResource.externalId }
    });
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  await page.getByLabel("Select row").click();
  await page.getByTitle("Delete selected").click();
  await page.getByRole("alertdialog", { name: "Delete multiple containers" }).getByRole("button", { name: "Delete All" }).click();
  await expect.poll(() => actionBodies().find((body) => body.type === "container.remove")).toEqual({
    type: "container.remove",
    payload: { containerId: containerResource.externalId, force: true, removeVolumes: false }
  });
});

test("Compose service settings wire update, deploy, stop, rollback, remove, and forget contracts", async ({ page }) => {
  const secondVersion = {
    ...composeVersion,
    id: "31313131-3131-4131-8131-313131313131",
    versionNumber: 2,
    composeYaml: composeStack.composeYaml,
    note: "Current"
  };
  const mock = await mockApi(page, {
    resources: [containerResource],
    composeStacks: [{ ...composeStack, currentVersionNumber: 2 }],
    composeVersions: [secondVersion, composeVersion]
  });
  await gotoApp(page, "/services");
  await page.getByTitle("Advanced deployment settings").click();
  let drawer = page.getByLabel(`Advanced deployment settings for ${composeStack.name}`);

  await drawer.getByLabel("Display name").fill(composeStack.name);
  await drawer.getByLabel("Environment").fill("QUALIFIED=true");
  await drawer.getByRole("button", { name: "Save deployment settings" }).click();
  await expect.poll(() => mock.requestBodies[`PUT /api/compose/${composeStack.id}`]?.at(-1)).toEqual({
    name: composeStack.name,
    projectName: composeStack.projectName,
    composeYaml: composeStack.composeYaml,
    env: "QUALIFIED=true"
  });

  await drawer.getByRole("button", { name: "Redeploy" }).click();
  await expect.poll(() => mock.requestBodies[`POST /api/compose/${composeStack.id}/deploy`]?.at(-1)).toEqual({});
  await drawer.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => mock.requestBodies[`POST /api/compose/${composeStack.id}/stop`]?.at(-1)).toEqual({});

  const versions = drawer.locator(".subPanel", { hasText: `Versions for ${composeStack.name}` });
  await versions.locator("tbody tr", { hasText: "v1" }).locator("button.danger").click();
  await page.getByRole("alertdialog", { name: "Rollback stack" }).getByRole("button", { name: "Rollback" }).click();
  await expect.poll(() => mock.requestBodies[`POST /api/compose/${composeStack.id}/rollback`]?.at(-1)).toEqual({
    versionId: composeVersion.id
  });

  await drawer.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Remove service from Docker" }).getByRole("button", { name: "Compose down" }).click();
  await expect.poll(() => mock.requestBodies[`POST /api/compose/${composeStack.id}/remove`]?.at(-1)).toEqual({
    removeVolumes: false
  });

  await expect(drawer).toHaveCount(0);
  await page.getByTitle("Advanced deployment settings").click();
  drawer = page.getByLabel(`Advanced deployment settings for ${composeStack.name}`);
  await drawer.getByRole("button", { name: "Forget only" }).click();
  await page.getByRole("alertdialog", { name: "Forget service record" }).getByRole("button", { name: "Forget only" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/compose/${composeStack.id}`);
});

test("host controls wire check, sync, secret-preserving edit, and confirmed delete", async ({ page }) => {
  const mock = await mockApi(page);
  const actionKey = `POST /api/hosts/${host.id}/actions`;
  await gotoApp(page, "/hosts");
  const hostRow = page.getByRole("row", { name: /prod-01/ });

  await hostRow.getByTitle("Check host").click();
  await hostRow.getByTitle("Refresh inventory").click();
  await expect.poll(() => mock.requestBodies[actionKey]).toEqual(expect.arrayContaining([
    { type: "host.check", payload: {} },
    { type: "host.sync", payload: {} }
  ]));

  await hostRow.getByTitle("Host settings").click();
  const settings = page.locator(".panel", { has: page.getByRole("heading", { name: "Host Settings" }) });
  const form = settings.locator("form.composeForm");
  await form.locator("input").nth(0).fill("prod-qualified");
  await form.getByPlaceholder("Tags, comma separated").fill("production, client-a");
  await form.getByRole("button", { name: "Save Host" }).click();
  await expect.poll(() => mock.requestBodies[`PUT /api/hosts/${host.id}`]?.at(-1)).toEqual({
    name: "prod-qualified",
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    connectionMode: "ssh",
    sshAuthType: "key",
    dockerSocketPath: host.dockerSocketPath,
    tags: ["production", "client-a"]
  });

  await form.getByRole("button", { name: "Delete Host" }).click();
  await page.getByRole("alertdialog", { name: "Delete host" }).getByRole("button", { name: "Delete host" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/hosts/${host.id}`);
});

test("registry and user positive CRUD preserve exact credentials, roles, and self invariants", async ({ page }) => {
  const mock = await mockApi(page, {
    registries: [registry],
    users: [user, managedUser]
  });
  await gotoApp(page, "/registries");
  await expect(page.getByRole("row", { name: /Private registry/ })).toBeVisible();

  await page.getByLabel("Registry name").fill("Qualification registry");
  await page.getByLabel("Registry URL").fill("http://registry.internal:5000");
  await page.getByLabel("Registry username").fill("qualification-bot");
  await page.getByLabel("Registry password or token").fill("registry-secret");
  await page.getByRole("checkbox", { name: "Insecure registry" }).check();
  const registryForm = page.locator("form.composeForm").filter({ has: page.getByLabel("Registry name") });
  expect(await registryForm.locator(":invalid").evaluateAll((elements) => elements.map((element) => ({
    label: element.getAttribute("aria-label"),
    message: (element as HTMLInputElement).validationMessage
  })))).toEqual([]);
  const saveRegistryButton = registryForm.getByRole("button", { name: "Save Registry" });
  await expect(saveRegistryButton).toBeEnabled();
  await saveRegistryButton.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => mock.requestBodies["POST /api/registries"]?.at(-1)).toEqual({
    name: "Qualification registry",
    url: "http://registry.internal:5000",
    username: "qualification-bot",
    password: "registry-secret",
    insecure: true
  });

  const registryRow = page.getByRole("row", { name: /Private registry/ });
  await registryRow.getByRole("button", { name: "Login" }).click();
  await expect.poll(() => mock.requestBodies[`POST /api/hosts/${host.id}/registries/${registry.id}/login`]?.at(-1)).toEqual({});
  await registryRow.getByTitle(`Delete ${registry.name}`).click();
  await page.getByRole("alertdialog", { name: "Delete registry" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/registries/${registry.id}`);

  await gotoApp(page, "/users");
  await page.getByLabel("User name").fill("Qualification Viewer");
  await page.getByLabel("Username").fill("qualification-viewer");
  await page.getByLabel("User email").fill("viewer@example.com");
  await page.getByLabel("Temporary password").fill("temporary-password");
  await page.getByLabel("New user role").selectOption("viewer");
  await page.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/users"]?.at(-1)).toEqual({
    name: "Qualification Viewer",
    username: "qualification-viewer",
    email: "viewer@example.com",
    password: "temporary-password",
    role: "viewer"
  });

  const selfRow = page.getByRole("row", { name: /Admin User/ });
  await expect(selfRow.getByLabel(`Role for ${user.email}`)).toBeDisabled();
  await expect(selfRow.getByRole("button", { name: "Disable" })).toBeDisabled();
  await expect(selfRow.getByLabel(`Delete ${user.email}`)).toBeDisabled();

  const managedRow = page.getByRole("row", { name: /Managed Operator/ });
  await managedRow.getByLabel(`Role for ${managedUser.email}`).selectOption("admin");
  await expect.poll(() => mock.requestBodies[`PUT /api/users/${managedUser.id}`]?.at(-1)).toEqual({ role: "admin" });
  await managedRow.getByRole("button", { name: "Disable" }).click();
  await page.getByRole("alertdialog", { name: "Disable user" }).getByRole("button", { name: "Disable" }).click();
  await expect.poll(() => mock.requestBodies[`PUT /api/users/${managedUser.id}`]?.at(-1)).toEqual({ isActive: false });
  await managedRow.getByLabel(`Delete ${managedUser.email}`).click();
  await page.getByRole("alertdialog", { name: "Delete user" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/users/${managedUser.id}`);
});

test("alert rule, channel, and silence CRUD submit metric and maintenance-window contracts", async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/alerts");

  const ruleForm = page.locator("form.stack").filter({ hasText: "Alert Rule" });
  await ruleForm.getByPlaceholder("Rule name").fill("Sustained memory");
  await ruleForm.locator("select").nth(0).selectOption("host.memory");
  await ruleForm.getByPlaceholder("Threshold").fill("90");
  await ruleForm.getByPlaceholder("Duration").fill("10");
  await ruleForm.locator("select").last().selectOption("77777777-7777-4777-8777-777777777777");
  await ruleForm.getByRole("button", { name: "Save Rule" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/alerts/rules"]?.at(-1)).toEqual({
    name: "Sustained memory",
    condition: "host.memory",
    hostId: host.id,
    channelId: "77777777-7777-4777-8777-777777777777",
    enabled: true,
    params: {
      comparator: "gte",
      threshold: 90,
      durationSeconds: 600
    }
  });

  const silenceForm = page.locator("form.inlineForm").filter({ hasText: "Maintenance window" });
  const expectedEndsAt = await page.evaluate(() => new Date("2099-01-01T00:00").toISOString());
  await silenceForm.getByPlaceholder("Name").fill("Qualification maintenance");
  await silenceForm.locator('input[type="datetime-local"]').fill("2099-01-01T00:00");
  await silenceForm.getByPlaceholder("Reason, optional").fill("production qualification");
  await silenceForm.getByRole("button", { name: "Silence" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/alerts/silences"]?.at(-1)).toEqual({
    name: "Qualification maintenance",
    endsAt: expectedEndsAt,
    reason: "production qualification",
    hostId: host.id
  });

  const ruleRow = page.getByRole("row", { name: /CPU sustained/ });
  await ruleRow.locator("button.danger").click();
  await page.getByRole("alertdialog", { name: "Delete alert rule" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain("DELETE /api/alerts/rules/88888888-8888-4888-8888-888888888888");

  const channelRow = page.getByRole("row", { name: /Ops email/ });
  await channelRow.locator("button.danger").click();
  await page.getByRole("alertdialog", { name: "Delete alert channel" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain("DELETE /api/alerts/channels/77777777-7777-4777-8777-777777777777");

  const silenceRow = page.getByRole("row", { name: /Maintenance/ });
  await silenceRow.locator("button.danger").click();
  await page.getByRole("alertdialog", { name: "Delete alert silence" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain("DELETE /api/alerts/silences/99999999-9999-4999-8999-999999999999");
});

test("recovery target and schedule CRUD preserve secrets and submit retention contracts", async ({ page }) => {
  const mock = await mockApi(page, {
    recoveryTargets: [s3RecoveryTarget, smbRecoveryTarget]
  });
  await gotoApp(page, "/recovery-targets");
  const storageForm = page.locator("form.inlineForm").filter({ hasText: "Add storage" });
  await storageForm.getByPlaceholder("Name").fill("Manager local");
  await storageForm.getByRole("button", { name: "Add storage" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/recovery/targets"]?.at(-1)).toEqual({
    name: "Manager local",
    type: "local",
    enabled: true
  });

  const s3Row = page.getByRole("row", { name: /Client object storage/ });
  await s3Row.getByTitle("Edit target").click();
  await page.getByPlaceholder("Prefix").fill("client-b");
  await page.getByRole("button", { name: "Save storage" }).click();
  await expect.poll(() => mock.requestBodies[`PATCH /api/recovery/targets/${s3RecoveryTarget.id}`]?.at(-1)).toEqual({
    name: s3RecoveryTarget.name,
    type: "s3",
    enabled: true,
    localCachePolicy: "keep",
    endpoint: s3RecoveryTarget.endpoint,
    bucket: s3RecoveryTarget.bucket,
    region: s3RecoveryTarget.region,
    prefix: "client-b",
    forcePathStyle: true,
    accessKeyId: s3RecoveryTarget.accessKeyId
  });

  await s3Row.getByTitle("Delete target").click();
  const targetDialog = page.getByRole("alertdialog", { name: "Delete backup target" });
  await expect(targetDialog).toContainText(s3RecoveryTarget.name);
  await targetDialog.getByRole("button", { name: "Delete target" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/recovery/targets/${s3RecoveryTarget.id}`);

  await gotoApp(page, "/recovery-schedules");
  await expect(page.getByTitle("Refresh recovery data")).toBeEnabled();
  const scheduleForm = page.locator("form.inlineForm").filter({ hasText: "Create schedule" });
  await expect(scheduleForm.locator("select").nth(0)).toHaveValue(host.id);
  await expect(scheduleForm.locator("select").nth(1)).toHaveValue(app.id);
  await scheduleForm.getByPlaceholder("Schedule name").fill("Six-hour qualification");
  await scheduleForm.locator("select").nth(2).selectOption(s3RecoveryTarget.id);
  await scheduleForm.locator("select").nth(3).selectOption("6");
  await scheduleForm.getByTitle("Retention count").fill("14");
  await scheduleForm.getByRole("radio", { name: "Stop-first" }).check();
  const enabledCheckbox = scheduleForm.getByRole("checkbox", { name: "Enabled" });
  await enabledCheckbox.focus();
  await page.keyboard.press("Space");
  await expect(enabledCheckbox).not.toBeChecked();
  expect(await scheduleForm.evaluate((form: HTMLFormElement) => ({
    valid: form.checkValidity(),
    invalid: Array.from(form.elements)
      .filter((element): element is HTMLInputElement | HTMLSelectElement => element instanceof HTMLInputElement || element instanceof HTMLSelectElement)
      .filter((element) => !element.validity.valid)
      .map((element) => ({ value: element.value, validationMessage: element.validationMessage }))
  }))).toEqual({ valid: true, invalid: [] });
  await scheduleForm.getByRole("button", { name: "Add schedule" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => mock.requestBodies["POST /api/recovery/schedules"]?.at(-1)).toEqual({
    hostId: host.id,
    name: "Six-hour qualification",
    appIdentity: {
      kind: "stack",
      stackId: app.stackId,
      projectName: app.projectName,
      label: app.name
    },
    backupTargetId: s3RecoveryTarget.id,
    intervalMs: 6 * 60 * 60 * 1000,
    retentionCount: 14,
    captureMode: "stop_first",
    enabled: false
  });

  await page.getByRole("row", { name: /Nightly Web/ }).locator("button.danger").click();
  await page.getByRole("alertdialog", { name: "Delete schedule" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain("DELETE /api/recovery/schedules/cccccccc-cccc-4ccc-8ccc-cccccccccccc");
});

test("recovery profile, capture, verify, and clone restore controls submit durable contracts", async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/recovery");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/recovery/analyze"]?.at(-1)).toMatchObject({
    hostId: host.id
  });

  await page.getByRole("button", { name: "Save profile" }).click();
  await expect.poll(() => mock.requestBodies["PUT /api/recovery/profiles"]?.at(-1)).toEqual({
    hostId: host.id,
    appIdentity: {
      kind: "stack",
      stackId: app.stackId,
      projectName: app.projectName,
      label: app.name
    },
    name: `${app.name} recovery`,
    includePaths: [],
    excludePatterns: [],
    captureMode: "hot",
    restorePaths: {},
    preCaptureCommand: null,
    postCaptureCommand: null
  });

  await page.getByRole("button", { name: "Delete profile" }).click();
  await page.getByRole("alertdialog", { name: "Delete recovery profile" }).getByRole("button", { name: "Delete profile" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/recovery/profiles/${recoveryProfile.id}`);

  await page.getByRole("button", { name: "Capture" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/recovery/points"]?.at(-1)).toEqual({
    hostId: host.id,
    appIdentity: {
      kind: "stack",
      stackId: app.stackId,
      projectName: app.projectName,
      label: app.name
    },
    extraIncludePaths: [],
    captureMode: "hot",
    stopFirst: false,
    triggerKind: "manual"
  });

  await page.getByTitle("Verify artifacts").click();
  await expect.poll(() => mock.requestBodies[`POST /api/recovery/points/${recoveryPoint.id}/verify`]?.at(-1)).toEqual({});
  await page.getByTitle("Restore clone").click();
  await page.getByRole("alertdialog", { name: "Restore clone" }).getByRole("button", { name: "Restore clone" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/recovery/restore"]?.at(-1)).toEqual({
    recoveryPointId: recoveryPoint.id,
    targetHostId: host.id,
    options: { mode: "clone", remapPorts: true }
  });
});

test("volume backup, restore, verify, drill, delete, and direct clone controls submit exact bodies", async ({ page }) => {
  const mock = await mockApi(page, {
    hosts: [host, fileHost],
    resources: [containerResource, volumeResource],
    backups: [backup]
  });
  await gotoApp(page, "/recovery-backups");
  const createBackupForm = page.locator("form.recoveryTaskCard").filter({ hasText: "Create backup" });
  await createBackupForm.getByPlaceholder("Volume name").fill("web-data");
  await createBackupForm.getByRole("button", { name: "Create" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/backups"]?.at(-1)).toEqual({
    hostId: host.id,
    volumeName: "web-data",
    encryption: "none"
  });

  const backupRow = page.getByRole("row", { name: /web-data/ }).filter({ has: page.getByTitle("Restore", { exact: true }) });
  await backupRow.getByPlaceholder("Target volume").fill("web-data-restored");
  await backupRow.getByTitle("Restore", { exact: true }).click();
  await page.getByRole("alertdialog", { name: "Restore backup" }).getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => mock.requestBodies[`POST /api/backups/${backup.id}/restore`]?.at(-1)).toEqual({
    targetHostId: host.id,
    targetVolumeName: "web-data-restored",
    overwrite: false
  });

  await backupRow.getByTitle("Verify checksum and remote copy").click();
  await expect.poll(() => mock.requestBodies[`POST /api/backups/${backup.id}/verify`]?.at(-1)).toEqual({ testArchive: false });
  await backupRow.getByTitle("Deep verify archive").click();
  await expect.poll(() => mock.requestBodies[`POST /api/backups/${backup.id}/verify`]?.at(-1)).toEqual({ testArchive: true });
  await backupRow.getByTitle("Test restore").click();
  await expect.poll(() => mock.requestBodies[`POST /api/backups/${backup.id}/drill`]?.at(-1)).toEqual({});
  await backupRow.getByTitle("Delete backup").click();
  await page.getByRole("alertdialog", { name: "Delete backup" }).getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => mock.requests).toContain(`DELETE /api/backups/${backup.id}`);

  await gotoApp(page, "/migrate");
  await page.getByText("Advanced direct clone tools").click();
  const volumeClone = page.locator("form.recoveryTaskCard").filter({ hasText: "Clone volume data" });
  await volumeClone.getByLabel("Target host").selectOption(fileHost.id);
  await volumeClone.getByLabel("Source volume").selectOption(volumeResource.name);
  await volumeClone.getByPlaceholder("Target volume").fill("web-data-clone");
  await volumeClone.getByRole("button", { name: "Clone volume" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/migrations/volume-clone"]?.at(-1)).toEqual({
    sourceHostId: host.id,
    targetHostId: fileHost.id,
    sourceVolumeName: volumeResource.name,
    targetVolumeName: "web-data-clone",
    overwrite: false
  });

  const containerClone = page.locator("form.recoveryTaskCard").filter({ hasText: "Clone container definition" });
  await containerClone.getByLabel("Target host").selectOption(fileHost.id);
  await containerClone.getByLabel("Source container").selectOption(containerResource.externalId);
  await containerClone.getByPlaceholder("Target name").fill("web-clone");
  await containerClone.getByRole("button", { name: "Clone container" }).click();
  await expect.poll(() => mock.requestBodies["POST /api/migrations/container-clone"]?.at(-1)).toEqual({
    sourceHostId: host.id,
    targetHostId: fileHost.id,
    containerId: containerResource.externalId,
    targetName: "web-clone",
    start: false
  });
});

test("mobile navigation opens and supports keyboard-visible links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await mockApi(page);
  await gotoApp(page, "/overview");
  await page.getByLabel("Open sidebar").click();
  await expect(page.getByLabel("Close sidebar")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /Dashboard/ })).toBeVisible();
});

test("mobile drawer remains open while initial host selection settles", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  let releaseHosts!: () => void;
  const hostsReady = new Promise<void>((resolve) => {
    releaseHosts = resolve;
  });
  await page.addInitScript(() => {
    window.localStorage.removeItem("composebastion.selectedHostId");
  });
  await mockApi(page, { hostsReady });
  await gotoApp(page, "/overview");
  await expect(page.getByRole("heading", { name: "All Docker hosts" })).toBeVisible();

  await page.getByLabel("Open sidebar").click();
  const sidebar = page.locator("aside.sidebar");
  await expect(sidebar).toHaveClass(/\bopen\b/);

  releaseHosts();
  await expect(page.getByText("1/1 online")).toBeVisible();
  await page.waitForFunction(
    (hostId) => window.localStorage.getItem("composebastion.selectedHostId") === hostId,
    host.id
  );
  await expect(sidebar).toHaveClass(/\bopen\b/);
  const containersLink = page.getByRole("link", { name: "Containers", exact: true });
  await expect(containersLink).toBeInViewport();
  await containersLink.click();
  await expect(page).toHaveURL(/\/containers$/);
  await expect(sidebar).not.toHaveClass(/\bopen\b/);
});

test("mobile admin settings remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await mockApi(page);
  await gotoApp(page, "/admin");
  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  await page.getByRole("button", { name: "Operations" }).click();
  await expect(page.getByRole("heading", { name: "Readiness checks" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible();
});

test("host SSH terminal action opens a visible warning drawer", async ({ page }) => {
  let closeTerminalSocket = async () => undefined;
  const terminalMessages: Array<string | Buffer> = [];
  await page.routeWebSocket(/\/api\/hosts\/[^/]+\/terminal$/, (socket) => {
    closeTerminalSocket = () => socket.close({ code: 1000, reason: "test complete" });
    socket.onMessage((message) => terminalMessages.push(message));
    socket.send(JSON.stringify({ type: "ready" }));
  });
  await mockApi(page);
  await gotoApp(page, "/hosts");
  const terminalButton = page.locator('button[title="Open SSH terminal"]');
  await expect(terminalButton).toHaveCount(1);
  await terminalButton.click();
  const dialog = page.getByRole("dialog", { name: "Host SSH terminal for prod-01" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Privileged shell access")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open shell" })).toBeVisible();
  const cancelButton = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close host terminal" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancelButton).toBeFocused();

  const box = await dialog.boundingBox();
  expect(box?.y ?? 9999).toBeLessThan(80);

  await dialog.getByRole("button", { name: "Open shell" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Connected to prod-01");
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
  const terminalInput = xterm.locator("textarea.xterm-helper-textarea");
  await terminalInput.focus();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(terminalInput).toBeFocused();
  await expect.poll(() => terminalMessages.some((message) => Buffer.isBuffer(message) && message.includes(0x1b))).toBe(true);
  await expect(dialog).toBeVisible();
  await closeTerminalSocket();
  await expect(dialog.getByRole("status")).toHaveText("Terminal disconnected from prod-01");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close host terminal" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(terminalButton).toBeFocused();
});

test("hosts add button opens the host form inline", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/hosts");
  await expect(page.getByRole("heading", { name: "Hosts", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add host" }).click();
  await expect(page.getByRole("button", { name: "Close form" })).toBeVisible();
  await expect(page.getByPlaceholder("Hostname or IP")).toBeVisible();
  await expect(page.locator(".hostsAddPanel .hostForm")).toBeVisible();
});

test("dedicated SSH route manages SSH connections", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/ssh");
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

test("universal deploy analyzes Git, deploys, and saves the source to My Library", { tag: ["@critical", "@deployment"] }, async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/deploy");
  await page.getByLabel("Deployment source").fill("http://10.0.21.40:3000/kobuslabs/linuxclitogui");
  await page.getByRole("button", { name: "Analyze" }).click();

  const review = page.locator(".universalDeploy", { hasText: "Review deployment" });
  await expect(review.getByText("Ready to deploy")).toBeVisible();
  await expect(review.getByRole("heading", { name: "linuxclitogui" })).toBeVisible();
  await expect(review).toContainText("10.0.21.40:3000/kobuslabs/linuxclitogui:latest");
  await expect(review).toContainText("8080:8080");
  await expect.poll(() => mock.requests).toContain("POST /api/deploy/analyses");

  await review.getByRole("button", { name: "Deploy & save" }).click();
  await expect(page.getByText("linuxclitogui deployed and saved to My Library.")).toBeVisible();
  await expect(page.locator(".deploymentSourceCard", { hasText: "linuxclitogui" })).toBeVisible();
  await expect.poll(() => mock.requests).toContain(`POST /api/deploy/analyses/${deploymentAnalysis.id}/deploy`);
});

test("apps compatibility route renders the services experience", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/apps");
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  const versionRow = page.locator(".serviceVersionRow", { hasText: "Current" });
  await expect(versionRow).toBeVisible();
  await expect(versionRow).toContainText("Latest");
  await expect(page.getByText("Ready 97")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan updates" })).toBeVisible();
  await expect(page.getByText("No apps discovered yet")).toHaveCount(0);
});

test("services load GitHub versions and select a tracked ref", async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/apps");
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

test("services rename the display name without changing the container", async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/services");
  await expect(page.getByText("Web").first()).toBeVisible();
  await page.getByTitle("Rename Web").click();
  await expect(page.getByRole("heading", { name: "Rename Web" })).toBeVisible();
  await page.getByLabel("Display name").fill("Example App");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect.poll(() => mock.requests).toContain(`PUT /api/apps/${app.id}/name`);
  await expect(page.getByText("Example App").first()).toBeVisible();
});

test("services expose service-level image tag updates", { tag: ["@critical", "@docker-lifecycle"] }, async ({ page }) => {
  await mockApi(page, {
    appOverride: {
      source: "image",
      repositoryId: null,
      repositoryUrl: null,
      branch: null,
      update: {
        status: "update_available",
        kind: "image",
        imageReference: "nginx:latest",
        currentDigest: "sha256:local",
        remoteDigest: "sha256:remote",
        checkedAt: new Date(0).toISOString(),
        riskNote: "Mutable tag"
      }
    }
  });
  await gotoApp(page, "/services");
  const updateTrigger = page.getByTitle("Update service image tags");
  await updateTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Update images for Web" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByText("Update Web images")).toBeVisible();
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Current latest channel");
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Latest stable v0.9.7");
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Remote digest remote");
  await expect(dialog.getByRole("button", { name: "Update 1 container" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "latest current" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "beta" })).toBeVisible();
  await dialog.getByLabel("Filter tags for nginx").fill("v0.9");
  await expect(dialog.getByRole("button", { name: "v0.9.7" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "main" })).toHaveCount(0);

  const close = dialog.getByTitle("Close");
  const submit = dialog.getByRole("button", { name: "Update 1 container" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(updateTrigger).toBeFocused();
});

test("service image update failures stay in the drawer without unhandled rejection", async ({ page }) => {
  const mock = await mockApi(page, {
    appOverride: {
      source: "image",
      repositoryId: null,
      repositoryUrl: null,
      branch: null,
      update: {
        status: "update_available",
        kind: "image",
        imageReference: "nginx:latest",
        currentDigest: "sha256:local",
        remoteDigest: "sha256:remote",
        checkedAt: new Date(0).toISOString()
      }
    },
    failures: {
      [`POST /api/hosts/${host.id}/actions`]: { status: 503, error: "Docker host is unavailable" }
    }
  });
  await gotoApp(page, "/services");
  await page.getByTitle("Update service image tags").click();
  const dialog = page.getByRole("dialog", { name: "Update images for Web" });
  await dialog.getByRole("button", { name: "Update 1 container" }).click();
  await page.getByRole("alertdialog", { name: "Update Web" }).getByRole("button", { name: "Update service" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Docker host is unavailable");
  await expect(page.locator(".toast-error", { hasText: "Docker host is unavailable" })).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await expect.poll(() => mock.requestBodies[`POST /api/hosts/${host.id}/actions`]?.at(-1)).toEqual({
    type: "container.update",
    payload: { containerId: containerResource.externalId, targetImage: "nginx:latest" }
  });
});

test("container create and detail action failures remain contained and visible", async ({ page }) => {
  await mockApi(page, {
    failures: {
      [`POST /api/hosts/${host.id}/actions`]: { status: 503, error: "Docker mutation service is unavailable" }
    }
  });
  await gotoApp(page, "/containers");

  await page.getByRole("button", { name: "Run container" }).click();
  await page.getByRole("button", { name: "Create Container" }).click();
  await page.getByPlaceholder("Image, e.g. nginx:alpine").fill("alpine:3.21");
  await page.locator("form.composeForm").filter({ has: page.getByPlaceholder("Image, e.g. nginx:alpine") }).getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Docker mutation service is unavailable" }).first()).toBeVisible();

  await page.getByTitle("Open logs, stats, inspect, and exec").click();
  const detail = page.locator(".containerDetailDrawer");
  await detail.getByRole("button", { name: "Start", exact: true }).click();
  await expect(detail.getByRole("alert").filter({ hasText: "Docker mutation service is unavailable" })).toBeVisible();
});

test("universal deployment analysis failures render inline without escaping the event boundary", async ({ page }) => {
  await mockApi(page, {
    failures: {
      "POST /api/deploy/analyses": { status: 502, error: "Deployment analyzer is unavailable" }
    }
  });
  await gotoApp(page, "/deploy");
  await page.getByLabel("Deployment source").fill("ghcr.io/example/qualification:latest");
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "Deployment analyzer is unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deploy an app" })).toBeVisible();
});

test("compose version and proxy failures stay scoped to the advanced service drawer", async ({ page }) => {
  await mockApi(page, {
    composeStacks: [composeStack],
    failures: {
      [`GET /api/compose/${composeStack.id}/versions`]: { status: 503, error: "Version history is unavailable" },
      [`GET /api/compose/${composeStack.id}/proxy/snippets`]: { status: 503, error: "Proxy preview is unavailable" }
    }
  });
  await gotoApp(page, "/compose");
  await page.getByTitle("Advanced deployment settings").click();
  const drawer = page.getByLabel(`Advanced deployment settings for ${composeStack.name}`);

  await expect(drawer.getByRole("alert").filter({ hasText: "Version history is unavailable" })).toBeVisible();
  await drawer.getByRole("button", { name: "Preview snippets" }).click();
  await expect(drawer.getByRole("alert").filter({ hasText: "Proxy preview is unavailable" })).toBeVisible();
  await expect(drawer).toBeVisible();
});

test("services allow beta channel refresh when a newer prerelease exists", async ({ page }) => {
  const image = "ghcr.io/composebastion-tests/example-app:beta";
  await mockApi(page, {
    containerImage: image,
    imageTags: ["latest", "main", "beta", "dev", "1.7.0-beta.4", "1.7.0-beta.3", "1.6.7", "1.2.2"],
    appOverride: {
      source: "image",
      repositoryId: null,
      repositoryUrl: null,
      branch: null,
      imageReferences: [image],
      update: {
        status: "up_to_date",
        kind: "image",
        imageReference: image,
        currentDigest: "sha256:local",
        remoteDigest: "sha256:local",
        checkedAt: new Date(0).toISOString()
      }
    }
  });
  await gotoApp(page, "/services");
  await page.getByTitle("Update service image tags").click();
  const dialog = page.getByRole("dialog", { name: "Update images for Web" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Current beta channel");
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Latest prerelease 1.7.0-beta.4");
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Refresh channel 1.7.0-beta.4");
  await expect(dialog.getByLabel("Target image for ghcr.io/composebastion-tests/example-app")).toHaveValue(image);
  await expect(dialog.getByRole("button", { name: "Update 1 container" })).toBeEnabled();
});

test("services order a stable image release ahead of its release candidates", async ({ page }) => {
  const image = "ghcr.io/composebastion-admin/example:1.1.0-rc.2";
  await mockApi(page, {
    containerImage: image,
    imageTags: ["1.1.0-rc.2", "1.1.0", "1.1.0-rc.10", "1.0.9"],
    appOverride: {
      source: "image",
      repositoryId: null,
      repositoryUrl: null,
      branch: null,
      imageReferences: [image],
      update: { status: "up_to_date", kind: "image", imageReference: image }
    }
  });
  await gotoApp(page, "/services");
  await page.getByTitle("Update service image tags").click();
  const dialog = page.getByRole("dialog", { name: "Update images for Web" });
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Latest stable 1.1.0");
  await expect(dialog.locator(".serviceImageVersionSummary")).toContainText("Latest prerelease 1.1.0-rc.10");
  const orderedTags = await dialog.locator(".imageTagOption").allTextContents();
  expect(orderedTags.slice(0, 3).map((value) => value.trim())).toEqual(["1.1.0", "1.1.0-rc.10", "1.1.0-rc.2current"]);
});

test("files route uses an in-panel host selector and resets paths", async ({ page }) => {
  await mockApi(page, { hosts: [host, fileHost] });
  await gotoApp(page, "/files");
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
  await gotoApp(page, "/images");
  await page.getByRole("button", { name: "Clean unused" }).click();
  await expect(page.getByText("held by stopped container demoapp-old")).toBeVisible();
  await expect(page.getByText("ghcr.io/composebastion-admin/demo-app:old")).toBeVisible();
  await expect(page.getByLabel("Select nginx:old")).toBeChecked();
  await expect(page.getByLabel("Select ghcr.io/composebastion-admin/demo-app:old")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete selected" })).toBeEnabled();
});

test("migrate compatibility route renders the unified migrate app panel", async ({ page }) => {
  await mockApi(page, { hosts: [host, fileHost] });
  await gotoApp(page, "/migrate");
  await expect(page.getByRole("heading", { name: "Recovery Center" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Migrate app", exact: true })).toBeVisible();
  await expect(page.getByText("Safe move")).toBeVisible();
  await expect(page.getByText("Warm move")).toBeVisible();
  await expect(page.getByText("Clone to host")).toBeVisible();
  await page.getByText("Advanced direct clone tools").click();
  await expect(page.getByText("Clone volume data")).toBeVisible();
  await expect(page.getByText("Clone container definition")).toBeVisible();
});

test("changing migration intent invalidates the displayed reviewed plan", async ({ page }) => {
  const mock = await mockApi(page, { hosts: [host, fileHost] });
  await gotoApp(page, "/migrate");
  await page.getByRole("button", { name: "Plan / check" }).click();
  const execute = page.getByRole("button", { name: "Execute migration" });
  await expect(execute).toBeEnabled();
  await page.getByLabel("Safe move").check();
  await expect(execute).toBeDisabled();
  await expect.poll(() => mock.requests.filter((request) => request === "POST /api/recovery/migrations/execute")).toEqual([]);
});

test("catalog imports external discovery as a review draft", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/catalog");
  await expect(page.getByRole("heading", { name: "Catalog", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("ArchiveBox")).toBeVisible();
  await page.getByRole("button", { name: "Import draft" }).click();
  await expect(page.getByRole("heading", { name: "Custom template" })).toBeVisible();
  await expect(page.getByPlaceholder("Template ID, e.g. home-assistant")).toHaveValue("awesome-archivebox");
  await expect(page.getByPlaceholder("Display name")).toHaveValue("ArchiveBox");
  await expect(page.locator(".composeEditor").first()).toContainText("replace-with-official-image:latest");
});

test("catalog load and refresh failures remain contained and disclose unavailability", async ({ page }) => {
  const mock = await mockApi(page, {
    failures: {
      "GET /api/catalog/templates": { status: 503, error: "Catalog service is unavailable" }
    }
  });
  await gotoApp(page, "/catalog");

  await expect(page.getByRole("alert").filter({ hasText: "Catalog service is unavailable" })).toBeVisible();
  await expect(page.getByText("Catalog unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Refresh catalog" }).click();
  await expect.poll(() => mock.requests.filter((request) => request === "GET /api/catalog/templates").length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("alert").filter({ hasText: "Catalog service is unavailable" })).toBeVisible();
});

test("custom catalog template delete failures remain contained and visible", async ({ page }) => {
  const customTemplate = {
    id: "qualification-template",
    name: "Qualification template",
    description: "Disposable qualification fixture",
    category: "utility",
    docsUrl: "https://example.com/docs",
    suggestedPorts: ["18080:80"],
    suggestedVolumes: ["qualification_data:/data"],
    defaultEnv: {},
    composeYaml: "services:\n  app:\n    image: nginx:alpine",
    source: "custom"
  };
  await mockApi(page, {
    catalogTemplates: [customTemplate],
    failures: {
      "DELETE /api/catalog/templates/qualification-template": { status: 409, error: "Template is currently in use" }
    }
  });
  await gotoApp(page, "/catalog");

  const row = page.locator("tbody tr", { hasText: "Qualification template" });
  await row.getByTitle("Delete custom template").click();
  await page.getByRole("alertdialog", { name: "Delete catalog template" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Template is currently in use" })).toBeVisible();
  await expect(row).toBeVisible();
});

test("metrics route follows host scope", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/host-metrics");
  await expect(page.getByRole("heading", { name: "Fleet metrics" })).toBeVisible();
  await page.getByLabel("Management scope").selectOption("selected");
  await expect(page.getByRole("heading", { name: "prod-01 metrics" })).toBeVisible();
});

test("recovery points surface restore drill status", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/recovery");
  await expect(page.getByRole("heading", { name: "Recovery Center" })).toBeVisible();
  await expect(page.locator(".readinessSummaryPanel")).toContainText("Ready");
  await expect(page.locator(".readinessDetailPanel")).toContainText("Volume web_data -> /data");
  await expect(page.getByText(/Last passed|Passed/).first()).toBeVisible();
});

test("backups route renders recovery-owned backups with sparse backup pages", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/backups");
  await expect(page.getByRole("heading", { name: "Recovery Center" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Backups" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Backups" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Backup inventory" })).toBeVisible();
  await expect(page.getByText("Create backup")).toBeVisible();
  await expect(page.getByText(/view failed to load|view failed to render/i)).toHaveCount(0);
});

test("backup auxiliary failures disclose partial data while fulfilled sections remain usable", async ({ page }) => {
  await mockApi(page, {
    failures: {
      "GET /api/backup-schedules": { status: 503, error: "Schedule service is unavailable" }
    }
  });
  await gotoApp(page, "/backups");

  const alert = page.getByRole("alert").filter({ hasText: "Backup data is partially unavailable" });
  await expect(alert).toContainText("schedules");
  await expect(alert).toContainText("Schedule service is unavailable");
  await expect(page.getByRole("heading", { name: "Backup inventory" })).toBeVisible();
  await expect(page.getByText("Backup health")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
});

test("backup deletion failures stay visible without an unhandled rejection", async ({ page }) => {
  await mockApi(page, {
    backups: [backup],
    failures: {
      [`DELETE /api/backups/${backup.id}`]: { status: 409, error: "Backup is protected by retention policy" }
    }
  });
  await gotoApp(page, "/backups");

  await page.getByTitle("Delete backup").click();
  await page.getByRole("alertdialog", { name: "Delete backup" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Backup is protected by retention policy" })).toBeVisible();
  await expect(page.getByText(backup.volumeName ?? "", { exact: true })).toBeVisible();
});

test("restore run surfaces render V1 labels", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/recovery-runs");
  await expect(page.getByRole("heading", { name: "Recovery Center" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Restore Runs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore / Migration Runs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent Restore / Migration Jobs" })).toBeVisible();
});

test("recovery drill flow uses confirmation before enqueue", { tag: ["@critical", "@backup-restore"] }, async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/recovery");
  await page.getByTitle("Run restore drill").click();
  const dialog = page.getByRole("alertdialog", { name: "Run restore drill" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Run drill" })).toBeFocused();
  await dialog.getByRole("button", { name: "Run drill" }).click();
  await expect.poll(() => mock.requests).toContain("POST /api/recovery/points/66666666-6666-4666-8666-666666666666/drill");
});

test("container detail drawer exposes logs, stats, inspect, and exec tabs", async ({ page }) => {
  await mockApi(page);
  await gotoApp(page, "/containers");
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  await page.getByTitle("Open logs, stats, inspect, and exec").click();
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

test("container usage consumes production-shaped streamed updates", { tag: "@sse" }, async ({ page }) => {
  let releaseSnapshotFallback!: () => void;
  const snapshotFallbackReady = new Promise<void>((resolve) => {
    releaseSnapshotFallback = resolve;
  });
  await mockApi(page, {
    usageSnapshot: [{ ID: "unrelated", CPUPerc: "0.1%", MemPerc: "0.2%", MemUsage: "1MiB / 512MiB" }],
    usageSnapshotFallbackReady: snapshotFallbackReady,
    usageStreamStats: {
      ID: "web",
      CPUPerc: "73.5%",
      MemPerc: "64.2%",
      MemUsage: "329MiB / 512MiB"
    }
  });
  try {
    await gotoApp(page, "/containers");
    const containerRow = page.locator(".containerTable tbody tr", { hasText: "web" });
    await expect(containerRow).toContainText("73.5%");
    await expect(containerRow).toContainText("64.2%");
  } finally {
    releaseSnapshotFallback();
  }
});

test("Docker lifecycle submits a container stop job", { tag: ["@critical", "@docker-lifecycle"] }, async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/containers");
  const containerRow = page.locator(".containerTable tbody tr", { hasText: "web" });
  await containerRow.getByTitle("Stop").click();
  await expect.poll(() => mock.requests).toContain(`POST /api/hosts/${host.id}/actions`);
});

test("image update preview traps focus and restores its current trigger on every close path", async ({ page }) => {
  const mock = await mockApi(page);
  await gotoApp(page, "/updates");
  await expect(page.getByRole("heading", { name: "Image Updates" })).toBeVisible();
  await expect(page.getByText(/Scanner: trivy/)).toBeVisible();
  const updateButton = page.getByTitle("Update container");
  const redeployButton = page.getByTitle("Redeploy Web");

  await updateButton.click();
  let dialog = page.getByRole("dialog", { name: "Update container" });
  await expect(dialog).toBeVisible();
  const closeButton = dialog.getByLabel("Close update preview");
  const cancelButton = dialog.getByRole("button", { name: "Cancel" });
  const confirmButton = dialog.getByRole("button", { name: "Update container" });
  await expect(cancelButton).toBeFocused();
  await expect(dialog.getByText("update_container")).toBeVisible();
  await expect(dialog.getByText("Mutable tag")).toBeVisible();

  await page.keyboard.press("Shift+Tab");
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancelButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await closeButton.click();
  await expect(dialog).toHaveCount(0);
  await expect(updateButton).toBeFocused();

  await redeployButton.click();
  dialog = page.getByRole("dialog", { name: "Redeploy Web" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(redeployButton).toBeFocused();

  await updateButton.click();
  dialog = page.getByRole("dialog", { name: "Update container" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(updateButton).toBeFocused();

  await redeployButton.click();
  dialog = page.getByRole("dialog", { name: "Redeploy Web" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Redeploy stack" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(redeployButton).toBeFocused();
  await expect.poll(() => mock.requests).toContain(`POST /api/compose/${app.stackId}/deploy`);
});

test("image update confirmation restores focus only after a slow action settles", async ({ page }) => {
  let releaseUpdate!: () => void;
  const updateReady = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const mock = await mockApi(page, { containerUpdateReady: updateReady });
  await gotoApp(page, "/updates");
  const updateButton = page.getByTitle("Update container");
  await updateButton.click();
  const dialog = page.getByRole("dialog", { name: "Update container" });
  await dialog.getByRole("button", { name: "Update container" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => mock.requests).toContain(`POST /api/hosts/${host.id}/actions`);
  await expect(updateButton).toBeDisabled();

  releaseUpdate();
  await expect(page.locator(".notice.success[role='status']")).toContainText("Container update successful");
  await expect(updateButton).toBeEnabled();
  await expect(updateButton).toBeFocused();
});

test("image update confirmation consumes failed action rejections and restores focus", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await mockApi(page, { failContainerUpdate: true });
  await gotoApp(page, "/updates");
  const updateButton = page.getByTitle("Update container");
  await updateButton.click();
  const dialog = page.getByRole("dialog", { name: "Update container" });
  await dialog.getByRole("button", { name: "Update container" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".notice.error")).toContainText("Container update failed intentionally");
  await expect(updateButton).toBeEnabled();
  await expect(updateButton).toBeFocused();
  await page.waitForTimeout(50);
  expect(pageErrors).toEqual([]);
});

test("image update preview failure is rendered without an unhandled rejection and restores focus", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await mockApi(page, { failUpdatePreview: true });
  await gotoApp(page, "/updates");
  const updateButton = page.getByTitle("Update container");
  await updateButton.click();

  await expect(page.getByRole("dialog", { name: "Update container" })).toHaveCount(0);
  await expect(page.locator(".notice.error")).toContainText("Update preview failed intentionally");
  await expect(updateButton).toBeEnabled();
  await expect(updateButton).toBeFocused();
  await page.waitForTimeout(50);
  expect(pageErrors).toEqual([]);
});

test("image update inventory load failures are contained and disclosed", async ({ page }) => {
  await mockApi(page, {
    failures: {
      "GET /api/image-updates": { status: 503, error: "Update inventory is unavailable" }
    }
  });
  await gotoApp(page, "/updates");

  await expect(page.getByRole("alert").filter({ hasText: "Update inventory is unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Image Updates" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check now" })).toBeEnabled();
});
