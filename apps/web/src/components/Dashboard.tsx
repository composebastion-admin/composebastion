import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Upload, X } from "lucide-react";
import { BrandMark } from "./ui/BrandMark.js";
import type {
  AdminUser,
  Backup,
  ComposeStack,
  DockerApp,
  DockerHost,
  FavoriteImage,
  GithubRepository,
  OperationJob,
  RecoveryReadiness,
  ResourceSnapshot
} from "@composebastion/shared";
import { api, postJson } from "../api.js";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { useDashboardTab } from "../hooks/useDashboardTab.js";
import { useHostPreference } from "../hooks/useHostPreference.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";
import { containerStateLabel } from "../lib/dockerMetrics.js";
import type { Jobish, JobResult } from "../lib/dashboardTypes.js";
import { getScopedHostIds, jobLabel, roleLabel, sleep } from "../lib/hostScope.js";
import { hostlessTabs, type HostScope } from "../lib/navigation.js";
import type { Theme } from "../lib/theme.js";
import { tabPath } from "../lib/tabRoute.js";
import { Link } from "react-router-dom";
import { useToast } from "./ToastProvider.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { HostForm } from "./dashboard/HostForm.js";
import { GlobalSearch } from "./dashboard/GlobalSearch.js";
import { HostScopeControl } from "./dashboard/HostScopeControl.js";
import { SideNavigation } from "./dashboard/SideNavigation.js";
import type { SearchResult } from "../lib/globalSearch.js";
import type { RecoverySection } from "./panels/RecoveryCenterPanel.js";
import { ButtonRow, SkeletonPanel } from "./ui/primitives.js";

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "dev";
const adminTabDefaults = {
  settings: "settings",
  alerts: "alerts",
  registries: "registries",
  users: "users",
  jobs: "jobs",
  audit: "audit"
} as const;

const recoveryTabDefaults = {
  backups: "volume-backups",
  recovery: "points",
  "recovery-move": "move",
  "recovery-schedules": "schedules",
  "recovery-targets": "targets",
  "recovery-runs": "runs",
  "recovery-backups": "volume-backups"
} as const satisfies Record<string, RecoverySection>;

const recoverySectionTabs: Record<RecoverySection, keyof typeof recoveryTabDefaults> = {
  points: "recovery",
  move: "recovery-move",
  schedules: "recovery-schedules",
  targets: "recovery-targets",
  runs: "recovery-runs",
  "volume-backups": "recovery-backups"
};

const AdminPanel = lazy(async () => ({ default: (await import("./panels/AdminPanel.js")).AdminPanel }));
const CatalogPanel = lazy(async () => ({ default: (await import("./panels/CatalogPanel.js")).CatalogPanel }));
const ComposePanel = lazy(async () => ({ default: (await import("./panels/ComposePanel.js")).ComposePanel }));
const ContainersPanel = lazy(async () => ({ default: (await import("./panels/ContainersPanel.js")).ContainersPanel }));
const GithubDeployPanel = lazy(async () => ({ default: (await import("./panels/GithubDeployPanel.js")).GithubDeployPanel }));
const HostFilesPanel = lazy(async () => ({ default: (await import("./panels/HostFilesPanel.js")).HostFilesPanel }));
const FleetMetricsPanel = lazy(async () => ({ default: (await import("./panels/HostMetricsPanel.js")).FleetMetricsPanel }));
const HostMetricsPanel = lazy(async () => ({ default: (await import("./panels/HostMetricsPanel.js")).HostMetricsPanel }));
const HostsPanel = lazy(async () => ({ default: (await import("./panels/HostsPanel.js")).HostsPanel }));
const HostTerminalDrawer = lazy(async () => ({ default: (await import("./hosts/HostTerminalDrawer.js")).HostTerminalDrawer }));
const ImagesPanel = lazy(async () => ({ default: (await import("./panels/ImagesPanel.js")).ImagesPanel }));
const LearnPanel = lazy(async () => ({ default: (await import("./panels/LearnPanel.js")).LearnPanel }));
const NetworksPanel = lazy(async () => ({ default: (await import("./panels/NetworksPanel.js")).NetworksPanel }));
const OverviewPanel = lazy(async () => ({ default: (await import("./panels/OverviewPanel.js")).OverviewPanel }));
const RecoveryCenterPanel = lazy(async () => ({ default: (await import("./panels/RecoveryCenterPanel.js")).RecoveryCenterPanel }));
const ServicesPanel = lazy(async () => ({ default: (await import("./panels/ServicesPanel.js")).ServicesPanel }));
const SshAccessPanel = lazy(async () => ({ default: (await import("./panels/SshAccessPanel.js")).SshAccessPanel }));
const UpdatesPanel = lazy(async () => ({ default: (await import("./panels/UpdatesPanel.js")).UpdatesPanel }));
const VolumesPanel = lazy(async () => ({ default: (await import("./panels/VolumesPanel.js")).VolumesPanel }));

function arrayOrEmpty<T>(value: T[] | undefined | null) {
  return Array.isArray(value) ? value : [];
}

export function Dashboard({ user, theme, onToggleTheme, onLogout }: { user: AdminUser; theme: Theme; onToggleTheme: () => void; onLogout: () => void }) {
  const action = useAsyncAction();
  const { pushToast } = useToast();
  const [hosts, setHosts] = useState<DockerHost[]>([]);
  const [resources, setResources] = useState<ResourceSnapshot[]>([]);
  const [stacks, setStacks] = useState<ComposeStack[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [jobs, setJobs] = useState<OperationJob[]>([]);
  const [favoriteImages, setFavoriteImages] = useState<FavoriteImage[]>([]);
  const [githubRepos, setGithubRepos] = useState<GithubRepository[]>([]);
  const [apps, setApps] = useState<DockerApp[]>([]);
  const [readiness, setReadiness] = useState<RecoveryReadiness[]>([]);
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts]);
  const { selectedHostId, setSelectedHostId } = useHostPreference(hostIds);
  const [hostScope, setHostScope] = useState<HostScope>("all");
  const [customHostIds, setCustomHostIds] = useState<string[]>([]);
  const [showHostForm, setShowHostForm] = useState(false);
  const [terminalHost, setTerminalHost] = useState<DockerHost | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [resourceListQuery, setResourceListQuery] = useState({ query: "", key: 0 });
  const [hostUsage, setHostUsage] = useState<Record<string, Record<string, any>[]>>({});
  const [optimisticContainerStates, setOptimisticContainerStates] = useState<Record<string, { state: string; timestamp: number }>>({});
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const clearActivityTimer = useRef<number | null>(null);

  const setOptimisticStates = useCallback((updates: Record<string, string>) => {
    const now = Date.now();
    const stateUpdates = Object.fromEntries(
      Object.entries(updates).map(([id, state]) => [id, { state, timestamp: now }])
    );
    setOptimisticContainerStates((current) => ({ ...current, ...stateUpdates }));
  }, []);


  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0] ?? null;
  const { tab, setTab } = useDashboardTab(Boolean(selectedHost), hostsLoaded);
  const scopedHostIds = useMemo(() => getScopedHostIds(hosts, selectedHost?.id ?? selectedHostId, hostScope, customHostIds), [hosts, selectedHost?.id, selectedHostId, hostScope, customHostIds]);
  const scopedHosts = useMemo(() => scopedHostIds.map((hostId) => hosts.find((host) => host.id === hostId)).filter((host): host is DockerHost => Boolean(host)), [hosts, scopedHostIds]);
  const fleetScope = hostScope !== "selected";
  const scopeTitle = fleetScope
    ? hostScope === "all"
      ? "All Docker hosts"
      : `${scopedHosts.length} selected ${scopedHosts.length === 1 ? "host" : "hosts"}`
    : selectedHost?.name ?? "Add a Docker host";
  const scopeChipLabel = hostScope === "all" ? "All hosts" : hostScope === "custom" ? "Selected hosts" : "Single host";

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Each section degrades independently: one failing endpoint (or one
      // unreachable host) must not blank the rest of the dashboard.
      const [hostResult, backupResult, jobResult, favoriteResult, githubResult, appResult, readinessResult] = await Promise.allSettled([
        api<{ hosts: DockerHost[] }>("/api/hosts"),
        api<{ backups?: Backup[] }>("/api/backups"),
        api<{ jobs?: OperationJob[] }>("/api/jobs?limit=80"),
        api<{ images?: FavoriteImage[] }>("/api/favorite-images"),
        api<{ repositories?: GithubRepository[] }>("/api/github/repos"),
        api<{ apps?: DockerApp[] }>("/api/apps"),
        api<{ readiness?: RecoveryReadiness[] }>("/api/recovery/readiness")
      ]);
      if (hostResult.status === "rejected") {
        setLoadError(hostResult.reason instanceof Error ? hostResult.reason.message : String(hostResult.reason));
        return;
      }
      setLoadError(null);
      const hostList = arrayOrEmpty(hostResult.value.hosts);
      setHosts(hostList);
      setHostsLoaded(true);
      if (backupResult.status === "fulfilled") setBackups(arrayOrEmpty(backupResult.value.backups));
      if (jobResult.status === "fulfilled") setJobs(arrayOrEmpty(jobResult.value.jobs));
      if (favoriteResult.status === "fulfilled") setFavoriteImages(arrayOrEmpty(favoriteResult.value.images));
      if (githubResult.status === "fulfilled") setGithubRepos(arrayOrEmpty(githubResult.value.repositories));
      if (appResult.status === "fulfilled") setApps(arrayOrEmpty(appResult.value.apps));
      if (readinessResult.status === "fulfilled") setReadiness(arrayOrEmpty(readinessResult.value.readiness));
      const hostId = hostList.some((host) => host.id === selectedHostId) ? selectedHostId : hostList[0]?.id ?? null;
      const hostIds = getScopedHostIds(hostList, hostId, hostScope, customHostIds);
      if (hostId) {
        if (selectedHostId !== hostId) setSelectedHostId(hostId);
        const [resourceResults, stackResults] = await Promise.all([
          Promise.allSettled(hostIds.map((id) => api<{ resources?: ResourceSnapshot[] }>(`/api/hosts/${id}/resources`))),
          Promise.allSettled(hostIds.map((id) => api<{ stacks?: ComposeStack[] }>(`/api/hosts/${id}/compose`)))
        ]);
        const nextResources = resourceResults.flatMap((result) => result.status === "fulfilled" ? arrayOrEmpty(result.value.resources) : []);
        setResources(nextResources);
        setStacks(stackResults.flatMap((result) => result.status === "fulfilled" ? arrayOrEmpty(result.value.stacks) : []));

        setOptimisticContainerStates((current) => {
          const next = { ...current };
          let changed = false;
          const now = Date.now();
          for (const [id, record] of Object.entries(next)) {
            if (now - record.timestamp > 15000) {
              delete next[id];
              changed = true;
              continue;
            }
            const container = nextResources.find((r) => r.kind === "container" && r.externalId === id);
            if (container) {
              const actualState = (container.data as any)?.State ?? "";
              if (actualState === record.state || (record.state === "exited" && (actualState === "exited" || actualState === "stopped" || actualState === "dead"))) {
                delete next[id];
                changed = true;
              }
            } else if (record.state === "removing") {
              delete next[id];
              changed = true;
            }
          }
          return changed ? next : current;
        });
      } else {
        setResources([]);
        setStacks([]);
      }
    } finally {
      setRefreshing(false);
    }
  }, [selectedHostId, hostScope, customHostIds]);

  useKeyboardShortcuts({
    setTab,
    refresh,
    hasHost: Boolean(selectedHost)
  });

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setIsSidebarOpen(false);
  }, [tab, selectedHostId]);

  useEffect(() => () => {
    if (clearActivityTimer.current) window.clearTimeout(clearActivityTimer.current);
  }, []);

  const waitForJob = useCallback(async (jobId: string) => {
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const result = await api<{ job: OperationJob }>(`/api/jobs/${jobId}`);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)].slice(0, 80));
      setActivity(`${jobLabel(result.job.type)} ${result.job.status}`);
      if (result.job.status === "completed" || result.job.status === "failed") return result.job;
      await sleep(1_000);
    }
    throw new Error("Job did not finish within six minutes");
  }, []);

  const waitForJobs = useCallback(async (nextJobs: OperationJob[]) => {
    const completed = [];
    for (const job of nextJobs) {
      completed.push(await waitForJob(job.id));
    }
    return completed;
  }, [waitForJob]);

  const runJob = useCallback(async <T extends Jobish>(request: () => Promise<T>) => {
    if (clearActivityTimer.current) window.clearTimeout(clearActivityTimer.current);
    setActivity("Starting operation");
    try {
      const result = await request();
      const completed: OperationJob[] = [];
      if (result.job) completed.push(await waitForJob(result.job.id));
      if (result.jobs?.length) completed.push(...await waitForJobs(result.jobs));
      await refresh();
      const failed = completed.find((job) => job.status === "failed");
      if (failed) throw new Error(failed.error ?? `${failed.type} failed`);
      if (completed.length > 0) {
        pushToast(`${jobLabel(completed[completed.length - 1]!.type)} completed`, "success");
      }
      return result;
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
      throw caught;
    } finally {
      clearActivityTimer.current = window.setTimeout(() => setActivity(null), 450);
    }
  }, [pushToast, refresh, waitForJob, waitForJobs]);

  const resourcesByKind = useMemo(
    () => ({
      container: resources.filter((resource) => resource.kind === "container"),
      image: resources.filter((resource) => resource.kind === "image"),
      network: resources.filter((resource) => resource.kind === "network"),
      volume: resources.filter((resource) => resource.kind === "volume")
    }),
    [resources]
  );
  const hostIdsKey = useMemo(() => hosts.map((item) => item.id).sort().join(","), [hosts]);
  const hostContainerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const container of resourcesByKind.container) counts[container.hostId] = (counts[container.hostId] ?? 0) + 1;
    for (const [hostId, usageRows] of Object.entries(hostUsage)) {
      if (!counts[hostId]) counts[hostId] = usageRows.length;
    }
    return counts;
  }, [resourcesByKind.container, hostUsage]);
  const onlineScopedHosts = scopedHosts.filter((host) => host.lastStatus === "online").length;
  const activeContainers = resourcesByKind.container.filter((container) => containerStateLabel(String((container.data as any).State ?? "")) === "running").length;
  const updatesAvailable = apps.filter((app) => app.update.status === "update_available").length;
  const queuedOrRunningJobs = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const failedJobs = jobs.filter((job) => job.status === "failed").length;
  const transitioningContainerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const job of jobs) {
      if (job.status === "queued" || job.status === "running") {
        if (typeof job.payload?.containerId === "string") {
          ids.add(job.payload.containerId);
        }
      }
    }
    return ids;
  }, [jobs]);
  const scopeHealth = scopedHosts.length === 0 ? "unknown" : onlineScopedHosts === scopedHosts.length ? "online" : onlineScopedHosts > 0 ? "checking" : "offline";
  const adminSection = tab === "admin" ? "settings" : adminTabDefaults[tab as keyof typeof adminTabDefaults];
  const recoverySection = tab === "migrate" ? "move" : recoveryTabDefaults[tab as keyof typeof recoveryTabDefaults];
  const showTopbarScope = hosts.length > 0 && !recoverySection && tab !== "catalog" && tab !== "files";
  const showTopbarKpis = hosts.length > 0 && !recoverySection;
  const topbarTitle = tab === "files" ? "Host Files" : recoverySection ? "Recovery Center" : tab === "catalog" ? "Catalog" : scopeTitle;

  const loadHostUsage = useCallback(async () => {
    const hostIds = hostIdsKey.split(",").filter(Boolean);
    if (hostIds.length === 0) {
      setHostUsage({});
      return;
    }
    const entries = await Promise.all(hostIds.map(async (hostId) => {
      try {
        const result = await api<{ usage: Record<string, any>[] }>(`/api/hosts/${hostId}/containers/usage`);
        return [hostId, result.usage] as const;
      } catch {
        return [hostId, []] as const;
      }
    }));
    setHostUsage(Object.fromEntries(entries));
  }, [hostIdsKey]);

  useEffect(() => {
    void loadHostUsage();
    const timer = window.setInterval(() => void loadHostUsage(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadHostUsage]);

  async function logout() {
    await postJson("/api/auth/logout", {});
    onLogout();
  }

  async function hostAction(type: string, payload: Record<string, unknown> = {}, hostId = selectedHost?.id) {
    if (!hostId) return;
    let targetContainerId: string | null = null;
    if (type.startsWith("container.") && typeof payload.containerId === "string") {
      targetContainerId = payload.containerId;
      const targetState = type === "container.start" || type === "container.restart"
        ? "running"
        : type === "container.stop"
          ? "exited"
          : type === "container.remove"
            ? "removing"
            : null;
      if (targetState) {
        setOptimisticStates({ [targetContainerId]: targetState });
      }
    }
    try {
      await action.run(async () => {
        await runJob(() => postJson<JobResult>(`/api/hosts/${hostId}/actions`, { type, payload }));
      });
    } catch (err) {
      if (targetContainerId) {
        setOptimisticContainerStates((current) => {
          const next = { ...current };
          delete next[targetContainerId!];
          return next;
        });
      }
      throw err;
    }
  }

  function handleSearchPick(result: SearchResult) {
    setSelectedHostId(result.hostId);
    setHostScope("selected");
    setTab(result.tab);
    if (result.kind === "resource" && (result.tab === "containers" || result.tab === "images")) {
      setResourceListQuery((current) => ({ query: result.label, key: current.key + 1 }));
    }
  }

  return (
    <main className={`appShell ${isSidebarCollapsed ? "sidebarCollapsed" : ""}`}>
      <aside className={`sidebar ${isSidebarOpen ? "open" : ""} ${isSidebarCollapsed ? "collapsed" : ""}`}>
        <div className="sideHeader">
          <div className="sideBrand">
            <div className="sideLogo">
              <BrandMark size={22} />
            </div>
            <div className="sideIdentity">
              <strong>ComposeBastion</strong>
              <span>{user.username ?? user.email}</span>
            </div>
          </div>
          <div className="sideHeaderActions">
            <button
              className="iconButton desktopSidebarToggle"
              onClick={() => setIsSidebarCollapsed((value) => !value)}
              title={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {isSidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <button className="mobileMenuClose" onClick={() => setIsSidebarOpen(false)} aria-label="Close sidebar">
              <X size={18} />
            </button>
            <button className="iconButton" onClick={logout} title="Log out">
              <LogOut size={18} />
            </button>
          </div>
          <div className="sideHeaderMeta">
            <small className="rolePill">{roleLabel(user.role)}</small>
            <small className="appVersion">v{APP_VERSION}</small>
          </div>
        </div>

        <button className="primary full" onClick={() => setShowHostForm((value) => !value)}>
          <Plus size={18} />
          <span className="buttonText">Host</span>
        </button>
        {showHostForm && <HostForm runJob={runJob} onCreated={() => { setShowHostForm(false); void refresh(); }} />}

        <SideNavigation currentTab={tab} hasHost={Boolean(selectedHost)} onTabChange={setTab} />
      </aside>

      <section className="workspace">
        {isSidebarOpen && (
          <div className="sidebarBackdrop" onClick={() => setIsSidebarOpen(false)} />
        )}
        <header className={`topbar ${showTopbarScope ? "" : "topbarNoScope"} ${showTopbarKpis ? "" : "topbarNoKpis"}`}>
          <button className="mobileMenuToggle" onClick={() => setIsSidebarOpen(true)} aria-label="Open sidebar">
            <Menu size={20} />
          </button>
          <div className="topbarTitle">
            <div className="topbarEyebrow">
              <span className={`hostStatus ${fleetScope ? scopeHealth : selectedHost?.lastStatus ?? "unknown"}`}>{fleetScope ? `${onlineScopedHosts}/${scopedHosts.length} online` : selectedHost?.lastStatus ?? "no host"}</span>
              <span className="scopeChip">{scopeChipLabel}</span>
            </div>
            <h2>{topbarTitle}</h2>
            {!fleetScope && selectedHost && (
              <p>
                {selectedHost.dockerVersion ? `Docker ${selectedHost.dockerVersion}` : "Docker version pending"}
                {selectedHost.composeVersion ? ` - Compose ${selectedHost.composeVersion}` : ""}
              </p>
            )}
          </div>
          {showTopbarScope && (
            <HostScopeControl
              hosts={hosts}
              selectedHostId={selectedHost?.id ?? selectedHostId ?? ""}
              scope={hostScope}
              customHostIds={customHostIds}
              onScopeChange={(nextScope) => setHostScope(nextScope)}
              onSelectedHostChange={(hostId) => {
                setSelectedHostId(hostId);
                setHostScope("selected");
              }}
              onCustomHostIdsChange={setCustomHostIds}
              variant="topbar"
            />
          )}
          {hosts.length > 0 && (
            <GlobalSearch
              hosts={hosts}
              resources={resources}
              scopedHostIds={scopedHostIds}
              onPick={handleSearchPick}
            />
          )}
          {showTopbarKpis && (
            <div className="topbarKpis" aria-label="Workspace summary">
              <div className="topbarKpi" title={`${onlineScopedHosts} of ${scopedHosts.length} hosts online`}>
                <span>Hosts</span>
                <strong>{onlineScopedHosts}/{scopedHosts.length}</strong>
              </div>
              <div className="topbarKpi" title={`${activeContainers} of ${resourcesByKind.container.length} containers running`}>
                <span>Running</span>
                <strong>{activeContainers}/{resourcesByKind.container.length}</strong>
              </div>
              <div className="topbarKpi" title={`${updatesAvailable} services with updates available`}>
                <span>Updates</span>
                <strong>{updatesAvailable}</strong>
              </div>
              <div className={`topbarKpi${failedJobs > 0 ? " alert" : ""}`} title={`${failedJobs} failed jobs, ${queuedOrRunningJobs} queued or running`}>
                <span>Failed jobs</span>
                <strong>{failedJobs}</strong>
              </div>
              <button
                type="button"
                className="topbarRefresh"
                onClick={() => void refresh()}
                disabled={refreshing}
                title="Refresh data (r)"
                aria-label="Refresh data"
              >
                <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
              </button>
            </div>
          )}
        </header>

        {loadError && (
          <div className="notice error noticeRow">
            <span>Could not load dashboard data: {loadError}</span>
            <button type="button" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
              Retry
            </button>
          </div>
        )}
        {selectedHost?.lastError && <div className="notice error">{selectedHost.lastError}</div>}
        {action.error && <div className="notice error">{action.error}</div>}
        {activity && (
          <div className="activityBanner">
            <RefreshCw className="spin" size={16} />
            <span>{activity}</span>
          </div>
        )}

        <ErrorBoundary resetKey={tab} title={`The ${tab} view failed to load`}>
          <Suspense fallback={<SkeletonPanel title={`Loading ${tab}`} rows={6} />}>
            {!selectedHost && !hostlessTabs.has(tab) ? (
              <section className="panel">
                <h3>Host Inventory</h3>
                <p>Add a Linux server reachable by SSH. ComposeBastion will check Docker Engine and Compose before syncing inventory.</p>
                <ButtonRow>
                  <button className="primary" onClick={() => setShowHostForm(true)}><Plus size={18} />Add Host</button>
                  <Link className="buttonLink" to={tabPath("settings")}><Upload size={18} />Restore Config</Link>
                </ButtonRow>
              </section>
            ) : (
              <section className="contentGrid">
                {tab === "overview" && selectedHost && <OverviewPanel host={selectedHost} hosts={hosts} apps={apps} resources={resources} backups={backups} jobs={jobs} scopeHosts={scopedHosts} />}
                {(tab === "services" || tab === "apps") && selectedHost && (
                  <ServicesPanel
                    hosts={hosts}
                    apps={apps}
                    readiness={readiness}
                    containers={resourcesByKind.container}
                    images={resourcesByKind.image}
                    stacks={stacks}
                    refresh={refresh}
                    runJob={runJob}
                    onOpenContainers={(query) => {
                      if (query) setResourceListQuery((current) => ({ query, key: current.key + 1 }));
                      setTab("containers");
                    }}
                    onOpenCompose={() => setTab("compose")}
                    optimisticContainerStates={optimisticContainerStates}
                    transitioningContainerIds={transitioningContainerIds}
                    onSetOptimisticStates={setOptimisticStates}
                  />
                )}
                {tab === "containers" && selectedHost && (
                  <ContainersPanel
                    host={selectedHost}
                    hosts={hosts}
                    containers={resourcesByKind.container}
                    images={resourcesByKind.image}
                    networks={resourcesByKind.network}
                    onAction={hostAction}
                    refresh={refresh}
                    runJob={runJob}
                    listQuery={resourceListQuery.query}
                    listQueryKey={resourceListQuery.key}
                    transitioningContainerIds={transitioningContainerIds}
                    optimisticContainerStates={optimisticContainerStates}
                    onSetOptimisticStates={setOptimisticStates}
                  />
                )}
                {tab === "hosts" && (
                  <HostsPanel
                    hosts={hosts}
                    selectedHostId={selectedHost?.id ?? ""}
                    containerCounts={hostContainerCounts}
                    user={user}
                    onSelectHost={(hostId) => { setSelectedHostId(hostId); setHostScope("selected"); }}
                    onAddHost={() => setShowHostForm(true)}
                    onHostAction={(type, hostId) => hostAction(type, {}, hostId)}
                    onOpenMetrics={(targetHost) => {
                      setSelectedHostId(targetHost.id);
                      setHostScope("selected");
                      setTab("host-metrics");
                    }}
                    onOpenAdmin={() => setTab("admin")}
                    onOpenTerminal={setTerminalHost}
                  />
                )}
                {tab === "ssh" && (
                  <SshAccessPanel
                    hosts={hosts}
                    selectedHostId={selectedHost?.id ?? ""}
                    user={user}
                    onSelectHost={(hostId) => {
                      setSelectedHostId(hostId);
                      setHostScope("selected");
                    }}
                    onHostAction={(type, hostId) => hostAction(type, {}, hostId)}
                    onOpenHostSettings={(hostId) => {
                      setSelectedHostId(hostId);
                      setHostScope("selected");
                      setTab("admin");
                    }}
                    onOpenTerminal={setTerminalHost}
                    refresh={refresh}
                    runJob={runJob}
                  />
                )}
                {tab === "host-metrics" && selectedHost && (
                  hostScope === "selected"
                    ? <HostMetricsPanel host={selectedHost} />
                    : <FleetMetricsPanel hosts={hosts} scopeHosts={scopedHosts} />
                )}
                {tab === "images" && selectedHost && (
                  <ImagesPanel
                    host={selectedHost}
                    hosts={hosts}
                    images={resourcesByKind.image}
                    containers={resourcesByKind.container}
                    networks={resourcesByKind.network}
                    favoriteImages={favoriteImages}
                    onAction={hostAction}
                    refresh={refresh}
                    listQuery={resourceListQuery.query}
                    listQueryKey={resourceListQuery.key}
                  />
                )}
                {tab === "networks" && selectedHost && <NetworksPanel host={selectedHost} hosts={hosts} networks={resourcesByKind.network} onAction={hostAction} />}
                {tab === "volumes" && selectedHost && <VolumesPanel host={selectedHost} hosts={hosts} volumes={resourcesByKind.volume} onAction={hostAction} runJob={runJob} />}
                {tab === "catalog" && <CatalogPanel hosts={hosts} refresh={refresh} runJob={runJob} />}
                {tab === "deploy" && <GithubDeployPanel hosts={hosts} scopeHosts={scopedHosts} repositories={githubRepos} refresh={refresh} runJob={runJob} />}
                {tab === "updates" && <UpdatesPanel hosts={hosts} refresh={refresh} runJob={runJob} />}
                {tab === "files" && selectedHost && (
                  <HostFilesPanel
                    host={selectedHost}
                    hosts={hosts}
                    onHostChange={(hostId) => {
                      setSelectedHostId(hostId);
                      setHostScope("selected");
                    }}
                    runJob={runJob}
                    refresh={refresh}
                  />
                )}
                {tab === "compose" && selectedHost && <ComposePanel host={selectedHost} hosts={hosts} stacks={stacks} refresh={refresh} runJob={runJob} />}
                {tab === "learn" && <LearnPanel />}
                {recoverySection && (
                  <RecoveryCenterPanel
                    hosts={hosts}
                    apps={apps}
                    readiness={readiness}
                    resources={resources}
                    backups={backups}
                    jobs={jobs}
                    refresh={refresh}
                    runJob={runJob}
                    section={recoverySection}
                    onSectionChange={(nextSection) => setTab(recoverySectionTabs[nextSection])}
                  />
                )}
                {adminSection && (
                  <AdminPanel
                    defaultSection={adminSection}
                    user={user}
                    hosts={hosts}
                    selectedHost={selectedHost}
                    backups={backups}
                    jobs={jobs}
                    resources={resources}
                    refresh={refresh}
                    runJob={runJob}
                    theme={theme}
                    onToggleTheme={onToggleTheme}
                  />
                )}
              </section>
            )}
          </Suspense>
        </ErrorBoundary>
      </section>
      {terminalHost && (
        <ErrorBoundary resetKey={terminalHost.id} title="The host terminal failed to load">
          <Suspense fallback={<div className="drawer hostTerminalDrawer"><div className="notice">Loading host terminal...</div></div>}>
            <HostTerminalDrawer host={terminalHost} onClose={() => setTerminalHost(null)} />
          </Suspense>
        </ErrorBoundary>
      )}
    </main>
  );
}
