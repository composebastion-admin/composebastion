import { v4 as uuid } from "uuid";
import type { AppGithubVersionSelect, AppGithubVersions, AppRenameInput, AppSourceLink, AppSourceLinkInput, ComposeStack, DockerApp, DockerAppUpdate, GithubRepository, ImageUpdateCheck, ResourceSnapshot } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { shQuote } from "./commands.js";
import { isDemoHost } from "./demo.js";
import { extractImagesFromCompose } from "./composeImages.js";
import {
  checkGithubRepositoryUpdates,
  deployGithubRepository,
  fetchGithubCommitShaWithStoredCredentials,
  listGithubVersionsForRepository,
  listGithubVersionsForUrl,
  mapGithubRepository,
  parseGithubUrl
} from "./github.js";
import { checkImageUpdatesForHost, listImageUpdateChecks } from "./imageUpdates.js";
import { enqueueJob } from "./jobs.js";
import { mapResource, mapStack } from "./mappers.js";
import { getHostForWorker, listHostIds } from "./hosts.js";
import { runSshCommand } from "./ssh.js";

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function nullIfBlank(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readLabel(data: Record<string, unknown>, label: string) {
  const labels = data.Labels;
  if (typeof labels === "string") {
    const match = labels.split(",").find((item) => item.trim().startsWith(`${label}=`));
    return match?.split("=").slice(1).join("=") ?? null;
  }
  if (labels && typeof labels === "object") {
    const value = (labels as Record<string, unknown>)[label];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function stateLabel(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("running") || normalized === "up") return "running";
  if (normalized.includes("exit") || normalized.includes("stop") || normalized.includes("dead")) return "stopped";
  if (normalized.includes("created")) return "created";
  if (normalized.includes("restarting")) return "degraded";
  return normalized || "unknown";
}

function aggregateStatus(containers: ResourceSnapshot[], fallback: string) {
  if (containers.length === 0) return stateLabel(fallback);
  const states = containers.map((container) => stateLabel(String((container.data as any).State ?? "")));
  if (states.every((state) => state === "running")) return "running";
  if (states.some((state) => state === "running")) return "degraded";
  if (states.every((state) => state === "stopped" || state === "created")) return "stopped";
  return states[0] ?? "unknown";
}

function latestTimestamp(values: Array<string | null | undefined>) {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return new Date(Math.max(...timestamps, Date.now())).toISOString();
}

function projectNameFromAppName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "").slice(0, 48) || "app";
}

function gitRemoteLatestCommands() {
  return [
    "git fetch --quiet --tags origin",
    'latest=$(git rev-parse "origin/$branch" 2>/dev/null || git rev-list -n 1 "refs/tags/$branch" 2>/dev/null || true)',
    'test -n "$latest"'
  ];
}

type HostGitMetadata = {
  currentCommit: string;
  latestCommit: string;
  branch: string;
  repositoryUrl: string;
};

async function readHostGitMetadata(hostId: string, workingDir: string, branch?: string | null, fetchRemote = false) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return {
      currentCommit: "demo-current",
      latestCommit: "demo-current",
      branch: branch ?? "main",
      repositoryUrl: ""
    };
  }
  if (host.connectionMode !== "ssh") throw new Error("Git folder checks require SSH host mode");
  const branchAssignment = branch
    ? `branch=${shQuote(branch)}`
    : "branch=$(git rev-parse --abbrev-ref HEAD)";
  const remoteCheck = fetchRemote
    ? gitRemoteLatestCommands()
    : ['latest=$(git rev-parse "origin/$branch" 2>/dev/null || git rev-list -n 1 "refs/tags/$branch" 2>/dev/null || true)'];
  const command = [
    `cd ${shQuote(workingDir)}`,
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1",
    "current=$(git rev-parse HEAD)",
    branchAssignment,
    "remote=$(git remote get-url origin 2>/dev/null || true)",
    ...remoteCheck,
    `printf '{"currentCommit":"%s","latestCommit":"%s","branch":"%s","repositoryUrl":"%s"}' "$current" "$latest" "$branch" "$remote"`
  ].join(" && ");
  const result = await runSshCommand(host.ssh, command, { timeoutMs: fetchRemote ? 5 * 60_000 : 30_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Git update check failed");
  return JSON.parse(result.stdout.trim()) as HostGitMetadata;
}

async function latestCommitForGithubUrl(repositoryUrl: string | null | undefined, branch: string | null | undefined) {
  if (!repositoryUrl || !branch) return null;
  try {
    return await fetchGithubCommitShaWithStoredCredentials(repositoryUrl, branch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/GitHub repository URL|Invalid URL/.test(message)) return null;
    throw error;
  }
}

async function checkedHostGitMetadata(input: {
  hostId: string;
  workingDir: string;
  branch?: string | null;
  repositoryUrl?: string | null;
}) {
  let local: HostGitMetadata | null = null;
  let apiError: Error | null = null;
  try {
    local = await readHostGitMetadata(input.hostId, input.workingDir, input.branch, false);
    const latest = await latestCommitForGithubUrl(input.repositoryUrl || local.repositoryUrl, input.branch || local.branch);
    if (latest) {
      return {
        currentCommit: local.currentCommit,
        latestCommit: latest,
        branch: input.branch || local.branch,
        repositoryUrl: input.repositoryUrl || local.repositoryUrl
      };
    }
  } catch (error) {
    apiError = error instanceof Error ? error : new Error(String(error));
  }

  try {
    return await readHostGitMetadata(input.hostId, input.workingDir, input.branch, true);
  } catch (error) {
    if (apiError) throw apiError;
    throw error;
  }
}

function mapAppSourceLink(row: any): AppSourceLink {
  return {
    id: row.id,
    sourceType: row.source_type,
    name: row.name ?? null,
    repositoryUrl: row.repository_url ?? null,
    branch: row.branch ?? null,
    workingDir: row.working_dir ?? null,
    composePath: row.compose_path ?? null,
    imageReference: row.image_reference ?? null,
    currentCommitSha: row.current_commit_sha ?? null,
    latestCommitSha: row.latest_commit_sha ?? null,
    checkedAt: iso(row.checked_at),
    checkError: row.check_error ?? null,
    updatedAt: iso(row.updated_at)!
  };
}

function sameImageReference(a: string, b: string) {
  if (a === b) return true;
  const [aRepository] = a.split(":");
  const [bRepository] = b.split(":");
  return Boolean(aRepository && bRepository && aRepository === bRepository);
}

function imageUpdateFor(input: {
  hostId: string;
  imageReferences: string[];
  containerIds: string[];
  stackId?: string | null;
  updates: ImageUpdateCheck[];
}): DockerAppUpdate {
  const candidates = input.updates.filter((update) => {
    if (update.hostId !== input.hostId) return false;
    if (input.stackId && update.affectedStacks.some((stack) => stack.id === input.stackId)) return true;
    if (update.affectedContainers.some((container) => input.containerIds.includes(container.id))) return true;
    return input.imageReferences.some((image) => sameImageReference(image, update.imageReference));
  });

  const update = candidates.find((item) => item.status === "update_available") ??
    candidates.find((item) => item.status === "error") ??
    candidates.find((item) => item.status === "unknown") ??
    candidates.find((item) => item.status === "up_to_date") ??
    candidates[0];

  if (!update) return { status: "unknown", kind: "none", checkedAt: null };
  return {
    status: update.status,
    kind: "image",
    imageReference: update.imageReference,
    currentDigest: update.currentDigest,
    remoteDigest: update.remoteDigest,
    checkedAt: update.lastCheckedAt,
    riskNote: update.riskNote
  };
}

function shortSha(value?: string | null) {
  return value ? value.slice(0, 12) : null;
}

function gitUpdateFor(repo?: GithubRepository | null): DockerAppUpdate | null {
  if (!repo) return null;
  if (repo.updateCheckError) {
    return {
      status: "error",
      kind: "git",
      currentVersion: shortSha(repo.lastDeployedCommitSha),
      availableVersion: shortSha(repo.latestCommitSha),
      checkedAt: repo.updateCheckedAt ?? null,
      riskNote: repo.updateCheckError
    };
  }
  if (repo.latestCommitSha && repo.lastDeployedCommitSha) {
    return {
      status: repo.latestCommitSha === repo.lastDeployedCommitSha ? "up_to_date" : "update_available",
      kind: "git",
      currentVersion: shortSha(repo.lastDeployedCommitSha),
      availableVersion: shortSha(repo.latestCommitSha),
      checkedAt: repo.updateCheckedAt ?? null
    };
  }
  return {
    status: "unknown",
    kind: "git",
    currentVersion: shortSha(repo.lastDeployedCommitSha),
    availableVersion: shortSha(repo.latestCommitSha),
    checkedAt: repo.updateCheckedAt ?? null,
    riskNote: !repo.lastDeployedAt
      ? "Repository has not been deployed yet."
      : repo.latestCommitSha && !repo.lastDeployedCommitSha
        ? "The deployed commit is unknown. Redeploy once to start commit-based update tracking."
        : "Use Check updates to compare the deployed commit with the branch."
  };
}

function stackGitUpdateFor(stack: ComposeStack): DockerAppUpdate | null {
  if (stack.sourceType !== "git" && stack.sourceType !== "github") return null;
  if (stack.sourceCheckError) {
    return {
      status: "error",
      kind: "git",
      currentVersion: shortSha(stack.sourceCurrentCommitSha),
      availableVersion: shortSha(stack.sourceLatestCommitSha),
      checkedAt: stack.sourceCheckedAt ?? null,
      riskNote: stack.sourceCheckError
    };
  }
  if (stack.sourceLatestCommitSha && stack.sourceCurrentCommitSha) {
    return {
      status: stack.sourceLatestCommitSha === stack.sourceCurrentCommitSha ? "up_to_date" : "update_available",
      kind: "git",
      currentVersion: shortSha(stack.sourceCurrentCommitSha),
      availableVersion: shortSha(stack.sourceLatestCommitSha),
      checkedAt: stack.sourceCheckedAt ?? null
    };
  }
  return {
    status: "unknown",
    kind: "git",
    currentVersion: shortSha(stack.sourceCurrentCommitSha),
    availableVersion: shortSha(stack.sourceLatestCommitSha),
    checkedAt: stack.sourceCheckedAt ?? null,
    riskNote: stack.sourceType === "github"
      ? "GitHub update check has not completed yet."
      : "Git folder update check has not completed yet."
  };
}

function repositoryMatchesGithubUrl(repo: GithubRepository, repositoryUrl?: string | null) {
  if (!repositoryUrl) return false;
  try {
    const parsed = parseGithubUrl(repositoryUrl);
    return repo.owner === parsed.owner && repo.repo === parsed.repo;
  } catch {
    return false;
  }
}

function repositoryForStack(
  stack: ComposeStack,
  repositories: GithubRepository[],
  repoByHostProject: Map<string, GithubRepository>
) {
  const byHostProject = repoByHostProject.get(`${stack.hostId}:${stack.projectName}`);
  if (byHostProject) return byHostProject;
  const matches = repositories.filter((repo) => repositoryMatchesGithubUrl(repo, stack.sourceRepositoryUrl));
  return matches.find((repo) => repo.branch === stack.sourceBranch) ?? matches[0] ?? null;
}

function sourceLinkGitUpdateFor(link: AppSourceLink | null): DockerAppUpdate | null {
  if (!link || link.sourceType !== "git") return null;
  if (link.checkError) {
    return {
      status: "error",
      kind: "git",
      currentVersion: shortSha(link.currentCommitSha),
      availableVersion: shortSha(link.latestCommitSha),
      checkedAt: link.checkedAt,
      riskNote: link.checkError
    };
  }
  if (link.latestCommitSha && link.currentCommitSha) {
    return {
      status: link.latestCommitSha === link.currentCommitSha ? "up_to_date" : "update_available",
      kind: "git",
      currentVersion: shortSha(link.currentCommitSha),
      availableVersion: shortSha(link.latestCommitSha),
      checkedAt: link.checkedAt
    };
  }
  return {
    status: "unknown",
    kind: "git",
    currentVersion: shortSha(link.currentCommitSha),
    availableVersion: shortSha(link.latestCommitSha),
    checkedAt: link.checkedAt,
    riskNote: "Git source link has not been checked yet."
  };
}

function chooseUpdate(source: DockerApp["source"], gitUpdate: DockerAppUpdate | null, imageUpdate: DockerAppUpdate): DockerAppUpdate {
  if (source === "git" && gitUpdate?.status === "update_available") return gitUpdate;
  if (imageUpdate.status === "update_available") return imageUpdate;
  if (source === "git" && gitUpdate) return gitUpdate;
  return imageUpdate;
}

function containerImage(container: ResourceSnapshot) {
  return String((container.data as any).Image ?? container.name);
}

function containerPorts(container: ResourceSnapshot) {
  return String((container.data as any).Ports ?? "");
}

async function checkHostGitStackUpdates(hostId?: string) {
  const stacks = hostId
    ? await query<any>(
        `SELECT * FROM compose_stacks
         WHERE host_id = $1
           AND source_type = 'git'
           AND source_working_dir IS NOT NULL`,
        [hostId]
      )
    : await query<any>(
        `SELECT * FROM compose_stacks
         WHERE source_type = 'git'
           AND source_working_dir IS NOT NULL`
      );

  for (const stack of stacks.rows) {
    try {
      const metadata = await checkedHostGitMetadata({
        hostId: stack.host_id,
        workingDir: stack.source_working_dir,
        branch: stack.source_branch,
        repositoryUrl: stack.source_repository_url
      });
      await query(
        `UPDATE compose_stacks
         SET source_repository_url = COALESCE($2, source_repository_url),
             source_branch = COALESCE($3, source_branch),
             source_current_commit_sha = $4,
             source_latest_commit_sha = $5,
             source_checked_at = now(),
             source_check_error = null,
             updated_at = now()
         WHERE id = $1`,
        [
          stack.id,
          metadata.repositoryUrl || null,
          metadata.branch || null,
          metadata.currentCommit || null,
          metadata.latestCommit || null
        ]
      );
    } catch (error) {
      await query(
        `UPDATE compose_stacks
         SET source_checked_at = now(),
             source_check_error = $2,
             updated_at = now()
         WHERE id = $1`,
        [stack.id, error instanceof Error ? error.message : String(error)]
      );
    }
  }
}

async function checkGithubApiStackUpdates(hostId?: string) {
  const stacks = hostId
    ? await query<any>(
        `SELECT * FROM compose_stacks
         WHERE host_id = $1
           AND source_type = 'github'
           AND source_repository_url IS NOT NULL
           AND source_branch IS NOT NULL`,
        [hostId]
      )
    : await query<any>(
        `SELECT * FROM compose_stacks
         WHERE source_type = 'github'
           AND source_repository_url IS NOT NULL
           AND source_branch IS NOT NULL`
      );

  for (const stack of stacks.rows) {
    try {
      const latestCommit = await latestCommitForGithubUrl(stack.source_repository_url, stack.source_branch);
      if (!latestCommit) throw new Error("GitHub repository URL is required for GitHub update checks");
      await query(
        `UPDATE compose_stacks
         SET source_latest_commit_sha = $2,
             source_checked_at = now(),
             source_check_error = null,
             updated_at = now()
         WHERE id = $1`,
        [stack.id, latestCommit]
      );
    } catch (error) {
      await query(
        `UPDATE compose_stacks
         SET source_checked_at = now(),
             source_check_error = $2,
             updated_at = now()
         WHERE id = $1`,
        [stack.id, error instanceof Error ? error.message : String(error)]
      );
    }
  }
}

async function checkHostGitSourceLinkUpdates(hostId?: string) {
  const links = hostId
    ? await query<any>(
        `SELECT * FROM app_source_links
         WHERE host_id = $1
           AND source_type = 'git'
           AND working_dir IS NOT NULL`,
        [hostId]
      )
    : await query<any>(
        `SELECT * FROM app_source_links
         WHERE source_type = 'git'
           AND working_dir IS NOT NULL`
      );

  for (const link of links.rows) {
    try {
      const metadata = await checkedHostGitMetadata({
        hostId: link.host_id,
        workingDir: link.working_dir,
        branch: link.branch,
        repositoryUrl: link.repository_url
      });
      await query(
        `UPDATE app_source_links
         SET repository_url = COALESCE($2, repository_url),
             branch = COALESCE($3, branch),
             current_commit_sha = $4,
             latest_commit_sha = $5,
             checked_at = now(),
             check_error = null,
             updated_at = now()
         WHERE id = $1`,
        [
          link.id,
          metadata.repositoryUrl || null,
          metadata.branch || null,
          metadata.currentCommit || null,
          metadata.latestCommit || null
        ]
      );
    } catch (error) {
      await query(
        `UPDATE app_source_links
         SET checked_at = now(),
             check_error = $2,
             updated_at = now()
         WHERE id = $1`,
        [link.id, error instanceof Error ? error.message : String(error)]
      );
    }
  }
}

export async function listApps(hostId?: string): Promise<DockerApp[]> {
  const [hostRows, resourceRows, stackRows, repoRows, sourceLinkRows, updates] = await Promise.all([
    hostId
      ? query<any>("SELECT id, name, hostname FROM docker_hosts WHERE id = $1", [hostId])
      : query<any>("SELECT id, name, hostname FROM docker_hosts ORDER BY name ASC"),
    hostId
      ? query<any>("SELECT * FROM resource_snapshots WHERE host_id = $1 AND kind IN ('container', 'image') ORDER BY name ASC", [hostId])
      : query<any>("SELECT * FROM resource_snapshots WHERE kind IN ('container', 'image') ORDER BY host_id, name ASC"),
    hostId
      ? query<any>("SELECT * FROM compose_stacks WHERE host_id = $1 ORDER BY name ASC", [hostId])
      : query<any>("SELECT * FROM compose_stacks ORDER BY host_id, name ASC"),
    query<any>("SELECT * FROM github_repositories ORDER BY name ASC"),
    hostId
      ? query<any>("SELECT * FROM app_source_links WHERE host_id = $1 ORDER BY updated_at DESC", [hostId])
      : query<any>("SELECT * FROM app_source_links ORDER BY host_id, updated_at DESC"),
    listImageUpdateChecks(hostId)
  ]);

  const hostNames = new Map(hostRows.rows.map((host) => [host.id, host.name]));
  const hostHostnames = new Map(hostRows.rows.map((host) => [host.id, host.hostname ?? host.name]));
  const containers = resourceRows.rows.map(mapResource).filter((resource) => resource.kind === "container");
  const stacks = stackRows.rows.map(mapStack);
  const repositories = repoRows.rows.map(mapGithubRepository);
  const sourceLinkByContainer = new Map<string, AppSourceLink>(
    sourceLinkRows.rows.map((row): [string, AppSourceLink] => [`${row.host_id}:${row.container_external_id}`, mapAppSourceLink(row)])
  );
  const stackByHostProject = new Map(stacks.map((stack) => [`${stack.hostId}:${stack.projectName}`, stack]));
  const repoByHostProject = new Map(repositories.filter((repo) => repo.defaultHostId).map((repo) => [`${repo.defaultHostId}:${repo.projectName}`, repo]));
  const containersByStack = new Map<string, ResourceSnapshot[]>();
  const representedContainers = new Set<string>();

  for (const container of containers) {
    const data = container.data as Record<string, unknown>;
    const project = readLabel(data, "com.docker.compose.project");
    const stack = project ? stackByHostProject.get(`${container.hostId}:${project}`) : null;
    if (!stack) continue;
    representedContainers.add(container.id);
    containersByStack.set(stack.id, [...(containersByStack.get(stack.id) ?? []), container]);
  }

  const apps: DockerApp[] = [];
  for (const stack of stacks) {
    const repo = repositoryForStack(stack, repositories, repoByHostProject);
    const stackContainers = containersByStack.get(stack.id) ?? [];
    const imageReferences = Array.from(new Set([
      ...stackContainers.map(containerImage),
      ...extractImagesFromCompose(stack.composeYaml)
    ])).filter(Boolean);
    const containerIds = stackContainers.map((container) => container.externalId);
    const imageUpdate = imageUpdateFor({ hostId: stack.hostId, imageReferences, containerIds, stackId: stack.id, updates });
    const source = repo || stack.sourceType === "git" || stack.sourceType === "github" ? "git" : "compose";
    const stackUpdate = stackGitUpdateFor(stack);
    const gitUpdate = stackUpdate ?? (repo ? gitUpdateFor(repo) : null);
    apps.push({
      id: repo ? `git:${repo.id}` : `stack:${stack.id}`,
      hostId: stack.hostId,
      hostName: hostNames.get(stack.hostId) ?? "Unknown host",
      hostHostname: hostHostnames.get(stack.hostId) ?? "localhost",
      name: stack.name,
      source,
      status: aggregateStatus(stackContainers, stack.status),
      imageReferences,
      ports: Array.from(new Set(stackContainers.map(containerPorts).filter(Boolean))).join(", "),
      containerIds,
      primaryContainerId: containerIds[0] ?? null,
      stackId: stack.id,
      repositoryId: repo?.id ?? null,
      repositoryUrl: stack.sourceRepositoryUrl ?? repo?.repositoryUrl ?? null,
      branch: stack.sourceBranch ?? repo?.branch ?? null,
      projectName: stack.projectName,
      sourceLink: null,
      update: chooseUpdate(source, gitUpdate, imageUpdate),
      updatedAt: latestTimestamp([stack.updatedAt, ...stackContainers.map((container) => container.updatedAt), repo?.updatedAt])
    });
  }

  for (const container of containers.filter((item) => !representedContainers.has(item.id))) {
    const link = sourceLinkByContainer.get(`${container.hostId}:${container.externalId}`) ?? null;
    const imageReferences = [link?.imageReference ?? containerImage(container)].filter(Boolean);
    const containerIds = [container.externalId];
    const imageUpdate = imageUpdateFor({ hostId: container.hostId, imageReferences, containerIds, updates });
    const source = link?.sourceType ?? (imageReferences.length > 0 ? "image" : "unknown");
    const gitUpdate = sourceLinkGitUpdateFor(link);
    apps.push({
      id: `container:${container.id}`,
      hostId: container.hostId,
      hostName: hostNames.get(container.hostId) ?? "Unknown host",
      hostHostname: hostHostnames.get(container.hostId) ?? "localhost",
      name: link?.name ?? String((container.data as any).Names ?? container.name),
      source,
      status: aggregateStatus([container], "unknown"),
      imageReferences,
      ports: containerPorts(container),
      containerIds,
      primaryContainerId: container.externalId,
      stackId: null,
      repositoryId: null,
      repositoryUrl: link?.repositoryUrl ?? null,
      branch: link?.branch ?? null,
      projectName: null,
      sourceLink: link,
      update: chooseUpdate(source, gitUpdate, imageUpdate),
      updatedAt: container.updatedAt
    });
  }

  const representedRepos = new Set(apps.map((app) => app.repositoryId).filter(Boolean));
  for (const repo of repositories.filter((item) => item.defaultHostId && !representedRepos.has(item.id))) {
    const gitUpdate = gitUpdateFor(repo);
    apps.push({
      id: `git:${repo.id}`,
      hostId: repo.defaultHostId!,
      hostName: hostNames.get(repo.defaultHostId!) ?? "Unknown host",
      hostHostname: hostHostnames.get(repo.defaultHostId!) ?? "localhost",
      name: repo.name,
      source: "git",
      status: "not deployed",
      imageReferences: [],
      ports: "",
      containerIds: [],
      primaryContainerId: null,
      stackId: null,
      repositoryId: repo.id,
      repositoryUrl: repo.repositoryUrl,
      branch: repo.branch,
      projectName: repo.projectName,
      sourceLink: null,
      update: gitUpdate ?? { status: "unknown", kind: "git", checkedAt: null },
      updatedAt: repo.updatedAt
    });
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

export async function checkAppUpdates(hostId?: string) {
  const hostIds = hostId ? [hostId] : await listHostIds();
  await Promise.allSettled(hostIds.map((id) => checkImageUpdatesForHost(id)));
  await Promise.allSettled([
    checkGithubRepositoryUpdates(),
    checkGithubApiStackUpdates(hostId),
    checkHostGitStackUpdates(hostId),
    checkHostGitSourceLinkUpdates(hostId)
  ]);
  return listApps(hostId);
}

async function findApp(appId: string) {
  const app = (await listApps()).find((item) => item.id === appId);
  if (!app) throw new Error("App not found");
  return app;
}

async function currentGitCommitForApp(app: DockerApp) {
  if (app.stackId) {
    const result = await query<{ source_current_commit_sha: string | null }>(
      "SELECT source_current_commit_sha FROM compose_stacks WHERE id = $1 AND host_id = $2",
      [app.stackId, app.hostId]
    );
    const current = result.rows[0]?.source_current_commit_sha;
    if (current) return current;
  }
  if (app.repositoryId) {
    const result = await query<{ last_deployed_commit_sha: string | null }>(
      "SELECT last_deployed_commit_sha FROM github_repositories WHERE id = $1",
      [app.repositoryId]
    );
    return result.rows[0]?.last_deployed_commit_sha ?? (app.update.kind === "git" ? app.update.currentVersion ?? null : null);
  }
  if (app.sourceLink?.currentCommitSha) return app.sourceLink.currentCommitSha;
  return app.update.kind === "git" ? app.update.currentVersion ?? null : null;
}

export async function listAppGithubVersions(appId: string): Promise<AppGithubVersions> {
  const app = await findApp(appId);
  if (app.source !== "git") throw new Error("Only Git-backed services can load GitHub versions");
  const currentCommitSha = await currentGitCommitForApp(app);
  const selectedRef = app.branch ?? null;

  if (app.repositoryId) {
    return listGithubVersionsForRepository(app.repositoryId, { selectedRef, currentCommitSha });
  }
  if (!app.repositoryUrl) throw new Error("Add a GitHub repository URL before loading versions");
  return listGithubVersionsForUrl(app.repositoryUrl, undefined, { selectedRef, currentCommitSha });
}

export async function selectAppGithubVersion(appId: string, input: AppGithubVersionSelect) {
  const app = await findApp(appId);
  if (app.source !== "git") throw new Error("Only Git-backed services can select a GitHub version");
  const ref = input.ref.trim();
  let updated = false;

  if (app.repositoryId) {
    await query(
      `UPDATE github_repositories
       SET branch = $2,
           latest_commit_sha = null,
           update_checked_at = null,
           update_check_error = null,
           updated_at = now()
       WHERE id = $1`,
      [app.repositoryId, ref]
    );
    updated = true;
  }
  if (app.sourceLink?.id) {
    await query(
      `UPDATE app_source_links
       SET branch = $2,
           latest_commit_sha = null,
           checked_at = null,
           check_error = null,
           updated_at = now()
       WHERE id = $1`,
      [app.sourceLink.id, ref]
    );
    updated = true;
  }
  if (app.stackId) {
    await query(
      `UPDATE compose_stacks
       SET source_branch = $3,
           source_latest_commit_sha = null,
           source_checked_at = null,
           source_check_error = null,
           updated_at = now()
       WHERE id = $1 AND host_id = $2`,
      [app.stackId, app.hostId, ref]
    );
    updated = true;
  }
  if (!updated) {
    throw new Error("This service does not have a selectable Git source yet");
  }

  return { app: (await listApps()).find((item) => item.id === appId) ?? null };
}

async function findLinkableApp(appId: string) {
  const app = await findApp(appId);
  if (!app.id.startsWith("container:") || !app.primaryContainerId) {
    throw new Error("Only standalone container apps can be manually linked to a source");
  }
  return app;
}

export async function upsertAppSourceLink(appId: string, input: AppSourceLinkInput) {
  const app = await findLinkableApp(appId);
  const saved = await query<any>(
    `INSERT INTO app_source_links (
       id, host_id, container_external_id, source_type, name, repository_url, branch,
       working_dir, compose_path, image_reference, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (host_id, container_external_id)
     DO UPDATE SET
       source_type = EXCLUDED.source_type,
       name = EXCLUDED.name,
       repository_url = EXCLUDED.repository_url,
       branch = EXCLUDED.branch,
       working_dir = EXCLUDED.working_dir,
       compose_path = EXCLUDED.compose_path,
       image_reference = EXCLUDED.image_reference,
       current_commit_sha = null,
       latest_commit_sha = null,
       checked_at = null,
       check_error = null,
       updated_at = now()
     RETURNING *`,
    [
      uuid(),
      app.hostId,
      app.primaryContainerId,
      input.sourceType,
      nullIfBlank(input.name),
      nullIfBlank(input.repositoryUrl),
      nullIfBlank(input.branch),
      nullIfBlank(input.workingDir),
      nullIfBlank(input.composePath),
      nullIfBlank(input.imageReference)
    ]
  );
  return mapAppSourceLink(saved.rows[0]);
}

export async function deleteAppSourceLink(appId: string) {
  const app = await findLinkableApp(appId);
  await query(
    `DELETE FROM app_source_links
     WHERE host_id = $1 AND container_external_id = $2`,
    [app.hostId, app.primaryContainerId]
  );
  return { ok: true };
}

export async function renameApp(appId: string, input: AppRenameInput) {
  const app = await findApp(appId);
  const name = input.name.trim();
  let updated = false;

  if (app.stackId) {
    await query(
      `UPDATE compose_stacks
       SET name = $3,
           updated_at = now()
       WHERE id = $1 AND host_id = $2`,
      [app.stackId, app.hostId, name]
    );
    updated = true;
  }

  if (app.repositoryId) {
    await query(
      `UPDATE github_repositories
       SET name = $2,
           updated_at = now()
       WHERE id = $1`,
      [app.repositoryId, name]
    );
    updated = true;
  }

  if (app.sourceLink?.id) {
    await query(
      `UPDATE app_source_links
       SET name = $2,
           updated_at = now()
       WHERE id = $1`,
      [app.sourceLink.id, name]
    );
    updated = true;
  } else if (!app.stackId && !app.repositoryId && app.primaryContainerId) {
    await query(
      `INSERT INTO app_source_links (
         id, host_id, container_external_id, source_type, name, image_reference, updated_at
       )
       VALUES ($1, $2, $3, 'image', $4, $5, now())
       ON CONFLICT (host_id, container_external_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         updated_at = now()`,
      [uuid(), app.hostId, app.primaryContainerId, name, app.imageReferences[0] ?? null]
    );
    updated = true;
  }

  if (!updated) throw new Error("This service cannot be renamed yet");
  return { app: (await listApps(app.hostId)).find((item) => item.id === appId) ?? null };
}

export async function updateApp(appId: string, createdBy?: string | null) {
  const app = await findApp(appId);

  if (app.source === "git" && app.repositoryId) {
    return deployGithubRepository(app.repositoryId, { hostId: app.hostId, branch: app.branch ?? undefined }, createdBy);
  }

  if ((app.source === "git" || app.source === "compose") && app.sourceLink?.workingDir && app.sourceLink.composePath) {
    const jobs = [];
    if (app.source === "git") {
      jobs.push(await enqueueJob({
        type: "git.pull",
        hostId: app.hostId,
        payload: { directory: app.sourceLink.workingDir, ...(app.sourceLink.branch ? { branch: app.sourceLink.branch } : {}) }
      }, createdBy));
    }
    jobs.push(await enqueueJob({
      type: "compose.deployPath",
      hostId: app.hostId,
      payload: {
        projectName: app.projectName ?? projectNameFromAppName(app.sourceLink.name ?? app.name),
        workingDir: app.sourceLink.workingDir,
        composePath: app.sourceLink.composePath
      }
    }, createdBy));
    return { jobs };
  }

  if (app.stackId) {
    const stackResult = await query<any>("SELECT * FROM compose_stacks WHERE id = $1 AND host_id = $2", [app.stackId, app.hostId]);
    const stack = stackResult.rows[0];
    if (!stack) throw new Error("Compose stack not found");

    if (app.source === "git" && stack.source_working_dir && stack.source_compose_path) {
      const jobs = [];
      jobs.push(await enqueueJob({
        type: "git.pull",
        hostId: app.hostId,
        payload: { directory: stack.source_working_dir, ...(stack.source_branch ? { branch: stack.source_branch } : {}) }
      }, createdBy));
      jobs.push(await enqueueJob({
        type: "compose.deployPath",
        hostId: app.hostId,
        payload: {
          projectName: stack.project_name,
          workingDir: stack.source_working_dir,
          composePath: stack.source_compose_path
        }
      }, createdBy));
      return { jobs };
    }

    const jobs = [];
    if (app.update.kind === "image" && app.update.imageReference) {
      jobs.push(await enqueueJob({ type: "image.pull", hostId: app.hostId, payload: { image: app.update.imageReference } }, createdBy));
    }
    jobs.push(await enqueueJob({ type: "compose.deploy", hostId: app.hostId, payload: { stackId: app.stackId } }, createdBy));
    return { jobs };
  }

  if (app.primaryContainerId) {
    const targetImage = app.update.kind === "image" && app.update.imageReference
      ? app.update.imageReference
      : app.imageReferences[0];
    const job = await enqueueJob({
      type: "container.update",
      hostId: app.hostId,
      payload: { containerId: app.primaryContainerId, ...(targetImage ? { targetImage } : {}) }
    }, createdBy);
    return { job };
  }

  throw new Error("This app does not have an update action yet");
}
