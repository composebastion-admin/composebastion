import path from "node:path";
import { v4 as uuid } from "uuid";
import type { DockerActionRequest, DockerHost, ResourceKind } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { encryptSecret } from "./crypto.js";
import { mapHost } from "./mappers.js";

export const DEMO_TAG = "demo";
const DEMO_HOSTNAME = "demo.composebastion.local";
const DEMO_FILE_KIND = "demo_file";

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
};

type DemoFileType = "directory" | "file" | "link";

export function isDemoHost(host: Pick<DockerHost, "tags"> | { tags?: string[] | null }) {
  return Array.isArray(host.tags) && host.tags.includes(DEMO_TAG);
}

export async function isDemoHostId(hostId: string) {
  const result = await query<{ tags: string[] }>("SELECT tags FROM docker_hosts WHERE id = $1", [hostId]);
  return result.rows[0] ? isDemoHost(result.rows[0]) : false;
}

function stableHash(value: string) {
  return Array.from(value).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
}

function metricWave(seed: string, min: number, max: number) {
  const hash = stableHash(seed);
  const wave = (Math.sin(Date.now() / 2500 + hash) + 1) / 2;
  return min + (max - min) * wave;
}

function splitImage(image: string) {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return { repository: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { repository: image, tag: "latest" };
}

function imageName(image: string) {
  const { repository } = splitImage(image);
  return repository.split("/").at(-1)?.replace(/[^a-zA-Z0-9_.-]/g, "-") || "container";
}

function normalizeDemoPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) throw new Error("Path contains invalid characters");
  if (!trimmed.startsWith("/")) throw new Error("Use an absolute Linux path, for example /home/demo/app");
  return path.posix.normalize(trimmed);
}

function parentPath(value: string) {
  const normalized = normalizeDemoPath(value);
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "/" : parent;
}

function basePath(value: string) {
  return path.posix.basename(normalizeDemoPath(value));
}

async function upsertResource(client: Queryable, hostId: string, kind: string, externalId: string, name: string, data: Record<string, unknown>) {
  await client.query(
    `INSERT INTO resource_snapshots (id, host_id, kind, external_id, name, data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (host_id, kind, external_id)
     DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now()`,
    [uuid(), hostId, kind, externalId, name, data]
  );
}

async function upsertDemoFile(client: Queryable, hostId: string, filePath: string, type: DemoFileType, content = "") {
  const normalized = normalizeDemoPath(filePath);
  await upsertResource(client, hostId, DEMO_FILE_KIND, normalized, basePath(normalized), {
    path: normalized,
    type,
    size: type === "file" ? Buffer.byteLength(content) : 0,
    modified: new Date().toISOString().slice(0, 16).replace("T", " "),
    content
  });
}

async function ensureDemoDirectory(client: Queryable, hostId: string, directory: string) {
  const normalized = normalizeDemoPath(directory);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    await upsertDemoFile(client, hostId, current, "directory");
  }
}

function containerData(input: {
  id: string;
  name: string;
  image: string;
  state: "running" | "exited" | "created" | "paused" | "restarting" | "dead";
  ports?: string;
  size?: string;
  mounts?: Array<Record<string, unknown>>;
  network?: string;
  labels?: Record<string, string>;
  env?: string[];
  status?: string;
  health?: "healthy" | "unhealthy" | "starting";
}) {
  return {
    ID: input.id,
    Names: input.name,
    Image: input.image,
    State: input.state,
    Status: input.status ?? (input.state === "running" ? "Up 2 hours" : input.state === "exited" ? "Exited (0) 18 minutes ago" : input.state),
    Ports: input.ports ?? "",
    Size: input.size ?? "4.1kB (virtual 128MB)",
    Mounts: input.mounts ?? [],
    Network: input.network ?? "demo_frontend",
    Labels: input.labels ?? { "composebastion.demo": "true" },
    Env: input.env ?? [],
    Health: input.health
  };
}

function imageData(image: string, size: string, digestSeed?: string) {
  const { repository, tag } = splitImage(image);
  const seed = digestSeed ?? image;
  return {
    Repository: repository,
    Tag: tag,
    ID: `sha256:${stableHash(seed).toString(16).padStart(12, "0")}`,
    Size: size,
    Digest: `sha256:${stableHash(`${seed}-digest`).toString(16).padStart(64, "0")}`
  };
}

function networkData(name: string, driver = "bridge", scope = "local") {
  return {
    ID: `demo-net-${stableHash(name).toString(16)}`,
    Name: name,
    Driver: driver,
    Scope: scope,
    Internal: false,
    IPv6: false,
    Labels: { "composebastion.demo": "true" }
  };
}

function volumeData(name: string, sizeBytes = 134_217_728) {
  return {
    Name: name,
    Driver: "local",
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Scope: "local",
    Labels: { "composebastion.demo": "true" },
    UsageData: { Size: sizeBytes, RefCount: 1 }
  };
}

function demoHex(seed: string, length: number) {
  const chunk = stableHash(seed).toString(16).padStart(8, "0");
  return chunk.repeat(Math.ceil(length / chunk.length)).slice(0, length);
}

function demoCommit(seed: string) {
  return demoHex(seed, 40);
}

function demoDigest(seed: string) {
  return `sha256:${demoHex(seed, 64)}`;
}

function composeLabels(project: string, service: string) {
  return {
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "com.docker.compose.config-hash": demoHex(`${project}:${service}`, 16),
    "composebastion.demo": "true"
  };
}

export async function seedDemoWorkspace(createdBy?: string | null) {
  return withTransaction(async (client) => {
    const hostSpecs = [
      {
        key: "primary",
        name: "Demo Production Node",
        hostname: DEMO_HOSTNAME,
        port: 22,
        username: "demo",
        connectionMode: "ssh",
        lastStatus: "online",
        lastSeenOffset: "1 minute",
        lastError: null,
        dockerVersion: "29.4.0-demo",
        composeVersion: "5.1.1-demo",
        agentVersion: null,
        tags: ["demo", "sandbox", "production", "showcase"]
      },
      {
        key: "edge",
        name: "Demo Edge Agent",
        hostname: "demo.edge.composebastion.local",
        port: 443,
        username: "agent",
        connectionMode: "agent",
        agentUrl: "https://edge-agent.demo.composebastion.local",
        lastStatus: "online",
        lastSeenOffset: "3 minutes",
        lastError: null,
        dockerVersion: "28.2.1-demo",
        composeVersion: "2.39.2-demo",
        agentVersion: "0.9.6",
        tags: ["demo", "sandbox", "edge", "agent"]
      },
      {
        key: "recovery",
        name: "Demo Recovery Target",
        hostname: "demo.dr.composebastion.local",
        port: 22,
        username: "demo",
        connectionMode: "ssh",
        lastStatus: "online",
        lastSeenOffset: "8 minutes",
        lastError: null,
        dockerVersion: "29.4.0-demo",
        composeVersion: "5.1.1-demo",
        agentVersion: null,
        tags: ["demo", "sandbox", "recovery", "standby"]
      }
    ] as const;

    const demoHostnames = hostSpecs.map((host) => host.hostname);
    const demoHostNames = ["Demo Host", ...hostSpecs.map((host) => host.name)];
    const demoChannelNames = ["Demo webhook", "Demo operations webhook", "Demo email digest"];
    const demoBackupTargetNames = ["Demo Local Vault", "Demo SMB Remote", "Demo S3 Archive"];
    const demoRegistryNames = ["Demo GHCR", "Demo Docker Hub Mirror", "Demo Insecure Lab Registry"];
    const demoRepositoryNames = ["Demo Compose App", "Demo Showcase App", "Demo Open WebUI", "Demo Edge Playbook"];
    const demoTemplateIds = ["demo-production-web", "demo-observability", "demo-worker-suite"];

    const staleHosts = await client.query<{ id: string }>(
      `SELECT id FROM docker_hosts
       WHERE hostname = ANY($1::text[])
          OR ($2 = ANY(tags) AND name = ANY($3::text[]))`,
      [demoHostnames, DEMO_TAG, demoHostNames]
    );
    const staleHostIds = staleHosts.rows.map((row) => row.id);

    await client.query("DELETE FROM alert_events WHERE host_id = ANY($1::uuid[]) OR channel_id IN (SELECT id FROM notification_channels WHERE name = ANY($2::text[]) OR config->>'demo' = 'true')", [staleHostIds, demoChannelNames]);
    await client.query("DELETE FROM alert_silences WHERE host_id = ANY($1::uuid[]) OR rule_id IN (SELECT id FROM alert_rules WHERE host_id = ANY($1::uuid[]) OR name LIKE 'Demo %')", [staleHostIds]);
    await client.query("DELETE FROM alert_rules WHERE host_id = ANY($1::uuid[]) OR name LIKE 'Demo %'", [staleHostIds]);
    await client.query("DELETE FROM alert_channel_test_events WHERE channel_id IN (SELECT id FROM notification_channels WHERE name = ANY($1::text[]) OR config->>'demo' = 'true')", [demoChannelNames]);
    await client.query("DELETE FROM notification_channels WHERE name = ANY($1::text[]) OR config->>'demo' = 'true'", [demoChannelNames]);
    await client.query("DELETE FROM migration_runs WHERE source_host_id = ANY($1::uuid[]) OR target_host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM recovery_schedules WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM recovery_points WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM recovery_profiles WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM backup_schedules WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM backups WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM app_source_links WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM image_update_checks WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM image_scan_results WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM resource_snapshots WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM compose_stacks WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM operation_jobs WHERE host_id = ANY($1::uuid[])", [staleHostIds]);
    await client.query("DELETE FROM github_repositories WHERE name = ANY($1::text[]) OR default_host_id = ANY($2::uuid[])", [demoRepositoryNames, staleHostIds]);
    await client.query("DELETE FROM recovery_artifacts WHERE backup_target_id IN (SELECT id FROM backup_targets WHERE name = ANY($1::text[]) OR config->>'demo' = 'true')", [demoBackupTargetNames]);
    await client.query("DELETE FROM backup_targets WHERE name = ANY($1::text[]) OR config->>'demo' = 'true'", [demoBackupTargetNames]);
    await client.query("DELETE FROM registries WHERE name = ANY($1::text[])", [demoRegistryNames]);
    await client.query("DELETE FROM custom_catalog_templates WHERE id = ANY($1::text[])", [demoTemplateIds]);

    const hostIds: Record<string, string> = {};
    for (const spec of hostSpecs) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM docker_hosts WHERE hostname = $1 ORDER BY created_at ASC LIMIT 1",
        [spec.hostname]
      );
      const hostId = existing.rows[0]?.id ?? uuid();
      hostIds[spec.key] = hostId;
      const sshPassword = spec.connectionMode === "ssh" ? encryptSecret("demo-password") : null;
      const agentToken = spec.connectionMode === "agent" ? encryptSecret("demo-agent-token") : null;
      const agentUrl = "agentUrl" in spec ? spec.agentUrl : null;
      if (existing.rows[0]) {
        await client.query(
          `UPDATE docker_hosts
           SET name = $2,
               hostname = $3,
               port = $4,
               username = $5,
               connection_mode = $6,
               ssh_auth_type = $7,
               ssh_key_encrypted = NULL,
               ssh_password_encrypted = $8,
               agent_url = $9,
               agent_token_encrypted = $10,
               docker_socket_path = '/var/run/docker.sock',
               tags = $11,
               last_status = $12,
               last_seen_at = CASE WHEN $13::text IS NULL THEN NULL ELSE now() - $13::interval END,
               last_error = $14,
               docker_version = $15,
               compose_version = $16,
               agent_version = $17,
               deleted_at = NULL,
               updated_at = now()
           WHERE id = $1`,
          [
            hostId,
            spec.name,
            spec.hostname,
            spec.port,
            spec.username,
            spec.connectionMode,
            spec.connectionMode === "ssh" ? "password" : "key",
            sshPassword,
            agentUrl,
            agentToken,
            spec.tags,
            spec.lastStatus,
            spec.lastSeenOffset,
            spec.lastError,
            spec.dockerVersion,
            spec.composeVersion,
            spec.agentVersion
          ]
        );
      } else {
        await client.query(
          `INSERT INTO docker_hosts (
             id, name, hostname, port, username, connection_mode, ssh_auth_type,
             ssh_key_encrypted, ssh_password_encrypted, agent_url, agent_token_encrypted,
             docker_socket_path, tags, last_status, last_seen_at, last_error,
             docker_version, compose_version, agent_version
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             NULL, $8, $9, $10,
             '/var/run/docker.sock', $11, $12,
             CASE WHEN $13::text IS NULL THEN NULL ELSE now() - $13::interval END,
             $14, $15, $16, $17
           )`,
          [
            hostId,
            spec.name,
            spec.hostname,
            spec.port,
            spec.username,
            spec.connectionMode,
            spec.connectionMode === "ssh" ? "password" : "key",
            sshPassword,
            agentUrl,
            agentToken,
            spec.tags,
            spec.lastStatus,
            spec.lastSeenOffset,
            spec.lastError,
            spec.dockerVersion,
            spec.composeVersion,
            spec.agentVersion
          ]
        );
      }
    }

    const primaryHostId = hostIds.primary!;
    const edgeHostId = hostIds.edge!;
    const recoveryHostId = hostIds.recovery!;

    const showcaseComposeYaml = `services:
  web:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "\${WEB_PORT:-8088}:80"
    volumes:
      - demo_web_content:/usr/share/nginx/html:ro
    depends_on:
      - api
  api:
    image: ghcr.io/composebastion-admin/showcase-api:0.9.6
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://demo:demo@postgres:5432/showcase
      REDIS_URL: redis://redis:6379/0
    ports:
      - "\${API_PORT:-9090}:8080"
    volumes:
      - demo_api_uploads:/app/uploads
    depends_on:
      - postgres
      - redis
  worker:
    image: ghcr.io/composebastion-admin/showcase-worker:0.9.6
    restart: unless-stopped
    environment:
      QUEUE_URL: redis://redis:6379/0
    depends_on:
      - redis
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: showcase
      POSTGRES_USER: demo
      POSTGRES_PASSWORD: demo
    volumes:
      - demo_postgres_data:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - demo_redis_data:/data
networks:
  default:
    name: demo_backend
volumes:
  demo_web_content:
  demo_api_uploads:
  demo_postgres_data:
  demo_redis_data:
`;
    const showcaseEnv = `WEB_PORT=8088
API_PORT=9090
SHOWCASE_DOMAIN=portal.demo.composebastion.local
`;
    const observabilityComposeYaml = `services:
  prometheus:
    image: prom/prometheus:v2.54.1
    restart: unless-stopped
    ports:
      - "\${PROMETHEUS_PORT:-9095}:9090"
    volumes:
      - demo_prometheus_data:/prometheus
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
  grafana:
    image: grafana/grafana:11.5.2
    restart: unless-stopped
    ports:
      - "\${GRAFANA_PORT:-3001}:3000"
    volumes:
      - demo_grafana_data:/var/lib/grafana
volumes:
  demo_prometheus_data:
  demo_grafana_data:
`;
    const observabilityEnv = `PROMETHEUS_PORT=9095
GRAFANA_PORT=3001
`;
    const aiComposeYaml = `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    restart: unless-stopped
    ports:
      - "\${OPEN_WEBUI_PORT:-3000}:8080"
    volumes:
      - demo_open_webui:/app/backend/data
volumes:
  demo_open_webui:
`;
    const edgeComposeYaml = `services:
  edge-proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "\${EDGE_HTTP_PORT:-8081}:80"
    volumes:
      - demo_edge_caddy:/data
  camera-relay:
    image: ghcr.io/composebastion-admin/camera-relay:0.9.6
    restart: unless-stopped
    volumes:
      - demo_edge_clips:/clips
volumes:
  demo_edge_caddy:
  demo_edge_clips:
`;

    const stackIds: Record<string, string> = {};
    async function insertStack(input: {
      key: string;
      hostId: string;
      name: string;
      projectName: string;
      composeYaml: string;
      env: string;
      status: string;
      domains?: string[];
      exposedService?: string | null;
      exposedPort?: number | null;
      tlsDesired?: boolean;
      updatePolicyEnabled?: boolean;
      updatePolicyChannel?: string | null;
      sourceType?: string;
      sourceRepositoryUrl?: string | null;
      sourceBranch?: string | null;
      sourceWorkingDir?: string | null;
      sourceComposePath?: string | null;
      sourceCurrentCommitSha?: string | null;
      sourceLatestCommitSha?: string | null;
      sourceCheckError?: string | null;
      lastDeployError?: string | null;
      versionSource?: string;
      versionNote?: string;
      previousComposeYaml?: string;
      previousEnv?: string;
    }) {
      const stackId = uuid();
      await client.query(
        `INSERT INTO compose_stacks (
           id, host_id, name, project_name, compose_yaml, env, status,
           domains, exposed_service, exposed_port, tls_desired,
           update_policy_enabled, update_policy_channel,
           source_type, source_repository_url, source_branch, source_working_dir,
           source_compose_path, source_current_commit_sha, source_latest_commit_sha,
           source_checked_at, source_check_error, last_deploy_error, updated_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11,
           $12, $13,
           $14, $15, $16, $17,
           $18, $19, $20,
           now() - interval '6 minutes', $21, $22, now()
         )`,
        [
          stackId,
          input.hostId,
          input.name,
          input.projectName,
          input.composeYaml,
          input.env,
          input.status,
          input.domains ?? [],
          input.exposedService ?? null,
          input.exposedPort ?? null,
          input.tlsDesired ?? false,
          input.updatePolicyEnabled ?? false,
          input.updatePolicyChannel ?? null,
          input.sourceType ?? "ui",
          input.sourceRepositoryUrl ?? null,
          input.sourceBranch ?? null,
          input.sourceWorkingDir ?? null,
          input.sourceComposePath ?? null,
          input.sourceCurrentCommitSha ?? null,
          input.sourceLatestCommitSha ?? null,
          input.sourceCheckError ?? null,
          input.lastDeployError ?? null
        ]
      );
      const previousVersionId = uuid();
      const currentVersionId = uuid();
      await client.query(
        `INSERT INTO compose_stack_versions
          (id, stack_id, version_number, compose_yaml, env, source, note, created_by, created_at)
         VALUES
          ($1, $3, 1, $4, $5, $6, $7, $8, now() - interval '2 days'),
          ($2, $3, 2, $9, $10, $11, $12, $8, now() - interval '45 minutes')`,
        [
          previousVersionId,
          currentVersionId,
          stackId,
          input.previousComposeYaml ?? input.composeYaml.replace(/:0\.9/g, ":0.8"),
          input.previousEnv ?? input.env,
          input.versionSource ?? "deploy",
          "Initial demo baseline",
          createdBy ?? null,
          input.composeYaml,
          input.env,
          input.versionSource ?? "deploy",
          input.versionNote ?? "Current demo deployment"
        ]
      );
      await client.query("UPDATE compose_stacks SET current_version_id = $2 WHERE id = $1", [stackId, currentVersionId]);
      stackIds[input.key] = stackId;
      return stackId;
    }

    await insertStack({
      key: "showcase",
      hostId: primaryHostId,
      name: "Customer Portal",
      projectName: "demo_showcase",
      composeYaml: showcaseComposeYaml,
      env: showcaseEnv,
      status: "deployed",
      domains: ["portal.demo.composebastion.local", "api.demo.composebastion.local"],
      exposedService: "web",
      exposedPort: 80,
      tlsDesired: true,
      updatePolicyEnabled: true,
      updatePolicyChannel: "patch",
      sourceType: "github",
      sourceRepositoryUrl: "https://github.com/composebastion-admin/composebastion",
      sourceBranch: "main",
      sourceWorkingDir: "/srv/apps/customer-portal",
      sourceComposePath: "examples/customer-portal/compose.yaml",
      sourceCurrentCommitSha: demoCommit("showcase-current"),
      sourceLatestCommitSha: demoCommit("showcase-latest"),
      versionSource: "github",
      versionNote: "v0.9.6 showcase deployment with update policy enabled"
    });
    await insertStack({
      key: "observability",
      hostId: primaryHostId,
      name: "Observability",
      projectName: "demo_observability",
      composeYaml: observabilityComposeYaml,
      env: observabilityEnv,
      status: "deployed",
      domains: ["metrics.demo.composebastion.local"],
      exposedService: "grafana",
      exposedPort: 3000,
      tlsDesired: true,
      updatePolicyEnabled: true,
      updatePolicyChannel: "minor",
      sourceType: "host_files",
      sourceWorkingDir: "/srv/apps/observability",
      sourceComposePath: "docker-compose.yml",
      versionSource: "host_files",
      versionNote: "Added Grafana persistence and proxy metadata"
    });
    await insertStack({
      key: "ai",
      hostId: primaryHostId,
      name: "AI Tools",
      projectName: "demo_ai_tools",
      composeYaml: aiComposeYaml,
      env: "OPEN_WEBUI_PORT=3000",
      status: "created",
      domains: ["ai.demo.composebastion.local"],
      exposedService: "open-webui",
      exposedPort: 8080,
      tlsDesired: true,
      updatePolicyEnabled: false,
      sourceType: "catalog",
      versionSource: "catalog",
      versionNote: "Catalog template staged but not deployed yet"
    });
    await insertStack({
      key: "edge",
      hostId: edgeHostId,
      name: "Edge Gateway",
      projectName: "demo_edge_gateway",
      composeYaml: edgeComposeYaml,
      env: "EDGE_HTTP_PORT=8081",
      status: "deployed",
      domains: ["edge.demo.composebastion.local"],
      exposedService: "edge-proxy",
      exposedPort: 80,
      tlsDesired: false,
      updatePolicyEnabled: true,
      updatePolicyChannel: "digest",
      sourceType: "git",
      sourceRepositoryUrl: "https://github.com/composebastion-admin/composebastion",
      sourceBranch: "main",
      sourceWorkingDir: "/srv/edge/gateway",
      sourceComposePath: "edge/docker-compose.yml",
      sourceCurrentCommitSha: demoCommit("edge-current"),
      sourceLatestCommitSha: demoCommit("edge-current"),
      versionSource: "git",
      versionNote: "Edge agent deployment"
    });

    const containers = [
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-web-000000000001",
          name: "cb-portal-web",
          image: "nginx:1.27-alpine",
          state: "running",
          ports: "0.0.0.0:8088->80/tcp, [::]:8088->80/tcp",
          size: "16.2kB (virtual 49.6MB)",
          mounts: [{ Type: "volume", Name: "demo_web_content", Destination: "/usr/share/nginx/html", RW: false }],
          network: "demo_backend",
          labels: composeLabels("demo_showcase", "web"),
          health: "healthy"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-api-000000000002",
          name: "cb-portal-api",
          image: "ghcr.io/composebastion-admin/showcase-api:0.9.6",
          state: "running",
          ports: "0.0.0.0:9090->8080/tcp",
          size: "31.8MB (virtual 228MB)",
          mounts: [{ Type: "volume", Name: "demo_api_uploads", Destination: "/app/uploads", RW: true }],
          network: "demo_backend",
          labels: composeLabels("demo_showcase", "api"),
          env: ["NODE_ENV=production", "REDIS_URL=redis://redis:6379/0"],
          health: "healthy"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-worker-000000003",
          name: "cb-portal-worker",
          image: "ghcr.io/composebastion-admin/showcase-worker:0.9.6",
          state: "running",
          status: "Up 38 minutes (health: starting)",
          size: "19.5MB (virtual 174MB)",
          network: "demo_backend",
          labels: composeLabels("demo_showcase", "worker"),
          health: "starting"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-postgres-0000004",
          name: "cb-portal-postgres",
          image: "postgres:16-alpine",
          state: "running",
          ports: "5432/tcp",
          size: "18.8kB (virtual 396MB)",
          mounts: [{ Type: "volume", Name: "demo_postgres_data", Destination: "/var/lib/postgresql/data", RW: true }],
          network: "demo_backend",
          labels: composeLabels("demo_showcase", "postgres"),
          health: "healthy"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-redis-000000005",
          name: "cb-portal-redis",
          image: "redis:7-alpine",
          state: "running",
          ports: "6379/tcp",
          size: "6.1kB (virtual 57.8MB)",
          mounts: [{ Type: "volume", Name: "demo_redis_data", Destination: "/data", RW: true }],
          network: "demo_backend",
          labels: composeLabels("demo_showcase", "redis"),
          health: "healthy"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-prometheus-000006",
          name: "cb-prometheus",
          image: "prom/prometheus:v2.54.1",
          state: "running",
          ports: "0.0.0.0:9095->9090/tcp",
          size: "9.2MB (virtual 272MB)",
          mounts: [{ Type: "volume", Name: "demo_prometheus_data", Destination: "/prometheus", RW: true }],
          network: "demo_observability",
          labels: composeLabels("demo_observability", "prometheus"),
          health: "healthy"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-grafana-0000007",
          name: "cb-grafana",
          image: "grafana/grafana:11.5.2",
          state: "running",
          ports: "0.0.0.0:3001->3000/tcp",
          size: "42.4MB (virtual 473MB)",
          mounts: [{ Type: "volume", Name: "demo_grafana_data", Destination: "/var/lib/grafana", RW: true }],
          network: "demo_observability",
          labels: composeLabels("demo_observability", "grafana"),
          health: "healthy"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-registry-cache-08",
          name: "cb-registry-cache",
          image: "registry:2",
          state: "running",
          ports: "127.0.0.1:5000->5000/tcp",
          size: "64.1MB (virtual 86.3MB)",
          mounts: [{ Type: "volume", Name: "demo_registry_cache", Destination: "/var/lib/registry", RW: true }],
          network: "demo_frontend",
          labels: { "composebastion.demo": "true", "composebastion.source": "image" },
          health: "healthy"
        })
      },
      {
        hostId: primaryHostId,
        data: containerData({
          id: "demo-legacy-cron-0009",
          name: "cb-legacy-cron",
          image: "alpine:3.20",
          state: "exited",
          status: "Exited (0) 17 minutes ago",
          size: "2.1kB (virtual 7.8MB)",
          network: "none",
          labels: { "composebastion.demo": "true", "composebastion.source": "git" }
        })
      },
      {
        hostId: edgeHostId,
        data: containerData({
          id: "demo-edge-proxy-0001",
          name: "cb-edge-proxy",
          image: "caddy:2-alpine",
          state: "running",
          ports: "0.0.0.0:8081->80/tcp",
          size: "8.1MB (virtual 49.1MB)",
          mounts: [{ Type: "volume", Name: "demo_edge_caddy", Destination: "/data", RW: true }],
          network: "demo_edge_gateway",
          labels: composeLabels("demo_edge_gateway", "edge-proxy"),
          health: "healthy"
        })
      },
      {
        hostId: edgeHostId,
        data: containerData({
          id: "demo-camera-relay-02",
          name: "cb-camera-relay",
          image: "ghcr.io/composebastion-admin/camera-relay:0.9.6",
          state: "running",
          status: "Up 6 hours (health: unhealthy)",
          ports: "8554/tcp",
          size: "14.8MB (virtual 163MB)",
          mounts: [{ Type: "volume", Name: "demo_edge_clips", Destination: "/clips", RW: true }],
          network: "demo_edge_gateway",
          labels: composeLabels("demo_edge_gateway", "camera-relay"),
          health: "unhealthy"
        })
      },
      {
        hostId: recoveryHostId,
        data: containerData({
          id: "demo-standby-proxy-01",
          name: "cb-standby-proxy",
          image: "nginx:1.27-alpine",
          state: "paused",
          status: "Paused 2 days",
          ports: "0.0.0.0:18080->80/tcp",
          size: "4.4kB (virtual 49.6MB)",
          network: "demo_recovery",
          labels: { "composebastion.demo": "true", "composebastion.role": "standby" }
        })
      }
    ];

    for (const item of containers) {
      await upsertResource(client, item.hostId, "container", String(item.data.ID), String(item.data.Names), item.data);
    }

    const imageSpecs = [
      [primaryHostId, "nginx:1.27-alpine", "49.6MB"],
      [primaryHostId, "nginx:alpine", "49.6MB"],
      [primaryHostId, "ghcr.io/composebastion-admin/showcase-api:0.9.6", "228MB"],
      [primaryHostId, "ghcr.io/composebastion-admin/showcase-api:0.9.7", "236MB"],
      [primaryHostId, "ghcr.io/composebastion-admin/showcase-worker:0.9.6", "174MB"],
      [primaryHostId, "postgres:16-alpine", "396MB"],
      [primaryHostId, "redis:7-alpine", "57.8MB"],
      [primaryHostId, "prom/prometheus:v2.54.1", "272MB"],
      [primaryHostId, "grafana/grafana:11.5.2", "473MB"],
      [primaryHostId, "registry:2", "86.3MB"],
      [primaryHostId, "alpine:3.20", "7.8MB"],
      [primaryHostId, "ghcr.io/open-webui/open-webui:main", "6.68GB"],
      [edgeHostId, "caddy:2-alpine", "49.1MB"],
      [edgeHostId, "ghcr.io/composebastion-admin/camera-relay:0.9.6", "163MB"],
      [edgeHostId, "ghcr.io/composebastion-admin/camera-relay:0.9.7", "168MB"],
      [recoveryHostId, "nginx:1.27-alpine", "49.6MB"],
      [recoveryHostId, "postgres:16-alpine", "396MB"]
    ] as const;
    for (const [targetHostId, image, size] of imageSpecs) {
      const data = imageData(image, size);
      await upsertResource(client, targetHostId, "image", String(data.ID), `${data.Repository}:${data.Tag}`, data);
    }

    for (const [targetHostId, networks] of [
      [primaryHostId, [networkData("bridge"), networkData("host", "host"), networkData("none", "null"), networkData("demo_frontend"), networkData("demo_backend"), networkData("demo_observability")]],
      [edgeHostId, [networkData("bridge"), networkData("host", "host"), networkData("demo_edge_gateway")]],
      [recoveryHostId, [networkData("bridge"), networkData("host", "host"), networkData("demo_recovery")]]
    ] as const) {
      for (const network of networks) {
        await upsertResource(client, targetHostId, "network", String(network.ID), String(network.Name), network);
      }
    }

    const volumeSpecs = [
      [primaryHostId, "demo_web_content", 26_214_400],
      [primaryHostId, "demo_api_uploads", 2_348_810_240],
      [primaryHostId, "demo_postgres_data", 8_934_621_184],
      [primaryHostId, "demo_redis_data", 174_063_616],
      [primaryHostId, "demo_prometheus_data", 1_457_684_480],
      [primaryHostId, "demo_grafana_data", 336_592_896],
      [primaryHostId, "demo_registry_cache", 12_884_901_888],
      [primaryHostId, "demo_open_webui", 3_495_253_504],
      [edgeHostId, "demo_edge_caddy", 83_886_080],
      [edgeHostId, "demo_edge_clips", 6_979_321_856],
      [recoveryHostId, "demo_restored_postgres_data", 8_934_621_184],
      [recoveryHostId, "demo_rehearsal_uploads", 2_348_810_240]
    ] as const;
    for (const [targetHostId, volumeName, sizeBytes] of volumeSpecs) {
      await upsertResource(client, targetHostId, "volume", volumeName, volumeName, volumeData(volumeName, sizeBytes));
    }

    const repoIds: Record<string, string> = {};
    for (const repo of [
      {
        key: "showcase",
        name: "Demo Showcase App",
        repositoryUrl: "https://github.com/composebastion-admin/composebastion",
        owner: "composebastion-admin",
        repo: "composebastion",
        branch: "main",
        composePath: "examples/customer-portal/compose.yaml",
        projectName: "demo_showcase",
        env: showcaseEnv,
        defaultHostId: primaryHostId,
        deployed: "22 minutes",
        current: demoCommit("showcase-current"),
        latest: demoCommit("showcase-latest"),
        error: null
      },
      {
        key: "awesome",
        name: "Demo Compose App",
        repositoryUrl: "https://github.com/docker/awesome-compose",
        owner: "docker",
        repo: "awesome-compose",
        branch: "master",
        composePath: "nginx-flask-mysql/compose.yaml",
        projectName: "demo_compose_app",
        env: "WEB_PORT=8088",
        defaultHostId: primaryHostId,
        deployed: "2 hours",
        current: demoCommit("awesome-current"),
        latest: demoCommit("awesome-current"),
        error: null
      },
      {
        key: "openwebui",
        name: "Demo Open WebUI",
        repositoryUrl: "https://github.com/open-webui/open-webui",
        owner: "open-webui",
        repo: "open-webui",
        branch: "main",
        composePath: "docker-compose.yaml",
        projectName: "demo_ai_tools",
        env: "OPEN_WEBUI_PORT=3000",
        defaultHostId: primaryHostId,
        deployed: null,
        current: null,
        latest: null,
        error: "Demo: staged catalog app has not been deployed yet."
      },
      {
        key: "edge",
        name: "Demo Edge Playbook",
        repositoryUrl: "https://github.com/composebastion-admin/composebastion",
        owner: "composebastion-admin",
        repo: "composebastion",
        branch: "main",
        composePath: "examples/edge-gateway/compose.yaml",
        projectName: "demo_edge_gateway",
        env: "EDGE_HTTP_PORT=8081",
        defaultHostId: edgeHostId,
        deployed: "1 hour",
        current: demoCommit("edge-current"),
        latest: demoCommit("edge-current"),
        error: null
      }
    ]) {
      const saved = await client.query<{ id: string }>(
        `INSERT INTO github_repositories
          (id, name, repository_url, owner, repo, branch, compose_path, project_name, env, default_host_id,
           last_deployed_at, last_deployed_commit_sha, latest_commit_sha, update_checked_at, update_check_error, last_error)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           CASE WHEN $11::text IS NULL THEN NULL ELSE now() - $11::interval END,
           $12, $13, now() - interval '5 minutes', $14, $14)
         ON CONFLICT (owner, repo, branch, compose_path)
         DO UPDATE SET name = EXCLUDED.name,
                       repository_url = EXCLUDED.repository_url,
                       project_name = EXCLUDED.project_name,
                       env = EXCLUDED.env,
                       default_host_id = EXCLUDED.default_host_id,
                       last_deployed_at = EXCLUDED.last_deployed_at,
                       last_deployed_commit_sha = EXCLUDED.last_deployed_commit_sha,
                       latest_commit_sha = EXCLUDED.latest_commit_sha,
                       update_checked_at = EXCLUDED.update_checked_at,
                       update_check_error = EXCLUDED.update_check_error,
                       last_error = EXCLUDED.last_error,
                       updated_at = now()
         RETURNING id`,
        [
          uuid(),
          repo.name,
          repo.repositoryUrl,
          repo.owner,
          repo.repo,
          repo.branch,
          repo.composePath,
          repo.projectName,
          repo.env,
          repo.defaultHostId,
          repo.deployed,
          repo.current,
          repo.latest,
          repo.error
        ]
      );
      repoIds[repo.key] = saved.rows[0]!.id;
    }

    for (const link of [
      {
        hostId: primaryHostId,
        containerId: "demo-registry-cache-08",
        sourceType: "image",
        name: "Registry Cache",
        repositoryUrl: null,
        branch: null,
        workingDir: null,
        composePath: null,
        imageReference: "registry:2",
        current: null,
        latest: null,
        error: null
      },
      {
        hostId: primaryHostId,
        containerId: "demo-legacy-cron-0009",
        sourceType: "git",
        name: "Legacy Cleanup Job",
        repositoryUrl: "https://github.com/composebastion-admin/composebastion",
        branch: "main",
        workingDir: "/srv/jobs/legacy-cleanup",
        composePath: "compose.yml",
        imageReference: "alpine:3.20",
        current: demoCommit("legacy-current"),
        latest: demoCommit("legacy-latest"),
        error: null
      }
    ]) {
      await client.query(
        `INSERT INTO app_source_links (
           id, host_id, container_external_id, source_type, name, repository_url, branch,
           working_dir, compose_path, image_reference, current_commit_sha,
           latest_commit_sha, checked_at, check_error, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now() - interval '9 minutes', $13, now())
         ON CONFLICT (host_id, container_external_id)
         DO UPDATE SET source_type = EXCLUDED.source_type,
                       name = EXCLUDED.name,
                       repository_url = EXCLUDED.repository_url,
                       branch = EXCLUDED.branch,
                       working_dir = EXCLUDED.working_dir,
                       compose_path = EXCLUDED.compose_path,
                       image_reference = EXCLUDED.image_reference,
                       current_commit_sha = EXCLUDED.current_commit_sha,
                       latest_commit_sha = EXCLUDED.latest_commit_sha,
                       checked_at = EXCLUDED.checked_at,
                       check_error = EXCLUDED.check_error,
                       updated_at = now()`,
        [
          uuid(),
          link.hostId,
          link.containerId,
          link.sourceType,
          link.name,
          link.repositoryUrl,
          link.branch,
          link.workingDir,
          link.composePath,
          link.imageReference,
          link.current,
          link.latest,
          link.error
        ]
      );
    }

    const targetIds: Record<string, string> = {};
    for (const target of [
      {
        key: "local",
        name: "Demo Local Vault",
        kind: "local",
        enabled: true,
        config: { demo: true, basePath: "/var/lib/composebastion/demo-backups" },
        accessKeyId: null,
        secret: null,
        provider: null,
        remotePath: null,
        cache: "keep",
        genericConfig: null,
        genericCredentials: null,
        health: "healthy",
        healthError: null
      },
      {
        key: "smb",
        name: "Demo SMB Remote",
        kind: "rclone",
        enabled: true,
        config: { demo: true, provider: "smb", remoteName: "demo-smb", smb: { server: "nas.demo.local", share: "composebastion", subPath: "showcase" } },
        accessKeyId: null,
        secret: null,
        provider: "smb",
        remotePath: "demo-smb:composebastion/showcase",
        cache: "remote_only",
        genericConfig: encryptSecret("[demo-smb]\ntype = smb\nhost = nas.demo.local\nshare = composebastion\n"),
        genericCredentials: encryptSecret("username=demo\npassword=demo"),
        health: "healthy",
        healthError: null
      },
      {
        key: "s3",
        name: "Demo S3 Archive",
        kind: "s3",
        enabled: true,
        config: { demo: true, endpoint: "https://s3.example.invalid", bucket: "composebastion-demo", region: "us-east-1", prefix: "v0.9-showcase", forcePathStyle: true },
        accessKeyId: "DEMOACCESSKEY",
        secret: encryptSecret("demo-secret-access-key"),
        provider: null,
        remotePath: null,
        cache: "keep",
        genericConfig: null,
        genericCredentials: null,
        health: "failed",
        healthError: "Demo failure: archive bucket credentials need rotation."
      }
    ]) {
      const id = uuid();
      targetIds[target.key] = id;
      await client.query(
        `INSERT INTO backup_targets (
           id, name, kind, enabled, config, access_key_id, secret_access_key_encrypted,
           provider, remote_path, local_cache_policy, generic_config_encrypted,
           generic_credentials_encrypted, health_status, health_checked_at, health_error, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() - interval '11 minutes', $14, $15)`,
        [
          id,
          target.name,
          target.kind,
          target.enabled,
          target.config,
          target.accessKeyId,
          target.secret,
          target.provider,
          target.remotePath,
          target.cache,
          target.genericConfig,
          target.genericCredentials,
          target.health,
          target.healthError,
          createdBy ?? null
        ]
      );
    }

    const portalIdentity = { kind: "stack", stackId: stackIds.showcase!, projectName: "demo_showcase", label: "Customer Portal" };
    const observabilityIdentity = { kind: "stack", stackId: stackIds.observability!, projectName: "demo_observability", label: "Observability" };
    const aiIdentity = { kind: "stack", stackId: stackIds.ai!, projectName: "demo_ai_tools", label: "AI Tools" };
    const registryIdentity = { kind: "standalone", containerIds: ["demo-registry-cache-08"], label: "Registry Cache" };

    const profileIds: Record<string, string> = {};
    for (const profile of [
      {
        key: "portal",
        hostId: primaryHostId,
        identity: portalIdentity,
        name: "Portal database-safe capture",
        includePaths: ["/srv/apps/customer-portal", "/var/lib/docker/volumes/demo_api_uploads/_data"],
        excludePatterns: ["**/node_modules/**", "**/.cache/**", "**/tmp/**"],
        restorePaths: { "/srv/apps/customer-portal": "/srv/restored/customer-portal" },
        pre: "docker compose exec -T postgres pg_start_backup('composebastion-demo', true)",
        post: "docker compose exec -T postgres pg_stop_backup()",
        mode: "stop_first"
      },
      {
        key: "observability",
        hostId: primaryHostId,
        identity: observabilityIdentity,
        name: "Metrics hot capture",
        includePaths: ["/srv/apps/observability"],
        excludePatterns: ["**/wal/**", "**/*.tmp"],
        restorePaths: {},
        pre: null,
        post: null,
        mode: "hot"
      },
      {
        key: "registry",
        hostId: primaryHostId,
        identity: registryIdentity,
        name: "Registry cache volume",
        includePaths: ["/var/lib/docker/volumes/demo_registry_cache/_data"],
        excludePatterns: ["**/docker/registry/v2/repositories/_layers/**"],
        restorePaths: {},
        pre: null,
        post: null,
        mode: "hot"
      }
    ]) {
      const id = uuid();
      profileIds[profile.key] = id;
      await client.query(
        `INSERT INTO recovery_profiles (
           id, host_id, app_identity, name, include_paths, exclude_patterns,
           restore_paths, pre_capture_command, post_capture_command, capture_mode, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          profile.hostId,
          profile.identity,
          profile.name,
          JSON.stringify(profile.includePaths),
          JSON.stringify(profile.excludePatterns),
          profile.restorePaths,
          profile.pre,
          profile.post,
          profile.mode,
          createdBy ?? null
        ]
      );
    }

    const recoveryPointIds: Record<string, string> = {};
    async function insertRecoveryPoint(input: {
      key: string;
      hostId: string;
      name: string;
      identity: Record<string, unknown>;
      trigger: string;
      status: string;
      targetId: string | null;
      profileId?: string | null;
      error?: string | null;
      createdOffset: string;
      drillStatus?: string | null;
      drillError?: string | null;
      artifacts: Array<{
        kind: string;
        storageKey: string;
        sizeBytes: number | null;
        status: string;
        error?: string | null;
        metadata?: Record<string, unknown>;
      }>;
    }) {
      const pointId = uuid();
      const completed = input.artifacts.filter((artifact) => artifact.status === "completed");
      const totalBytes = input.artifacts.reduce((total, artifact) => total + (artifact.sizeBytes ?? 0), 0);
      await client.query(
        `INSERT INTO recovery_points (
           id, host_id, name, app_identity, trigger_kind, status, backup_target_id,
           artifact_count, completed_artifact_count, total_bytes, error, metadata,
           created_by, profile_id, created_at, started_at, completed_at,
           last_drill_at, last_drill_status, last_drill_error, last_successful_drill_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12,
           $13, $14, now() - $15::interval, now() - $15::interval + interval '1 minute',
           CASE WHEN $6 IN ('completed', 'partial', 'failed') THEN now() - $15::interval + interval '8 minutes' ELSE NULL END,
           CASE WHEN $16::text IS NULL THEN NULL ELSE now() - interval '6 hours' END,
           $16, $17,
           CASE WHEN $16 = 'completed' THEN now() - interval '6 hours' ELSE NULL END
         )`,
        [
          pointId,
          input.hostId,
          input.name,
          input.identity,
          input.trigger,
          input.status,
          input.targetId,
          input.artifacts.length,
          completed.length,
          totalBytes || null,
          input.error ?? null,
          { demo: true, verifyStatus: input.status === "completed" ? "completed" : input.status === "partial" ? "warning" : "failed" },
          createdBy ?? null,
          input.profileId ?? null,
          input.createdOffset,
          input.drillStatus ?? null,
          input.drillError ?? null
        ]
      );
      for (const artifact of input.artifacts) {
        await client.query(
          `INSERT INTO recovery_artifacts (
             id, recovery_point_id, kind, backup_target_id, storage_key,
             size_bytes, checksum, status, error, metadata, created_at, completed_at
           )
           VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8, $9, $10, now() - $11::interval,
             CASE WHEN $8 = 'completed' THEN now() - $11::interval + interval '7 minutes' ELSE NULL END
           )`,
          [
            uuid(),
            pointId,
            artifact.kind,
            input.targetId,
            artifact.storageKey,
            artifact.sizeBytes,
            artifact.sizeBytes ? demoDigest(`${artifact.storageKey}:checksum`) : null,
            artifact.status,
            artifact.error ?? null,
            {
              demo: true,
              remoteObjectKey: artifact.metadata?.remoteObjectKey ?? artifact.storageKey,
              localCachePolicy: artifact.metadata?.localCachePolicy ?? "keep",
              ...artifact.metadata
            },
            input.createdOffset
          ]
        );
      }
      recoveryPointIds[input.key] = pointId;
      return pointId;
    }

    await insertRecoveryPoint({
      key: "portal",
      hostId: primaryHostId,
      name: "Portal nightly verified recovery point",
      identity: portalIdentity,
      trigger: "scheduled",
      status: "completed",
      targetId: targetIds.smb!,
      profileId: profileIds.portal!,
      createdOffset: "5 hours",
      drillStatus: "completed",
      artifacts: [
        { kind: "compose_yaml", storageKey: "recovery/demo_showcase/compose.yaml", sizeBytes: 8_192, status: "completed", metadata: { localCachePolicy: "remote_only" } },
        { kind: "env_file", storageKey: "recovery/demo_showcase/.env", sizeBytes: 512, status: "completed", metadata: { localCachePolicy: "remote_only" } },
        { kind: "volume", storageKey: "recovery/demo_showcase/demo_postgres_data.tar.zst", sizeBytes: 2_148_532_224, status: "completed", metadata: { volumeName: "demo_postgres_data", localCachePolicy: "remote_only" } },
        { kind: "volume", storageKey: "recovery/demo_showcase/demo_api_uploads.tar.zst", sizeBytes: 751_619_276, status: "completed", metadata: { volumeName: "demo_api_uploads", localCachePolicy: "remote_only" } },
        { kind: "image_manifest", storageKey: "recovery/demo_showcase/images.json", sizeBytes: 4_096, status: "completed", metadata: { images: ["nginx:1.27-alpine", "postgres:16-alpine"] } }
      ]
    });
    await insertRecoveryPoint({
      key: "observability",
      hostId: primaryHostId,
      name: "Observability partial capture",
      identity: observabilityIdentity,
      trigger: "manual",
      status: "partial",
      targetId: targetIds.local!,
      profileId: profileIds.observability!,
      createdOffset: "21 hours",
      drillStatus: "failed",
      drillError: "Demo drill found a missing Grafana plugin cache.",
      error: "Prometheus WAL changed during capture; schedule stop-first if this matters.",
      artifacts: [
        { kind: "compose_yaml", storageKey: "recovery/demo_observability/compose.yaml", sizeBytes: 5_120, status: "completed" },
        { kind: "volume", storageKey: "recovery/demo_observability/demo_prometheus_data.tar.zst", sizeBytes: 451_125_248, status: "completed", metadata: { volumeName: "demo_prometheus_data" } },
        { kind: "volume", storageKey: "recovery/demo_observability/demo_grafana_data.tar.zst", sizeBytes: 129_261_568, status: "failed", error: "Demo failure: file changed while reading.", metadata: { volumeName: "demo_grafana_data" } }
      ]
    });
    await insertRecoveryPoint({
      key: "registry",
      hostId: primaryHostId,
      name: "Registry cache ad hoc snapshot",
      identity: registryIdentity,
      trigger: "manual",
      status: "completed",
      targetId: targetIds.local!,
      profileId: profileIds.registry!,
      createdOffset: "2 days",
      drillStatus: null,
      artifacts: [
        { kind: "volume", storageKey: "recovery/registry-cache/demo_registry_cache.tar.zst", sizeBytes: 3_221_225_472, status: "completed", metadata: { volumeName: "demo_registry_cache" } },
        { kind: "metadata", storageKey: "recovery/registry-cache/manifest.json", sizeBytes: 2_048, status: "completed" }
      ]
    });
    await insertRecoveryPoint({
      key: "ai",
      hostId: primaryHostId,
      name: "AI Tools failed cloud archive",
      identity: aiIdentity,
      trigger: "policy",
      status: "failed",
      targetId: targetIds.s3!,
      createdOffset: "3 days",
      error: "Demo failure: S3 target health is failed.",
      artifacts: [
        { kind: "compose_yaml", storageKey: "recovery/demo_ai_tools/compose.yaml", sizeBytes: null, status: "failed", error: "Archive bucket rejected credentials." }
      ]
    });

    for (const schedule of [
      {
        hostId: primaryHostId,
        name: "Portal nightly verified recovery",
        identity: portalIdentity,
        targetId: targetIds.smb!,
        profileId: profileIds.portal!,
        interval: 24 * 60 * 60 * 1000,
        retention: 14,
        mode: "stop_first",
        lastRun: "5 hours",
        nextRun: "19 hours",
        drillStatus: "completed",
        drillError: null
      },
      {
        hostId: primaryHostId,
        name: "Observability every 6 hours",
        identity: observabilityIdentity,
        targetId: targetIds.local!,
        profileId: profileIds.observability!,
        interval: 6 * 60 * 60 * 1000,
        retention: 8,
        mode: "hot",
        lastRun: "21 hours",
        nextRun: "2 hours",
        drillStatus: "failed",
        drillError: "Demo drill found a missing Grafana plugin cache."
      }
    ]) {
      await client.query(
        `INSERT INTO recovery_schedules (
           id, host_id, name, app_identity, backup_target_id, profile_id,
           interval_ms, retention_count, enabled, last_run_at, next_run_at,
           capture_mode, last_drill_at, last_drill_status, last_drill_error,
           last_successful_drill_at, created_by
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, true, now() - $9::interval, now() + $10::interval,
           $11, now() - interval '6 hours', $12, $13,
           CASE WHEN $12 = 'completed' THEN now() - interval '6 hours' ELSE NULL END, $14
         )`,
        [
          uuid(),
          schedule.hostId,
          schedule.name,
          schedule.identity,
          schedule.targetId,
          schedule.profileId,
          schedule.interval,
          schedule.retention,
          schedule.lastRun,
          schedule.nextRun,
          schedule.mode,
          schedule.drillStatus,
          schedule.drillError,
          createdBy ?? null
        ]
      );
    }

    for (const backup of [
      {
        hostId: primaryHostId,
        kind: "volume",
        volume: "demo_postgres_data",
        sourcePath: null,
        file: "demo-postgres-nightly.tar.zst",
        size: 2_148_532_224,
        status: "completed",
        targetId: targetIds.smb!,
        remoteKey: "volume/demo_postgres_data/nightly.tar.zst",
        error: null,
        completed: "4 hours",
        verified: "3 hours",
        encryption: "app_secret",
        drillStatus: "completed"
      },
      {
        hostId: primaryHostId,
        kind: "host_path",
        volume: null,
        sourcePath: "/srv/apps/customer-portal",
        file: "customer-portal-files.tar.zst",
        size: 84_459_520,
        status: "completed",
        targetId: targetIds.local!,
        remoteKey: null,
        error: null,
        completed: "6 hours",
        verified: "5 hours",
        encryption: "none",
        drillStatus: "completed"
      },
      {
        hostId: edgeHostId,
        kind: "volume",
        volume: "demo_edge_clips",
        sourcePath: null,
        file: "edge-clips-incremental.tar.zst",
        size: null,
        status: "failed",
        targetId: targetIds.s3!,
        remoteKey: null,
        error: "Demo failure: remote archive target is unhealthy.",
        completed: "37 minutes",
        verified: null,
        encryption: "app_secret",
        drillStatus: "failed"
      }
    ]) {
      await client.query(
        `INSERT INTO backups (
           id, host_id, kind, volume_name, source_path, target_volume_name,
           file_name, size_bytes, status, error, metadata, checksum,
           backup_target_id, remote_object_key, verified_at, encryption,
           encryption_key_id, encryption_key_fingerprint, last_drill_at, last_drill_status,
           created_at, completed_at
         )
         VALUES (
           $1, $2, $3, $4, $5, NULL,
           $6, $7, $8, $9, $10, $11,
           $12, $13,
           CASE WHEN $14::text IS NULL THEN NULL ELSE now() - $14::interval END,
           $15, $16, $17,
           CASE WHEN $18::text IS NULL THEN NULL ELSE now() - interval '6 hours' END,
           $18, now() - $19::interval - interval '8 minutes', now() - $19::interval
         )`,
        [
          uuid(),
          backup.hostId,
          backup.kind,
          backup.volume,
          backup.sourcePath,
          backup.file,
          backup.size,
          backup.status,
          backup.error,
          { demo: true, target: backup.targetId ? "configured" : "local", note: backup.status === "completed" ? "Showcase backup proof" : "Showcase failed backup" },
          backup.size ? demoDigest(`${backup.file}:backup`) : null,
          backup.targetId,
          backup.remoteKey,
          backup.verified,
          backup.encryption,
          backup.encryption === "app_secret" ? "app_secret" : null,
          backup.encryption === "app_secret" ? "demo-key-fp-2026" : null,
          backup.drillStatus,
          backup.completed
        ]
      );
    }

    for (const schedule of [
      { hostId: primaryHostId, kind: "volume", volume: "demo_postgres_data", sourcePath: null, targetId: targetIds.smb!, interval: 24 * 60 * 60 * 1000, retention: 14, status: "completed", error: null, encryption: "app_secret" },
      { hostId: primaryHostId, kind: "host_path", volume: null, sourcePath: "/srv/apps/customer-portal", targetId: targetIds.local!, interval: 12 * 60 * 60 * 1000, retention: 20, status: "completed", error: null, encryption: "none" },
      { hostId: edgeHostId, kind: "volume", volume: "demo_edge_clips", sourcePath: null, targetId: targetIds.s3!, interval: 6 * 60 * 60 * 1000, retention: 8, status: "failed", error: "Archive bucket credentials need rotation.", encryption: "app_secret" }
    ]) {
      await client.query(
        `INSERT INTO backup_schedules (
           id, host_id, volume_name, interval_ms, enabled, last_run_at, next_run_at,
           created_by, kind, source_path, backup_target_id, retention_count,
           last_status, last_error, encryption
         )
         VALUES (
           $1, $2, $3, $4, true, now() - interval '4 hours', now() + interval '20 hours',
           $5, $6, $7, $8, $9, $10, $11, $12
         )`,
        [
          uuid(),
          schedule.hostId,
          schedule.volume,
          schedule.interval,
          createdBy ?? null,
          schedule.kind,
          schedule.sourcePath,
          schedule.targetId,
          schedule.retention,
          schedule.status,
          schedule.error,
          schedule.encryption
        ]
      );
    }

    await client.query(
      `INSERT INTO migration_runs (
         id, source_host_id, target_host_id, source_app_identity, mode, status,
         recovery_point_id, plan, error, created_by, created_at, started_at, completed_at
       )
       VALUES
         ($1, $3, $4, $5, 'plan', 'completed', $6, $7, NULL, $8, now() - interval '50 minutes', now() - interval '49 minutes', now() - interval '48 minutes'),
         ($2, $3, $4, $5, 'execute', 'completed', $6, $7, NULL, $8, now() - interval '42 minutes', now() - interval '41 minutes', now() - interval '35 minutes')`,
      [
        uuid(),
        uuid(),
        primaryHostId,
        recoveryHostId,
        portalIdentity,
        recoveryPointIds.portal!,
        {
          sourceHostId: primaryHostId,
          targetHostId: recoveryHostId,
          sourceAppIdentity: portalIdentity,
          steps: [
            { id: "backup", title: "Capture recovery point", description: "Use the verified portal recovery profile.", kind: "backup", required: true },
            { id: "transfer", title: "Transfer artifacts", description: "Reuse the remote-only SMB target.", kind: "transfer", required: true },
            { id: "deploy", title: "Deploy stack on target", description: "Apply compose with remapped ports.", kind: "deploy", required: true },
            { id: "verify", title: "Verify health", description: "Run HTTP and database smoke checks.", kind: "verify", required: true }
          ],
          warnings: ["Port 8088 is remapped to 18080 on the recovery host."],
          estimatedArtifacts: 5,
          estimatedVolumes: 2,
          estimatedHostFolders: 1,
          checks: {
            sourceHostAvailable: true,
            targetHostAvailable: true,
            sourceDockerAvailable: true,
            targetDockerAvailable: true,
            sourceComposeAvailable: true,
            targetComposeAvailable: true
          },
          portConflicts: [{ hostPort: "8088", protocol: "tcp", sourceContainer: "cb-portal-web", reason: "Target host already reserves the demo web port." }],
          volumeCollisions: [],
          nameCollisions: [],
          missingNetworks: ["demo_backend"],
          networkConflicts: [],
          estimatedDataBytes: 2_900_155_596,
          blockingIssues: []
        },
        createdBy ?? null
      ]
    );

    const channelIds: Record<string, string> = {};
    for (const channel of [
      { key: "webhook", name: "Demo operations webhook", type: "webhook", email: null, webhook: "https://example.invalid/composebastion-webhook", enabled: true },
      { key: "email", name: "Demo email digest", type: "email", email: "ops@example.invalid", webhook: null, enabled: false }
    ]) {
      const id = uuid();
      channelIds[channel.key] = id;
      await client.query(
        `INSERT INTO notification_channels (id, name, type, email_to, webhook_url, enabled, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, channel.name, channel.type, channel.email, channel.webhook, channel.enabled, { demo: true, purpose: channel.key }]
      );
    }

    const alertRuleIds: Record<string, string> = {};
    for (const rule of [
      { key: "api", name: "Demo API must stay running", condition: "container.not_running", hostId: primaryHostId, containerId: "demo-api-000000000002", channelId: channelIds.webhook!, state: "ok", params: null, breaching: null },
      { key: "cpu", name: "Demo production CPU sustained", condition: "host.cpu", hostId: primaryHostId, containerId: null, channelId: channelIds.webhook!, state: "ok", params: { comparator: "gte", threshold: 82, durationSeconds: 300 }, breaching: null },
      { key: "edge", name: "Demo edge camera unhealthy", condition: "container.not_running", hostId: edgeHostId, containerId: "demo-camera-relay-02", channelId: channelIds.email!, state: "firing", params: null, breaching: "18 minutes" },
      { key: "disk", name: "Demo recovery disk pressure", condition: "host.disk", hostId: recoveryHostId, containerId: null, channelId: channelIds.webhook!, state: "silenced", params: { comparator: "gte", threshold: 88, durationSeconds: 900, mount: "/" }, breaching: "2 hours" }
    ]) {
      const saved = await client.query<{ id: string }>(
        `INSERT INTO alert_rules (
           id, name, condition, host_id, container_id, channel_id, enabled,
           last_state, last_checked_at, last_notified_at, params, breaching_since
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, true,
           $7, now() - interval '2 minutes',
           CASE WHEN $7 IN ('firing', 'silenced') THEN now() - interval '12 minutes' ELSE NULL END,
           $8,
           CASE WHEN $9::text IS NULL THEN NULL ELSE now() - $9::interval END
         )
         RETURNING id`,
        [uuid(), rule.name, rule.condition, rule.hostId, rule.containerId, rule.channelId, rule.state, rule.params, rule.breaching]
      );
      alertRuleIds[rule.key] = saved.rows[0]!.id;
    }

    await client.query(
      `INSERT INTO alert_silences (id, name, host_id, rule_id, starts_at, ends_at, reason, created_by)
       VALUES ($1, 'Demo maintenance silence', $2, $3, now() - interval '20 minutes', now() + interval '3 hours', 'Showcase active silence for planned recovery drill.', $4)`,
      [uuid(), recoveryHostId, alertRuleIds.disk!, createdBy ?? null]
    );
    for (const event of [
      { ruleId: alertRuleIds.api!, hostId: primaryHostId, channelId: channelIds.webhook!, state: "ok", message: "Demo API container recovered after restart.", notified: true, silenced: false, error: null, offset: "26 minutes" },
      { ruleId: alertRuleIds.edge!, hostId: edgeHostId, channelId: channelIds.email!, state: "firing", message: "Camera relay health check is failing.", notified: false, silenced: false, error: "Email channel is disabled in demo mode.", offset: "12 minutes" },
      { ruleId: alertRuleIds.disk!, hostId: recoveryHostId, channelId: channelIds.webhook!, state: "firing", message: "Recovery target root disk is above 88%.", notified: false, silenced: true, error: null, offset: "6 minutes" }
    ]) {
      await client.query(
        `INSERT INTO alert_events (id, rule_id, host_id, channel_id, state, message, notified, silenced, error, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - $10::interval)`,
        [uuid(), event.ruleId, event.hostId, event.channelId, event.state, event.message, event.notified, event.silenced, event.error, event.offset]
      );
    }
    for (const test of [
      { channelId: channelIds.webhook!, status: "success", error: null, offset: "14 minutes" },
      { channelId: channelIds.email!, status: "failed", error: "Demo channel is disabled; enable it after adding SMTP settings.", offset: "13 minutes" }
    ]) {
      await client.query(
        `INSERT INTO alert_channel_test_events (id, channel_id, status, error, tested_by, tested_at)
         VALUES ($1, $2, $3, $4, $5, now() - $6::interval)`,
        [uuid(), test.channelId, test.status, test.error, createdBy ?? null, test.offset]
      );
    }

    for (const [targetHostId, imageReference, status, riskNote, containersAffected, stacksAffected, severities] of [
      [primaryHostId, "ghcr.io/composebastion-admin/showcase-api:0.9.6", "update_available", "v0.9.7 is available; redeploy the Customer Portal stack after reviewing migrations.", [{ id: "demo-api-000000000002", name: "cb-portal-api" }], [{ id: stackIds.showcase!, name: "Customer Portal" }], { critical: 0, high: 1, medium: 3, low: 8 }],
      [primaryHostId, "postgres:16-alpine", "up_to_date", "Database image digest matches the remote registry.", [{ id: "demo-postgres-0000004", name: "cb-portal-postgres" }], [{ id: stackIds.showcase!, name: "Customer Portal" }], { critical: 0, high: 0, medium: 1, low: 6 }],
      [primaryHostId, "ghcr.io/open-webui/open-webui:main", "unknown", "Mutable main tag; pin a release before production use.", [], [{ id: stackIds.ai!, name: "AI Tools" }], { critical: 2, high: 4, medium: 11, low: 20 }],
      [edgeHostId, "ghcr.io/composebastion-admin/camera-relay:0.9.6", "update_available", "Patch image includes a health probe fix for RTSP reconnects.", [{ id: "demo-camera-relay-02", name: "cb-camera-relay" }], [{ id: stackIds.edge!, name: "Edge Gateway" }], { critical: 0, high: 0, medium: 2, low: 5 }],
      [primaryHostId, "registry:2", "local", "Local cache image is not checked against a remote registry.", [{ id: "demo-registry-cache-08", name: "cb-registry-cache" }], [], { critical: 0, high: 0, medium: 0, low: 2 }]
    ] as const) {
      await client.query(
        `INSERT INTO image_update_checks (
           id, host_id, image_reference, current_digest, remote_digest, status,
           risk_note, affected_containers, affected_stacks, last_checked_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - interval '7 minutes')`,
        [
          uuid(),
          targetHostId,
          imageReference,
          demoDigest(`${imageReference}:current`),
          status === "local" ? null : demoDigest(`${imageReference}:remote`),
          status,
          riskNote,
          JSON.stringify(containersAffected),
          JSON.stringify(stacksAffected)
        ]
      );
      await client.query(
        `INSERT INTO image_scan_results (
           id, host_id, image_reference, image_digest, scanner, severity_counts, raw, generated_at
         )
         VALUES ($1, $2, $3, $4, 'demo-trivy', $5, $6, now() - interval '6 minutes')`,
        [uuid(), targetHostId, imageReference, demoDigest(`${imageReference}:current`), severities, { demo: true, summary: "Synthetic scan for product showcase" }]
      );
    }

    for (const favorite of [
      ["nginx:1.27-alpine", "Nginx Alpine", "Small reverse proxy and static asset server."],
      ["postgres:16-alpine", "Postgres 16", "Database base image used by the recovery demo."],
      ["redis:7-alpine", "Redis 7", "Queue and cache service for app stacks."],
      ["grafana/grafana:11.5.2", "Grafana", "Dashboards for the observability stack."],
      ["prom/prometheus:v2.54.1", "Prometheus", "Metrics collection and alerting baseline."],
      ["ghcr.io/open-webui/open-webui:main", "Open WebUI", "AI tools stack example for catalog deployment."],
      ["registry:2", "Registry Cache", "Standalone container example with source linking."],
      ["caddy:2-alpine", "Caddy", "Edge proxy example for agent-managed hosts."]
    ]) {
      await client.query(
        `INSERT INTO favorite_images (id, image, name, notes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (image)
         DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now()`,
        [uuid(), ...favorite]
      );
    }

    for (const registry of [
      { name: "Demo GHCR", url: "ghcr.io", username: "composebastion-admin", password: "demo-ghcr-token", insecure: false },
      { name: "Demo Docker Hub Mirror", url: "registry-1.docker.io", username: "composebastion-demo", password: "demo-docker-token", insecure: false },
      { name: "Demo Insecure Lab Registry", url: "registry.demo.local:5000", username: "demo", password: "demo", insecure: true }
    ]) {
      await client.query(
        `INSERT INTO registries (id, name, url, username, password_encrypted, insecure)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuid(), registry.name, registry.url, registry.username, encryptSecret(registry.password), registry.insecure]
      );
    }

    for (const template of [
      {
        id: "demo-production-web",
        name: "Demo Production Web App",
        description: "Nginx, API, Postgres, Redis, and worker services with volumes and health checks.",
        category: "web",
        composeYaml: showcaseComposeYaml,
        defaultEnv: { WEB_PORT: "8088", API_PORT: "9090", SHOWCASE_DOMAIN: "portal.example.com" },
        volumes: ["demo_web_content", "demo_api_uploads", "demo_postgres_data", "demo_redis_data"],
        ports: ["8088:80", "9090:8080"],
        docs: "https://github.com/composebastion-admin/composebastion"
      },
      {
        id: "demo-observability",
        name: "Demo Observability Pack",
        description: "Prometheus and Grafana with persistent storage for host and app dashboards.",
        category: "monitoring",
        composeYaml: observabilityComposeYaml,
        defaultEnv: { PROMETHEUS_PORT: "9095", GRAFANA_PORT: "3001" },
        volumes: ["demo_prometheus_data", "demo_grafana_data"],
        ports: ["9095:9090", "3001:3000"],
        docs: "https://github.com/prometheus/prometheus"
      },
      {
        id: "demo-worker-suite",
        name: "Demo Worker Suite",
        description: "Background worker pattern with Redis and volume-backed job artifacts.",
        category: "automation",
        composeYaml: `services:
  redis:
    image: redis:7-alpine
    volumes:
      - demo_worker_redis:/data
  worker:
    image: alpine:3.20
    command: ["sh", "-c", "while true; do date; sleep 30; done"]
    volumes:
      - demo_worker_artifacts:/work
volumes:
  demo_worker_redis:
  demo_worker_artifacts:
`,
        defaultEnv: {},
        volumes: ["demo_worker_redis", "demo_worker_artifacts"],
        ports: [],
        docs: "https://github.com/composebastion-admin/composebastion"
      }
    ] as const) {
      await client.query(
        `INSERT INTO custom_catalog_templates (
           id, name, description, category, compose_yaml, default_env,
           suggested_volumes, suggested_ports, docs_url, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       description = EXCLUDED.description,
                       category = EXCLUDED.category,
                       compose_yaml = EXCLUDED.compose_yaml,
                       default_env = EXCLUDED.default_env,
                       suggested_volumes = EXCLUDED.suggested_volumes,
                       suggested_ports = EXCLUDED.suggested_ports,
                       docs_url = EXCLUDED.docs_url,
                       updated_at = now()`,
        [
          template.id,
          template.name,
          template.description,
          template.category,
          template.composeYaml,
          template.defaultEnv,
          template.volumes,
          template.ports,
          template.docs,
          createdBy ?? null
        ]
      );
    }

    for (const [targetHostId, paths] of [
      [
        primaryHostId,
        [
          ["/home/demo/apps/customer-portal/docker-compose.yml", showcaseComposeYaml],
          ["/home/demo/apps/customer-portal/.env", showcaseEnv],
          ["/home/demo/apps/customer-portal/README.md", "# Customer Portal Demo\n\nThis stack shows git deployments, proxy metadata, updates, backups, and recovery readiness.\n"],
          ["/home/demo/apps/customer-portal/runbook.md", "## Demo Runbook\n\n1. Check image updates.\n2. Review recovery readiness.\n3. Start a migration plan to the recovery target.\n"],
          ["/home/demo/apps/observability/docker-compose.yml", observabilityComposeYaml],
          ["/home/demo/apps/observability/prometheus.yml", "global:\n  scrape_interval: 15s\nscrape_configs:\n  - job_name: composebastion-demo\n    static_configs:\n      - targets: ['cb-portal-api:8080']\n"],
          ["/home/demo/backups/README.md", "Demo backup artifacts are represented in the Backups and Recovery Center panels.\n"],
          ["/home/demo/playbooks/recovery-drill.md", "# Recovery Drill\n\nUse the Portal nightly verified recovery point and restore to Demo Recovery Target.\n"],
          ["/home/demo/secrets/secrets.example.env", "POSTGRES_PASSWORD=demo\nAPI_TOKEN=change-me-before-production\n"]
        ]
      ],
      [
        edgeHostId,
        [
          ["/home/demo/edge/docker-compose.yml", edgeComposeYaml],
          ["/home/demo/edge/README.md", "# Edge Gateway Demo\n\nThis host uses agent mode and includes an unhealthy camera relay for alert showcases.\n"],
          ["/home/demo/edge/caddy/Caddyfile", ":80 {\n  respond \"ComposeBastion edge demo\"\n}\n"]
        ]
      ],
      [
        recoveryHostId,
        [
          ["/home/demo/recovery/README.md", "# Recovery Target\n\nThis host receives demo migration runs and restore rehearsals.\n"],
          ["/home/demo/recovery/restore-plan.json", JSON.stringify({ source: "Demo Production Node", app: "Customer Portal", portRemap: { "8088": "18080" } }, null, 2)]
        ]
      ]
    ] as const) {
      await ensureDemoDirectory(client, targetHostId, "/home/demo");
      await ensureDemoDirectory(client, targetHostId, "/home/demo/apps");
      for (const [filePath, content] of paths) {
        await ensureDemoDirectory(client, targetHostId, parentPath(filePath));
        await upsertDemoFile(client, targetHostId, filePath, "file", content);
      }
    }

    const jobs = [
      {
        type: "host.check",
        status: "completed",
        hostId: primaryHostId,
        payload: { demo: true, scope: "production" },
        result: { dockerVersion: "29.4.0-demo", composeVersion: "5.1.1-demo" },
        error: null,
        offset: "35 minutes",
        progress: [
          { id: "connect", label: "Connect", status: "completed" },
          { id: "inspect", label: "Inspect host", status: "completed" }
        ]
      },
      {
        type: "host.sync",
        status: "completed",
        hostId: primaryHostId,
        payload: { demo: true },
        result: { container: 9, image: 12, network: 6, volume: 8 },
        error: null,
        offset: "30 minutes",
        progress: [
          { id: "inventory", label: "Inventory", status: "completed" },
          { id: "save", label: "Save snapshots", status: "completed" }
        ]
      },
      {
        type: "compose.deploy",
        status: "completed",
        hostId: primaryHostId,
        payload: { demo: true, stackId: stackIds.showcase },
        result: { projectName: "demo_showcase", version: 2 },
        error: null,
        offset: "22 minutes",
        progress: [
          { id: "pull", label: "Pull images", status: "completed" },
          { id: "deploy", label: "Deploy stack", status: "completed" },
          { id: "verify", label: "Verify health", status: "completed" }
        ]
      },
      {
        type: "image.pull",
        status: "failed",
        hostId: edgeHostId,
        payload: { demo: true, image: "ghcr.io/composebastion-admin/camera-relay:0.9.7" },
        result: null,
        error: "Demo failure: registry token does not allow edge image pulls.",
        offset: "13 minutes",
        progress: [
          { id: "resolve", label: "Resolve image", status: "completed" },
          { id: "pull", label: "Pull layers", status: "failed", detail: "Registry token rejected the request." }
        ]
      },
      {
        type: "recovery.capture",
        status: "running",
        hostId: primaryHostId,
        payload: { demo: true, app: "Observability" },
        result: null,
        error: null,
        offset: "3 minutes",
        progress: [
          { id: "prepare", label: "Prepare manifest", status: "completed" },
          { id: "capture", label: "Capture artifacts", status: "running", detail: "Saving Grafana volume." },
          { id: "verify", label: "Verify artifacts", status: "pending" }
        ]
      },
      {
        type: "migration.execute",
        status: "completed",
        hostId: recoveryHostId,
        payload: { demo: true, sourceHostId: primaryHostId, recoveryPointId: recoveryPointIds.portal },
        result: { source: "Demo Production Node", target: "Demo Recovery Target", app: "Customer Portal" },
        error: null,
        offset: "35 minutes",
        progress: [
          { id: "backup", label: "Capture recovery point", status: "completed" },
          { id: "transfer", label: "Transfer artifacts", status: "completed" },
          { id: "deploy", label: "Deploy on target", status: "completed" },
          { id: "verify", label: "Verify app", status: "completed" }
        ]
      }
    ];
    for (const job of jobs) {
      await client.query(
        `INSERT INTO operation_jobs (
           id, type, status, host_id, payload, result, error, created_by,
           progress, created_at, started_at, completed_at, updated_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, now() - $10::interval,
           CASE WHEN $3 <> 'queued' THEN now() - $10::interval + interval '15 seconds' ELSE NULL END,
           CASE WHEN $3 IN ('completed', 'failed', 'canceled') THEN now() - $10::interval + interval '2 minutes' ELSE NULL END,
           now()
         )`,
        [
          uuid(),
          job.type,
          job.status,
          job.hostId,
          job.payload,
          job.result,
          job.error,
          createdBy ?? null,
          JSON.stringify(job.progress),
          job.offset
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_events (id, user_id, host_id, action, target_kind, target_id, details)
       VALUES ($1, $2, $3, 'demo.seed', 'workspace', $4, $5)`,
      [
        uuid(),
        createdBy ?? null,
        primaryHostId,
        primaryHostId,
        {
          demo: true,
          hosts: Object.keys(hostIds).length,
          stacks: Object.keys(stackIds).length,
          repositories: Object.keys(repoIds).length,
          recoveryPoints: Object.keys(recoveryPointIds).length
        }
      ]
    );

    const host = await client.query("SELECT * FROM docker_hosts WHERE id = $1", [primaryHostId]);
    return { host: mapHost(host.rows[0]), seeded: true };
  });
}

export async function demoInventorySummary(hostId: string) {
  const result = await query<{ kind: ResourceKind; count: string }>(
    "SELECT kind, count(*) FROM resource_snapshots WHERE host_id = $1 AND kind = ANY($2::text[]) GROUP BY kind",
    [hostId, ["container", "image", "network", "volume"]]
  );
  const summary: Record<ResourceKind, number> = { container: 0, image: 0, network: 0, volume: 0 };
  for (const row of result.rows) summary[row.kind] = Number(row.count);
  return summary;
}

async function findResource(hostId: string, kind: string, idOrName: string) {
  const result = await query<any>(
    `SELECT * FROM resource_snapshots
     WHERE host_id = $1 AND kind = $2 AND (external_id = $3 OR name = $3 OR data->>'Names' = $3 OR data->>'Name' = $3)
     LIMIT 1`,
    [hostId, kind, idOrName]
  );
  return result.rows[0] ?? null;
}

async function updateContainer(hostId: string, containerId: string, updater: (data: Record<string, any>) => Record<string, any>) {
  const row = await findResource(hostId, "container", containerId);
  if (!row) throw new Error("Demo container not found");
  const data = updater({ ...(row.data ?? {}) });
  await query("UPDATE resource_snapshots SET name = $4, data = $3, updated_at = now() WHERE id = $1 AND host_id = $2", [
    row.id,
    hostId,
    data,
    data.Names ?? row.name
  ]);
  return data;
}

async function upsertImageForAction(hostId: string, image: string) {
  const data = imageData(image, `${Math.max(18, (stableHash(image) % 800) + 20)}MB`);
  await upsertResource({ query }, hostId, "image", String(data.ID), `${data.Repository}:${data.Tag}`, data);
  return data;
}

function portMappingsToText(ports: Array<{ hostPort: number; containerPort: number; protocol: string }>) {
  return ports.map((port) => `0.0.0.0:${port.hostPort}->${port.containerPort}/${port.protocol}`).join(", ");
}

export async function executeDemoDockerAction(action: DockerActionRequest) {
  if (action.type === "host.check") {
    await query(
      `UPDATE docker_hosts SET last_status = 'online', last_seen_at = now(), last_error = null, docker_version = '29.4.0-demo', compose_version = '5.1.1-demo', updated_at = now()
       WHERE id = $1`,
      [action.hostId]
    );
    return { dockerVersion: "29.4.0-demo", composeVersion: "5.1.1-demo", demo: true };
  }

  if (action.type === "host.sync") return { ...(await demoInventorySummary(action.hostId)), demo: true };

  if (action.type === "host.mkdir") {
    await ensureDemoDirectory({ query }, action.hostId, action.payload.path);
    return { path: normalizeDemoPath(action.payload.path), demo: true };
  }

  if (action.type === "git.clone") {
    await demoCloneRepository(action.hostId, action.payload.repositoryUrl, action.payload.directory, action.payload.branch);
    return { path: normalizeDemoPath(action.payload.directory), stdout: "Demo repository cloned", stderr: "", demo: true };
  }

  if (action.type === "git.pull") {
    return {
      path: normalizeDemoPath(action.payload.directory),
      stdout: "Demo repository pulled",
      stderr: "",
      currentCommit: "demo-current",
      latestCommit: "demo-latest",
      branch: action.payload.branch ?? "main",
      demo: true
    };
  }

  if (action.type === "git.cloneDeploy") {
    await demoCloneRepository(action.hostId, action.payload.repositoryUrl, action.payload.directory, action.payload.branch);
    await query(
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status,
         source_type, source_repository_url, source_branch, source_working_dir, source_compose_path
       )
       VALUES ($1, $2, $3, $4, $5, '', 'deployed', 'git', $6, $7, $8, $9)
       ON CONFLICT (host_id, project_name)
       DO UPDATE SET status = 'deployed',
                     source_type = EXCLUDED.source_type,
                     source_repository_url = EXCLUDED.source_repository_url,
                     source_branch = EXCLUDED.source_branch,
                     source_working_dir = EXCLUDED.source_working_dir,
                     source_compose_path = EXCLUDED.source_compose_path,
                     updated_at = now()`,
      [
        uuid(),
        action.hostId,
        basePath(action.payload.directory),
        action.payload.projectName,
        `# Demo clone deploy from ${action.payload.repositoryUrl}\nservices: {}\n`,
        action.payload.repositoryUrl,
        action.payload.branch ?? "main",
        normalizeDemoPath(action.payload.directory),
        action.payload.composePath
      ]
    );
    return { repositoryUrl: action.payload.repositoryUrl, projectName: action.payload.projectName, demo: true };
  }

  if (action.type === "compose.deployPath") {
    await query(
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status,
         source_type, source_working_dir, source_compose_path
       )
       VALUES ($1, $2, $3, $4, $5, '', 'deployed', 'host_files', $6, $7)
       ON CONFLICT (host_id, project_name)
       DO UPDATE SET status = 'deployed',
                     source_type = EXCLUDED.source_type,
                     source_working_dir = EXCLUDED.source_working_dir,
                     source_compose_path = EXCLUDED.source_compose_path,
                     updated_at = now()`,
      [
        uuid(),
        action.hostId,
        basePath(action.payload.workingDir),
        action.payload.projectName,
        `# Demo deploy from ${normalizeDemoPath(action.payload.workingDir)}/${action.payload.composePath}\nservices: {}\n`,
        normalizeDemoPath(action.payload.workingDir),
        action.payload.composePath
      ]
    );
    return { workingDir: action.payload.workingDir, composePath: action.payload.composePath, demo: true };
  }

  if (action.type === "compose.writeDeployPath") {
    const workingDir = normalizeDemoPath(action.payload.workingDir);
    const composeFile = action.payload.composePath.startsWith("/")
      ? normalizeDemoPath(action.payload.composePath)
      : normalizeDemoPath(path.posix.join(workingDir, action.payload.composePath));
    const envPath = normalizeDemoPath(path.posix.join(workingDir, ".env"));
    if (!action.payload.overwrite) {
      const composeStat = await statDemoPath(action.hostId, composeFile);
      if (composeStat.exists) throw new Error(`${composeFile} already exists. Confirm overwrite before replacing it.`);
      if (action.payload.env !== undefined) {
        const envStat = await statDemoPath(action.hostId, envPath);
        if (envStat.exists) throw new Error(`${envPath} already exists. Confirm overwrite before replacing it.`);
      }
    }
    await writeDemoTextFile(action.hostId, composeFile, action.payload.composeYaml);
    if (action.payload.env !== undefined) {
      await writeDemoTextFile(action.hostId, envPath, action.payload.env);
    }
    await query(
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status,
         source_type, source_working_dir, source_compose_path
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'deployed', 'host_files', $7, $8)
       ON CONFLICT (host_id, project_name)
       DO UPDATE SET compose_yaml = EXCLUDED.compose_yaml,
                     env = EXCLUDED.env,
                     status = 'deployed',
                     source_type = EXCLUDED.source_type,
                     source_working_dir = EXCLUDED.source_working_dir,
                     source_compose_path = EXCLUDED.source_compose_path,
                     updated_at = now()`,
      [
        uuid(),
        action.hostId,
        basePath(workingDir),
        action.payload.projectName,
        action.payload.composeYaml,
        action.payload.env ?? "",
        workingDir,
        composeFile
      ]
    );
    return { workingDir, composePath: composeFile, demo: true };
  }

  if (action.type === "container.run") {
    const image = action.payload.image;
    await upsertImageForAction(action.hostId, image);
    const name = action.payload.name || `${imageName(image)}-${String(Date.now()).slice(-4)}`;
    const id = `demo-${stableHash(`${name}-${Date.now()}`).toString(16).padStart(12, "0")}`;
    const data = containerData({
      id,
      name,
      image,
      state: "running",
      ports: portMappingsToText(action.payload.ports),
      mounts: action.payload.volumes.map((volume) => ({ Type: "volume", Name: volume.volumeName, Destination: volume.containerPath, RW: !volume.readOnly })),
      network: action.payload.network
    });
    await upsertResource({ query }, action.hostId, "container", id, name, data);
    for (const volume of action.payload.volumes) {
      await upsertResource({ query }, action.hostId, "volume", volume.volumeName, volume.volumeName, volumeData(volume.volumeName));
    }
    return { containerId: id, name, demo: true };
  }

  if (action.type === "container.start" || action.type === "container.stop" || action.type === "container.restart") {
    const state = action.type === "container.stop" ? "exited" : "running";
    const data = await updateContainer(action.hostId, action.payload.containerId, (current) => ({
      ...current,
      State: state,
      Status: state === "running" ? "Up less than a minute" : "Exited (0) less than a minute ago"
    }));
    return { container: data.Names, state, demo: true };
  }

  if (action.type === "container.rename") {
    const data = await updateContainer(action.hostId, action.payload.containerId, (current) => ({ ...current, Names: action.payload.name }));
    return { container: data.Names, demo: true };
  }

  if (action.type === "container.update") {
    const image = action.payload.targetImage;
    const data = await updateContainer(action.hostId, action.payload.containerId, (current) => ({ ...current, Image: image ?? current.Image }));
    if (image) await upsertImageForAction(action.hostId, image);
    return { container: data.Names, image: data.Image, demo: true };
  }

  if (action.type === "container.remove") {
    await query("DELETE FROM resource_snapshots WHERE host_id = $1 AND kind = 'container' AND (external_id = $2 OR name = $2 OR data->>'Names' = $2)", [
      action.hostId,
      action.payload.containerId
    ]);
    return { removed: action.payload.containerId, demo: true };
  }

  if (action.type === "image.pull") {
    const data = await upsertImageForAction(action.hostId, action.payload.image);
    return { image: `${data.Repository}:${data.Tag}`, demo: true };
  }

  if (action.type === "image.remove") {
    await query("DELETE FROM resource_snapshots WHERE host_id = $1 AND kind = 'image' AND (external_id = $2 OR name = $2)", [
      action.hostId,
      action.payload.imageId
    ]);
    return { removed: action.payload.imageId, demo: true };
  }

  if (action.type === "image.prune") return { pruned: 0, demo: true };

  if (action.type === "image.cleanup") {
    const targets = action.payload.targets.map((target) => target.imageId);
    await query("DELETE FROM resource_snapshots WHERE host_id = $1 AND kind = 'image' AND external_id = ANY($2::text[])", [
      action.hostId,
      targets
    ]);
    return { removed: targets.map((imageId) => ({ imageId, reference: imageId })), count: targets.length, demo: true };
  }

  if (action.type === "network.create") {
    const data = networkData(action.payload.name, action.payload.driver);
    await upsertResource({ query }, action.hostId, "network", String(data.ID), String(data.Name), { ...data, Labels: action.payload.labels });
    return { network: data.Name, demo: true };
  }

  if (action.type === "network.remove") {
    await query("DELETE FROM resource_snapshots WHERE host_id = $1 AND kind = 'network' AND (external_id = $2 OR name = $2 OR data->>'Name' = $2)", [
      action.hostId,
      action.payload.networkId
    ]);
    return { removed: action.payload.networkId, demo: true };
  }

  if (action.type === "network.prune") return { pruned: 0, demo: true };

  if (action.type === "volume.create") {
    await upsertResource({ query }, action.hostId, "volume", action.payload.name, action.payload.name, { ...volumeData(action.payload.name), Labels: action.payload.labels });
    return { volume: action.payload.name, demo: true };
  }

  if (action.type === "volume.remove") {
    await query("DELETE FROM resource_snapshots WHERE host_id = $1 AND kind = 'volume' AND (external_id = $2 OR name = $2)", [
      action.hostId,
      action.payload.volumeName
    ]);
    return { removed: action.payload.volumeName, demo: true };
  }

  if (action.type === "volume.prune") return { pruned: 0, demo: true };

  if (action.type === "compose.deploy" || action.type === "compose.stop" || action.type === "compose.remove") {
    const status = action.type === "compose.deploy" ? "deployed" : action.type === "compose.stop" ? "stopped" : "removed";
    await query("UPDATE compose_stacks SET status = $3, updated_at = now() WHERE id = $1 AND host_id = $2", [
      action.payload.stackId,
      action.hostId,
      status
    ]);
    return { status, demo: true };
  }

  if (action.type === "registry.login") return { stdout: "Demo registry login simulated", stderr: "", demo: true };
  if (action.type === "container.clone") return { stdout: "Demo container clone simulated", stderr: "", demo: true };
  throw new Error(`${action.type} is not available in demo mode yet`);
}

export async function getDemoContainerUsage(hostId: string) {
  const result = await query<any>("SELECT * FROM resource_snapshots WHERE host_id = $1 AND kind = 'container' ORDER BY name ASC", [hostId]);
  return result.rows.map((row) => {
    const data = row.data ?? {};
    const running = data.State === "running";
    const cpu = running ? metricWave(row.external_id, 0.05, row.name.includes("postgres") ? 4.5 : 16) : 0;
    const memory = running ? metricWave(`${row.external_id}-mem`, 2, row.name.includes("web") ? 18 : 48) : 0;
    return {
      ID: String(row.external_id).slice(0, 12),
      Name: data.Names ?? row.name,
      CPUPerc: `${cpu.toFixed(2)}%`,
      MemPerc: `${memory.toFixed(2)}%`,
      MemUsage: `${Math.max(8, memory * 8).toFixed(1)}MiB / 3.823GiB`,
      NetIO: "2.1MB / 640kB",
      BlockIO: data.Size ?? "4.1kB",
      PIDs: running ? "8" : "0"
    };
  });
}

export async function streamDemoContainerUsage(hostId: string, onStats: (stats: Record<string, unknown>) => void) {
  const emit = async () => {
    const usage = await getDemoContainerUsage(hostId);
    for (const row of usage) onStats(row);
  };
  await emit();
  const timer = setInterval(() => void emit(), 2_000);
  return () => clearInterval(timer);
}

export async function getDemoContainerStats(hostId: string, containerId: string) {
  const usage = await getDemoContainerUsage(hostId);
  return usage.find((item) => String(containerId).startsWith(String(item.ID)) || item.Name === containerId) ?? usage[0] ?? {};
}

export async function getDemoContainerLogs(hostId: string, containerId: string, tail = 200) {
  const row = await findResource(hostId, "container", containerId);
  const name = row?.data?.Names ?? row?.name ?? containerId;
  return {
    stdout: [
      `${new Date().toISOString()} ${name} demo log stream started`,
      `${new Date().toISOString()} ${name} health check passed`,
      `${new Date().toISOString()} ${name} serving sample traffic`,
      `Showing the last ${tail} lines from demo mode.`
    ].join("\n"),
    stderr: ""
  };
}

export async function getDemoContainerVolumeMounts(hostId: string, containerId: string) {
  const row = await findResource(hostId, "container", containerId);
  if (!row) throw new Error("Demo container not found");
  return (row.data?.Mounts ?? [])
    .filter((mount: any) => mount.Type === "volume" && mount.Name)
    .map((mount: any) => ({
      name: String(mount.Name),
      destination: String(mount.Destination ?? ""),
      readOnly: mount.RW === false
    }));
}

export async function execDemoContainer(hostId: string, containerId: string, command: string) {
  const row = await findResource(hostId, "container", containerId);
  const name = row?.data?.Names ?? row?.name ?? containerId;
  return {
    stdout: `$ ${command}\nDemo exec ran inside ${name}.\n/home/app\ncompose.yml\n.env\nlogs/`,
    stderr: ""
  };
}

export async function listDemoDirectory(hostId: string, directory: string) {
  const normalized = normalizeDemoPath(directory);
  const result = await query<any>("SELECT * FROM resource_snapshots WHERE host_id = $1 AND kind = $2", [hostId, DEMO_FILE_KIND]);
  const byPath = new Map(result.rows.map((row) => [String(row.external_id), row]));
  if (!byPath.has(normalized)) {
    await ensureDemoDirectory({ query }, hostId, normalized);
  }
  const entries = Array.from(byPath.values())
    .filter((row) => String(row.external_id) !== normalized && parentPath(String(row.external_id)) === normalized)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((row) => ({
      name: row.name,
      path: row.external_id,
      type: row.data?.type ?? "file",
      size: Number(row.data?.size ?? 0),
      modified: row.data?.modified ?? ""
    }));
  return {
    path: normalized,
    parent: normalized === "/" ? null : parentPath(normalized),
    entries
  };
}

export async function readDemoTextFile(hostId: string, filePath: string) {
  const normalized = normalizeDemoPath(filePath);
  const row = await findResource(hostId, DEMO_FILE_KIND, normalized);
  if (!row || row.data?.type !== "file") throw new Error("Demo file not found");
  return { path: normalized, content: String(row.data?.content ?? "") };
}

export async function statDemoPath(hostId: string, filePath: string) {
  const normalized = normalizeDemoPath(filePath);
  const row = await findResource(hostId, DEMO_FILE_KIND, normalized);
  return {
    path: normalized,
    exists: Boolean(row),
    type: row?.data?.type ?? null,
    size: row ? Number(row.data?.size ?? 0) : null
  };
}

export async function writeDemoTextFile(hostId: string, filePath: string, content: string) {
  const normalized = normalizeDemoPath(filePath);
  await ensureDemoDirectory({ query }, hostId, parentPath(normalized));
  await upsertDemoFile({ query }, hostId, normalized, "file", content);
  return { path: normalized };
}

export async function demoCloneRepository(hostId: string, repositoryUrl: string, directory: string, branch?: string) {
  const normalized = normalizeDemoPath(directory);
  await ensureDemoDirectory({ query }, hostId, normalized);
  await upsertDemoFile({ query }, hostId, `${normalized}/README.md`, "file", `# Cloned Demo Repository\n\nSource: ${repositoryUrl}\nBranch: ${branch || "default"}\n`);
  await upsertDemoFile({ query }, hostId, `${normalized}/docker-compose.yml`, "file", "services:\n  app:\n    image: nginx:alpine\n    ports:\n      - \"8088:80\"\n");
}
