import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type { PoolClient } from "pg";
import {
  canonicalizeGithubRepositoryUrl,
  canonicalizeGitRepositoryUrl,
  gitRepositoryUrlIssue,
  githubRepositoryAccessCheckSchema,
  githubRepositoryCreateSchema,
  githubRepositoryUpdateSchema,
  sanitizeGithubRepositoryUrl,
  sanitizeGitRepositoryUrl,
  sanitizeUrlDiagnosticText,
  type AppGithubVersionOption,
  type AppGithubVersions,
  type GithubRepository
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { isDemoHostId } from "./demo.js";
import {
  enqueueJobInTransaction,
  lockComposeStackForMutation,
  lockGithubRepositoryForMutation,
  notifyJobQueued
} from "./jobs.js";
import { mapStack } from "./mappers.js";
import { recordStackVersionInTransaction } from "./stackVersions.js";
import { inspectGitComposeSourceIntegrity } from "./gitComposeIntegrity.js";
import {
  deploymentEnvironmentBinding,
  parseDeploymentEnvironment,
  serializeDeploymentEnvironment
} from "./deploymentEnvironment.js";
import { normalizeRemotePath } from "./files.js";

const GITHUB_PAGE_SIZE = 100;
const MAX_GITHUB_VERSION_PAGES = 20;
const EXACT_GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const repositoryDeploymentInputColumns = [
  "name",
  "repository_url",
  "owner",
  "repo",
  "branch",
  "compose_path",
  "project_name",
  "env",
  "default_host_id",
  "host_clone_url",
  "host_clone_directory"
] as const;

function sameRepositoryDeploymentInputs(
  expected: Record<string, unknown>,
  current: Record<string, unknown>
) {
  return repositoryDeploymentInputColumns.every((column) =>
    (expected[column] ?? null) === (current[column] ?? null)
  );
}

type GithubBranchResponse = {
  name?: string;
  commit?: { sha?: string };
};

type GithubTagResponse = {
  name?: string;
  commit?: { sha?: string };
};

type GithubReleaseResponse = {
  tag_name?: string;
  name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  html_url?: string | null;
};

type GithubRepositoryAccessInput = {
  repositoryUrl: string;
  branch: string;
  composePath: string;
  githubToken?: string;
};

type GithubRepositoryAccessResult = {
  ok: boolean;
  checkedAt: string;
  repositoryPrivate: boolean | null;
  error: string | null;
};

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function normalizeProjectName(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80);
  return normalized || "github-stack";
}

function nullIfBlank(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function exactGithubCommitSha(value: unknown) {
  const commitSha = typeof value === "string"
    ? value.trim().toLowerCase()
    : "";
  if (!EXACT_GIT_COMMIT.test(commitSha)) {
    throw new Error(
      "GitHub did not resolve the selected ref to an exact commit. Retry after verifying the repository and branch."
    );
  }
  return commitSha;
}

function composeSha256(composeYaml: string) {
  return createHash("sha256")
    .update(composeYaml, "utf8")
    .digest("hex");
}

function defaultHostCloneUrl(owner: string, repo: string) {
  return `git@github.com:${owner}/${repo}.git`;
}

function defaultHostCloneUrlForRepositoryUrl(repositoryUrl: string | null) {
  if (!repositoryUrl) return null;
  const [owner, repo] = new URL(repositoryUrl).pathname.replace(/^\/|\/$/g, "").split("/");
  return owner && repo ? defaultHostCloneUrl(owner, repo) : null;
}

function githubRepoParts(owner: string | undefined, repo: string | undefined) {
  const normalizedOwner = owner?.trim();
  const normalizedRepo = repo?.trim().replace(/\.git$/i, "");
  if (!normalizedOwner || !normalizedRepo) {
    throw new Error("Use a GitHub repository URL like https://github.com/owner/repo");
  }
  return { owner: normalizedOwner.toLowerCase(), repo: normalizedRepo.toLowerCase() };
}

export function parseGithubUrl(repositoryUrl: string) {
  const trimmed = repositoryUrl.trim();
  const scpMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
  if (scpMatch && !gitRepositoryUrlIssue(trimmed)) {
    return githubRepoParts(scpMatch[1], scpMatch[2]);
  }
  if (/^ssh:\/\//i.test(trimmed) && !gitRepositoryUrlIssue(trimmed)) {
    const sshUrl = new URL(trimmed);
    const sshPath = sshUrl.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "");
    const [sshOwner, sshRepo] = sshPath.split("/");
    if (
      sshUrl.hostname.toLowerCase().replace(/^www\./, "") === "github.com"
      && sshPath.split("/").filter(Boolean).length === 2
    ) {
      return githubRepoParts(sshOwner, sshRepo);
    }
  }

  const url = new URL(canonicalizeGithubRepositoryUrl(trimmed));
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "");
  const [owner, repo] = path.split("/");
  if (hostname !== "github.com") {
    throw new Error("Use a GitHub repository URL like https://github.com/owner/repo");
  }
  return githubRepoParts(owner, repo);
}

function githubHeaders(token?: string | null) {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "ComposeBastion"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function githubPrivateRepoHint(message: string) {
  if (!/GitHub returned (401|403|404)/.test(message)) return message;
  return `${message}. For private GitHub repositories, use a fine-grained personal access token scoped to this repository with read-only Contents access. Organization-owned repositories may also require token approval.`;
}

function githubTokenForRow(row: any) {
  return row.github_token_encrypted ? decryptSecret(row.github_token_encrypted) : null;
}

async function fetchGithubJson<T>(url: string | URL, token: string | null | undefined, label: string) {
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} while ${label}`);
  return response.json() as Promise<T>;
}

function githubTokenStatus(row: any): "none" | "unchecked" | "valid" | "error" {
  if (!row.github_token_encrypted) return "none";
  if (row.github_token_check_error) return "error";
  if (row.github_token_checked_at) return "valid";
  return "unchecked";
}

async function storedGithubRepositoryCredential(owner: string, repo: string, ref?: string | null) {
  const result = await query<any>(
    `SELECT * FROM github_repositories
     WHERE owner = $1 AND repo = $2
     ORDER BY CASE WHEN branch = $3 THEN 0 ELSE 1 END,
              github_token_encrypted IS NULL,
              updated_at DESC
     LIMIT 1`,
    [owner, repo, ref ?? null]
  );
  const row = result.rows[0] ?? null;
  return {
    row,
    token: row ? githubTokenForRow(row) : null
  };
}

function shaMatches(left?: string | null, right?: string | null) {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function githubVersionOption(input: {
  kind: AppGithubVersionOption["kind"];
  name: string;
  ref: string;
  label?: string;
  commitSha?: string | null;
  publishedAt?: string | null;
  htmlUrl?: string | null;
  selectedRef?: string | null;
  currentCommitSha?: string | null;
}): AppGithubVersionOption {
  const selected = Boolean(input.selectedRef && (input.selectedRef === input.ref || input.selectedRef === input.name));
  const deployed = shaMatches(input.commitSha, input.currentCommitSha);
  return {
    kind: input.kind,
    name: input.name,
    ref: input.ref,
    label: input.label ?? input.name,
    commitSha: input.commitSha ?? null,
    publishedAt: input.publishedAt ?? null,
    htmlUrl: input.htmlUrl ?? null,
    selected,
    deployed,
    updateAvailable: Boolean(input.currentCommitSha && input.commitSha && !deployed)
  };
}

async function fetchGithubPages<T>(owner: string, repo: string, endpoint: string, token: string | null | undefined, label: string) {
  const items: T[] = [];
  for (let page = 1; page <= MAX_GITHUB_VERSION_PAGES; page += 1) {
    const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${endpoint}`);
    url.searchParams.set("per_page", String(GITHUB_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} while listing ${label}`);
    const body = await response.json() as T[];
    if (!Array.isArray(body)) throw new Error(`GitHub response for ${label} was not a list`);
    items.push(...body);
    if (body.length < GITHUB_PAGE_SIZE) break;
  }
  return items;
}

async function listGithubVersionOptions(
  owner: string,
  repo: string,
  repositoryUrl: string,
  token: string | null | undefined,
  context: { selectedRef?: string | null; currentCommitSha?: string | null } = {}
): Promise<AppGithubVersions> {
  const [branches, tags, releases] = await Promise.all([
    fetchGithubPages<GithubBranchResponse>(owner, repo, "branches", token, "branches"),
    fetchGithubPages<GithubTagResponse>(owner, repo, "tags", token, "tags"),
    fetchGithubPages<GithubReleaseResponse>(owner, repo, "releases", token, "releases")
  ]);

  const tagCommits = new Map<string, string | null>();
  const options: AppGithubVersionOption[] = [];

  for (const branch of branches) {
    if (!branch.name) continue;
    options.push(githubVersionOption({
      kind: "branch",
      name: branch.name,
      ref: branch.name,
      commitSha: branch.commit?.sha ?? null,
      selectedRef: context.selectedRef,
      currentCommitSha: context.currentCommitSha
    }));
  }

  for (const tag of tags) {
    if (!tag.name) continue;
    const commitSha = tag.commit?.sha ?? null;
    tagCommits.set(tag.name, commitSha);
    options.push(githubVersionOption({
      kind: "tag",
      name: tag.name,
      ref: tag.name,
      commitSha,
      selectedRef: context.selectedRef,
      currentCommitSha: context.currentCommitSha
    }));
  }

  for (const release of releases.filter((item) => !item.draft)) {
    if (!release.tag_name) continue;
    const labelSuffix = release.prerelease ? " (pre-release)" : "";
    options.push(githubVersionOption({
      kind: "release",
      name: release.name?.trim() || release.tag_name,
      ref: release.tag_name,
      label: `${release.name?.trim() || release.tag_name}${labelSuffix}`,
      commitSha: tagCommits.get(release.tag_name) ?? null,
      publishedAt: release.published_at ?? null,
      htmlUrl: release.html_url ?? null,
      selectedRef: context.selectedRef,
      currentCommitSha: context.currentCommitSha
    }));
  }

  return {
    repositoryUrl,
    selectedRef: context.selectedRef ?? null,
    currentCommitSha: context.currentCommitSha ?? null,
    options
  };
}

export function mapGithubRepository(row: any) {
  const hasGithubToken = Boolean(row.github_token_encrypted);
  const repositoryUrl = sanitizeGithubRepositoryUrl(row.repository_url, {
    owner: row.owner,
    repo: row.repo
  });
  const hostCloneUrl = sanitizeGitRepositoryUrl(row.host_clone_url)
    ?? defaultHostCloneUrlForRepositoryUrl(repositoryUrl);
  return {
    id: row.id,
    name: row.name,
    repositoryUrl: repositoryUrl ?? "",
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    composePath: row.compose_path,
    projectName: row.project_name,
    env: row.env ?? "",
    defaultHostId: row.default_host_id,
    hostCloneUrl,
    hostCloneDirectory: row.host_clone_directory ?? null,
    lastDeployedAt: iso(row.last_deployed_at),
    lastDeployedCommitSha: row.last_deployed_commit_sha ?? null,
    latestCommitSha: row.latest_commit_sha ?? null,
    updateCheckedAt: iso(row.update_checked_at),
    updateCheckError: sanitizeUrlDiagnosticText(row.update_check_error) as string | null,
    hasGithubToken,
    githubTokenStatus: githubTokenStatus(row),
    githubTokenCheckedAt: iso(row.github_token_checked_at),
    githubTokenCheckError: sanitizeUrlDiagnosticText(row.github_token_check_error) as string | null,
    lastError: sanitizeUrlDiagnosticText(row.last_error) as string | null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export async function listGithubRepositories() {
  const result = await query("SELECT * FROM github_repositories ORDER BY name ASC");
  return result.rows.map(mapGithubRepository);
}

export async function getGithubRepositoryForConfig() {
  const result = await query("SELECT * FROM github_repositories ORDER BY name ASC");
  return result.rows;
}

function githubContentsPath(composePath: string) {
  return composePath
    .split("/")
    .map((part: string) => encodeURIComponent(part))
    .join("/");
}

async function fetchComposeFileByParts(owner: string, repo: string, composePath: string, ref: string, token?: string | null) {
  const path = githubContentsPath(composePath);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const body = await fetchGithubJson<{ content?: string; encoding?: string }>(url, token, `fetching ${composePath}`);
  if (body.encoding !== "base64" || !body.content) {
    throw new Error("GitHub response did not include a base64 file body");
  }
  return Buffer.from(body.content.replace(/\s/g, ""), "base64").toString("utf8");
}

async function checkGithubRepositoryAccess(input: GithubRepositoryAccessInput): Promise<GithubRepositoryAccessResult> {
  const { owner, repo } = parseGithubUrl(input.repositoryUrl);
  const token = input.githubToken?.trim() || null;
  const checkedAt = new Date().toISOString();
  try {
    const repository = await fetchGithubJson<{ private?: boolean }>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      token,
      `checking ${owner}/${repo}`
    );
    const branchesUrl = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
    branchesUrl.searchParams.set("per_page", "1");
    const tagsUrl = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags`);
    tagsUrl.searchParams.set("per_page", "1");
    const releasesUrl = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`);
    releasesUrl.searchParams.set("per_page", "1");
    await Promise.all([
      fetchGithubCommitSha(owner, repo, input.branch, token),
      fetchComposeFileByParts(owner, repo, input.composePath, input.branch, token),
      fetchGithubJson<unknown[]>(branchesUrl, token, "listing branches"),
      fetchGithubJson<unknown[]>(tagsUrl, token, "listing tags"),
      fetchGithubJson<unknown[]>(releasesUrl, token, "listing releases")
    ]);
    return {
      ok: true,
      checkedAt,
      repositoryPrivate: typeof repository.private === "boolean" ? repository.private : null,
      error: null
    };
  } catch (error) {
    const message = githubPrivateRepoHint(error instanceof Error ? error.message : String(error));
    throw new Error(message);
  }
}

async function accessResultFromError(error: unknown): Promise<GithubRepositoryAccessResult> {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    repositoryPrivate: null,
    error: githubPrivateRepoHint(error instanceof Error ? error.message : String(error))
  };
}

export async function testGithubRepositoryAccess(input: unknown) {
  const body = githubRepositoryAccessCheckSchema.parse(input);
  try {
    return await checkGithubRepositoryAccess(body);
  } catch (error) {
    return accessResultFromError(error);
  }
}

async function requireValidGithubRepositoryAccess(input: GithubRepositoryAccessInput) {
  return checkGithubRepositoryAccess(input);
}

export async function testGithubRepositoryStoredAccess(
  id: string,
  onChanged?: (
    client: PoolClient,
    result: {
      repository: GithubRepository;
      access: GithubRepositoryAccessResult;
    }
  ) => Promise<void>,
  beforeAccess?: (repositoryId: string) => Promise<void>
) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) return null;
  // The callback must complete before decrypting the stored token or making a
  // GitHub request so an unavailable audit store fails closed.
  await beforeAccess?.(id);
  let access: GithubRepositoryAccessResult;
  try {
    const repositoryUrl = sanitizeGithubRepositoryUrl(row.repository_url, {
      owner: row.owner,
      repo: row.repo
    });
    if (!repositoryUrl) throw new Error("Stored GitHub repository URL is invalid");
    access = await checkGithubRepositoryAccess({
      repositoryUrl,
      branch: row.branch,
      composePath: row.compose_path,
      githubToken: githubTokenForRow(row) ?? undefined
    });
  } catch (error) {
    access = await accessResultFromError(error);
  }
  return withTransaction(async (client) => {
    const updated = await client.query<any>(
      `UPDATE github_repositories
       SET github_token_checked_at = now(),
           github_token_check_error = $2,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, access.ok ? null : access.error]
    );
    if (!updated.rows[0]) return null;
    const changed = { repository: mapGithubRepository(updated.rows[0]), access };
    await onChanged?.(client, changed);
    return changed;
  });
}

export async function createGithubRepository(
  input: unknown,
  onChanged?: (
    client: PoolClient,
    repository: GithubRepository
  ) => Promise<void>
) {
  const body = githubRepositoryCreateSchema.parse(input);
  const repositoryUrl = canonicalizeGithubRepositoryUrl(body.repositoryUrl);
  const { owner, repo } = parseGithubUrl(repositoryUrl);
  const projectName = body.projectName ?? normalizeProjectName(repo);
  const githubToken = body.githubToken?.trim() || null;
  const hostCloneUrl = body.hostCloneUrl
    ? canonicalizeGitRepositoryUrl(body.hostCloneUrl)
    : null;
  const hostCloneDirectory = nullIfBlank(body.hostCloneDirectory);
  if (githubToken) {
    await requireValidGithubRepositoryAccess({
      repositoryUrl,
      branch: body.branch,
      composePath: body.composePath,
      githubToken
    });
  }
  const result = await withTransaction(async (client) => {
    const identityKey = `github-repository:${owner}/${repo}:${body.branch}:${body.composePath}`;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [identityKey]
    );
    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM github_repositories
       WHERE owner = $1 AND repo = $2 AND branch = $3 AND compose_path = $4`,
      [owner, repo, body.branch, body.composePath]
    );
    if (existing.rows[0]) {
      await lockGithubRepositoryForMutation(client, existing.rows[0].id);
    }
    const saved = await client.query(
      `INSERT INTO github_repositories
        (id, name, repository_url, owner, repo, branch, compose_path, project_name, env, default_host_id,
         host_clone_url, host_clone_directory, github_token_encrypted, github_token_updated_at, github_token_checked_at, github_token_check_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               CASE WHEN $13::text IS NULL THEN null ELSE now() END,
               CASE WHEN $13::text IS NULL THEN null ELSE now() END,
               null)
       ON CONFLICT (owner, repo, branch, compose_path)
       DO UPDATE SET name = EXCLUDED.name,
                     repository_url = EXCLUDED.repository_url,
                     project_name = EXCLUDED.project_name,
                     env = EXCLUDED.env,
                     default_host_id = EXCLUDED.default_host_id,
                     host_clone_url = EXCLUDED.host_clone_url,
                     host_clone_directory = EXCLUDED.host_clone_directory,
                     github_token_encrypted = COALESCE(EXCLUDED.github_token_encrypted, github_repositories.github_token_encrypted),
                     github_token_updated_at = CASE WHEN EXCLUDED.github_token_encrypted IS NULL THEN github_repositories.github_token_updated_at ELSE now() END,
                     github_token_checked_at = CASE WHEN EXCLUDED.github_token_encrypted IS NULL THEN github_repositories.github_token_checked_at ELSE now() END,
                     github_token_check_error = CASE WHEN EXCLUDED.github_token_encrypted IS NULL THEN github_repositories.github_token_check_error ELSE null END,
                     updated_at = now()
       RETURNING *`,
      [
        uuid(),
        body.name,
        repositoryUrl,
        owner,
        repo,
        body.branch,
        body.composePath,
        projectName,
        body.env,
        body.defaultHostId ?? null,
        hostCloneUrl,
        hostCloneDirectory,
        githubToken ? encryptSecret(githubToken) : null
      ]
    );
    const repository = mapGithubRepository(saved.rows[0]);
    await onChanged?.(client, repository);
    return repository;
  });
  return result;
}

export async function updateGithubRepository(
  id: string,
  input: unknown,
  onChanged?: (
    client: PoolClient,
    repository: GithubRepository
  ) => Promise<void>
) {
  const body = githubRepositoryUpdateSchema.parse(input);
  const current = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = current.rows[0];
  if (!row) return null;
  const repositoryUrl = body.repositoryUrl
    ? canonicalizeGithubRepositoryUrl(body.repositoryUrl)
    : sanitizeGithubRepositoryUrl(row.repository_url, { owner: row.owner, repo: row.repo });
  if (!repositoryUrl) throw Object.assign(new Error("Stored GitHub repository URL is invalid"), { statusCode: 400 });
  const parsed = parseGithubUrl(repositoryUrl);
  const nextBranch = body.branch ?? row.branch;
  const nextComposePath = body.composePath ?? row.compose_path;
  const githubToken = body.githubToken?.trim() || null;
  const clearGithubToken = Boolean(body.clearGithubToken);
  const existingToken = clearGithubToken ? null : githubTokenForRow(row);
  const tokenForValidation = githubToken ?? existingToken;
  const changedAccessTarget = Boolean(body.repositoryUrl || body.branch || body.composePath);
  const hostCloneUrl = body.hostCloneUrl === undefined
    ? sanitizeGitRepositoryUrl(row.host_clone_url) ?? defaultHostCloneUrl(parsed.owner, parsed.repo)
    : body.hostCloneUrl
      ? canonicalizeGitRepositoryUrl(body.hostCloneUrl)
      : null;
  const hostCloneDirectory = body.hostCloneDirectory === undefined ? row.host_clone_directory : nullIfBlank(body.hostCloneDirectory);
  if (!clearGithubToken && tokenForValidation && (githubToken || changedAccessTarget)) {
    await requireValidGithubRepositoryAccess({
      repositoryUrl,
      branch: nextBranch,
      composePath: nextComposePath,
      githubToken: tokenForValidation
    });
  }
  const result = await withTransaction(async (client) => {
    const locked = await lockGithubRepositoryForMutation<any>(client, id);
    if (!locked) return { rows: [] };
    if (!sameRepositoryDeploymentInputs(row, locked)) {
      throw Object.assign(
        new Error("GitHub repository changed while the update was being validated. Retry with the latest settings."),
        { statusCode: 409 }
      );
    }
    const updated = await client.query(
      `UPDATE github_repositories
       SET name = $2,
           repository_url = $3,
           owner = $4,
           repo = $5,
           branch = $6,
           compose_path = $7,
           project_name = $8,
           env = $9,
           default_host_id = $10,
           host_clone_url = $11,
           host_clone_directory = $12,
           github_token_encrypted = CASE WHEN $14::boolean THEN null ELSE COALESCE($13, github_token_encrypted) END,
           github_token_updated_at = CASE
             WHEN $14::boolean THEN null
             WHEN $13::text IS NULL THEN github_token_updated_at
             ELSE now()
           END,
           github_token_checked_at = CASE
             WHEN $14::boolean THEN null
             WHEN $13::text IS NOT NULL OR ($15::boolean AND github_token_encrypted IS NOT NULL) THEN now()
             ELSE github_token_checked_at
           END,
           github_token_check_error = CASE
             WHEN $14::boolean THEN null
             WHEN $13::text IS NOT NULL OR ($15::boolean AND github_token_encrypted IS NOT NULL) THEN null
             ELSE github_token_check_error
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        body.name ?? row.name,
        repositoryUrl,
        parsed.owner,
        parsed.repo,
        nextBranch,
        nextComposePath,
        body.projectName ?? row.project_name,
        body.env ?? row.env,
        body.defaultHostId ?? row.default_host_id,
        hostCloneUrl,
        hostCloneDirectory,
        githubToken ? encryptSecret(githubToken) : null,
        clearGithubToken,
        changedAccessTarget
      ]
    );
    if (!updated.rows[0]) return null;
    const repository = mapGithubRepository(updated.rows[0]);
    await onChanged?.(client, repository);
    return repository;
  });
  return result;
}

export async function deleteGithubRepository(
  id: string,
  onChanged?: (client: PoolClient) => Promise<void>
) {
  const result = await withTransaction(async (client) => {
    const repository = await lockGithubRepositoryForMutation(client, id);
    if (!repository) return false;
    const deleted = await client.query(
      "DELETE FROM github_repositories WHERE id = $1 RETURNING id",
      [id]
    );
    if (!deleted.rowCount) return false;
    await onChanged?.(client);
    return true;
  });
  return result;
}

async function fetchComposeFileForRef(row: any, ref: string) {
  try {
    return await fetchComposeFileByParts(row.owner, row.repo, row.compose_path, ref, githubTokenForRow(row));
  } catch (error) {
    throw new Error(githubPrivateRepoHint(error instanceof Error ? error.message : String(error)));
  }
}

async function fetchGithubCommitSha(owner: string, repo: string, ref: string, token?: string | null) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  const response = await fetch(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} while checking ${owner}/${repo}@${ref}`);
  }
  const body = await response.json() as { sha?: string };
  if (!body.sha) throw new Error("GitHub response did not include a commit SHA");
  return body.sha;
}

async function fetchBranchCommitSha(row: any, ref: string) {
  return fetchGithubCommitSha(
    row.owner,
    row.repo,
    ref,
    row.github_token_encrypted ? decryptSecret(row.github_token_encrypted) : null
  );
}

export async function fetchGithubCommitShaForUrl(repositoryUrl: string, ref: string, token?: string | null) {
  const { owner, repo } = parseGithubUrl(repositoryUrl);
  return fetchGithubCommitSha(owner, repo, ref, token);
}

export async function fetchGithubCommitShaWithStoredCredentials(repositoryUrl: string, ref: string) {
  const { owner, repo } = parseGithubUrl(repositoryUrl);
  const { token } = await storedGithubRepositoryCredential(owner, repo, ref);
  try {
    return await fetchGithubCommitSha(owner, repo, ref, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!token && /GitHub returned (401|403|404)/.test(message)) {
      throw new Error(
        `${message}. If this is a private GitHub repository, track it under Deploy -> Tracked GitHub repositories with a read-only Contents token.`
      );
    }
    throw error;
  }
}

export async function listGithubVersionsForUrlWithStoredCredentials(
  repositoryUrl: string,
  context: { selectedRef?: string | null; currentCommitSha?: string | null } = {}
) {
  const { owner, repo } = parseGithubUrl(repositoryUrl);
  const { token } = await storedGithubRepositoryCredential(owner, repo, context.selectedRef);
  try {
    return await listGithubVersionOptions(owner, repo, repositoryUrl, token, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!token && /GitHub returned (401|403|404)/.test(message)) {
      throw new Error(
        `${message}. If this is a private GitHub repository, track it under Deploy -> Tracked GitHub repositories with a read-only Contents token.`
      );
    }
    throw error;
  }
}

export async function checkGithubRepositoryUpdates(id?: string) {
  const result = id
    ? await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id])
    : await query<any>("SELECT * FROM github_repositories ORDER BY name ASC");

  const repositories = [];
  for (const row of result.rows) {
    // Repositories bound to a demo workspace host are simulated end to end; a live
    // GitHub lookup would drift away from the seeded deploy SHAs and show fake errors.
    if (row.default_host_id && await isDemoHostId(row.default_host_id)) {
      const updated = await query<any>(
        `UPDATE github_repositories
         SET latest_commit_sha = COALESCE(last_deployed_commit_sha, latest_commit_sha),
             update_checked_at = now(),
             update_check_error = null,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [row.id]
      );
      repositories.push(mapGithubRepository(updated.rows[0]));
      continue;
    }
    try {
      const latestSha = await fetchBranchCommitSha(row, row.branch);
      const updated = await query<any>(
        `UPDATE github_repositories
         SET latest_commit_sha = $2,
             update_checked_at = now(),
             update_check_error = null,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [row.id, latestSha]
      );
      repositories.push(mapGithubRepository(updated.rows[0]));
    } catch (error) {
      const updated = await query<any>(
        `UPDATE github_repositories
         SET update_checked_at = now(),
             update_check_error = $2,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [row.id, error instanceof Error ? error.message : String(error)]
      );
      repositories.push(mapGithubRepository(updated.rows[0]));
    }
  }

  return repositories;
}

export async function listGithubBranchesForUrl(repositoryUrl: string, githubToken?: string) {
  const canonical = canonicalizeGithubRepositoryUrl(repositoryUrl);
  const { owner, repo } = parseGithubUrl(canonical);
  return listGithubBranches(owner, repo, githubToken);
}

export async function listGithubVersionsForUrl(
  repositoryUrl: string,
  githubToken?: string,
  context: { selectedRef?: string | null; currentCommitSha?: string | null } = {}
) {
  const canonical = canonicalizeGithubRepositoryUrl(repositoryUrl);
  const { owner, repo } = parseGithubUrl(canonical);
  return listGithubVersionOptions(owner, repo, canonical, githubToken, context);
}

export async function listGithubBranchesForRepository(id: string) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("GitHub repository not found");
  return listGithubBranches(row.owner, row.repo, row.github_token_encrypted ? decryptSecret(row.github_token_encrypted) : undefined);
}

export async function listGithubVersionsForRepository(
  id: string,
  context: { selectedRef?: string | null; currentCommitSha?: string | null } = {}
) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("GitHub repository not found");
  const token = row.github_token_encrypted ? decryptSecret(row.github_token_encrypted) : undefined;
  const repositoryUrl = sanitizeGithubRepositoryUrl(row.repository_url, {
    owner: row.owner,
    repo: row.repo
  });
  if (!repositoryUrl) throw Object.assign(new Error("Stored GitHub repository URL is invalid"), { statusCode: 400 });
  return listGithubVersionOptions(row.owner, row.repo, repositoryUrl, token, {
    selectedRef: context.selectedRef ?? row.branch,
    currentCommitSha: context.currentCommitSha ?? row.last_deployed_commit_sha ?? null
  });
}

export async function previewGithubRepositoryCompose(id: string, branchOverride: string | undefined) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("GitHub repository not found");
  const branch = branchOverride ?? row.branch;
  const composeYaml = await fetchComposeFileForRef(row, branch);
  return {
    repository: mapGithubRepository(row),
    branch,
    composeYaml,
    projectName: normalizeProjectName(row.project_name),
    env: row.env ?? ""
  };
}

async function listGithubBranches(owner: string, repo: string, token?: string) {
  const branches: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100&page=${page}`;
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} while listing branches`);
    const body = await response.json() as Array<{ name?: string }>;
    branches.push(...body.map((branch) => branch.name).filter((name): name is string => Boolean(name)));
    if (body.length < 100) break;
  }
  return branches;
}

export async function deployGithubRepository(
  id: string,
  options: {
    hostId?: string;
    branch?: string;
    projectName?: string;
    composeYaml?: string;
    env?: string;
    mode?: "api" | "host_clone";
    hostCloneUrl?: string;
    hostCloneDirectory?: string;
  },
  createdBy?: string | null,
  onQueued?: (
    client: PoolClient,
    result: {
      job: Awaited<ReturnType<typeof enqueueJobInTransaction>>;
      stack?: ReturnType<typeof mapStack>;
      branch: string;
      mode: "api" | "host_clone";
      sourceCommitSha?: string;
      composeSha256?: string;
      customCompose?: boolean;
    }
  ) => Promise<void>
) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("GitHub repository not found");
  const hostId = options.hostId ?? row.default_host_id;
  if (!hostId) throw new Error("Choose a host before deploying this repository");
  const branch = options.branch ?? row.branch;
  const projectName = options.projectName ?? normalizeProjectName(row.project_name);
  const env = options.env ?? row.env ?? "";
  const repositoryUrl = sanitizeGithubRepositoryUrl(row.repository_url, {
    owner: row.owner,
    repo: row.repo
  });
  if (!repositoryUrl) throw Object.assign(new Error("Stored GitHub repository URL is invalid"), { statusCode: 400 });
  let queuedCallbackError: unknown;

  try {
    if (options.mode === "host_clone") {
      if (options.composeYaml !== undefined) {
        throw Object.assign(
          new Error(
            "Clone/Build Deploy uses the Compose file from the pinned repository revision. Use API mode for a custom Compose definition."
          ),
          { statusCode: 400 }
        );
      }
      const requestedHostCloneUrl = nullIfBlank(options.hostCloneUrl);
      const hostCloneUrl = requestedHostCloneUrl
        ? canonicalizeGitRepositoryUrl(requestedHostCloneUrl)
        : sanitizeGitRepositoryUrl(row.host_clone_url) ?? defaultHostCloneUrlForRepositoryUrl(repositoryUrl);
      if (!hostCloneUrl) throw Object.assign(new Error("Stored host clone URL is invalid"), { statusCode: 400 });
      const requestedHostCloneDirectory =
        nullIfBlank(options.hostCloneDirectory) ?? row.host_clone_directory;
      if (!requestedHostCloneDirectory) {
        throw new Error(
          "Choose a host clone directory before using Clone/Build Deploy."
        );
      }
      const hostCloneDirectory = normalizeRemotePath(
        requestedHostCloneDirectory
      );
      const sourceCommitSha = exactGithubCommitSha(
        await fetchBranchCommitSha(row, branch)
      );
      const composeYaml = await fetchComposeFileForRef(
        row,
        sourceCommitSha
      );
      inspectGitComposeSourceIntegrity(composeYaml, row.compose_path);
      const queuedComposeSha256 = composeSha256(composeYaml);
      const canonicalEnvironment = serializeDeploymentEnvironment(
        parseDeploymentEnvironment(env)
      );
      const environmentBinding = deploymentEnvironmentBinding(
        canonicalEnvironment
      );
      const encryptedEnvironment = encryptSecret(canonicalEnvironment);
      const transactionResult = await withTransaction(async (client) => {
        const lockedRepository = await lockGithubRepositoryForMutation<any>(client, id);
        if (!lockedRepository) throw new Error("GitHub repository not found");
        if (!sameRepositoryDeploymentInputs(row, lockedRepository)) {
          throw Object.assign(
            new Error("GitHub repository changed while deployment was being prepared. Retry with the latest settings."),
            { statusCode: 409 }
          );
        }
        await client.query(
          `UPDATE github_repositories
           SET host_clone_url = $2,
               host_clone_directory = $3,
               last_error = null,
               updated_at = now()
           WHERE id = $1`,
          [id, hostCloneUrl, hostCloneDirectory]
        );
        const job = await enqueueJobInTransaction(client, {
          type: "git.cloneDeploy",
          hostId,
          payload: {
            repositoryUrl: hostCloneUrl,
            directory: hostCloneDirectory,
            branch,
            composePath: row.compose_path,
            projectName,
            repositoryId: id,
            sourceCommitSha,
            composeSha256: queuedComposeSha256
          }
        }, createdBy);
        await client.query(
          `INSERT INTO github_clone_deployment_jobs (
             operation_job_id, repository_id, host_id,
             source_repository_url, clone_repository_url, source_branch,
             source_commit_sha, source_compose_path, compose_yaml,
             compose_sha256, project_name, working_dir,
             environment_encrypted, environment_binding
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           )`,
          [
            job.id,
            id,
            hostId,
            repositoryUrl,
            hostCloneUrl,
            branch,
            sourceCommitSha,
            row.compose_path,
            composeYaml,
            queuedComposeSha256,
            projectName,
            hostCloneDirectory,
            encryptedEnvironment,
            environmentBinding
          ]
        );
        try {
          await onQueued?.(client, {
            job,
            branch,
            mode: "host_clone",
            sourceCommitSha,
            composeSha256: queuedComposeSha256,
            customCompose: false
          });
        } catch (error) {
          queuedCallbackError = error;
          throw error;
        }
        return { job };
      });
      await notifyJobQueued(transactionResult.job.id);
      const { job } = transactionResult;
      return {
        job,
        branch,
        mode: "host_clone",
        sourceCommitSha,
        composeSha256: queuedComposeSha256,
        customCompose: false
      };
    }

    const sourceCommitSha = exactGithubCommitSha(
      await fetchBranchCommitSha(row, branch)
    );
    const customCompose = options.composeYaml !== undefined;
    // Resolve the moving ref once, then fetch the reviewed file by that
    // immutable object id. A caller-provided definition is an explicit custom
    // deployment: it remains bound to the source revision for provenance, but
    // completion must not claim that its bytes equal the upstream commit.
    const composeYaml = customCompose
      ? options.composeYaml!
      : await fetchComposeFileForRef(row, sourceCommitSha);
    const sourceIntegrity = inspectGitComposeSourceIntegrity(
      composeYaml,
      row.compose_path
    );
    if (
      sourceIntegrity.buildContexts.length > 0
      || sourceIntegrity.referencedFiles.some((file) =>
        file !== sourceIntegrity.composePath
      )
    ) {
      throw Object.assign(
        new Error(
          "GitHub API deployment cannot materialize build contexts or referenced source files. Use Clone/Build Deploy for this repository."
        ),
        { statusCode: 409 }
      );
    }
    const queuedComposeSha256 = composeSha256(composeYaml);
    const transactionResult = await withTransaction(async (client) => {
      const lockedRepository = await lockGithubRepositoryForMutation<any>(client, id);
      if (!lockedRepository) throw new Error("GitHub repository not found");
      if (!sameRepositoryDeploymentInputs(row, lockedRepository)) {
        throw Object.assign(
          new Error("GitHub repository changed while deployment was being prepared. Retry with the latest settings."),
          { statusCode: 409 }
        );
      }
      const existingStack = await client.query<{ id: string }>(
        `SELECT id
         FROM compose_stacks
         WHERE host_id = $1 AND project_name = $2
         FOR UPDATE`,
        [hostId, projectName]
      );
      if (existingStack.rows[0]) {
        await lockComposeStackForMutation(client, existingStack.rows[0].id);
      }
      const stackResult = await client.query(
        `INSERT INTO compose_stacks (
           id, host_id, name, project_name, compose_yaml, env, status,
           source_type, source_repository_url, source_branch, source_compose_path, source_current_commit_sha,
           source_latest_commit_sha, source_checked_at, source_check_error
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'created', 'github', $7, $8, $9, null, $10, CASE WHEN $10::text IS NULL THEN null ELSE now() END, null)
         ON CONFLICT (host_id, project_name)
         DO UPDATE SET name = EXCLUDED.name,
                       compose_yaml = EXCLUDED.compose_yaml,
                       env = EXCLUDED.env,
                       source_type = EXCLUDED.source_type,
                       source_repository_url = EXCLUDED.source_repository_url,
                       source_branch = EXCLUDED.source_branch,
                       source_compose_path = EXCLUDED.source_compose_path,
                       source_latest_commit_sha = EXCLUDED.source_latest_commit_sha,
                       source_checked_at = EXCLUDED.source_checked_at,
                       source_check_error = null,
                       updated_at = now()
         RETURNING *`,
        [
          uuid(),
          hostId,
          row.name,
          projectName,
          composeYaml,
          env,
          repositoryUrl,
          branch,
          row.compose_path,
          sourceCommitSha
        ]
      );
      const stack = mapStack(stackResult.rows[0]);
      await recordStackVersionInTransaction(client, {
        stackId: stack.id,
        composeYaml: stack.composeYaml,
        env: stack.env,
        source: "github",
        createdBy,
        note: customCompose
          ? `GitHub custom Compose deploy ${row.owner}/${row.repo}@${sourceCommitSha}`
          : `GitHub deploy ${row.owner}/${row.repo}@${sourceCommitSha}`
      });
      const job = await enqueueJobInTransaction(
        client,
        {
          type: "compose.deploy",
          hostId,
          payload: { stackId: stack.id, pullBeforeDeploy: false }
        },
        createdBy
      );
      await client.query(
        `INSERT INTO github_deployment_jobs (
           operation_job_id, repository_id, stack_id, source_repository_url,
           source_branch, source_compose_path, source_commit_sha,
           compose_sha256, custom_compose
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          job.id,
          id,
          stack.id,
          repositoryUrl,
          branch,
          row.compose_path,
          sourceCommitSha,
          queuedComposeSha256,
          customCompose
        ]
      );
      await client.query(
        `UPDATE github_repositories
         SET latest_commit_sha = COALESCE($2, latest_commit_sha),
             update_checked_at = CASE WHEN $2::text IS NULL THEN update_checked_at ELSE now() END,
             update_check_error = CASE WHEN $2::text IS NULL THEN update_check_error ELSE null END,
             updated_at = now()
         WHERE id = $1`,
        [id, sourceCommitSha]
      );
      try {
        await onQueued?.(client, {
          stack,
          job,
          branch,
          mode: "api",
          sourceCommitSha,
          composeSha256: queuedComposeSha256,
          customCompose
        });
      } catch (error) {
        queuedCallbackError = error;
        throw error;
      }
      return { stack, job };
    });
    await notifyJobQueued(transactionResult.job.id);
    const { stack, job } = transactionResult;
    return {
      stack,
      job,
      branch,
      sourceCommitSha,
      composeSha256: queuedComposeSha256,
      customCompose
    };
  } catch (error) {
    // A transactional route callback is used to persist the audit event next
    // to the job and related domain changes. If that callback fails, the
    // transaction has already rolled everything back; do not follow it with an
    // unaudited `last_error` write that would make the 500 response misleading.
    if (error === queuedCallbackError) throw error;
    const message = String(sanitizeUrlDiagnosticText(
      error instanceof Error ? error.message : String(error)
    ));
    await withTransaction(async (client) => {
      const repository = await lockGithubRepositoryForMutation(client, id);
      if (!repository) return;
      await client.query(
        "UPDATE github_repositories SET last_error = $2, updated_at = now() WHERE id = $1",
        [id, message]
      );
    }).catch(() => undefined);
    throw error;
  }
}
