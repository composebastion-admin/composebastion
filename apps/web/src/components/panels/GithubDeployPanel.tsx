import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  FileUp,
  GitBranch,
  Library,
  LoaderCircle,
  Pencil,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2
} from "lucide-react";
import type {
  DeploymentAnalysis,
  DeploymentSource,
  DeploymentSourceType,
  DockerHost,
  GithubRepository,
  OperationJob
} from "@composebastion/shared";
import { api, deleteJson, postJson, putJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish } from "../../lib/dashboardTypes.js";
import { useConfirm } from "../ConfirmProvider.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { ButtonRow, EmptyState, InlineStatus, Panel } from "../ui/primitives.js";

type AnalysisJobResponse = {
  analysis: DeploymentAnalysis;
  job: OperationJob;
};

function sourceTypeLabel(sourceType: DeploymentSource["sourceType"]) {
  if (sourceType === "git") return "Git repository";
  if (sourceType === "compose_url") return "Compose URL";
  if (sourceType === "compose_upload") return "Compose file";
  return "Container image";
}

function envFromAnalysis(analysis: DeploymentAnalysis, values: Record<string, string>) {
  return analysis.variables
    .filter((variable) => (values[variable.key] ?? variable.value) !== "" || !variable.required)
    .map((variable) => `${variable.key}=${values[variable.key] ?? variable.value}`)
    .join("\n");
}

function initialVariableValues(analysis: DeploymentAnalysis) {
  return Object.fromEntries(analysis.variables.map((variable) => [variable.key, variable.value]));
}

function environmentDefaultsText(values: Record<string, string>) {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
}

function parseEnvironmentDefaults(value: string) {
  const defaults: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid environment default: ${line}`);
    defaults[match[1]!] = match[2] ?? "";
  }
  return defaults;
}

export function GithubDeployPanel({
  hosts,
  repositories: _repositories,
  scopeHosts: _scopeHosts,
  refresh,
  runJob
}: {
  hosts: DockerHost[];
  scopeHosts: DockerHost[];
  repositories: GithubRepository[];
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [source, setSource] = useState("");
  const [sourceType, setSourceType] = useState<DeploymentSourceType | "auto">("auto");
  const [composeYaml, setComposeYaml] = useState("");
  const [credentialUsername, setCredentialUsername] = useState("");
  const [credentialSecret, setCredentialSecret] = useState("");
  const [analysis, setAnalysis] = useState<DeploymentAnalysis | null>(null);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<DeploymentSource[]>([]);
  const [sourceTargets, setSourceTargets] = useState<Record<string, string>>({});
  const [editingSource, setEditingSource] = useState<DeploymentSource | null>(null);
  const [sourceEdit, setSourceEdit] = useState({
    name: "",
    projectName: "",
    branch: "",
    composePath: "",
    workingDir: "",
    defaultHostId: "",
    safeEnvironment: ""
  });
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!hostId && hosts[0]?.id) setHostId(hosts[0].id);
  }, [hostId, hosts]);

  async function loadSources() {
    const result = await api<{ sources: DeploymentSource[] }>("/api/deployment-sources");
    setSources(result.sources);
    setSourceTargets((current) => Object.fromEntries(result.sources.map((sourceCard) => [
      sourceCard.id,
      current[sourceCard.id] ?? sourceCard.defaultHostId ?? hostId
    ])));
  }

  useEffect(() => {
    void loadSources().catch(() => undefined);
  }, []);

  async function loadFinishedAnalysis(id: string) {
    const result = await api<{ analysis: DeploymentAnalysis }>(`/api/deploy/analyses/${id}`);
    setAnalysis(result.analysis);
    setVariables(initialVariableValues(result.analysis));
    return result.analysis;
  }

  async function analyze(options: { sourceId?: string; composePath?: string; sourceValue?: string } = {}) {
    const sourceValue = options.sourceValue ?? source;
    if (!hostId || !sourceValue.trim()) return;
    setSuccess(null);
    await action.run(async () => {
      const result = await runJob(() => postJson<AnalysisJobResponse>("/api/deploy/analyses", {
        hostId,
        source: sourceValue,
        sourceType: sourceType === "auto" ? undefined : sourceType,
        sourceId: options.sourceId ?? analysis?.sourceId ?? undefined,
        composeYaml: composeYaml || undefined,
        composePath: options.composePath,
        credentialUsername: credentialUsername || undefined,
        credentialSecret: credentialSecret || undefined
      }));
      await loadFinishedAnalysis(result.analysis.id);
      setCredentialSecret("");
    });
  }

  async function uploadCompose(file: File) {
    const text = await file.text();
    setSource(file.name);
    setSourceType("compose_upload");
    setComposeYaml(text);
    setAnalysis(null);
    setSuccess(null);
  }

  async function deploy() {
    if (!analysis) return;
    await action.run(async () => {
      const result = await runJob(() => postJson<AnalysisJobResponse>(`/api/deploy/analyses/${analysis.id}/deploy`, {
        displayName: analysis.displayName ?? undefined,
        projectName: analysis.projectName ?? undefined,
        branch: analysis.branch ?? undefined,
        composePath: analysis.composePath ?? undefined,
        workingDir: analysis.workingDir ?? undefined,
        composeYaml: analysis.composeYaml ?? undefined,
        env: envFromAnalysis(analysis, variables)
      }));
      const finished = await loadFinishedAnalysis(result.analysis.id);
      setSuccess(`${finished.displayName ?? "App"} deployed and saved to My Library.`);
      await Promise.all([loadSources(), refresh()]);
    });
  }

  async function repairRegistry(registry: string) {
    if (!analysis) return;
    const host = hosts.find((candidate) => candidate.id === analysis.hostId);
    const approved = await confirm({
      title: "Trust HTTP registry",
      confirmLabel: "Back up, apply & restart",
      tone: "danger",
      message: `ComposeBastion will safely merge '${registry}' into Docker's insecure registries on ${host?.name ?? "this host"}, validate and back up the daemon config, then restart Docker. Continue?`
    });
    if (!approved) return;
    await action.run(async () => {
      await runJob(() => postJson<{ job: OperationJob }>(`/api/hosts/${analysis.hostId}/registry-trust/apply`, {
        registry,
        insecure: true
      }));
      await analyze({
        sourceId: analysis.sourceId ?? undefined,
        composePath: analysis.composePath ?? undefined,
        sourceValue: analysis.sourceInput
      });
    });
  }

  async function deploySource(sourceCard: DeploymentSource) {
    const requestedHostId = sourceTargets[sourceCard.id] ?? sourceCard.defaultHostId ?? hostId;
    const selectedHostId = hosts.some((host) => host.id === requestedHostId) ? requestedHostId : hostId;
    if (selectedHostId !== hostId) setHostId(selectedHostId);
    setSource(sourceCard.sourceLocator);
    setSourceType(sourceCard.sourceType);
    setComposeYaml("");
    await action.run(async () => {
      const result = await runJob(() => postJson<AnalysisJobResponse>("/api/deploy/analyses", {
        hostId: selectedHostId,
        source: sourceCard.sourceLocator,
        sourceId: sourceCard.id
      }));
      await loadFinishedAnalysis(result.analysis.id);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  async function removeSource(sourceCard: DeploymentSource) {
    const approved = await confirm({
      title: "Remove from My Library",
      confirmLabel: "Remove source",
      tone: "danger",
      message: `Remove '${sourceCard.name}' from My Library? Running containers and Services entries are not removed.`
    });
    if (!approved) return;
    await action.run(async () => {
      await deleteJson<{ ok: boolean }>(`/api/deployment-sources/${sourceCard.id}`);
      await loadSources();
    });
  }

  function beginSourceEdit(sourceCard: DeploymentSource) {
    setEditingSource(sourceCard);
    setSourceEdit({
      name: sourceCard.name,
      projectName: sourceCard.projectName,
      branch: sourceCard.branch ?? "",
      composePath: sourceCard.composePath ?? "",
      workingDir: sourceCard.workingDir ?? "",
      defaultHostId: sourceCard.defaultHostId ?? "",
      safeEnvironment: environmentDefaultsText(sourceCard.safeEnvironment)
    });
  }

  async function saveSourceEdit() {
    if (!editingSource) return;
    await action.run(async () => {
      await putJson(`/api/deployment-sources/${editingSource.id}`, {
        ...sourceEdit,
        branch: sourceEdit.branch || null,
        composePath: sourceEdit.composePath || null,
        workingDir: sourceEdit.workingDir || null,
        defaultHostId: sourceEdit.defaultHostId || null,
        safeEnvironment: parseEnvironmentDefaults(sourceEdit.safeEnvironment)
      });
      setEditingSource(null);
      await loadSources();
    });
  }

  const selectedHost = hosts.find((host) => host.id === hostId) ?? null;
  const requiredMissing = analysis?.variables.filter((variable) =>
    variable.required && !(variables[variable.key] ?? variable.value).trim()
  ) ?? [];
  const deployBlocked = Boolean(
    !analysis
    || analysis.status !== "ready"
    || analysis.blockers.length
    || requiredMissing.length
  );

  return (
    <div className="universalDeploy">
      <Panel title="Deploy an app">
        <div className="deployHero">
          <div>
            <h2>Paste it. We&apos;ll work out the rest.</h2>
            <p>Git repository, Compose URL, Compose YAML, or container image. ComposeBastion analyzes it on the selected host and asks only for what is missing.</p>
          </div>
          <div className="deployHost">
            <span>Deploy to</span>
            <HostSelect hosts={hosts} value={hostId} onChange={(value) => {
              setHostId(value);
              setAnalysis(null);
            }} />
          </div>
        </div>

        <form className="deploySourceForm" onSubmit={(event) => {
          event.preventDefault();
          void analyze();
        }}>
          <textarea
            aria-label="Deployment source"
            placeholder={"Paste a Git URL, Compose URL, image reference, or Compose YAML…\nExample: http://10.0.21.40:3000/kobuslabs/linuxclitogui"}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setComposeYaml("");
              setSourceType("auto");
              setAnalysis(null);
              setSuccess(null);
            }}
            required
          />
          <div className="deploySourceActions">
            <input
              ref={fileInput}
              type="file"
              accept=".yml,.yaml,application/yaml,text/yaml,text/plain"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadCompose(file);
              }}
            />
            <button type="button" onClick={() => fileInput.current?.click()}><FileUp size={17} />Upload Compose</button>
            <button className="primary" disabled={action.busy || !hostId || !source.trim()}>
              {action.busy ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}
              {action.busy ? "Working…" : "Analyze"}
            </button>
          </div>
        </form>

        <details className="deployAdvancedCredentials">
          <summary>Source type &amp; private Git credentials</summary>
          <label className="deploySourceType">
            <span>Source type</span>
            <select value={sourceType} onChange={(event) => setSourceType(event.target.value as DeploymentSourceType | "auto")}>
              <option value="auto">Detect automatically</option>
              <option value="git">Git repository</option>
              <option value="compose_url">Compose URL</option>
              <option value="compose_upload">Pasted Compose YAML</option>
              <option value="image">Container image</option>
            </select>
          </label>
          <div className="two">
            <input
              autoComplete="off"
              placeholder="Username"
              value={credentialUsername}
              onChange={(event) => setCredentialUsername(event.target.value)}
            />
            <input
              autoComplete="new-password"
              type="password"
              placeholder="Token / password"
              value={credentialSecret}
              onChange={(event) => setCredentialSecret(event.target.value)}
            />
          </div>
          <small>Host deploy keys are tried first. Credentials are encrypted, materialized only in a temporary mode-0600 file used by a protected askpass helper, and never written to the Git remote.</small>
        </details>

        {selectedHost?.connectionMode === "agent" && (
          <div className="notice warning">This is an agent host. Compose and image inputs work; Git analysis currently requires an SSH-connected host.</div>
        )}
        {action.error && <div className="notice error">{action.error}</div>}
        {success && <div className="notice success"><CheckCircle2 size={17} />{success}</div>}
      </Panel>

      {analysis && (
        <Panel title="Review deployment">
          <div className="deployReviewHeader">
            <div>
              <InlineStatus tone={analysis.blockers.length ? "danger" : "success"}>
                {analysis.blockers.length ? `${analysis.blockers.length} blocker${analysis.blockers.length === 1 ? "" : "s"}` : "Ready to deploy"}
              </InlineStatus>
              <h3>{analysis.displayName}</h3>
              <p>{sourceTypeLabel(analysis.sourceType)} → {hosts.find((host) => host.id === analysis.hostId)?.name}</p>
            </div>
            <ButtonRow>
              <button
                className="primary"
                disabled={action.busy || deployBlocked}
                onClick={() => void deploy()}
              ><Play size={18} />Deploy &amp; save</button>
            </ButtonRow>
          </div>

          <div className="deploySummaryGrid">
            <div><span>App</span><strong>{analysis.projectName}</strong></div>
            <div><span>Services</span><strong>{analysis.summary.services.length}</strong></div>
            <div><span>Ports</span><strong>{analysis.summary.services.flatMap((service) => service.ports).join(", ") || "None detected"}</strong></div>
            <div><span>Storage</span><strong>{analysis.summary.services.flatMap((service) => service.volumes).length || "None detected"}</strong></div>
          </div>

          <div className="deployServiceList">
            {analysis.summary.services.map((service) => (
              <div key={service.name}>
                <Box size={18} />
                <span><strong>{service.name}</strong><small>{service.image ?? `Build ${service.build ?? "."}`}</small></span>
                <span className="monoText">{service.ports.join(", ") || "no published ports"}</span>
              </div>
            ))}
          </div>

          {analysis.registryIssues.map((issue) => (
            <div className={`registryReadiness ${issue.trusted ? "ready" : "blocked"}`} key={issue.registry}>
              <ShieldCheck size={20} />
              <div>
                <strong>{issue.trusted ? "Registry ready" : "Registry trust required"}</strong>
                <span>{issue.message}</span>
              </div>
              {!issue.trusted && issue.canApply && (
                <button type="button" onClick={() => void repairRegistry(issue.registry)} disabled={action.busy}>
                  Repair safely
                </button>
              )}
              {!issue.trusted && !issue.canApply && (
                <small>Add <code>{issue.registry}</code> to <code>insecure-registries</code> in <code>/etc/docker/daemon.json</code>, then restart Docker.</small>
              )}
            </div>
          ))}

          {analysis.blockers.map((blocker) => (
            <div className="notice error deployNotice" key={blocker.code}><AlertTriangle size={17} />{blocker.message}</div>
          ))}
          {analysis.warnings.map((warning) => (
            <div className="notice warning deployNotice" key={warning.code}><AlertTriangle size={17} />{warning.message}</div>
          ))}

          {analysis.summary.composeCandidates.length > 1 && (
            <div className="composeCandidatePicker">
              <label>
                <span>Compose file</span>
                <select
                  value={analysis.composePath ?? ""}
                  onChange={(event) => void analyze({ composePath: event.target.value, sourceValue: analysis.sourceInput })}
                  disabled={action.busy}
                >
                  {analysis.summary.composeCandidates.map((candidate) => <option key={candidate}>{candidate}</option>)}
                </select>
              </label>
              <small>Selecting a file runs analysis again.</small>
            </div>
          )}

          {analysis.variables.length > 0 && (
            <section className="deployVariables">
              <h4>Configuration</h4>
              <div className="deployVariableGrid">
                {analysis.variables.map((variable) => (
                  <label key={variable.key}>
                    <span>{variable.key}{variable.required ? " *" : ""}</span>
                    <input
                      type={variable.secret ? "password" : "text"}
                      autoComplete={variable.secret ? "new-password" : "off"}
                      placeholder={variable.secret ? "Required secret" : variable.defaultValue ?? "Optional"}
                      value={variables[variable.key] ?? ""}
                      onChange={(event) => setVariables({ ...variables, [variable.key]: event.target.value })}
                    />
                    <small>{variable.secret ? "Encrypted at rest" : variable.defaultValue ? "Default detected" : variable.source.replace("_", " ")}</small>
                  </label>
                ))}
              </div>
              {requiredMissing.length > 0 && (
                <div className="notice warning">Enter {requiredMissing.map((variable) => variable.key).join(", ")} before deploying.</div>
              )}
            </section>
          )}

          <details className="deployAdvancedReview">
            <summary>Advanced deployment settings</summary>
            <div className="two">
              <label><span>Project name</span><input value={analysis.projectName ?? ""} onChange={(event) => setAnalysis({ ...analysis, projectName: event.target.value })} /></label>
              <label><span>Branch</span><input value={analysis.branch ?? ""} onChange={(event) => setAnalysis({ ...analysis, branch: event.target.value || null })} /></label>
            </div>
            <div className="two">
              <label><span>Working directory</span><input className="monoText" value={analysis.workingDir ?? ""} onChange={(event) => setAnalysis({ ...analysis, workingDir: event.target.value })} /></label>
              <label><span>Compose path</span><input className="monoText" value={analysis.composePath ?? ""} onChange={(event) => setAnalysis({ ...analysis, composePath: event.target.value })} /></label>
            </div>
            <label>
              <span>Compose YAML</span>
              <textarea
                className="monoTextarea composeEditor"
                value={analysis.composeYaml ?? ""}
                readOnly={analysis.sourceType === "git" && !analysis.summary.dockerfileGenerated}
                onChange={(event) => setAnalysis({ ...analysis, composeYaml: event.target.value })}
              />
              {analysis.sourceType === "git" && !analysis.summary.dockerfileGenerated && (
                <small>This Compose file is managed by Git. Change it in the repository, then analyze again.</small>
              )}
            </label>
          </details>
        </Panel>
      )}

      <Panel title={<><Library size={18} /> My Library</>} count={sources.length}>
        <div className="formHint">Every successful deployment is saved here. Re-analyze it, deploy to another host, or change safe defaults without touching running containers.</div>
        {sources.length === 0 ? (
          <EmptyState headline="Your app library is empty" hint="Deploy your first source and it will appear here automatically." />
        ) : (
          <div className="deploymentLibraryGrid">
            {sources.map((sourceCard) => (
              <article key={sourceCard.id} className="deploymentSourceCard">
                {editingSource?.id === sourceCard.id ? (
                  <>
                    <label><span>Name</span><input value={sourceEdit.name} onChange={(event) => setSourceEdit({ ...sourceEdit, name: event.target.value })} /></label>
                    <label><span>Project</span><input value={sourceEdit.projectName} onChange={(event) => setSourceEdit({ ...sourceEdit, projectName: event.target.value })} /></label>
                    {sourceCard.sourceType === "git" && <label><span>Branch</span><input value={sourceEdit.branch} onChange={(event) => setSourceEdit({ ...sourceEdit, branch: event.target.value })} /></label>}
                    {(sourceCard.sourceType === "git" || sourceCard.sourceType.startsWith("compose")) && <label><span>Compose path</span><input value={sourceEdit.composePath} onChange={(event) => setSourceEdit({ ...sourceEdit, composePath: event.target.value })} /></label>}
                    <label><span>Working directory</span><input className="monoText" value={sourceEdit.workingDir} onChange={(event) => setSourceEdit({ ...sourceEdit, workingDir: event.target.value })} /></label>
                    <label>
                      <span>Safe environment defaults</span>
                      <textarea
                        className="monoTextarea"
                        placeholder="SETTING=value"
                        value={sourceEdit.safeEnvironment}
                        onChange={(event) => setSourceEdit({ ...sourceEdit, safeEnvironment: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Default host</span>
                      <HostSelect hosts={hosts} value={sourceEdit.defaultHostId} onChange={(defaultHostId) => setSourceEdit({ ...sourceEdit, defaultHostId })} />
                    </label>
                    <ButtonRow>
                      <button className="primary" onClick={() => void saveSourceEdit()}>Save defaults</button>
                      <button onClick={() => setEditingSource(null)}>Cancel</button>
                    </ButtonRow>
                  </>
                ) : (
                  <>
                    <header>
                      <span className="deploymentSourceIcon">{sourceCard.sourceType === "git" ? <GitBranch size={19} /> : <Box size={19} />}</span>
                      <div><strong>{sourceCard.name}</strong><small>{sourceTypeLabel(sourceCard.sourceType)}</small></div>
                    </header>
                    <code title={sourceCard.sourceLocator}>{sourceCard.sourceLocator}</code>
                    <dl>
                      <div><dt>Project</dt><dd>{sourceCard.projectName}</dd></div>
                      <div><dt>Last deployed</dt><dd>{sourceCard.lastDeployedAt ? new Date(sourceCard.lastDeployedAt).toLocaleString() : "Not yet"}</dd></div>
                      <div>
                        <dt>Used on</dt>
                        <dd>{sourceCard.targetHostIds.map((targetHostId) => hosts.find((host) => host.id === targetHostId)?.name).filter(Boolean).join(", ") || "No hosts yet"}</dd>
                      </div>
                    </dl>
                    <label>
                      <span>Deploy to</span>
                      <HostSelect
                        hosts={hosts}
                        value={sourceTargets[sourceCard.id] ?? sourceCard.defaultHostId ?? hostId}
                        onChange={(targetHostId) => setSourceTargets({ ...sourceTargets, [sourceCard.id]: targetHostId })}
                      />
                    </label>
                    <ButtonRow>
                      <button className="primary" onClick={() => void deploySource(sourceCard)} disabled={action.busy}><Play size={16} />Analyze / Deploy</button>
                      <button title="Edit safe defaults" onClick={() => beginSourceEdit(sourceCard)}><Pencil size={16} /></button>
                      <button className="danger" title="Remove from library" onClick={() => void removeSource(sourceCard)}><Trash2 size={16} /></button>
                    </ButtonRow>
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
