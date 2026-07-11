import { useCallback, useEffect, useState } from "react";
import { Database, FilePlus, GitBranch, Pencil, Play, Plus, RefreshCw, Save, X } from "lucide-react";
import type { DockerHost } from "@composebastion/shared";
import { api, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { formatBytes } from "../../lib/format.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { emptyCompose } from "../../lib/navigation.js";
import { normalizeComposeProjectName } from "../../lib/hostScope.js";
import { defaultHostDirectory, remoteBaseName, remoteDirName, remoteJoin } from "../../lib/remotePaths.js";
import { ButtonRow, DataTable, Field, Panel } from "../ui/primitives.js";
import { HostSelect } from "../dashboard/HostSelect.js";

export type HostDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "link";
  size: number;
  modified: string;
};

export type HostDirectory = {
  path: string;
  parent: string | null;
  entries: HostDirectoryEntry[];
};

function isDemoHost(host: DockerHost) {
  return host.tags.includes("demo");
}

function canBrowseFiles(host: DockerHost) {
  return host.connectionMode === "ssh" || isDemoHost(host);
}

function isComposeFilePath(value: string) {
  return /compose.*\.ya?ml$|\.compose\.ya?ml$/i.test(remoteBaseName(value));
}

export function HostFilesPanel({
  host,
  hosts,
  onHostChange,
  runJob,
  refresh
}: {
  host: DockerHost;
  hosts: DockerHost[];
  onHostChange: (hostId: string) => void;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  refresh: () => Promise<void>;
}) {
  const [directoryPath, setDirectoryPath] = useState(defaultHostDirectory(host));
  const [directory, setDirectory] = useState<HostDirectory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newFolderPath, setNewFolderPath] = useState(remoteJoin(defaultHostDirectory(host), "app"));
  const [cloneForm, setCloneForm] = useState({ repositoryUrl: "", directory: remoteJoin(defaultHostDirectory(host), "repo"), branch: "", shallow: true });
  const [deployForm, setDeployForm] = useState({ workingDir: defaultHostDirectory(host), composePath: "docker-compose.yml", projectName: "" });
  const [editor, setEditor] = useState<{ path: string; content: string } | null>(null);
  const action = useAsyncAction();

  const supported = canBrowseFiles(host);

  const loadDirectory = useCallback(async (nextPath: string) => {
    setLoadError(null);
    const result = await api<{ directory: HostDirectory }>(`/api/hosts/${host.id}/files?path=${encodeURIComponent(nextPath)}`);
    setDirectory(result.directory);
    setDirectoryPath(result.directory.path);
  }, [host.id]);

  useEffect(() => {
    const home = defaultHostDirectory(host);
    setDirectoryPath(home);
    setNewFolderPath(remoteJoin(home, "app"));
    setCloneForm({ repositoryUrl: "", directory: remoteJoin(home, "repo"), branch: "", shallow: true });
    setDeployForm({ workingDir: home, composePath: "docker-compose.yml", projectName: "" });
    setEditor(null);
    setDirectory(null);
    setLoadError(null);
  }, [host.id, host.username]);

  useEffect(() => {
    if (!supported) return;
    void loadDirectory(defaultHostDirectory(host)).catch((error) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [host.id, host.username, loadDirectory, supported]);

  async function createFolder(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      await runJob(() => postJson<JobResult>(`/api/hosts/${host.id}/actions`, { type: "host.mkdir", payload: { path: newFolderPath } }));
      await loadDirectory(remoteDirName(newFolderPath));
    });
  }

  async function cloneRepository(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      await runJob(() => postJson<JobResult>(`/api/hosts/${host.id}/actions`, {
        type: "git.clone",
        payload: {
          repositoryUrl: cloneForm.repositoryUrl,
          directory: cloneForm.directory,
          branch: cloneForm.branch || undefined,
          shallow: cloneForm.shallow
        }
      }));
      await loadDirectory(remoteDirName(cloneForm.directory));
    });
  }

  async function deployFromFolder(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      await runJob(() => postJson<JobResult>(`/api/hosts/${host.id}/actions`, {
        type: "compose.deployPath",
        payload: {
          projectName: deployForm.projectName,
          workingDir: deployForm.workingDir,
          composePath: deployForm.composePath
        }
      }));
      await refresh();
    });
  }

  async function openFile(path: string) {
    await action.run(async () => {
      const result = await api<{ file: { path: string; content: string } }>(`/api/hosts/${host.id}/files/read?path=${encodeURIComponent(path)}`);
      setEditor(result.file);
    });
  }

  async function saveFile(event: React.FormEvent) {
    event.preventDefault();
    if (!editor) return;
    await action.run(async () => {
      await postJson(`/api/hosts/${host.id}/files/write`, editor);
      await loadDirectory(remoteDirName(editor.path));
    });
  }

  async function saveAndDeployFile() {
    if (!editor) return;
    await action.run(async () => {
      await postJson(`/api/hosts/${host.id}/files/write`, editor);
      const workingDir = remoteDirName(editor.path);
      const composePath = remoteBaseName(editor.path);
      await runJob(() => postJson<JobResult>(`/api/hosts/${host.id}/actions`, {
        type: "compose.deployPath",
        payload: {
          projectName: normalizeComposeProjectName(remoteBaseName(workingDir)) || "stack",
          workingDir,
          composePath
        }
      }));
      setDeployForm({
        workingDir,
        composePath,
        projectName: normalizeComposeProjectName(remoteBaseName(workingDir)) || "stack"
      });
      await loadDirectory(workingDir);
      await refresh();
    });
  }

  function newComposeFile() {
    const workingDir = directory?.path ?? directoryPath;
    const filePath = remoteJoin(workingDir, "docker-compose.yml");
    setEditor({ path: filePath, content: emptyCompose });
    setDeployForm({
      workingDir,
      composePath: "docker-compose.yml",
      projectName: normalizeComposeProjectName(remoteBaseName(workingDir)) || "stack"
    });
  }

  function useAsCompose(path: string) {
    const workingDir = remoteDirName(path);
    setDeployForm({
      workingDir,
      composePath: remoteBaseName(path),
      projectName: normalizeComposeProjectName(remoteBaseName(workingDir)) || "stack"
    });
  }

  return (
    <Panel title="Host Files" count={directory?.entries.length ?? 0}>
      <div className="resourceHeader">
        <div>
          <strong>{host.name}</strong>
          <span>{host.username}@{host.hostname}:{host.port}</span>
        </div>
        <Field label="Host">
          <HostSelect hosts={hosts} value={host.id} onChange={onHostChange} />
        </Field>
      </div>
      <div className="formHint">Browse your Docker host, create project folders, clone repos, edit small text files, and deploy Compose files from their real folder. Folder deploys are tracked as compose stacks with version history. Private GitHub clones use read-only deploy keys configured on the host.</div>
      {!supported && (
        <div className="notice error">File browsing requires an SSH host. Agent hosts cannot browse host files yet.</div>
      )}
      {loadError && <div className="notice error">{loadError}</div>}
      {supported && (
        <>
      <form className="inlineForm" onSubmit={(event) => { event.preventDefault(); void action.run(() => loadDirectory(directoryPath)); }}>
        <input className="monoText" value={directoryPath} onChange={(event) => setDirectoryPath(event.target.value)} />
        <button className="primary"><RefreshCw size={18} />Open</button>
        <button type="button" onClick={newComposeFile}><FilePlus size={18} />New Compose File</button>
        {directory?.parent && <button type="button" onClick={() => void action.run(() => loadDirectory(directory.parent!))}>Up</button>}
      </form>

      <div className="two">
        <form className="subPanel composeForm" onSubmit={createFolder}>
          <h3>Create Folder</h3>
          <input className="monoText" value={newFolderPath} onChange={(event) => setNewFolderPath(event.target.value)} />
          <button className="primary" disabled={action.busy}><Plus size={18} />Create Folder</button>
        </form>

        <form className="subPanel composeForm" onSubmit={cloneRepository}>
          <h3>Clone Repository</h3>
          <input placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git" value={cloneForm.repositoryUrl} onChange={(event) => setCloneForm({ ...cloneForm, repositoryUrl: event.target.value })} required />
          <input className="monoText" placeholder="/home/user/app" value={cloneForm.directory} onChange={(event) => setCloneForm({ ...cloneForm, directory: event.target.value })} required />
          <div className="two">
            <input placeholder="Branch, optional" value={cloneForm.branch} onChange={(event) => setCloneForm({ ...cloneForm, branch: event.target.value })} />
            <label className="checkLine"><input type="checkbox" checked={cloneForm.shallow} onChange={(event) => setCloneForm({ ...cloneForm, shallow: event.target.checked })} />Shallow clone</label>
          </div>
          <button className="primary" disabled={action.busy}><GitBranch size={18} />Clone</button>
        </form>
      </div>

      <form className="subPanel composeForm" onSubmit={deployFromFolder}>
        <h3>Deploy Compose From Folder</h3>
        <div className="three">
          <input className="monoText" placeholder="/home/user/app" value={deployForm.workingDir} onChange={(event) => setDeployForm({ ...deployForm, workingDir: event.target.value })} required />
          <input placeholder="docker-compose.yml" value={deployForm.composePath} onChange={(event) => setDeployForm({ ...deployForm, composePath: event.target.value })} required />
          <input placeholder="project name" value={deployForm.projectName} onChange={(event) => setDeployForm({ ...deployForm, projectName: normalizeComposeProjectName(event.target.value) })} required />
        </div>
        <button className="primary" disabled={action.busy || !deployForm.projectName}><Play size={18} />Deploy Folder</button>
      </form>

      {editor && (
        <form className="subPanel composeForm" onSubmit={saveFile}>
          <div className="panelHeader">
            <h3>Edit {remoteBaseName(editor.path)}</h3>
            <button type="button" onClick={() => setEditor(null)}><X size={16} />Close</button>
          </div>
          <input className="monoText" value={editor.path} onChange={(event) => setEditor({ ...editor, path: event.target.value })} />
          <textarea className="monoTextarea composeEditor" value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })} />
          <ButtonRow>
            <button className="primary" disabled={action.busy}><Save size={18} />Save File</button>
            {isComposeFilePath(editor.path) && (
              <button type="button" className="primary" disabled={action.busy} onClick={() => void saveAndDeployFile()}><Play size={18} />Save &amp; Deploy</button>
            )}
          </ButtonRow>
        </form>
      )}

      {action.error && <div className="notice error">{action.error}</div>}
      <DataTable
        rows={(directory?.entries ?? []).map((entry) => ({ ...entry, id: entry.path }))}
        columns={["Name", "Type", "Size", "Modified", "Actions"]}
        render={(entry) => [
          entry.type === "directory" ? <button className="linkButton" onClick={() => void action.run(() => loadDirectory(entry.path))}>{entry.name}</button> : <code>{entry.name}</code>,
          entry.type,
          entry.type === "directory" ? "" : formatBytes(entry.size),
          entry.modified,
          <ButtonRow key="actions">
            {entry.type === "directory" ? <button onClick={() => void action.run(() => loadDirectory(entry.path))}>Open</button> : <button onClick={() => void openFile(entry.path)}><Pencil size={16} />Edit</button>}
            {entry.type !== "directory" && isComposeFilePath(entry.path) && <button onClick={() => useAsCompose(entry.path)}><Database size={16} />Use Compose</button>}
          </ButtonRow>
        ]}
      />
        </>
      )}
    </Panel>
  );
}
