import { Buffer } from "node:buffer";
import { v4 as uuid } from "uuid";
import {
  githubRepositoryAccessCheckSchema,
  githubRepositoryCreateSchema,
  githubRepositoryUpdateSchema,
  type AppGithubVersionOption,
  type AppGithubVersions
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { isDemoHostId } from "./demo.js";
import { enqueueJobInTransaction, notifyJobQueued } from "./jobs.js";
import { mapStack } from "./mappers.js";
import { recordStackVersionInTransaction } from "./stackVersions.js";

const GITHUB_PAGE_SIZE = 100;
const MAX_GITHUB_VERSION_PAGES = 20;

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

function defaultHostCloneUrl(owner: string, repo: string) {
  return `git@github.com:${owner}/${repo}.git`;
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
  if (scpMatch) return githubRepoParts(scpMatch[1], scpMatch[2]);

  const url = new URL(trimmed);
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
  return {
    id: row.id,
    name: row.name,
    repositoryUrl: row.repository_url,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    composePath: row.compose_path,
    projectName: row.project_name,
    env: row.env ?? "",
    defaultHostId: row.default_host_id,
    hostCloneUrl: row.host_clone_url ?? defaultHostCloneUrl(row.owner, row.repo),
    hostCloneDirectory: row.host_clone_directory ?? null,
    lastDeployedAt: iso(row.last_deployed_at),
    lastDeployedCommitSha: row.last_deployed_commit_sha ?? null,
    latestCommitSha: row.latest_commit_sha ?? null,
    updateCheckedAt: iso(row.update_checked_at),
    updateCheckError: row.update_check_error ?? null,
    hasGithubToken,
    githubTokenStatus: githubTokenStatus(row),
    githubTokenCheckedAt: iso(row.github_token_checked_at),
    githubTokenCheckError: row.github_token_check_error ?? null,
    lastError: row.last_error,
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

export async function testGithubRepositoryStoredAccess(id: string) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) return null;
  let access: GithubRepositoryAccessResult;
  try {
    access = await checkGithubRepositoryAccess({
      repositoryUrl: row.repository_url,
      branch: row.branch,
      composePath: row.compose_path,
      githubToken: githubTokenForRow(row) ?? undefined
    });
  } catch (error) {
    access = await accessResultFromError(error);
  }
  const updated = await query<any>(
    `UPDATE github_repositories
     SET github_token_checked_at = now(),
         github_token_check_error = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, access.ok ? null : access.error]
  );
  return { repository: mapGithubRepository(updated.rows[0]), access };
}

export async function createGithubRepository(input: unknown) {
  const body = githubRepositoryCreateSchema.parse(input);
  const { owner, repo } = parseGithubUrl(body.repositoryUrl);
  const projectName = body.projectName ?? normalizeProjectName(repo);
  const githubToken = body.githubToken?.trim() || null;
  const hostCloneUrl = nullIfBlank(body.hostCloneUrl);
  const hostCloneDirectory = nullIfBlank(body.hostCloneDirectory);
  if (githubToken) {
    await requireValidGithubRepositoryAccess({
      repositoryUrl: body.repositoryUrl,
      branch: body.branch,
      composePath: body.composePath,
      githubToken
    });
  }
  const result = await query(
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
      body.repositoryUrl,
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
  return mapGithubRepository(result.rows[0]);
}

export async function updateGithubRepository(id: string, input: unknown) {
  const body = githubRepositoryUpdateSchema.parse(input);
  const current = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = current.rows[0];
  if (!row) return null;
  const repositoryUrl = body.repositoryUrl ?? row.repository_url;
  const parsed = body.repositoryUrl ? parseGithubUrl(body.repositoryUrl) : { owner: row.owner, repo: row.repo };
  const nextBranch = body.branch ?? row.branch;
  const nextComposePath = body.composePath ?? row.compose_path;
  const githubToken = body.githubToken?.trim() || null;
  const clearGithubToken = Boolean(body.clearGithubToken);
  const existingToken = clearGithubToken ? null : githubTokenForRow(row);
  const tokenForValidation = githubToken ?? existingToken;
  const changedAccessTarget = Boolean(body.repositoryUrl || body.branch || body.composePath);
  const hostCloneUrl = body.hostCloneUrl === undefined ? row.host_clone_url : nullIfBlank(body.hostCloneUrl);
  const hostCloneDirectory = body.hostCloneDirectory === undefined ? row.host_clone_directory : nullIfBlank(body.hostCloneDirectory);
  if (!clearGithubToken && tokenForValidation && (githubToken || changedAccessTarget)) {
    await requireValidGithubRepositoryAccess({
      repositoryUrl,
      branch: nextBranch,
      composePath: nextComposePath,
      githubToken: tokenForValidation
    });
  }
  const result = await query(
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
  return mapGithubRepository(result.rows[0]);
}

export async function deleteGithubRepository(id: string) {
  const result = await query("DELETE FROM github_repositories WHERE id = $1 RETURNING id", [id]);
  return Boolean(result.rowCount);
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
  const { owner, repo } = parseGithubUrl(repositoryUrl);
  return listGithubBranches(owner, repo, githubToken);
}

export async function listGithubVersionsForUrl(
  repositoryUrl: string,
  githubToken?: string,
  context: { selectedRef?: string | null; currentCommitSha?: string | null } = {}
) {
  const { owner, repo } = parseGithubUrl(repositoryUrl);
  return listGithubVersionOptions(owner, repo, repositoryUrl, githubToken, context);
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
  return listGithubVersionOptions(row.owner, row.repo, row.repository_url, token, {
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
  createdBy?: string | null
) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("GitHub repository not found");
  const hostId = options.hostId ?? row.default_host_id;
  if (!hostId) throw new Error("Choose a host before deploying this repository");
  const branch = options.branch ?? row.branch;
  const projectName = options.projectName ?? normalizeProjectName(row.project_name);
  const env = options.env ?? row.env ?? "";
  let commitSha: string | null = null;

  try {
    if (options.mode === "host_clone") {
      const hostCloneUrl = nullIfBlank(options.hostCloneUrl) ?? row.host_clone_url ?? defaultHostCloneUrl(row.owner, row.repo);
      const hostCloneDirectory = nullIfBlank(options.hostCloneDirectory) ?? row.host_clone_directory;
      if (!hostCloneDirectory) throw new Error("Choose a host clone directory before using Clone/Build Deploy.");
      const transactionResult = await withTransaction(async (client) => {
        const lockedRepository = await client.query(
          "SELECT id FROM github_repositories WHERE id = $1 FOR UPDATE",
          [id]
        );
        if (!lockedRepository.rows[0]) throw new Error("GitHub repository not found");
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
            repositoryId: id
          }
        }, createdBy);
        return { job };
      });
      await notifyJobQueued(transactionResult.job.id);
      const { job } = transactionResult;
      return { job, branch, mode: "host_clone" };
    }

    try {
      commitSha = await fetchBranchCommitSha(row, branch);
    } catch {
      commitSha = null;
    }
    const composeYaml = options.composeYaml ?? await fetchComposeFileForRef(row, branch);
    const transactionResult = await withTransaction(async (client) => {
      const lockedRepository = await client.query(
        "SELECT id FROM github_repositories WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!lockedRepository.rows[0]) throw new Error("GitHub repository not found");
      const stackResult = await client.query(
        `INSERT INTO compose_stacks (
           id, host_id, name, project_name, compose_yaml, env, status,
           source_type, source_repository_url, source_branch, source_current_commit_sha,
           source_latest_commit_sha, source_checked_at, source_check_error
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'created', 'github', $7, $8, $9, $9, CASE WHEN $9::text IS NULL THEN null ELSE now() END, null)
         ON CONFLICT (host_id, project_name)
         DO UPDATE SET name = EXCLUDED.name,
                       compose_yaml = EXCLUDED.compose_yaml,
                       env = EXCLUDED.env,
                       source_type = EXCLUDED.source_type,
                       source_repository_url = EXCLUDED.source_repository_url,
                       source_branch = EXCLUDED.source_branch,
                       source_current_commit_sha = EXCLUDED.source_current_commit_sha,
                       source_latest_commit_sha = EXCLUDED.source_latest_commit_sha,
                       source_checked_at = EXCLUDED.source_checked_at,
                       source_check_error = null,
                       updated_at = now()
         RETURNING *`,
        [uuid(), hostId, row.name, projectName, composeYaml, env, row.repository_url, branch, commitSha]
      );
      const stack = mapStack(stackResult.rows[0]);
      await recordStackVersionInTransaction(client, {
        stackId: stack.id,
        composeYaml: stack.composeYaml,
        env: stack.env,
        source: "github",
        createdBy,
        note: `GitHub deploy ${row.owner}/${row.repo}@${branch}`
      });
      const job = await enqueueJobInTransaction(
        client,
        { type: "compose.deploy", hostId, payload: { stackId: stack.id } },
        createdBy
      );
      await client.query(
        `UPDATE github_repositories
         SET last_deployed_at = now(),
             last_deployed_commit_sha = COALESCE($2, last_deployed_commit_sha),
             latest_commit_sha = COALESCE($2, latest_commit_sha),
             update_checked_at = CASE WHEN $2::text IS NULL THEN update_checked_at ELSE now() END,
             update_check_error = CASE WHEN $2::text IS NULL THEN update_check_error ELSE null END,
             last_error = null,
             updated_at = now()
         WHERE id = $1`,
        [id, commitSha]
      );
      return { stack, job };
    });
    await notifyJobQueued(transactionResult.job.id);
    const { stack, job } = transactionResult;
    return { stack, job, branch };
  } catch (error) {
    await query("UPDATE github_repositories SET last_error = $2, updated_at = now() WHERE id = $1", [
      id,
      error instanceof Error ? error.message : String(error)
    ]);
    throw error;
  }
}
