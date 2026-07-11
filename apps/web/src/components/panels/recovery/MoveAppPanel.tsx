import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Copy, Play, Search } from "lucide-react";
import type { DockerApp, DockerHost, MigrationRun, MigrationStrategy, OperationJob, ResourceSnapshot } from "@composebastion/shared";
import { postJson } from "../../../api.js";
import { useAsyncAction } from "../../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../../lib/dashboardTypes.js";
import { formatDate } from "../../../lib/format.js";
import { hostName } from "../../../lib/hostScope.js";
import { activeJobPhase, jobProgressSteps } from "../../../lib/jobProgress.js";
import { dockerAppToRecoveryIdentity, migrationPlanMatchesSelection } from "../../../lib/recovery.js";
import { HostSelect } from "../../dashboard/HostSelect.js";
import { ButtonRow, CardSection, Field, Panel, ProgressSteps, StatusPill } from "../../ui/primitives.js";

const strategies: Array<{ id: MigrationStrategy; label: string; detail: string }> = [
  { id: "safe_move", label: "Safe move", detail: "Stop source, capture, deploy on target, leave source stopped." },
  { id: "warm_move", label: "Warm move", detail: "Pre-copy while running, stop source, final sync, deploy on target." },
  { id: "clone", label: "Clone to host", detail: "Copy and start on target without stopping the source." }
];

type MigrationExecuteResponse = JobResult & { run: MigrationRun };

function stringMapEntries(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function restoreResult(job: OperationJob | null) {
  const restore = job?.result?.restore;
  if (!restore || typeof restore !== "object" || Array.isArray(restore)) return null;
  return restore as {
    projectName?: unknown;
    restoredVolumes?: unknown;
    restoredBindMounts?: unknown;
    volumeMap?: unknown;
    bindMap?: unknown;
    portRemap?: unknown;
  };
}

function activeProgressDetail(job: OperationJob | null) {
  const active = job?.progress.find((step) => step.status === "running" && step.detail);
  return active?.detail ?? null;
}

export function MoveAppPanel({
  hosts,
  apps,
  resources,
  jobs,
  plannedRun,
  onPlanned,
  refresh,
  runJob
}: {
  hosts: DockerHost[];
  apps: DockerApp[];
  resources: ResourceSnapshot[];
  jobs: OperationJob[];
  plannedRun: MigrationRun | null;
  onPlanned: (run: MigrationRun | null) => void;
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const action = useAsyncAction();
  const [form, setForm] = useState({
    sourceHostId: hosts[0]?.id ?? "",
    targetHostId: hosts[1]?.id ?? hosts[0]?.id ?? "",
    appId: apps[0]?.id ?? "",
    strategy: "clone" as MigrationStrategy
  });
  const [volumeForm, setVolumeForm] = useState({ sourceHostId: hosts[0]?.id ?? "", targetHostId: hosts[1]?.id ?? hosts[0]?.id ?? "", sourceVolumeName: "", targetVolumeName: "", overwrite: false });
  const [containerForm, setContainerForm] = useState({ sourceHostId: hosts[0]?.id ?? "", targetHostId: hosts[1]?.id ?? hosts[0]?.id ?? "", containerId: "", targetName: "", start: false });
  const [activeMigrationJobId, setActiveMigrationJobId] = useState<string | null>(null);

  const volumes = resources.filter((resource) => resource.kind === "volume");
  const containers = resources.filter((resource) => resource.kind === "container");
  const sourceApps = useMemo(
    () => apps.filter((app) => app.hostId === form.sourceHostId),
    [apps, form.sourceHostId]
  );
  const selectedApp = apps.find((app) => app.id === form.appId) ?? sourceApps[0] ?? null;
  const selectedIdentity = selectedApp ? dockerAppToRecoveryIdentity(selectedApp) : null;
  const currentOptions = { stopSource: false, remapPorts: true, networkMode: "clone" as const };
  const planMatchesSelection = selectedIdentity ? migrationPlanMatchesSelection(plannedRun, {
    sourceHostId: form.sourceHostId,
    targetHostId: form.targetHostId,
    sourceAppIdentity: selectedIdentity,
    strategy: form.strategy,
    options: currentOptions
  }) : false;
  const plan = plannedRun?.plan ?? null;
  const targetHostLabel = hostName(hosts, form.targetHostId);
  const activeMigrationJob = jobs.find((job) => job.id === activeMigrationJobId) ?? null;
  const activeDetail = activeProgressDetail(activeMigrationJob);
  const restore = restoreResult(activeMigrationJob);
  const restoredVolumes = typeof restore?.restoredVolumes === "number" ? restore.restoredVolumes : null;
  const restoredBindMounts = typeof restore?.restoredBindMounts === "number" ? restore.restoredBindMounts : null;
  const restoredProjectName = typeof restore?.projectName === "string" ? restore.projectName : null;
  const bindMapEntries = stringMapEntries(restore?.bindMap);
  const volumeMapEntries = stringMapEntries(restore?.volumeMap);
  const portMapEntries = stringMapEntries(restore?.portRemap);

  useEffect(() => {
    if (plannedRun && !planMatchesSelection) onPlanned(null);
  }, [form.sourceHostId, form.targetHostId, form.appId, form.strategy, planMatchesSelection, plannedRun, onPlanned]);

  return (
    <Panel title="Migrate app">
      <form
        className="recoveryMoveForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedApp) return;
          void action.run(async () => {
            const result = await postJson<{ run: MigrationRun }>("/api/recovery/migrations/plan", {
              sourceHostId: form.sourceHostId,
              targetHostId: form.targetHostId,
              sourceAppIdentity: dockerAppToRecoveryIdentity(selectedApp),
              strategy: form.strategy,
              options: currentOptions
            });
            onPlanned(result.run);
          });
        }}
      >
        <div className="recoveryRouteGrid">
          <CardSection title="Source">
            <Field label="Host">
              <HostSelect hosts={hosts} value={form.sourceHostId} onChange={(sourceHostId) => setForm((current) => ({
                ...current,
                sourceHostId,
                appId: apps.find((app) => app.hostId === sourceHostId)?.id ?? ""
              }))} />
            </Field>
            <Field label="App">
              <select value={form.appId} onChange={(event) => setForm((current) => ({ ...current, appId: event.target.value }))} required>
                <option value="">Select app</option>
                {sourceApps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
              </select>
            </Field>
          </CardSection>
          <div className="recoveryRouteArrow" aria-hidden="true">
            <ArrowRight size={18} />
          </div>
          <CardSection title="Target">
            <Field label="Host">
              <HostSelect hosts={hosts} value={form.targetHostId} onChange={(targetHostId) => setForm((current) => ({ ...current, targetHostId }))} />
            </Field>
            <div className="recoveryRouteSummary">
              <span>{selectedApp?.name ?? "No app selected"}</span>
              <strong>{targetHostLabel}</strong>
            </div>
          </CardSection>
        </div>

        <CardSection title="Mode">
          <div className="recoveryStrategyGrid">
            {strategies.map((strategy) => (
              <label key={strategy.id} className={`recoveryStrategyOption${form.strategy === strategy.id ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="migration-strategy"
                  checked={form.strategy === strategy.id}
                  onChange={() => setForm((current) => ({ ...current, strategy: strategy.id }))}
                />
                <span>
                  <strong>{strategy.label}</strong>
                  <small>{strategy.detail}</small>
                </span>
              </label>
            ))}
          </div>
        </CardSection>

        <ButtonRow className="recoveryActionRow">
          <button type="submit" className="primary" disabled={action.busy || !selectedApp}>
            <Search size={16} />
            Plan / check
          </button>
          <button
            type="button"
            className="primary"
            disabled={action.busy || !planMatchesSelection || Boolean(plan?.blockingIssues.length)}
            onClick={() => void action.run(async () => {
              if (!selectedApp || !plannedRun || !planMatchesSelection) return;
              try {
                await runJob(async () => {
                  const result = await postJson<MigrationExecuteResponse>("/api/recovery/migrations/execute", {
                    planRunId: plannedRun.id
                  });
                  setActiveMigrationJobId(result.job.id);
                  return result;
                });
                await refresh();
              } finally {
                // A plan is single-use, and an ambiguous network failure may
                // have happened after commit. Require a new reviewed plan.
                onPlanned(null);
              }
            })}
          >
            <Play size={16} />
            Execute migration
          </button>
        </ButtonRow>
      </form>

      <details className="advancedMigrationTools">
        <summary>Advanced direct clone tools</summary>
        <div className="recoveryTaskGrid">
          <form className="recoveryTaskCard" onSubmit={(event) => { event.preventDefault(); void action.run(() => runJob(() => postJson<JobResult>("/api/migrations/volume-clone", volumeForm))); }}>
            <CardSection title="Clone volume data">
              <div className="recoveryFieldGrid twoColumn">
                <Field label="Source host">
                  <HostSelect hosts={hosts} value={volumeForm.sourceHostId} onChange={(sourceHostId) => setVolumeForm({ ...volumeForm, sourceHostId })} />
                </Field>
                <Field label="Target host">
                  <HostSelect hosts={hosts} value={volumeForm.targetHostId} onChange={(targetHostId) => setVolumeForm({ ...volumeForm, targetHostId })} />
                </Field>
              </div>
              <Field label="Source volume">
                <select value={volumeForm.sourceVolumeName} onChange={(event) => setVolumeForm({ ...volumeForm, sourceVolumeName: event.target.value, targetVolumeName: volumeForm.targetVolumeName || event.target.value })}>
                  <option value="">Select volume</option>
                  {volumes
                    .filter((volume) => volume.hostId === volumeForm.sourceHostId)
                    .map((volume) => <option key={volume.id} value={volume.name}>{volume.name}</option>)}
                </select>
              </Field>
              <Field label="Target volume">
                <input placeholder="Target volume" value={volumeForm.targetVolumeName} onChange={(event) => setVolumeForm({ ...volumeForm, targetVolumeName: event.target.value })} required />
              </Field>
              <label className="checkLine"><input type="checkbox" checked={volumeForm.overwrite} onChange={(event) => setVolumeForm({ ...volumeForm, overwrite: event.target.checked })} /> Overwrite existing volume</label>
            </CardSection>
            <ButtonRow className="recoveryActionRow">
              <button className="primary" disabled={action.busy || !volumeForm.sourceVolumeName || !volumeForm.targetVolumeName}><Copy size={18} />Clone volume</button>
            </ButtonRow>
          </form>
          <form className="recoveryTaskCard" onSubmit={(event) => { event.preventDefault(); void action.run(() => runJob(() => postJson<JobResult>("/api/migrations/container-clone", containerForm))); }}>
            <CardSection title="Clone container definition">
              <div className="recoveryFieldGrid twoColumn">
                <Field label="Source host">
                  <HostSelect hosts={hosts} value={containerForm.sourceHostId} onChange={(sourceHostId) => setContainerForm({ ...containerForm, sourceHostId })} />
                </Field>
                <Field label="Target host">
                  <HostSelect hosts={hosts} value={containerForm.targetHostId} onChange={(targetHostId) => setContainerForm({ ...containerForm, targetHostId })} />
                </Field>
              </div>
              <Field label="Source container">
                <select value={containerForm.containerId} onChange={(event) => setContainerForm({ ...containerForm, containerId: event.target.value })}>
                  <option value="">Select container</option>
                  {containers
                    .filter((container) => container.hostId === containerForm.sourceHostId)
                    .map((container) => <option key={container.id} value={container.externalId}>{container.name}</option>)}
                </select>
              </Field>
              <Field label="Target name">
                <input placeholder="Target name" value={containerForm.targetName} onChange={(event) => setContainerForm({ ...containerForm, targetName: event.target.value })} />
              </Field>
              <label className="checkLine"><input type="checkbox" checked={containerForm.start} onChange={(event) => setContainerForm({ ...containerForm, start: event.target.checked })} /> Start after clone</label>
            </CardSection>
            <ButtonRow className="recoveryActionRow">
              <button className="primary" disabled={action.busy || !containerForm.containerId}><Copy size={18} />Clone container</button>
            </ButtonRow>
          </form>
        </div>
      </details>

      {action.error && <div className="notice error">{action.error}</div>}

      {plan && (
        <div className="stack recoveryPlanCard">
          <strong>Plan checks</strong>
          <div className="appsSummary">
            <div><span>Source Docker</span><strong>{plan.checks.sourceDockerAvailable ? "OK" : "Fail"}</strong></div>
            <div><span>Target Docker</span><strong>{plan.checks.targetDockerAvailable ? "OK" : "Fail"}</strong></div>
            <div><span>Target Compose</span><strong>{plan.checks.targetComposeAvailable ? "OK" : "Fail"}</strong></div>
            <div><span>Artifacts</span><strong>{plan.estimatedArtifacts}</strong></div>
            <div><span>Volumes</span><strong>{plan.estimatedVolumes}</strong></div>
            <div><span>Host folders</span><strong>{plan.estimatedHostFolders}</strong></div>
          </div>
          {plan.estimatedDataBytes != null && <p>Estimated data: {(plan.estimatedDataBytes / 1024 / 1024).toFixed(1)} MB</p>}
          {plan.warnings.length > 0 && (
            <div className="notice">
              <strong>Warnings</strong>
              <ul>{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          )}
          {plan.blockingIssues.length > 0 && (
            <div className="notice error">
              <strong>Blocking issues</strong>
              <ul>{plan.blockingIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            </div>
          )}
          {plan.portConflicts.length > 0 && (
            <div className="notice">
              <strong>Port conflicts</strong>
              <ul>{plan.portConflicts.map((conflict) => <li key={`${conflict.hostPort}-${conflict.protocol}`}>{conflict.reason}</li>)}</ul>
            </div>
          )}
          {plan.volumeCollisions.length > 0 && (
            <p>Volume collisions: {plan.volumeCollisions.join(", ")}</p>
          )}
          {plan.missingNetworks.length > 0 && (
            <p>Missing networks on target: {plan.missingNetworks.join(", ")}</p>
          )}
          {plan.networkConflicts.length > 0 && (
            <div className="notice warning">
              <strong>Network conflicts</strong>
              <ul>{plan.networkConflicts.map((conflict) => <li key={conflict}>{conflict}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {activeMigrationJob && (
        <div className="stack recoveryPlanCard migrationExecutionLog">
          <div className="migrationExecutionHeader">
            <strong>Migration execution</strong>
            <StatusPill status={activeMigrationJob.status} />
          </div>
          <ProgressSteps steps={jobProgressSteps(activeMigrationJob)} />
          <div className="appsSummary migrationExecutionSummary">
            <div><span>Phase</span><strong>{activeJobPhase(activeMigrationJob)}</strong></div>
            <div><span>Job</span><strong><code>{activeMigrationJob.id.slice(0, 8)}</code></strong></div>
            <div><span>Run</span><strong><code>{String(activeMigrationJob.payload.migrationRunId ?? "").slice(0, 8) || "pending"}</code></strong></div>
            <div><span>Updated</span><strong>{formatDate(activeMigrationJob.updatedAt)}</strong></div>
          </div>
          {activeDetail && <div className="notice">{activeDetail}</div>}
          {activeMigrationJob.error && <div className="notice error">{activeMigrationJob.error}</div>}
          {(restoredVolumes !== null || restoredBindMounts !== null || restoredProjectName) && (
            <div className="migrationExecutionResult">
              {restoredProjectName && <div><span>Target project</span><code>{restoredProjectName}</code></div>}
              {restoredVolumes !== null && <div><span>Restored volumes</span><strong>{restoredVolumes}</strong></div>}
              {restoredBindMounts !== null && <div><span>Restored host folders</span><strong>{restoredBindMounts}</strong></div>}
            </div>
          )}
          {(bindMapEntries.length > 0 || volumeMapEntries.length > 0 || portMapEntries.length > 0) && (
            <div className="migrationMapList">
              {bindMapEntries.length > 0 && <strong>Host folder remaps</strong>}
              {bindMapEntries.map(([source, target]) => (
                <div key={source}>
                  <code>{source}</code>
                  <ArrowRight size={14} aria-hidden="true" />
                  <code>{target}</code>
                </div>
              ))}
              {volumeMapEntries.length > 0 && <strong>Volume remaps</strong>}
              {volumeMapEntries.map(([source, target]) => (
                <div key={source}>
                  <code>{source}</code>
                  <ArrowRight size={14} aria-hidden="true" />
                  <code>{target}</code>
                </div>
              ))}
              {portMapEntries.length > 0 && <strong>Port remaps</strong>}
              {portMapEntries.map(([source, target]) => (
                <div key={source}>
                  <code>{source}</code>
                  <ArrowRight size={14} aria-hidden="true" />
                  <code>{target}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
