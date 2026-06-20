import { useEffect, useMemo, useState } from "react";
import { Download, Play, Plus, RefreshCw, Save, Search, Star, Trash2, X } from "lucide-react";
import type { CatalogTemplate, DockerHost, ExternalCatalogCandidate, ExternalCatalogResponse } from "@dockermender/shared";
import { api, deleteJson, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { ButtonRow, DataTable, EmptyState, Panel } from "../ui/primitives.js";
import { useConfirm } from "../ConfirmProvider.js";

type CatalogTemplateView = CatalogTemplate & {
  source?: "built_in" | "custom";
};

const emptyCustomForm = {
  id: "",
  name: "",
  description: "",
  category: "utility",
  docsUrl: "",
  suggestedPorts: "",
  suggestedVolumes: "",
  defaultEnv: "",
  composeYaml: `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
`
};

function envToString(env: Record<string, string>) {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

function envFromString(value: string) {
  const env: Record<string, string> = {};
  value.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index <= 0) return;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  });
  return env;
}

function linesFromString(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function CatalogPanel({
  hosts,
  runJob,
  refresh
}: {
  hosts: DockerHost[];
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  refresh: () => Promise<void>;
}) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [templates, setTemplates] = useState<CatalogTemplateView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [projectName, setProjectName] = useState("");
  const [envText, setEnvText] = useState("");
  const [composeYaml, setComposeYaml] = useState("");
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customForm, setCustomForm] = useState(emptyCustomForm);
  const [customError, setCustomError] = useState<string | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);
  const [externalCatalog, setExternalCatalog] = useState<ExternalCatalogResponse | null>(null);
  const [externalQuery, setExternalQuery] = useState("");
  const [externalLimit, setExternalLimit] = useState(100);
  const [loadingExternal, setLoadingExternal] = useState(false);
  const [externalError, setExternalError] = useState<string | null>(null);

  const selected = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [templates, selectedId]
  );

  async function loadTemplates() {
    const result = await api<{ templates: CatalogTemplateView[] }>("/api/catalog/templates");
    const list = result.templates ?? [];
    setTemplates(list);
    if (!selectedId && list[0]) {
      pickTemplate(list[0]);
    }
  }

  function pickTemplate(template: CatalogTemplate) {
    setSelectedId(template.id);
    setProjectName(template.id.replace(/[^a-z0-9]+/g, "-"));
    setEnvText(envToString(template.defaultEnv));
    setComposeYaml(template.composeYaml);
  }

  async function saveCustomTemplate(event: React.FormEvent) {
    event.preventDefault();
    setSavingCustom(true);
    setCustomError(null);
    try {
      const response = await postJson<{ template: CatalogTemplateView }>("/api/catalog/templates", {
        id: customForm.id.trim(),
        name: customForm.name.trim(),
        description: customForm.description.trim(),
        category: customForm.category,
        docsUrl: customForm.docsUrl.trim() || null,
        suggestedPorts: linesFromString(customForm.suggestedPorts),
        suggestedVolumes: linesFromString(customForm.suggestedVolumes),
        defaultEnv: envFromString(customForm.defaultEnv),
        composeYaml: customForm.composeYaml
      });
      setCustomForm(emptyCustomForm);
      setShowCustomForm(false);
      await loadTemplates();
      pickTemplate(response.template);
    } catch (caught) {
      setCustomError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingCustom(false);
    }
  }

  async function removeCustomTemplate(template: CatalogTemplateView) {
    if (template.source !== "custom") return;
    if (!await confirm({
      title: "Delete catalog template",
      tone: "danger",
      confirmLabel: "Delete",
      message: `Delete custom template "${template.name}"? Existing deployed stacks are not changed.`
    })) return;
    await deleteJson(`/api/catalog/templates/${encodeURIComponent(template.id)}`);
    if (selectedId === template.id) setSelectedId("");
    await loadTemplates();
  }

  async function loadExternalCatalog() {
    setLoadingExternal(true);
    setExternalError(null);
    try {
      const params = new URLSearchParams({
        source: "awesome-selfhosted",
        limit: String(externalLimit)
      });
      if (externalQuery.trim()) params.set("query", externalQuery.trim());
      const result = await api<ExternalCatalogResponse>(`/api/catalog/external?${params.toString()}`);
      setExternalCatalog(result);
    } catch (caught) {
      setExternalError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingExternal(false);
    }
  }

  function importExternalCandidate(candidate: ExternalCatalogCandidate) {
    const template = candidate.importTemplate;
    setCustomForm({
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      docsUrl: template.docsUrl ?? candidate.docsUrl,
      suggestedPorts: template.suggestedPorts.join("\n"),
      suggestedVolumes: template.suggestedVolumes.join("\n"),
      defaultEnv: envToString(template.defaultEnv),
      composeYaml: template.composeYaml
    });
    setCustomError(null);
    setShowCustomForm(true);
  }

  useEffect(() => {
    void loadTemplates();
  }, []);

  async function deploy(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    await action.run(async () => {
      await runJob(() => postJson<JobResult>("/api/catalog/deploy", {
        templateId: selected.id,
        hostId,
        projectName,
        env: envFromString(envText),
        composeYaml
      }));
      await refresh();
    });
  }

  return (
    <Panel title="Catalog" count={templates.length}>
      <div className="formHint">Built-in and custom templates for self-hosted services. Review env values and compose YAML before deploying to your selected host.</div>
      <ButtonRow>
        <button type="button" onClick={() => void loadTemplates()}><RefreshCw size={16} />Refresh catalog</button>
        <button type="button" onClick={() => void loadExternalCatalog()} disabled={loadingExternal}>
          <Search size={16} className={loadingExternal ? "spin" : undefined} />
          Discover top apps
        </button>
        <button type="button" onClick={() => setShowCustomForm((value) => !value)}>
          {showCustomForm ? <X size={16} /> : <Plus size={16} />}
          {showCustomForm ? "Close" : "Add template"}
        </button>
      </ButtonRow>
      <section className="subPanel externalCatalogPanel" aria-label="External catalog discovery">
        <div className="externalCatalogToolbar">
          <div>
            <h3>External discovery</h3>
            <p>Load popular apps from Awesome-Selfhosted, then import a draft template for review.</p>
          </div>
          <div className="externalCatalogControls">
            <input
              placeholder="Search external catalog"
              value={externalQuery}
              onChange={(event) => setExternalQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadExternalCatalog();
              }}
              aria-label="Search external catalog"
            />
            <select value={externalLimit} onChange={(event) => setExternalLimit(Number(event.target.value))} aria-label="External catalog result limit">
              <option value={50}>Top 50</option>
              <option value={100}>Top 100</option>
              <option value={200}>Top 200</option>
            </select>
            <button type="button" onClick={() => void loadExternalCatalog()} disabled={loadingExternal}>
              <RefreshCw size={16} className={loadingExternal ? "spin" : undefined} />
              Load
            </button>
          </div>
        </div>
        {externalError && <div className="notice error">{externalError}</div>}
        {externalCatalog && (
          <>
            <div className="formHint">
              {externalCatalog.candidates.length} of {externalCatalog.total} results from <a href={externalCatalog.sourceUrl} target="_blank" rel="noreferrer">{externalCatalog.sourceLabel}</a>. Imported apps are drafts; review image, ports, volumes, and secrets before deploy.
            </div>
            <div className="externalCatalogList">
              {externalCatalog.candidates.map((candidate) => (
                <article key={candidate.id} className="externalCatalogItem">
                  <div>
                    <h4>{candidate.name}</h4>
                    <p>{candidate.description}</p>
                    <div className="externalCatalogMeta">
                      <span className={`appSourcePill ${candidate.category}`}>{candidate.category}</span>
                      {candidate.stargazersCount !== null && <span><Star size={13} />{candidate.stargazersCount.toLocaleString()}</span>}
                      {candidate.platforms.slice(0, 3).map((platform) => <span key={platform}>{platform}</span>)}
                      {candidate.latestRelease?.tag && <span>{candidate.latestRelease.tag}</span>}
                      {candidate.updatedAt && <span>Updated {candidate.updatedAt}</span>}
                    </div>
                  </div>
                  <ButtonRow>
                    <a className="buttonLink" href={candidate.docsUrl} target="_blank" rel="noreferrer">Docs</a>
                    {candidate.sourceCodeUrl && <a className="buttonLink" href={candidate.sourceCodeUrl} target="_blank" rel="noreferrer">Source</a>}
                    <button type="button" onClick={() => importExternalCandidate(candidate)}>
                      <Download size={16} />
                      Import draft
                    </button>
                  </ButtonRow>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      {showCustomForm && (
        <form className="subPanel customCatalogForm" onSubmit={saveCustomTemplate}>
          <h3>Custom template</h3>
          <div className="templateHelpGrid">
            <span><strong>ID</strong> lowercase key, for example <code>home-assistant</code>.</span>
            <span><strong>Ports</strong> one mapping per line, for example <code>8123:8123</code>.</span>
            <span><strong>Volumes</strong> one mount per line, for example <code>./config:/config</code>.</span>
            <span><strong>Compose YAML</strong> paste a working Compose file from the project docs, then review image tags, secrets, host paths, and ports before deploy.</span>
          </div>
          <div className="two">
            <input
              placeholder="Template ID, e.g. home-assistant"
              value={customForm.id}
              onChange={(event) => setCustomForm({ ...customForm, id: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") })}
              required
            />
            <input placeholder="Display name" value={customForm.name} onChange={(event) => setCustomForm({ ...customForm, name: event.target.value })} required />
          </div>
          <div className="two">
            <select value={customForm.category} onChange={(event) => setCustomForm({ ...customForm, category: event.target.value })}>
              <option value="web">Web</option>
              <option value="monitoring">Monitoring</option>
              <option value="database">Database</option>
              <option value="devtools">Dev tools</option>
              <option value="automation">Automation</option>
              <option value="utility">Utility</option>
            </select>
            <input placeholder="Docs URL (optional)" value={customForm.docsUrl} onChange={(event) => setCustomForm({ ...customForm, docsUrl: event.target.value })} />
          </div>
          <input placeholder="Short description" value={customForm.description} onChange={(event) => setCustomForm({ ...customForm, description: event.target.value })} required />
          <div className="two">
            <textarea className="monoTextarea" placeholder="Default env, KEY=value per line" value={customForm.defaultEnv} onChange={(event) => setCustomForm({ ...customForm, defaultEnv: event.target.value })} />
            <textarea className="monoTextarea" placeholder="Suggested ports, one per line" value={customForm.suggestedPorts} onChange={(event) => setCustomForm({ ...customForm, suggestedPorts: event.target.value })} />
          </div>
          <textarea className="monoTextarea" placeholder="Suggested volumes, one per line" value={customForm.suggestedVolumes} onChange={(event) => setCustomForm({ ...customForm, suggestedVolumes: event.target.value })} />
          <textarea className="monoTextarea composeEditor" value={customForm.composeYaml} onChange={(event) => setCustomForm({ ...customForm, composeYaml: event.target.value })} required />
          {customError && <div className="notice error">{customError}</div>}
          <button className="primary" disabled={savingCustom}>
            <Save size={18} />
            Save template
          </button>
        </form>
      )}
      {templates.length === 0 ? (
        <EmptyState headline="Catalog loading" hint="Refresh to load built-in templates." />
      ) : (
        <DataTable
          rows={templates}
          columns={["App", "Source", "Category", "Ports", "Docs", ""]}
          render={(template) => [
            <button key="name" className="linkButton" onClick={() => pickTemplate(template)}>{template.name}</button>,
            <span key="source" className={`appSourcePill ${template.source === "custom" ? "custom" : "catalog"}`}>{template.source === "custom" ? "Custom" : "Built-in"}</span>,
            template.category,
            template.suggestedPorts.join(", ") || "—",
            <a key="docs" className="buttonLink" href={template.docsUrl} target="_blank" rel="noreferrer">Docs</a>,
            <ButtonRow key="actions">
              <button type="button" onClick={() => pickTemplate(template)}>Configure</button>
              {template.source === "custom" && (
                <button type="button" className="danger" title="Delete custom template" onClick={() => void removeCustomTemplate(template)}>
                  <Trash2 size={16} />
                </button>
              )}
            </ButtonRow>
          ]}
        />
      )}
      {selected && (
        <form className="subPanel composeForm" onSubmit={deploy}>
          <h3>Deploy {selected.name}</h3>
          <p>{selected.description}</p>
          <HostSelect hosts={hosts} value={hostId} onChange={setHostId} />
          <input placeholder="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))} required />
          <textarea className="monoTextarea" placeholder="Environment values" value={envText} onChange={(event) => setEnvText(event.target.value)} />
          <textarea className="monoTextarea composeEditor" value={composeYaml} onChange={(event) => setComposeYaml(event.target.value)} required />
          {action.error && <div className="notice error">{action.error}</div>}
          <button className="primary" disabled={action.busy || !hostId}><Play size={18} />Deploy template</button>
        </form>
      )}
    </Panel>
  );
}
