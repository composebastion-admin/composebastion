import { v4 as uuid } from "uuid";
import {
  catalogDeploySchema,
  catalogTemplates,
  customCatalogTemplateInputSchema,
  externalCatalogCandidateSchema,
  externalCatalogQuerySchema,
  getCatalogTemplate,
  type CatalogTemplate,
  type ExternalCatalogCandidate,
  type ExternalCatalogQuery
} from "@composebastion/shared";
import { query } from "../db/pool.js";
import { enqueueJob } from "./jobs.js";
import { mapStack } from "./mappers.js";
import { recordStackVersion } from "./stackVersions.js";

const CUSTOM_DOCS_FALLBACK = "https://docs.docker.com/compose/";
const AWESOME_SOURCE_URL = "https://github.com/awesome-selfhosted/awesome-selfhosted-data";
const AWESOME_TREE_URL = "https://api.github.com/repos/awesome-selfhosted/awesome-selfhosted-data/git/trees/master?recursive=1";
const AWESOME_RAW_BASE = "https://raw.githubusercontent.com/awesome-selfhosted/awesome-selfhosted-data/master/";
const EXTERNAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const EXTERNAL_FETCH_CONCURRENCY = 24;

type ExternalCatalogCache = {
  fetchedAt: string;
  expiresAt: number;
  candidates: ExternalCatalogCandidate[];
};

type AwesomeSoftware = {
  name?: string;
  websiteUrl?: string | null;
  description?: string;
  licenses: string[];
  platforms: string[];
  tags: string[];
  sourceCodeUrl?: string | null;
  demoUrl?: string | null;
  stargazersCount?: number | null;
  updatedAt?: string | null;
  archived: boolean;
  latestRelease?: {
    tag: string | null;
    publishedAt: string | null;
  } | null;
};

let externalCatalogCache: ExternalCatalogCache | null = null;

function envRecordToString(env: Record<string, string>) {
  return Object.entries(env)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export type CatalogTemplateRecord = CatalogTemplate & {
  source: "built_in" | "custom";
};

function mapCustomTemplate(row: any): CatalogTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    composeYaml: row.compose_yaml,
    defaultEnv: row.default_env ?? {},
    suggestedVolumes: row.suggested_volumes ?? [],
    suggestedPorts: row.suggested_ports ?? [],
    docsUrl: row.docs_url ?? CUSTOM_DOCS_FALLBACK,
    source: "custom"
  };
}

function builtInTemplate(template: CatalogTemplate): CatalogTemplateRecord {
  return { ...template, source: "built_in" };
}

function normalizeCatalogId(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return normalized || "external-app";
}

function stripYamlValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") return "";
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseAwesomeSoftwareYaml(text: string): AwesomeSoftware {
  const result: AwesomeSoftware = {
    licenses: [],
    platforms: [],
    tags: [],
    archived: false,
    latestRelease: null
  };
  let listKey: "licenses" | "platforms" | "tags" | null = null;
  let nestedKey: "current_release" | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    const listItem = /^\s+-\s*(.+)$/.exec(line);
    if (listItem && listKey) {
      result[listKey].push(stripYamlValue(listItem[1] ?? ""));
      continue;
    }

    const nested = /^\s{2}([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (nested && nestedKey === "current_release") {
      result.latestRelease ??= { tag: null, publishedAt: null };
      const nestedName = nested[1] ?? "";
      const nestedValue = nested[2] ?? "";
      if (nestedName === "tag") result.latestRelease.tag = stripYamlValue(nestedValue) || null;
      if (nestedName === "published_at") result.latestRelease.publishedAt = stripYamlValue(nestedValue) || null;
      continue;
    }

    const pair = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1] ?? "";
    const rawValue = pair[2] ?? "";
    listKey = null;
    nestedKey = null;
    if (key === "licenses" || key === "platforms" || key === "tags") {
      listKey = key;
      continue;
    }
    if (key === "current_release") {
      nestedKey = "current_release";
      result.latestRelease = { tag: null, publishedAt: null };
      continue;
    }
    const value = stripYamlValue(rawValue);
    if (key === "name") result.name = value;
    if (key === "website_url") result.websiteUrl = value || null;
    if (key === "description") result.description = value;
    if (key === "source_code_url") result.sourceCodeUrl = value || null;
    if (key === "demo_url") result.demoUrl = value || null;
    if (key === "stargazers_count") result.stargazersCount = Number.isFinite(Number(value)) ? Number(value) : null;
    if (key === "updated_at") result.updatedAt = value || null;
    if (key === "archived") result.archived = value === "true";
  }

  return result;
}

function externalCategory(tags: string[]) {
  const values = tags.map((tag) => tag.toLowerCase());
  if (values.some((tag) => /monitor|analytics|status|observability/.test(tag))) return "monitoring";
  if (values.some((tag) => /database|data storage|dbms/.test(tag))) return "database";
  if (values.some((tag) => /development|code|git|continuous integration|ide|project management/.test(tag))) return "devtools";
  if (values.some((tag) => /automation|internet of things|task/.test(tag))) return "automation";
  if (values.some((tag) => /content management|blog|wiki|media|photo|gallery|web/.test(tag))) return "web";
  return "utility";
}

function composeDraft(name: string, projectId: string) {
  return `# Imported from Awesome-Selfhosted discovery.
# Review the official project docs before deploying.
services:
  app:
    image: replace-with-official-image:latest
    restart: unless-stopped
    ports:
      - "\${APP_PORT:-8080}:8080"
    volumes:
      - ${projectId}_data:/data
volumes:
  ${projectId}_data:
`;
}

function mapAwesomeSoftware(path: string, item: AwesomeSoftware): ExternalCatalogCandidate | null {
  if (!item.name || !item.description) return null;
  const baseId = normalizeCatalogId(item.name);
  const docsUrl = item.websiteUrl || item.sourceCodeUrl || `${AWESOME_SOURCE_URL}/blob/master/${path}`;
  const importTemplate = customCatalogTemplateInputSchema.parse({
    id: `awesome-${baseId}`.slice(0, 80),
    name: item.name,
    description: item.description,
    category: externalCategory(item.tags),
    composeYaml: composeDraft(item.name, baseId),
    defaultEnv: { APP_PORT: "8080" },
    suggestedVolumes: [`${baseId}_data`],
    suggestedPorts: ["8080:8080"],
    docsUrl
  });
  return externalCatalogCandidateSchema.parse({
    id: `awesome-selfhosted:${baseId}`,
    name: item.name,
    description: item.description,
    category: importTemplate.category,
    source: "awesome-selfhosted",
    sourceLabel: "Awesome-Selfhosted",
    websiteUrl: item.websiteUrl ?? null,
    docsUrl,
    sourceCodeUrl: item.sourceCodeUrl ?? null,
    demoUrl: item.demoUrl ?? null,
    licenses: item.licenses.filter(Boolean),
    platforms: item.platforms.filter(Boolean),
    tags: item.tags.filter(Boolean),
    stargazersCount: item.stargazersCount ?? null,
    updatedAt: item.updatedAt ?? null,
    latestRelease: item.latestRelease ?? null,
    archived: item.archived,
    importTemplate
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ComposeBastion"
    }
  });
  if (!response.ok) throw new Error(`External catalog returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "ComposeBastion" }
  });
  if (!response.ok) throw new Error(`External catalog returned ${response.status}`);
  return response.text();
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  let index = 0;
  async function run() {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item === undefined) break;
      results.push(await worker(item));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function loadAwesomeSelfhostedCandidates() {
  const now = Date.now();
  if (externalCatalogCache && externalCatalogCache.expiresAt > now) return externalCatalogCache;

  const tree = await fetchJson<{ tree?: Array<{ path?: string; type?: string }> }>(AWESOME_TREE_URL);
  const paths = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path?.startsWith("software/") && entry.path.endsWith(".yml"))
    .map((entry) => entry.path!)
    .sort();

  const candidates = (await mapWithConcurrency(paths, EXTERNAL_FETCH_CONCURRENCY, async (path) => {
    try {
      const text = await fetchText(`${AWESOME_RAW_BASE}${path.split("/").map(encodeURIComponent).join("/")}`);
      return mapAwesomeSoftware(path, parseAwesomeSoftwareYaml(text));
    } catch {
      return null;
    }
  }))
    .filter((item): item is ExternalCatalogCandidate => Boolean(item))
    .sort((a, b) => (b.stargazersCount ?? 0) - (a.stargazersCount ?? 0) || a.name.localeCompare(b.name));

  const fetchedAt = new Date().toISOString();
  externalCatalogCache = {
    fetchedAt,
    expiresAt: now + EXTERNAL_CACHE_TTL_MS,
    candidates
  };
  return externalCatalogCache;
}

export async function listExternalCatalogCandidates(input: unknown) {
  const body = externalCatalogQuerySchema.parse(input) as ExternalCatalogQuery;
  if (body.source !== "awesome-selfhosted") {
    throw new Error("Unsupported external catalog source");
  }
  const cache = await loadAwesomeSelfhostedCandidates();
  const queryText = body.query?.toLowerCase() ?? "";
  const filtered = cache.candidates.filter((candidate) => {
    if (!body.includeArchived && candidate.archived) return false;
    if (!queryText) return true;
    const haystack = [
      candidate.name,
      candidate.description,
      candidate.category,
      ...candidate.tags,
      ...candidate.platforms
    ].join(" ").toLowerCase();
    return haystack.includes(queryText);
  });
  return {
    source: body.source,
    sourceLabel: "Awesome-Selfhosted",
    sourceUrl: AWESOME_SOURCE_URL,
    fetchedAt: cache.fetchedAt,
    total: filtered.length,
    candidates: filtered.slice(0, body.limit)
  };
}

export async function listCatalogTemplates() {
  const custom = await query<any>("SELECT * FROM custom_catalog_templates ORDER BY name ASC");
  return [
    ...catalogTemplates.map(builtInTemplate),
    ...custom.rows.map(mapCustomTemplate)
  ].sort((a, b) => a.name.localeCompare(b.name));
}

async function findCatalogTemplate(templateId: string) {
  const builtIn = getCatalogTemplate(templateId);
  if (builtIn) return builtInTemplate(builtIn);
  const custom = await query<any>("SELECT * FROM custom_catalog_templates WHERE id = $1", [templateId]);
  return custom.rows[0] ? mapCustomTemplate(custom.rows[0]) : null;
}

export async function saveCustomCatalogTemplate(input: unknown, createdBy?: string | null) {
  const body = customCatalogTemplateInputSchema.parse(input);
  if (getCatalogTemplate(body.id)) {
    throw new Error("A built-in catalog template already uses that ID");
  }
  const saved = await query<any>(
    `INSERT INTO custom_catalog_templates (
       id, name, description, category, compose_yaml, default_env,
       suggested_volumes, suggested_ports, docs_url, created_by, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (id)
     DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       category = EXCLUDED.category,
       compose_yaml = EXCLUDED.compose_yaml,
       default_env = EXCLUDED.default_env,
       suggested_volumes = EXCLUDED.suggested_volumes,
       suggested_ports = EXCLUDED.suggested_ports,
       docs_url = EXCLUDED.docs_url,
       updated_at = now()
     RETURNING *`,
    [
      body.id,
      body.name,
      body.description,
      body.category,
      body.composeYaml,
      JSON.stringify(body.defaultEnv),
      body.suggestedVolumes,
      body.suggestedPorts,
      body.docsUrl?.trim() || null,
      createdBy ?? null
    ]
  );
  return mapCustomTemplate(saved.rows[0]);
}

export async function deleteCustomCatalogTemplate(templateId: string) {
  if (getCatalogTemplate(templateId)) {
    throw new Error("Built-in catalog templates cannot be deleted");
  }
  const deleted = await query<{ id: string }>("DELETE FROM custom_catalog_templates WHERE id = $1 RETURNING id", [templateId]);
  if (!deleted.rows[0]) throw new Error("Custom catalog template not found");
  return { ok: true, templateId: deleted.rows[0].id };
}

export async function deployCatalogTemplate(input: unknown, createdBy?: string | null) {
  const body = catalogDeploySchema.parse(input);
  const template = await findCatalogTemplate(body.templateId);
  if (!template) throw new Error("Catalog template not found");

  const mergedEnv = { ...template.defaultEnv, ...body.env };
  const composeYaml = body.composeYaml ?? template.composeYaml;
  const envString = envRecordToString(mergedEnv);
  const name = body.name ?? template.name;
  const proxy = body.proxy;

  const stackResult = await query(
    `INSERT INTO compose_stacks (
       id, host_id, name, project_name, compose_yaml, env, status,
       domains, exposed_service, exposed_port, tls_desired,
       update_policy_enabled, update_policy_channel
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'created', $7, $8, $9, $10, false, NULL)
     ON CONFLICT (host_id, project_name)
     DO UPDATE SET
       name = EXCLUDED.name,
       compose_yaml = EXCLUDED.compose_yaml,
       env = EXCLUDED.env,
       domains = EXCLUDED.domains,
       exposed_service = EXCLUDED.exposed_service,
       exposed_port = EXCLUDED.exposed_port,
       tls_desired = EXCLUDED.tls_desired,
       updated_at = now()
     RETURNING *`,
    [
      uuid(),
      body.hostId,
      name,
      body.projectName,
      composeYaml,
      envString,
      proxy?.domains ?? [],
      proxy?.exposedService ?? template.suggestedPorts[0]?.split(":")[1] ?? null,
      proxy?.exposedPort ?? (Number(Object.values(template.defaultEnv).find((value) => /^\d+$/.test(value)) ?? 80) || null),
      proxy?.tlsDesired ?? false
    ]
  );

  const stack = mapStack(stackResult.rows[0]);
  await recordStackVersion({
    stackId: stack.id,
    composeYaml: stack.composeYaml,
    env: stack.env,
    source: "catalog",
    createdBy,
    note: body.note ?? `Catalog template ${template.id}`
  });

  const job = await enqueueJob({
    type: "compose.deploy",
    hostId: body.hostId,
    payload: { stackId: stack.id }
  }, createdBy);

  return { stack, job, templateId: template.id };
}
