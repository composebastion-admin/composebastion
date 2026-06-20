import path from "node:path";
import { v4 as uuid } from "uuid";
import type { DockerActionRequest, DockerHost, ResourceKind } from "@dockermender/shared";
import { query, withTransaction } from "../db/pool.js";
import { encryptSecret } from "./crypto.js";
import { mapHost } from "./mappers.js";

export const DEMO_TAG = "demo";
const DEMO_HOSTNAME = "demo.dockermender.local";
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
}) {
  return {
    ID: input.id,
    Names: input.name,
    Image: input.image,
    State: input.state,
    Status: input.state === "running" ? "Up 2 hours" : input.state === "exited" ? "Exited (0) 18 minutes ago" : input.state,
    Ports: input.ports ?? "",
    Size: input.size ?? "4.1kB (virtual 128MB)",
    Mounts: input.mounts ?? [],
    Network: input.network ?? "demo_frontend"
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
    Labels: { "dockermender.demo": "true" }
  };
}

function volumeData(name: string) {
  return {
    Name: name,
    Driver: "local",
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    Scope: "local",
    Labels: { "dockermender.demo": "true" }
  };
}

const demoComposeYaml = `services:
  web:
    image: nginx:alpine
    ports:
      - "\${WEB_PORT:-8088}:80"
    volumes:
      - demo_web_content:/usr/share/nginx/html
  api:
    image: ghcr.io/example/demo-api:1.4.2
    environment:
      NODE_ENV: production
    ports:
      - "\${API_PORT:-9090}:8080"
volumes:
  demo_web_content:
`;

const demoEnv = `WEB_PORT=8088
API_PORT=9090
`;

export async function seedDemoWorkspace(createdBy?: string | null) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      "SELECT * FROM docker_hosts WHERE hostname = $1 OR $2 = ANY(tags) ORDER BY created_at ASC LIMIT 1",
      [DEMO_HOSTNAME, DEMO_TAG]
    );
    const hostId = existing.rows[0]?.id ?? uuid();

    if (existing.rows[0]) {
      await client.query(
        `UPDATE docker_hosts
         SET name = 'Demo Host',
             hostname = $2,
             port = 22,
             username = 'demo',
             connection_mode = 'ssh',
             ssh_auth_type = 'password',
             ssh_password_encrypted = COALESCE(ssh_password_encrypted, $3),
             docker_socket_path = '/var/run/docker.sock',
             tags = ARRAY['demo', 'sandbox', 'sample'],
             last_status = 'online',
             last_seen_at = now(),
             last_error = null,
             docker_version = '29.4.0-demo',
             compose_version = '5.1.1-demo',
             updated_at = now()
         WHERE id = $1`,
        [hostId, DEMO_HOSTNAME, encryptSecret("demo-password")]
      );
    } else {
      await client.query(
        `INSERT INTO docker_hosts
          (id, name, hostname, port, username, connection_mode, ssh_auth_type, ssh_password_encrypted, docker_socket_path, tags, last_status, last_seen_at, docker_version, compose_version)
         VALUES ($1, 'Demo Host', $2, 22, 'demo', 'ssh', 'password', $3, '/var/run/docker.sock', ARRAY['demo', 'sandbox', 'sample'], 'online', now(), '29.4.0-demo', '5.1.1-demo')`,
        [hostId, DEMO_HOSTNAME, encryptSecret("demo-password")]
      );
    }

    await client.query("DELETE FROM resource_snapshots WHERE host_id = $1", [hostId]);
    await client.query("DELETE FROM compose_stacks WHERE host_id = $1", [hostId]);
    await client.query("DELETE FROM backups WHERE host_id = $1", [hostId]);
    await client.query("DELETE FROM alert_rules WHERE host_id = $1", [hostId]);
    await client.query("DELETE FROM operation_jobs WHERE host_id = $1", [hostId]);

    const containers = [
      containerData({
        id: "demo-web-000000000001",
        name: "demo-web",
        image: "nginx:alpine",
        state: "running",
        ports: "0.0.0.0:8088->80/tcp, [::]:8088->80/tcp",
        size: "12.4kB (virtual 49.6MB)",
        mounts: [{ Type: "volume", Name: "demo_web_content", Destination: "/usr/share/nginx/html", RW: true }],
        network: "demo_frontend"
      }),
      containerData({
        id: "demo-api-000000000002",
        name: "demo-api",
        image: "ghcr.io/example/demo-api:1.4.2",
        state: "running",
        ports: "0.0.0.0:9090->8080/tcp",
        size: "28.1MB (virtual 212MB)",
        mounts: [{ Type: "volume", Name: "demo_api_data", Destination: "/data", RW: true }],
        network: "demo_backend"
      }),
      containerData({
        id: "demo-postgres-0000003",
        name: "demo-postgres",
        image: "postgres:16-alpine",
        state: "running",
        ports: "5432/tcp",
        size: "18.8kB (virtual 396MB)",
        mounts: [{ Type: "volume", Name: "demo_postgres_data", Destination: "/var/lib/postgresql/data", RW: true }],
        network: "demo_backend"
      }),
      containerData({
        id: "demo-worker-000000004",
        name: "demo-worker",
        image: "redis:7-alpine",
        state: "exited",
        ports: "6379/tcp",
        size: "4.1kB (virtual 57.8MB)",
        network: "demo_backend"
      })
    ];

    for (const item of containers) {
      await upsertResource(client, hostId, "container", String(item.ID), String(item.Names), item);
    }

    const images = [
      ["nginx:alpine", "49.6MB"],
      ["ghcr.io/example/demo-api:1.4.2", "212MB"],
      ["ghcr.io/example/demo-api:1.5.0", "218MB"],
      ["postgres:16-alpine", "396MB"],
      ["redis:7-alpine", "57.8MB"],
      ["ghcr.io/open-webui/open-webui:main", "6.68GB"]
    ] as const;
    for (const [image, size] of images) {
      const data = imageData(image, size);
      await upsertResource(client, hostId, "image", String(data.ID), `${data.Repository}:${data.Tag}`, data);
    }

    for (const network of [
      networkData("bridge"),
      networkData("host", "host"),
      networkData("none", "null"),
      networkData("demo_frontend"),
      networkData("demo_backend")
    ]) {
      await upsertResource(client, hostId, "network", String(network.ID), String(network.Name), network);
    }

    for (const volume of ["demo_web_content", "demo_api_data", "demo_postgres_data", "demo_uploads"]) {
      await upsertResource(client, hostId, "volume", volume, volume, volumeData(volume));
    }

    await client.query(
      `INSERT INTO compose_stacks (id, host_id, name, project_name, compose_yaml, env, status, updated_at)
       VALUES
         ($1, $3, 'Demo Web Stack', 'demo_web', $4, $5, 'deployed', now()),
         ($2, $3, 'AI Tools Stack', 'demo_ai', $6, 'OPEN_WEBUI_PORT=3000', 'created', now())`,
      [
        uuid(),
        uuid(),
        hostId,
        demoComposeYaml,
        demoEnv,
        `services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports:
      - "\${OPEN_WEBUI_PORT:-3000}:8080"
    volumes:
      - demo_open_webui:/app/backend/data
volumes:
  demo_open_webui:
`
      ]
    );

    // Matches the seeded "Demo Compose App" GitHub repository so the deployed
    // repo -> stack pairing shows the full git update flow in the demo.
    await client.query(
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status,
         source_type, source_repository_url, source_branch,
         source_current_commit_sha, source_latest_commit_sha, source_checked_at, updated_at
       )
       VALUES ($1, $2, 'Demo Compose App', 'demo_compose_app', $3, 'WEB_PORT=8088', 'deployed',
               'github', 'https://github.com/docker/awesome-compose', 'master',
               'd3m0c0mm1tf0rdem0c0mp0seapp0000000000001', 'd3m0c0mm1tf0rdem0c0mp0seapp0000000000001', now() - interval '5 minutes', now())`,
      [
        uuid(),
        hostId,
        `services:
  web:
    image: nginx:alpine
    ports:
      - "\${WEB_PORT:-8088}:80"
`
      ]
    );

    await client.query(
      `INSERT INTO backups (id, host_id, volume_name, target_volume_name, file_name, size_bytes, status, completed_at, metadata)
       VALUES
         ($1, $3, 'demo_postgres_data', null, $4, 7340032, 'completed', now() - interval '20 minutes', $5),
         ($2, $3, 'demo_uploads', null, $6, null, 'failed', now() - interval '1 hour', $7)`,
      [
        uuid(),
        uuid(),
        hostId,
        `demo-postgres-${Date.now()}.tar.gz`,
        { demo: true, note: "Sample completed backup" },
        `demo-uploads-${Date.now()}.tar.gz`,
        { demo: true, note: "Sample failed backup" }
      ]
    );

    const channel = await client.query("SELECT * FROM notification_channels WHERE name = 'Demo webhook' LIMIT 1");
    const channelId = channel.rows[0]?.id ?? uuid();
    if (!channel.rows[0]) {
      await client.query(
        `INSERT INTO notification_channels (id, name, type, webhook_url, enabled, config)
         VALUES ($1, 'Demo webhook', 'webhook', 'https://example.invalid/dockermender-webhook', false, $2)`,
        [channelId, { demo: true }]
      );
    }
    await client.query(
      `INSERT INTO alert_rules (id, name, condition, host_id, container_id, channel_id, enabled, last_state, last_checked_at)
       VALUES
         ($1, 'Demo host offline', 'host.offline', $3, null, $4, true, 'ok', now()),
         ($2, 'Demo API must run', 'container.not_running', $3, 'demo-api-000000000002', $4, true, 'ok', now())`,
      [uuid(), uuid(), hostId, channelId]
    );

    for (const favorite of [
      ["nginx:alpine", "Nginx Alpine", "Tiny web server for quick smoke tests."],
      ["postgres:16-alpine", "Postgres 16", "Common database base image."],
      ["ghcr.io/open-webui/open-webui:main", "Open WebUI", "Example app for Compose deployments."]
    ]) {
      await client.query(
        `INSERT INTO favorite_images (id, image, name, notes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (image)
         DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now()`,
        [uuid(), ...favorite]
      );
    }

    await client.query(
      `INSERT INTO github_repositories
        (id, name, repository_url, owner, repo, branch, compose_path, project_name, env, default_host_id,
         last_deployed_at, last_deployed_commit_sha, latest_commit_sha, update_checked_at)
       VALUES
        ($1, 'Demo Compose App', 'https://github.com/docker/awesome-compose', 'docker', 'awesome-compose', 'master', 'nginx-flask-mysql/compose.yaml', 'demo_compose_app', 'WEB_PORT=8088', $3,
         now() - interval '30 minutes', 'd3m0c0mm1tf0rdem0c0mp0seapp0000000000001', 'd3m0c0mm1tf0rdem0c0mp0seapp0000000000001', now() - interval '5 minutes'),
        ($2, 'Open WebUI', 'https://github.com/open-webui/open-webui', 'open-webui', 'open-webui', 'main', 'docker-compose.yaml', 'demo_openwebui', 'OPEN_WEBUI_PORT=3000', $3,
         null, null, null, null)
       ON CONFLICT (owner, repo, branch, compose_path)
       DO UPDATE SET name = EXCLUDED.name, project_name = EXCLUDED.project_name, env = EXCLUDED.env, default_host_id = EXCLUDED.default_host_id, updated_at = now()`,
      [uuid(), uuid(), hostId]
    );

    await ensureDemoDirectory(client, hostId, "/home/demo/apps");
    await ensureDemoDirectory(client, hostId, "/home/demo/backups");
    await ensureDemoDirectory(client, hostId, "/home/demo/apps/demo-web");
    await ensureDemoDirectory(client, hostId, "/home/demo/apps/openwebui");
    await upsertDemoFile(client, hostId, "/home/demo/apps/demo-web/docker-compose.yml", "file", demoComposeYaml);
    await upsertDemoFile(client, hostId, "/home/demo/apps/demo-web/.env", "file", demoEnv);
    await upsertDemoFile(client, hostId, "/home/demo/apps/demo-web/README.md", "file", "# Demo Web Stack\n\nEdit this compose file and deploy it from the Files tab.\n");
    await upsertDemoFile(client, hostId, "/home/demo/apps/openwebui/docker-compose.yaml", "file", "services:\n  open-webui:\n    image: ghcr.io/open-webui/open-webui:main\n    ports:\n      - \"3000:8080\"\n");

    for (const [type, status, result, error, createdOffset] of [
      ["host.check", "completed", { dockerVersion: "29.4.0-demo", composeVersion: "5.1.1-demo" }, null, "4 minutes"],
      ["host.sync", "completed", { container: 4, image: 6, network: 5, volume: 4 }, null, "3 minutes"],
      ["compose.deploy", "completed", { projectName: "demo_web" }, null, "2 minutes"],
      ["image.pull", "failed", null, "Demo failure: registry tag not found", "1 minute"]
    ] as const) {
      await client.query(
        `INSERT INTO operation_jobs (id, type, status, host_id, payload, result, error, created_by, created_at, started_at, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - $9::interval, now() - $9::interval, now() - $9::interval, now() - $9::interval)`,
        [uuid(), type, status, hostId, { demo: true }, result, error, createdBy ?? null, createdOffset]
      );
    }

    await client.query(
      `INSERT INTO audit_events (id, user_id, host_id, action, target_kind, target_id, details)
       VALUES ($1, $2, $3, 'demo.seed', 'host', $4, $5)`,
      [uuid(), createdBy ?? null, hostId, hostId, { demo: true }]
    );

    const host = await client.query("SELECT * FROM docker_hosts WHERE id = $1", [hostId]);
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
