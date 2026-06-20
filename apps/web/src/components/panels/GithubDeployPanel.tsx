import { useEffect, useState } from "react";
import { FileText, FolderOpen, GitBranch, Github, Pencil, Play, RefreshCw, Save, Trash2, Wand2, X } from "lucide-react";
import type { ComposeStack, DockerHost, GithubRepository, OperationJob } from "@dockermender/shared";
import { api, deleteJson, postJson, putJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { composeVariableOverrides, upsertEnvValue } from "../../lib/composeVariables.js";
import { generateSingleImageCompose, imageBaseName, imageWithDefaultLatest, normalizeComposeServiceName } from "../../lib/deployCompose.js";
import { formatDate } from "../../lib/format.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { normalizeComposeProjectName } from "../../lib/hostScope.js";
import { defaultHostDirectory, remoteJoin } from "../../lib/remotePaths.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { ButtonRow, DataTable, Panel } from "../ui/primitives.js";

function repoNameFromUrl(url: string) {
  const cleaned = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const lastSegment = cleaned.split(/[/:]/).filter(Boolean).at(-1) ?? "";
  return normalizeComposeProjectName(lastSegment);
}

function defaultDeployRoot(host: DockerHost) {
  return host.connectionMode === "agent" ? "/tmp/dockermender/apps" : remoteJoin(defaultHostDirectory(host), "apps");
}

function defaultDeployDirectory(host: DockerHost, projectName: string) {
  return remoteJoin(defaultDeployRoot(host), normalizeComposeProjectName(projectName) || "app");
}

function composeFilePath(workingDir: string, composePath: string) {
  const file = composePath.trim() || "docker-compose.yml";
  return file.startsWith("/") ? file : remoteJoin(workingDir, file);
}

type GeneratedComposeDraft = {
  projectName: string;
  composeYaml: string;
  pullBeforeDeploy: boolean;
};

function ImageComposeGenerator({ onGenerate }: { onGenerate: (draft: GeneratedComposeDraft) => void }) {
  const [form, setForm] = useState({
    image: "",
    serviceName: "",
    projectName: "",
    restartPolicy: "unless-stopped",
    ports: "",
    env: "",
    volumes: "",
    command: "",
    alwaysPullLatest: true
  });

  function applyImage(value: string) {
    const base = imageBaseName(value);
    setForm((current) => ({
      ...current,
      image: value,
      serviceName: current.serviceName || normalizeComposeServiceName(base),
      projectName: current.projectName || normalizeComposeProjectName(base)
    }));
  }

  function generate(event: React.FormEvent) {
    event.preventDefault();
    const image = imageWithDefaultLatest(form.image);
    const serviceName = normalizeComposeServiceName(form.serviceName || imageBaseName(image));
    const projectName = normalizeComposeProjectName(form.projectName || serviceName) || "app";
    onGenerate({
      projectName,
      pullBeforeDeploy: form.alwaysPullLatest,
      composeYaml: generateSingleImageCompose({
        ...form,
        image,
        serviceName
      })
    });
  }

  return (
    <form className="subPanel composeForm" onSubmit={generate}>
      <h3><Wand2 size={16} /> Image to Compose</h3>
      <div className="formHint">Generate a single-service Compose file, then review or edit it before deploying to a folder.</div>
      <div className="two">
        <input placeholder="Image, e.g. ghcr.io/example/app" value={form.image} onChange={(event) => applyImage(event.target.value)} required />
        <input placeholder="Service name" value={form.serviceName} onChange={(event) => setForm({ ...form, serviceName: normalizeComposeServiceName(event.target.value) })} />
      </div>
      <div className="two">
        <input placeholder="Project name" value={form.projectName} onChange={(event) => setForm({ ...form, projectName: normalizeComposeProjectName(event.target.value) })} />
        <select value={form.restartPolicy} onChange={(event) => setForm({ ...form, restartPolicy: event.target.value })}>
          <option value="unless-stopped">unless-stopped</option>
          <option value="always">always</option>
          <option value="on-failure">on-failure</option>
          <option value="no">no restart</option>
        </select>
      </div>
      <textarea placeholder={"Ports, one per line: 8080:80"} value={form.ports} onChange={(event) => setForm({ ...form, ports: event.target.value })} />
      <textarea placeholder={"Environment, one per line: KEY=value"} value={form.env} onChange={(event) => setForm({ ...form, env: event.target.value })} />
      <textarea placeholder={"Volumes, one per line: volume:/path[:ro]"} value={form.volumes} onChange={(event) => setForm({ ...form, volumes: event.target.value })} />
      <input placeholder="Optional command" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} />
      <label className="checkLine">
        <input type="checkbox" checked={form.alwaysPullLatest} onChange={(event) => setForm({ ...form, alwaysPullLatest: event.target.checked })} />
        <span>Always pull latest image before deploy</span>
      </label>
      <ButtonRow>
        <button className="primary"><Wand2 size={18} />Generate Compose</button>
      </ButtonRow>
    </form>
  );
}

function FolderComposeDeployForm({
  hosts,
  refresh,
  runJob
}: {
  hosts: DockerHost[];
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [form, setForm] = useState({
    projectName: "app",
    workingDir: "",
    composePath: "docker-compose.yml",
    composeYaml: "services:\n  app:\n    image: nginx:alpine\n",
    env: "",
    pullBeforeDeploy: false
  });
  const [workingDirTouched, setWorkingDirTouched] = useState(false);
  const host = hosts.find((entry) => entry.id === hostId) ?? hosts[0] ?? null;

  useEffect(() => {
    if (!hostId && hosts[0]?.id) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  useEffect(() => {
    if (!host || workingDirTouched) return;
    setForm((current) => ({ ...current, workingDir: defaultDeployDirectory(host, current.projectName) }));
  }, [host, form.projectName, workingDirTouched]);

  function patchProjectName(value: string) {
    const projectName = normalizeComposeProjectName(value);
    setForm((current) => ({
      ...current,
      projectName,
      workingDir: host && !workingDirTouched ? defaultDeployDirectory(host, projectName) : current.workingDir
    }));
  }

  function applyGenerated(draft: GeneratedComposeDraft) {
    setForm((current) => ({
      ...current,
      projectName: draft.projectName,
      workingDir: host && !workingDirTouched ? defaultDeployDirectory(host, draft.projectName) : current.workingDir,
      composeYaml: draft.composeYaml,
      pullBeforeDeploy: draft.pullBeforeDeploy
    }));
  }

  async function pathExists(path: string) {
    if (!hostId) return false;
    const result = await api<{ file: { exists: boolean } }>(`/api/hosts/${hostId}/files/exists?path=${encodeURIComponent(path)}`);
    return result.file.exists;
  }

  async function deploy(event: React.FormEvent) {
    event.preventDefault();
    if (!hostId || !form.projectName) return;
    await action.run(async () => {
      const composePath = composeFilePath(form.workingDir, form.composePath);
      const conflicts: string[] = [];
      if (await pathExists(composePath)) conflicts.push(composePath);
      if (form.env.trim()) {
        const envPath = remoteJoin(form.workingDir, ".env");
        if (await pathExists(envPath)) conflicts.push(envPath);
      }
      if (conflicts.length > 0) {
        const ok = await confirm({
          title: "Replace existing files",
          tone: "danger",
          confirmLabel: "Overwrite",
          message: `Replace ${conflicts.join(", ")} on ${host?.name ?? "the selected host"}?`
        });
        if (!ok) return;
      }
      await runJob(() => postJson<JobResult>(`/api/hosts/${hostId}/actions`, {
        type: "compose.writeDeployPath",
        payload: {
          projectName: form.projectName,
          workingDir: form.workingDir,
          composePath: form.composePath.trim() || "docker-compose.yml",
          composeYaml: form.composeYaml,
          env: form.env.trim() ? form.env : undefined,
          overwrite: conflicts.length > 0,
          pullBeforeDeploy: form.pullBeforeDeploy
        }
      }));
      await refresh();
    });
  }

  return (
    <>
      <ImageComposeGenerator onGenerate={applyGenerated} />
      <form className="subPanel composeForm" onSubmit={deploy}>
        <h3><FolderOpen size={16} /> Compose YAML to Folder</h3>
        <div className="formHint">Writes Compose YAML to the selected host folder, then runs docker compose from that folder. Agent hosts deploy under /tmp/dockermender.</div>
        <div className="two">
          <HostSelect hosts={hosts} value={hostId} onChange={(nextHostId) => {
            setHostId(nextHostId);
            const nextHost = hosts.find((entry) => entry.id === nextHostId);
            if (nextHost && !workingDirTouched) {
              setForm((current) => ({ ...current, workingDir: defaultDeployDirectory(nextHost, current.projectName) }));
            }
          }} />
          <input placeholder="Project name" value={form.projectName} onChange={(event) => patchProjectName(event.target.value)} required />
        </div>
        <div className="two">
          <input
            className="monoText"
            placeholder={host?.connectionMode === "agent" ? "/tmp/dockermender/apps/app" : "/home/user/apps/app"}
            value={form.workingDir}
            onChange={(event) => { setForm({ ...form, workingDir: event.target.value }); setWorkingDirTouched(true); }}
            required
          />
          <input placeholder="docker-compose.yml" value={form.composePath} onChange={(event) => setForm({ ...form, composePath: event.target.value })} required />
        </div>
        <textarea className="monoTextarea composeEditor" value={form.composeYaml} onChange={(event) => setForm({ ...form, composeYaml: event.target.value })} required />
        <textarea className="monoTextarea envEditor" placeholder="Optional .env content" value={form.env} onChange={(event) => setForm({ ...form, env: event.target.value })} />
        <label className="checkLine">
          <input type="checkbox" checked={form.pullBeforeDeploy} onChange={(event) => setForm({ ...form, pullBeforeDeploy: event.target.checked })} />
          <span>Pull images before deploy</span>
        </label>
        {action.error && <div className="notice error">{action.error}</div>}
        <ButtonRow>
          <button className="primary" disabled={action.busy || !hostId || !form.projectName}><Play size={18} />Write &amp; Deploy</button>
        </ButtonRow>
      </form>
    </>
  );
}

function GitCloneDeployForm({
  hosts,
  refresh,
  runJob
}: {
  hosts: DockerHost[];
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const action = useAsyncAction();
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [directory, setDirectory] = useState("");
  const [composePath, setComposePath] = useState("docker-compose.yml");
  const [projectName, setProjectName] = useState("");
  const [directoryTouched, setDirectoryTouched] = useState(false);
  const [projectTouched, setProjectTouched] = useState(false);

  const host = hosts.find((entry) => entry.id === hostId) ?? hosts[0] ?? null;

  useEffect(() => {
    if (!hostId && hosts[0]?.id) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  function onUrlChange(url: string) {
    setRepositoryUrl(url);
    const repoName = repoNameFromUrl(url);
    if (repoName && !projectTouched) setProjectName(repoName);
    if (repoName && !directoryTouched && host) {
      setDirectory(remoteJoin(remoteJoin(defaultHostDirectory(host), "apps"), repoName));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!hostId) return;
    await action.run(async () => {
      await runJob(() => postJson<JobResult>(`/api/hosts/${hostId}/actions`, {
        type: "git.cloneDeploy",
        payload: {
          repositoryUrl: repositoryUrl.trim(),
          directory: directory.trim(),
          branch: branch.trim() || undefined,
          composePath: composePath.trim() || "docker-compose.yml",
          projectName
        }
      }));
      await refresh();
    });
  }

  return (
    <form className="subPanel composeForm" onSubmit={submit}>
      <h3><GitBranch size={16} /> Clone &amp; Deploy any Git repository</h3>
      <div className="formHint">
        Clones the repository onto the Docker host (or pulls if the folder already exists), then runs
        <code> docker compose up -d</code> from that folder. The folder stays on the host, so future updates are a
        pull + redeploy with the Update button on the Services page. Works with any Git URL the host can reach,
        including private repos when the host has a deploy key.
      </div>
      <div className="two">
        <HostSelect hosts={hosts} value={hostId} onChange={setHostId} />
        <input
          placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git"
          value={repositoryUrl}
          onChange={(event) => onUrlChange(event.target.value)}
          required
        />
      </div>
      <div className="two">
        <input placeholder="Branch, optional" value={branch} onChange={(event) => setBranch(event.target.value)} />
        <input
          className="monoText"
          placeholder="/home/user/apps/repo"
          value={directory}
          onChange={(event) => { setDirectory(event.target.value); setDirectoryTouched(true); }}
          required
        />
      </div>
      <div className="two">
        <input placeholder="docker-compose.yml" value={composePath} onChange={(event) => setComposePath(event.target.value)} required />
        <input
          placeholder="project name"
          value={projectName}
          onChange={(event) => { setProjectName(normalizeComposeProjectName(event.target.value)); setProjectTouched(true); }}
          required
        />
      </div>
      {action.error && <div className="notice error">{action.error}</div>}
      <ButtonRow>
        <button className="primary" disabled={action.busy || !hostId || !projectName}><Play size={18} />Clone &amp; Deploy</button>
      </ButtonRow>
    </form>
  );
}

export function GithubDeployPanel({
  hosts,
  scopeHosts,
  repositories,
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
  type RepoForm = {
    name: string;
    repositoryUrl: string;
    branch: string;
    composePath: string;
    projectName: string;
    defaultHostId: string;
    githubToken: string;
    env: string;
  };
  type ComposePreview = {
    repoId: string;
    repoName: string;
    hostId: string;
    deployToScope: boolean;
    branch: string;
    projectName: string;
    composeYaml: string;
    env: string;
  };
  type ComposePreviewResponse = {
    repository: GithubRepository;
    branch: string;
    composeYaml: string;
    projectName: string;
    env: string;
  };

  const emptyForm = (defaultHostId = ""): RepoForm => ({
    name: "",
    repositoryUrl: "",
    branch: "main",
    composePath: "docker-compose.yml",
    projectName: "",
    defaultHostId,
    githubToken: "",
    env: ""
  });

  const action = useAsyncAction();
  const [form, setForm] = useState<RepoForm>(() => emptyForm(hosts[0]?.id ?? ""));
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [deployHost, setDeployHost] = useState<Record<string, string>>({});
  const [deployBranch, setDeployBranch] = useState<Record<string, string>>({});
  const [deployPreview, setDeployPreview] = useState<ComposePreview | null>(null);
  const [formBranches, setFormBranches] = useState<string[]>([]);
  const [repoBranches, setRepoBranches] = useState<Record<string, string[]>>({});
  const [branchError, setBranchError] = useState<string | null>(null);

  useEffect(() => {
    const firstHostId = hosts[0]?.id;
    if (!form.defaultHostId && firstHostId) setForm((value) => ({ ...value, defaultHostId: firstHostId }));
  }, [hosts, form.defaultHostId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const payload = {
        ...form,
        projectName: form.projectName ? normalizeComposeProjectName(form.projectName) : undefined,
        defaultHostId: form.defaultHostId || undefined,
        githubToken: form.githubToken || undefined
      };
      if (editingRepoId) {
        await putJson(`/api/github/repos/${editingRepoId}`, payload);
      } else {
        await postJson("/api/github/repos", payload);
      }
      resetForm();
      await refresh();
    });
  }

  function resetForm() {
    setEditingRepoId(null);
    setForm(emptyForm(hosts[0]?.id ?? ""));
    setFormBranches([]);
    setBranchError(null);
  }

  function startEdit(repo: GithubRepository) {
    setEditingRepoId(repo.id);
    setForm({
      name: repo.name,
      repositoryUrl: repo.repositoryUrl,
      branch: repo.branch,
      composePath: repo.composePath,
      projectName: normalizeComposeProjectName(repo.projectName),
      defaultHostId: repo.defaultHostId ?? hosts[0]?.id ?? "",
      githubToken: "",
      env: repo.env ?? ""
    });
    setFormBranches(repoBranches[repo.id] ?? []);
    setBranchError(null);
  }

  async function loadFormBranches() {
    setBranchError(null);
    try {
      const result = await postJson<{ branches: string[] }>("/api/github/branches", {
        repositoryUrl: form.repositoryUrl,
        githubToken: form.githubToken || undefined
      });
      setFormBranches(result.branches);
      if (result.branches.length > 0 && !result.branches.includes(form.branch)) {
        setForm({ ...form, branch: result.branches[0] ?? form.branch });
      }
    } catch (caught) {
      setBranchError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function loadRepoBranches(repo: GithubRepository) {
    setBranchError(null);
    try {
      const result = await api<{ branches: string[] }>(`/api/github/repos/${repo.id}/branches`);
      setRepoBranches((current) => ({ ...current, [repo.id]: result.branches }));
      setDeployBranch((current) => current[repo.id] ? current : { ...current, [repo.id]: repo.branch });
    } catch (caught) {
      setBranchError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function deleteRepo(repo: GithubRepository) {
    if (!await confirm({
      title: "Delete tracked repository",
      tone: "danger",
      confirmLabel: "Delete",
      message: `Delete tracked repo "${repo.name}"? This does not remove containers from Docker.`
    })) return;
    await action.run(async () => {
      await deleteJson<{ ok: boolean }>(`/api/github/repos/${repo.id}`);
      if (editingRepoId === repo.id) resetForm();
      if (deployPreview?.repoId === repo.id) setDeployPreview(null);
      await refresh();
    });
  }

  async function openDeployPreview(repo: GithubRepository) {
    const branch = deployBranch[repo.id] ?? repo.branch;
    const hostId = deployHost[repo.id] ?? repo.defaultHostId ?? hosts[0]?.id ?? "";
    await action.run(async () => {
      const result = await api<ComposePreviewResponse>(`/api/github/repos/${repo.id}/compose?branch=${encodeURIComponent(branch)}`);
      setDeployPreview({
        repoId: repo.id,
        repoName: repo.name,
        hostId,
        deployToScope: false,
        branch: result.branch,
        projectName: normalizeComposeProjectName(result.projectName || repo.projectName || repo.repo) || "github-stack",
        composeYaml: result.composeYaml,
        env: result.env ?? ""
      });
    });
  }

  async function deployCustomizedCompose() {
    if (!deployPreview) return;
    const targetHostIds = deployPreview.deployToScope ? scopeHosts.map((host) => host.id) : [deployPreview.hostId];
    await action.run(async () => {
      await runJob(async () => {
        const results = await Promise.all(targetHostIds.map((hostId) => postJson<{ stack: ComposeStack; job: OperationJob }>(`/api/github/repos/${deployPreview.repoId}/deploy`, {
          hostId,
          branch: deployPreview.branch,
          projectName: deployPreview.projectName,
          composeYaml: deployPreview.composeYaml,
          env: deployPreview.env
        })));
        return { jobs: results.map((result) => result.job) };
      });
      setDeployPreview(null);
    });
  }

  const deployVariableOverrides = deployPreview ? composeVariableOverrides(deployPreview.composeYaml, deployPreview.env) : [];
  const SubmitIcon = editingRepoId ? Save : Github;

  return (
    <Panel title="Deploy" count={repositories.length}>
      <FolderComposeDeployForm hosts={hosts} refresh={refresh} runJob={runJob} />
      <GitCloneDeployForm hosts={hosts} refresh={refresh} runJob={runJob} />
      <h3 className="panelSectionTitle"><Github size={16} /> Tracked GitHub repositories</h3>
      <div className="formHint">
        Track a GitHub repository to deploy its compose file straight from the GitHub API (no clone on the host),
        preview and customize the YAML before deploying, and get commit-based update checks. Private repositories work
        with a fine-grained GitHub token that has read-only Contents access; Dockermender encrypts the token and never
        shows it again. When editing a repo, leave the token blank to keep the saved token.
      </div>
      <form className="composeForm" onSubmit={save}>
        <div className="two">
          <input placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          <input placeholder="https://github.com/owner/repo" value={form.repositoryUrl} onChange={(event) => { setForm({ ...form, repositoryUrl: event.target.value }); setFormBranches([]); }} required />
        </div>
        <div className="two">
          <div className="branchPicker">
            {formBranches.length > 0 ? (
              <select value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })}>
                {formBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
              </select>
            ) : (
              <input placeholder="Branch" value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} required />
            )}
            <button type="button" onClick={() => void loadFormBranches()}><RefreshCw size={16} />Branches</button>
          </div>
          <input placeholder="Compose path" value={form.composePath} onChange={(event) => setForm({ ...form, composePath: event.target.value })} required />
        </div>
        <div className="two">
          <input placeholder="Project name, lowercase" value={form.projectName} onChange={(event) => setForm({ ...form, projectName: normalizeComposeProjectName(event.target.value) })} />
          <HostSelect hosts={hosts} value={form.defaultHostId} onChange={(defaultHostId) => setForm({ ...form, defaultHostId })} />
        </div>
        <input
          placeholder="Fine-grained GitHub token for private repos, Contents: Read-only"
          type="password"
          autoComplete="off"
          value={form.githubToken}
          onChange={(event) => { setForm({ ...form, githubToken: event.target.value }); setFormBranches([]); }}
        />
        <textarea placeholder="Optional .env content" value={form.env} onChange={(event) => setForm({ ...form, env: event.target.value })} />
        {(branchError || action.error) && <div className="notice error">{branchError ?? action.error}</div>}
        <ButtonRow>
          <button className="primary" disabled={action.busy}><SubmitIcon size={18} />{editingRepoId ? "Save Repo" : "Track Repo"}</button>
          {editingRepoId && <button type="button" onClick={resetForm}><X size={16} />Cancel</button>}
        </ButtonRow>
      </form>
      {deployPreview && (
        <div className="subPanel deployPreview">
          <div className="previewHeader">
            <div>
              <strong>Customize Deployment</strong>
              <small>{deployPreview.repoName} - {deployPreview.branch}</small>
            </div>
            <button type="button" title="Close preview" onClick={() => setDeployPreview(null)}><X size={16} /></button>
          </div>
          <div className="two">
            <HostSelect hosts={hosts} value={deployPreview.hostId} onChange={(hostId) => setDeployPreview({ ...deployPreview, hostId })} />
            <input value={deployPreview.projectName} onChange={(event) => setDeployPreview({ ...deployPreview, projectName: normalizeComposeProjectName(event.target.value) })} required />
          </div>
          {scopeHosts.length > 1 && (
            <label className="checkLine deployScopeToggle">
              <input
                type="checkbox"
                checked={deployPreview.deployToScope}
                onChange={(event) => setDeployPreview({ ...deployPreview, deployToScope: event.target.checked })}
              />
              <span>Deploy to current scope ({scopeHosts.length} hosts)</span>
            </label>
          )}
          <textarea className="monoTextarea composeEditor" value={deployPreview.composeYaml} onChange={(event) => setDeployPreview({ ...deployPreview, composeYaml: event.target.value })} />
          <div className="formHint">This edited Compose YAML is what Dockermender deploys. Variable override fields only write .env values; delete or change placeholders in the YAML when you want the YAML itself to control ports, images, volumes, or build settings.</div>
          {deployVariableOverrides.length > 0 && (
            <div className="variableOverridePanel">
              <div>
                <strong>Compose variable overrides</strong>
                <small>Values are written to .env before Compose deploys and work for any variable in this file, including ports, image tags, secrets, and service environment.</small>
              </div>
              <div className="variableOverrideGrid">
                {deployVariableOverrides.map((variable) => (
                  <label key={variable.key}>
                    <span>{variable.containerPort ? `${variable.key} -> container ${variable.containerPort}` : variable.key}</span>
                    <input
                      inputMode={variable.containerPort ? "numeric" : undefined}
                      placeholder={variable.defaultValue || "value"}
                      value={variable.value}
                      onChange={(event) => setDeployPreview({
                        ...deployPreview,
                        env: upsertEnvValue(deployPreview.env, variable.key, event.target.value)
                      })}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          <textarea className="monoTextarea envEditor" placeholder="Optional .env content" value={deployPreview.env} onChange={(event) => setDeployPreview({ ...deployPreview, env: event.target.value })} />
          <ButtonRow>
            <button type="button" className="primary" disabled={action.busy || !deployPreview.projectName || !deployPreview.composeYaml} onClick={() => void deployCustomizedCompose()}><Play size={18} />Deploy Customized</button>
            <button type="button" onClick={() => setDeployPreview(null)}><X size={16} />Close</button>
          </ButtonRow>
        </div>
      )}
      <DataTable
        rows={repositories}
        columns={["Name", "Repository", "Branch", "Compose", "Project", "Last Deploy", "Actions"]}
        render={(repo) => [
          repo.name,
          `${repo.owner}/${repo.repo}`,
          repo.branch,
          repo.composePath,
          repo.projectName,
          repo.lastDeployedAt ? formatDate(repo.lastDeployedAt) : repo.lastError ?? "",
          <div className="deployActions" key="actions">
            <select value={deployBranch[repo.id] ?? repo.branch} onChange={(event) => setDeployBranch({ ...deployBranch, [repo.id]: event.target.value })}>
              {(repoBranches[repo.id] ?? [repo.branch]).map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
            <HostSelect hosts={hosts} value={deployHost[repo.id] ?? repo.defaultHostId ?? hosts[0]?.id ?? ""} onChange={(hostId) => setDeployHost({ ...deployHost, [repo.id]: hostId })} />
            <button type="button" title="Load branches" onClick={() => void loadRepoBranches(repo)}><RefreshCw size={16} /></button>
            <button type="button" title="Preview and customize compose" onClick={() => void openDeployPreview(repo)}><FileText size={16} /></button>
            <button type="button" title="Edit repo" onClick={() => startEdit(repo)}><Pencil size={16} /></button>
            <button type="button" title="Delete repo" className="danger" onClick={() => void deleteRepo(repo)}><Trash2 size={16} /></button>
          </div>
        ]}
      />
    </Panel>
  );
}
