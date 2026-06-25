import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Layers,
  Link2,
  ListTree,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  Square,
  Tags,
  Trash2,
  Unlink,
  UploadCloud
} from "lucide-react";
import type { AppGithubVersionKind, AppGithubVersionOption, AppGithubVersions, ComposeStack, DockerApp, DockerHost, RecoveryReadiness, ResourceSnapshot } from "@composebastion/shared";
import { imageRepository, imageTag, publishedWebLinks } from "@composebastion/shared";
import { api, deleteJson, postJson, putJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useToast } from "../ToastProvider.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import {
  filterServiceGroups,
  findAppForServiceGroup,
  groupServices,
  isSelfManagementServiceGroup,
  summarizeServiceGroups,
  type ServiceGroup,
  type ServiceMember,
  type ServiceStateFilter
} from "../../lib/serviceGroups.js";
import { ButtonRow, EmptyState, Panel } from "../ui/primitives.js";
import { ContainerStatePill } from "../dashboard/ContainerStatePill.js";
import { formatDate } from "../../lib/format.js";
import { dockerAppRecoveryKey, recoveryIdentityKey, recoveryReadinessClass, recoveryReadinessLabel } from "../../lib/recovery.js";
import { activeSourceChannel, imageReferenceWithTag, sourceChannels } from "../../lib/sourceChannels.js";
import { countGithubVersionUpdates, groupGithubVersionOptions, shortVersionSha } from "../../lib/sourceVersions.js";
import { isImageChannelTag, summarizeImageVersionTags } from "../../lib/imageTagOptions.js";
import { ServiceImageUpdateDrawer, type ServiceImageUpdateTarget } from "../services/ServiceImageUpdateDrawer.js";

type GroupActionVerb = "start" | "stop" | "restart" | "deploy" | "remove";
type SourceLinkForm = {
  sourceType: "image" | "compose" | "git";
  name: string;
  repositoryUrl: string;
  branch: string;
  workingDir: string;
  composePath: string;
  imageReference: string;
};

type VersionLookupState = {
  status: "idle" | "loading" | "ready" | "error";
  data?: AppGithubVersions;
  error?: string;
  selectingRef?: string | null;
};

type TagLookupState = {
  status: "loading" | "ready" | "error";
  tags: string[];
  error?: string;
};

const emptyVersionLookup: VersionLookupState = { status: "idle", selectingRef: null };

const optimisticForVerb: Record<Exclude<GroupActionVerb, "deploy">, string> = {
  start: "running",
  stop: "exited",
  restart: "running",
  remove: "removing"
};

function compactText(value: string | null | undefined, maxLength: number) {
  const text = value?.trim() ?? "";
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function sourceLabel(source: DockerApp["source"]) {
  if (source === "git") return "Git";
  if (source === "compose") return "Compose";
  if (source === "image") return "Image";
  return "Unknown";
}

function updateLabel(app: DockerApp) {
  if (app.update.status === "update_available") return "Update available";
  if (app.update.status === "error") return "Check failed";
  if (app.update.status === "up_to_date") return "Up to date";
  if (app.update.status === "local") return "Local image";
  return "Unknown";
}

function versionValue(app: DockerApp, type: "current" | "latest") {
  if (app.update.kind === "git") {
    const value = type === "current" ? app.update.currentVersion : app.update.availableVersion;
    return compactText(value, 12) || "Unknown";
  }
  if (app.update.kind === "image") {
    const value = type === "current" ? app.update.currentDigest : app.update.remoteDigest;
    return compactText(value, 12) || compactText(app.update.imageReference, 24) || "Unknown";
  }
  return type === "current" ? compactText(app.imageReferences[0], 24) || "Unknown" : "Unknown";
}

function versionLabel(app: DockerApp, type: "current" | "latest") {
  if (app.update.kind === "image") return type === "current" ? "Current digest" : "Remote digest";
  return type === "current" ? "Current" : "Latest";
}

function primaryImageReference(app: DockerApp, group?: ServiceGroup | null) {
  return app.update.kind === "image" && app.update.imageReference
    ? app.update.imageReference
    : app.imageReferences[0] ?? group?.images[0] ?? null;
}

function sourceReferenceLabel(app: DockerApp, group?: ServiceGroup | null) {
  if (app.source === "git" && app.branch) {
    return { label: "Git ref", value: app.branch };
  }
  const imageReference = primaryImageReference(app, group);
  if (imageReference) return { label: "Image tag", value: imageTag(imageReference) };
  if (app.branch) return { label: "Source ref", value: app.branch };
  return null;
}

function tagLookupLabel(lookup: TagLookupState | undefined, currentTag: string) {
  if (!lookup) return "Waiting for tag scan";
  if (lookup.status === "loading") return "Scanning tags...";
  if (lookup.status === "error") return "Tag scan failed";
  const summary = summarizeImageVersionTags(lookup.tags, currentTag);
  if (summary.latestStable && summary.latestPrerelease && summary.latestPrerelease !== summary.latestStable) {
    return `${summary.latestStable} stable / ${summary.latestPrerelease} prerelease`;
  }
  return summary.latestStable ?? summary.latestPrerelease ?? "No numbered versions";
}

function tagLookupUpdateAvailable(lookup: TagLookupState | undefined, currentTag: string) {
  if (!lookup || lookup.status !== "ready") return false;
  const summary = summarizeImageVersionTags(lookup.tags, currentTag);
  return summary.stableUpdateAvailable || summary.prereleaseUpdateAvailable;
}

function displayImageTag(tag: string) {
  return isImageChannelTag(tag) ? `${tag} channel` : tag;
}

function updateReason(app: DockerApp, lookup: TagLookupState | undefined, currentTag: string | null) {
  if (app.update.status === "error") return "Check failed";
  if (app.update.kind === "git" && app.update.status === "update_available") return "Git ref has newer commits";
  if (app.update.kind === "image" && app.update.status === "update_available") return "Tracked image digest changed";
  if (currentTag && tagLookupUpdateAvailable(lookup, currentTag)) return "Newer version tag found";
  return "No update";
}

function imageDigestUpdatesForApp(app: DockerApp | null | undefined) {
  if (!app || app.update.kind !== "image" || app.update.status !== "update_available" || !app.update.imageReference) return [];
  return [{
    imageReference: app.update.imageReference,
    currentDigest: app.update.currentDigest ?? null,
    remoteDigest: app.update.remoteDigest ?? null
  }];
}

function dataMountLabel(mount: ServiceGroup["dataMounts"][number]) {
  if (mount.type === "volume") return `Volume ${mount.name ?? "unnamed"} -> ${mount.destination}`;
  if (mount.type === "bind") return `Path ${mount.source ?? "unknown"} -> ${mount.destination}`;
  if (mount.type === "tmpfs") return `tmpfs -> ${mount.destination}`;
  return `Compose folder ${mount.source ?? "unknown"}`;
}

function sourceFormFromApp(app: DockerApp): SourceLinkForm {
  return {
    sourceType: app.sourceLink?.sourceType ?? (app.source === "git" || app.source === "compose" ? app.source : "image"),
    name: app.sourceLink?.name ?? app.name,
    repositoryUrl: app.sourceLink?.repositoryUrl ?? app.repositoryUrl ?? "",
    branch: app.sourceLink?.branch ?? app.branch ?? "main",
    workingDir: app.sourceLink?.workingDir ?? "",
    composePath: app.sourceLink?.composePath ?? "docker-compose.yml",
    imageReference: app.sourceLink?.imageReference ?? app.imageReferences[0] ?? ""
  };
}

function emptyToNull(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sourcePayload(form: SourceLinkForm) {
  return {
    sourceType: form.sourceType,
    name: emptyToNull(form.name),
    repositoryUrl: form.sourceType === "git" ? emptyToNull(form.repositoryUrl) : null,
    branch: form.sourceType === "git" ? emptyToNull(form.branch) : null,
    workingDir: form.sourceType === "image" ? null : emptyToNull(form.workingDir),
    composePath: form.sourceType === "image" ? null : emptyToNull(form.composePath),
    imageReference: form.sourceType === "image" ? emptyToNull(form.imageReference) : null
  };
}

function readinessKeyForApp(app: DockerApp) {
  try {
    return dockerAppRecoveryKey(app);
  } catch {
    return "";
  }
}

export function ServicesPanel({
  hosts,
  apps,
  readiness,
  containers,
  images,
  stacks,
  refresh,
  runJob,
  onOpenContainers,
  onOpenCompose,
  optimisticContainerStates = {},
  transitioningContainerIds = new Set<string>(),
  onSetOptimisticStates
}: {
  hosts: DockerHost[];
  apps: DockerApp[];
  readiness?: RecoveryReadiness[];
  containers: ResourceSnapshot[];
  images: ResourceSnapshot[];
  stacks: ComposeStack[];
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  onOpenContainers: (query?: string) => void;
  onOpenCompose?: () => void;
  optimisticContainerStates?: Record<string, { state: string; timestamp: number }>;
  transitioningContainerIds?: Set<string>;
  onSetOptimisticStates?: (updates: Record<string, string>) => void;
}) {
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ServiceStateFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [sourceTarget, setSourceTarget] = useState<DockerApp | null>(null);
  const [renameTarget, setRenameTarget] = useState<DockerApp | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [imageUpdateTarget, setImageUpdateTarget] = useState<ServiceGroup | null>(null);
  const [sourceForm, setSourceForm] = useState<SourceLinkForm | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [versionLookup, setVersionLookup] = useState<VersionLookupState>(emptyVersionLookup);
  const [versionQuery, setVersionQuery] = useState("");
  const [showUpdateSummary, setShowUpdateSummary] = useState(false);
  const [updateSummaryDismissed, setUpdateSummaryDismissed] = useState(false);
  const [lastUpdateScanAt, setLastUpdateScanAt] = useState<string | null>(null);
  const [tagLookups, setTagLookups] = useState<Record<string, TagLookupState>>({});

  const groups = useMemo(() => groupServices(containers, stacks, hosts), [containers, stacks, hosts]);
  const appByGroupKey = useMemo(() => {
    const map = new Map<string, DockerApp>();
    for (const group of groups) {
      const app = findAppForServiceGroup(group, apps);
      if (app) map.set(group.key, app);
    }
    return map;
  }, [apps, groups]);
  const readinessByAppKey = useMemo(() => {
    const map = new Map<string, RecoveryReadiness>();
    for (const item of readiness ?? []) map.set(recoveryIdentityKey(item.appIdentity), item);
    return map;
  }, [readiness]);
  const visibleGroups = useMemo(() => filterServiceGroups(groups, query, stateFilter), [groups, query, stateFilter]);
  const summary = useMemo(() => summarizeServiceGroups(groups), [groups]);
  const showHost = useMemo(() => new Set(groups.map((group) => group.hostId)).size > 1, [groups]);
  const serviceUpdates = useMemo(
    () => Array.from(appByGroupKey.values()).filter((app) => app.update.status === "update_available").length,
    [appByGroupKey]
  );
  const servicesWithApps = useMemo(
    () => groups.flatMap((group) => {
      const app = appByGroupKey.get(group.key);
      return app ? [{ group, app }] : [];
    }),
    [appByGroupKey, groups]
  );
  const shouldShowUpdateSummary = showUpdateSummary || (serviceUpdates > 0 && !updateSummaryDismissed);
  const tagScanTargets = useMemo(() => {
    if (!shouldShowUpdateSummary) return [];
    const targets = new Map<string, string>();
    for (const { app, group } of servicesWithApps) {
      const imageReference = primaryImageReference(app, group);
      if (!imageReference) continue;
      const repository = imageRepository(imageReference);
      if (!targets.has(repository)) targets.set(repository, imageReference);
    }
    return Array.from(targets, ([repository, imageReference]) => ({ repository, imageReference }));
  }, [servicesWithApps, shouldShowUpdateSummary]);
  const updateSummaryItems = useMemo(() => servicesWithApps.flatMap(({ app, group }) => {
    const imageReference = primaryImageReference(app, group);
    const currentTag = imageReference ? imageTag(imageReference) : null;
    const lookup = imageReference ? tagLookups[imageRepository(imageReference)] : undefined;
    const hasVersionUpdate = currentTag ? tagLookupUpdateAvailable(lookup, currentTag) : false;
    const hasTrackedUpdate = app.update.status === "update_available" || app.update.status === "error";
    if (!hasTrackedUpdate && !hasVersionUpdate) return [];
    return [{ app, group, imageReference, currentTag, lookup }];
  }), [servicesWithApps, tagLookups]);
  const tagScanLoading = shouldShowUpdateSummary && tagScanTargets.some((target) => {
    const lookup = tagLookups[target.repository];
    return !lookup || lookup.status === "loading";
  });
  const hasGitServices = useMemo(() => apps.some((app) => app.source === "git"), [apps]);
  const canEditSourceLink = Boolean(sourceTarget?.id.startsWith("container:") && sourceTarget.primaryContainerId);
  const canLoadGithubVersions = Boolean(sourceTarget?.source === "git" && sourceForm?.sourceType === "git" && sourceForm.repositoryUrl.trim());
  const githubVersionGroups = useMemo(
    () => versionLookup.status === "ready" && versionLookup.data ? groupGithubVersionOptions(versionLookup.data.options, versionQuery) : [],
    [versionLookup, versionQuery]
  );
  const githubVersionUpdateCount = versionLookup.status === "ready" && versionLookup.data
    ? countGithubVersionUpdates(versionLookup.data.options)
    : 0;

  useEffect(() => {
    if (!shouldShowUpdateSummary) return;
    for (const target of tagScanTargets) {
      const existing = tagLookups[target.repository];
      if (existing?.status === "loading" || existing?.status === "ready") continue;
      setTagLookups((current) => ({
        ...current,
        [target.repository]: { status: "loading", tags: [] }
      }));
      void api<{ tags: string[] }>(`/api/image-tags?image=${encodeURIComponent(target.imageReference)}`)
        .then((response) => {
          setTagLookups((current) => ({
            ...current,
            [target.repository]: { status: "ready", tags: response.tags }
          }));
        })
        .catch((caught) => {
          setTagLookups((current) => ({
            ...current,
            [target.repository]: {
              status: "error",
              tags: [],
              error: caught instanceof Error ? caught.message : String(caught)
            }
          }));
        });
    }
  }, [shouldShowUpdateSummary, tagLookups, tagScanTargets]);

  function toggleExpanded(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function setBusy(key: string, value: boolean) {
    setBusyKeys((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  const allExpanded = visibleGroups.length > 0 && visibleGroups.every((group) => expanded.has(group.key));
  function toggleExpandAll() {
    setExpanded(allExpanded ? new Set() : new Set(visibleGroups.map((group) => group.key)));
  }

  async function runContainerActions(group: ServiceGroup, type: "container.start" | "container.stop" | "container.restart" | "container.remove", options?: Record<string, unknown>) {
    const members = group.members;
    if (members.length === 0) return;
    const verb = type.split(".")[1] as Exclude<GroupActionVerb, "deploy">;
    onSetOptimisticStates?.(Object.fromEntries(members.map((member) => [member.externalId, optimisticForVerb[verb]])));
    await runJob(async () => {
      const results = await Promise.all(
        members.map((member) =>
          postJson<JobResult>(`/api/hosts/${group.hostId}/actions`, {
            type,
            payload: { containerId: member.externalId, ...(options ?? {}) }
          })
        )
      );
      return { jobs: results.map((result) => result.job) };
    });
    await refresh();
  }

  async function composeAction(group: ServiceGroup, verb: "deploy" | "stop" | "remove", body?: Record<string, unknown>) {
    if (!group.stack) return;
    await runJob(() => postJson<JobResult>(`/api/compose/${group.stack!.id}/${verb}`, body ?? {}));
    await refresh();
  }

  async function groupAction(group: ServiceGroup, verb: GroupActionVerb) {
    if (busyKeys.has(group.key)) return;
    setBusy(group.key, true);
    try {
      if (verb === "deploy") {
        await composeAction(group, "deploy");
        return;
      }
      if (verb === "remove") {
        const isComposeDown = Boolean(group.stack);
        const confirmed = await confirm({
          title: isComposeDown ? `Remove ${group.name}` : `Remove ${group.totalCount} container(s)`,
          tone: "danger",
          confirmLabel: isComposeDown ? "Compose down" : "Remove",
          message: isComposeDown
            ? `Run "docker compose down" for ${group.name} on ${group.hostName}? Containers and the project network will be removed.`
            : `Remove ${group.totalCount} container(s) in "${group.name}" on ${group.hostName}?`
        });
        if (!confirmed) return;
        if (isComposeDown) await composeAction(group, "remove", { removeVolumes: false });
        else await runContainerActions(group, "container.remove", { force: true, removeVolumes: false });
        return;
      }
      // A managed stack with no live containers can only be brought up via compose.
      if (verb === "start" && group.stack && group.totalCount === 0) {
        await composeAction(group, "deploy");
        return;
      }
      const type = verb === "start" ? "container.start" : verb === "stop" ? "container.stop" : "container.restart";
      await runContainerActions(group, type);
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
    } finally {
      setBusy(group.key, false);
    }
  }

  async function memberAction(group: ServiceGroup, member: ServiceMember, type: "container.start" | "container.stop" | "container.restart") {
    const verb = type.split(".")[1] as Exclude<GroupActionVerb, "deploy" | "remove">;
    onSetOptimisticStates?.({ [member.externalId]: optimisticForVerb[verb] });
    try {
      await runJob(() => postJson<JobResult>(`/api/hosts/${group.hostId}/actions`, { type, payload: { containerId: member.externalId } }));
      await refresh();
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
    }
  }

  async function checkUpdates() {
    setCheckingUpdates(true);
    try {
      const result = await postJson<{ apps: DockerApp[] }>("/api/apps/check-updates", {});
      const updateCount = result.apps.filter((app) => app.update.status === "update_available").length;
      setShowUpdateSummary(true);
      setUpdateSummaryDismissed(false);
      setLastUpdateScanAt(new Date().toISOString());
      setTagLookups({});
      await refresh();
      pushToast(
        updateCount > 0
          ? `${updateCount} service update${updateCount === 1 ? "" : "s"} found`
          : "Tracked update scan completed; checking version tags",
        "success"
      );
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function updateApp(app: DockerApp) {
    await runJob(() => postJson<Jobish>(`/api/apps/${encodeURIComponent(app.id)}/update`, {}));
    await refresh();
  }

  function closeSourceDrawer() {
    setSourceTarget(null);
    setSourceForm(null);
    setVersionLookup(emptyVersionLookup);
    setVersionQuery("");
  }

  function openSourceLink(app: DockerApp) {
    setSourceTarget(app);
    setSourceForm(sourceFormFromApp(app));
    setVersionLookup(emptyVersionLookup);
    setVersionQuery("");
  }

  function openRename(app: DockerApp) {
    setRenameTarget(app);
    setRenameValue(app.name);
  }

  function closeRename() {
    setRenameTarget(null);
    setRenameValue("");
  }

  function patchSourceForm(patch: Partial<SourceLinkForm>) {
    setSourceForm((current) => current ? { ...current, ...patch } : current);
    if (patch.repositoryUrl || patch.sourceType) setVersionLookup(emptyVersionLookup);
  }

  function selectSourceChannel(channel: string) {
    if (!sourceForm) return;
    if (sourceForm.sourceType === "git") {
      patchSourceForm({ branch: channel });
      return;
    }
    if (sourceForm.sourceType === "image") {
      patchSourceForm({ imageReference: imageReferenceWithTag(sourceForm.imageReference, channel) });
    }
  }

  async function saveSourceLink() {
    if (!sourceTarget || !sourceForm) return;
    setSavingSource(true);
    try {
      await putJson(`/api/apps/${encodeURIComponent(sourceTarget.id)}/source`, sourcePayload(sourceForm));
      await postJson("/api/apps/check-updates", { hostId: sourceTarget.hostId });
      closeSourceDrawer();
      await refresh();
      pushToast("Service source updated", "success");
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
    } finally {
      setSavingSource(false);
    }
  }

  async function clearSourceLink() {
    if (!sourceTarget) return;
    setSavingSource(true);
    try {
      await deleteJson(`/api/apps/${encodeURIComponent(sourceTarget.id)}/source`);
      closeSourceDrawer();
      await refresh();
      pushToast("Service source cleared", "success");
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
    } finally {
      setSavingSource(false);
    }
  }

  async function saveRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.name) {
      closeRename();
      return;
    }
    setSavingSource(true);
    try {
      await putJson(`/api/apps/${encodeURIComponent(renameTarget.id)}/name`, { name });
      closeRename();
      await refresh();
      pushToast("Service renamed", "success");
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
    } finally {
      setSavingSource(false);
    }
  }

  async function loadGithubVersions() {
    if (!sourceTarget) return;
    setVersionLookup({ status: "loading", selectingRef: null });
    try {
      const response = await api<{ versions: AppGithubVersions }>(`/api/apps/${encodeURIComponent(sourceTarget.id)}/versions`);
      setVersionLookup({ status: "ready", data: response.versions, selectingRef: null });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setVersionLookup({ status: "error", error: message, selectingRef: null });
      pushToast(message, "error");
    }
  }

  async function selectGithubVersion(ref: string, kind?: AppGithubVersionKind, deployAfter = false) {
    if (!sourceTarget || !ref.trim()) return;
    const selectedRef = ref.trim();
    setVersionLookup((current) => ({ ...current, selectingRef: selectedRef }));
    try {
      await putJson(`/api/apps/${encodeURIComponent(sourceTarget.id)}/version`, { ref: selectedRef, kind });
      patchSourceForm({ branch: selectedRef });
      if (deployAfter) await updateApp(sourceTarget);
      else await refresh();
      const response = await api<{ versions: AppGithubVersions }>(`/api/apps/${encodeURIComponent(sourceTarget.id)}/versions`);
      setVersionLookup({ status: "ready", data: response.versions, selectingRef: null });
      pushToast(deployAfter ? `Updating ${sourceTarget.name} from ${selectedRef}` : `Now tracking ${selectedRef}`, "success");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setVersionLookup((current) => ({ ...current, status: current.status === "loading" ? "idle" : current.status, error: message, selectingRef: null }));
      pushToast(message, "error");
    }
  }

  async function updateServiceImages(group: ServiceGroup, targets: ServiceImageUpdateTarget[]) {
    if (targets.length === 0) return;
    const confirmed = await confirm({
      title: `Update ${group.name}`,
      confirmLabel: "Update service",
      message: `Update ${targets.length} container${targets.length === 1 ? "" : "s"} in "${group.name}" together?`
    });
    if (!confirmed) return;
    setBusy(group.key, true);
    try {
      await runJob(async () => {
        const results = await Promise.all(targets.map((target) =>
          postJson<JobResult>(`/api/hosts/${group.hostId}/actions`, {
            type: "container.update",
            payload: { containerId: target.containerId, targetImage: target.targetImage }
          })
        ));
        return { jobs: results.map((result) => result.job) };
      });
      setImageUpdateTarget(null);
      await refresh();
    } catch (caught) {
      pushToast(caught instanceof Error ? caught.message : String(caught), "error");
    } finally {
      setBusy(group.key, false);
    }
  }

  function memberDisplayState(member: ServiceMember) {
    return optimisticContainerStates[member.externalId]?.state ?? member.rawState;
  }

  function memberTransitioning(member: ServiceMember) {
    return transitioningContainerIds.has(member.externalId) || Boolean(optimisticContainerStates[member.externalId]);
  }

  return (
    <Panel title="Services" count={summary.totalServices}>
      <div className="servicesToolbar">
        <div className="servicesSummary">
          <div>
            <span>Services</span>
            <strong>{summary.runningServices}/{summary.totalServices}</strong>
          </div>
          <div>
            <span>Containers</span>
            <strong>{summary.runningContainers}/{summary.totalContainers}</strong>
          </div>
          {summary.partialServices > 0 && (
            <div className="servicesSummaryWarn">
              <span>Degraded</span>
              <strong>{summary.partialServices}</strong>
            </div>
          )}
          <div className={serviceUpdates > 0 ? "servicesSummaryWarn" : ""}>
            <span>Updates</span>
            <strong>{serviceUpdates}</strong>
          </div>
        </div>
        <input
          placeholder="Filter by service, image, or host"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter services"
        />
        <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as ServiceStateFilter)} aria-label="Filter by state">
          <option value="all">All states</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
        </select>
        <ButtonRow>
          {onOpenCompose && (
            <button type="button" onClick={onOpenCompose} title="Create or edit compose stacks">
              <Layers size={16} />
              Compose
            </button>
          )}
          <button type="button" onClick={toggleExpandAll} disabled={visibleGroups.length === 0}>
            <ListTree size={16} />
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
          <button type="button" onClick={() => void checkUpdates()} disabled={checkingUpdates} title="Scan service updates">
            <RefreshCw size={16} className={checkingUpdates ? "spin" : undefined} />
            Scan updates
          </button>
        </ButtonRow>
      </div>

      {shouldShowUpdateSummary && (
        <section className="servicesUpdateSummary" aria-label="Service update summary">
          <div className="servicesUpdateSummaryHeader">
            <div>
              <span>Update summary</span>
              <strong>
                {tagScanLoading
                  ? "Scanning services"
                  : updateSummaryItems.length > 0
                    ? `${updateSummaryItems.length} service${updateSummaryItems.length === 1 ? "" : "s"} need attention`
                    : "Everything looks current"}
              </strong>
              <small>
                {lastUpdateScanAt ? `Last scanned ${formatDate(lastUpdateScanAt)}` : "Based on the latest saved check"}
              </small>
            </div>
            <ButtonRow>
              <button type="button" onClick={() => void checkUpdates()} disabled={checkingUpdates}>
                <RefreshCw size={15} className={checkingUpdates ? "spin" : undefined} />
                Rescan
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUpdateSummary(false);
                  setUpdateSummaryDismissed(true);
                }}
              >
                Hide
              </button>
            </ButtonRow>
          </div>
          {tagScanLoading && <div className="notice">Checking registry tags so numbered versions can be compared.</div>}
          {!tagScanLoading && updateSummaryItems.length === 0 && (
            <div className="notice success">No outdated digests, newer numbered tags, or failed checks were found for the current service inventory.</div>
          )}
          {updateSummaryItems.length > 0 && (
            <div className="servicesUpdateRows">
              {updateSummaryItems.map(({ app, group, imageReference, currentTag, lookup }) => {
                const reason = updateReason(app, lookup, currentTag);
                const trackedDigestUpdate = app.update.kind === "image" && app.update.status === "update_available";
                const latestLabel = app.update.kind === "git"
                  ? compactText(app.update.availableVersion, 12) || "Unknown"
                  : trackedDigestUpdate
                    ? versionValue(app, "latest")
                  : currentTag
                    ? tagLookupLabel(lookup, currentTag)
                    : versionValue(app, "latest");
                return (
                  <div key={`${group.key}:${app.id}`} className="servicesUpdateRow">
                    <div className="servicesUpdateService">
                      <strong>{app.name}</strong>
                      <small>{group.hostName}</small>
                    </div>
                    <div>
                      <span>Reason</span>
                      <strong>{reason}</strong>
                    </div>
                    <div>
                      <span>Current</span>
                      <code>{app.update.kind === "git" ? versionValue(app, "current") : currentTag ? displayImageTag(currentTag) : versionValue(app, "current")}</code>
                    </div>
                    <div>
                      <span>Latest</span>
                      <code title={lookup?.status === "error" ? lookup.error : undefined}>{latestLabel}</code>
                    </div>
                    <div className="servicesUpdateImage">
                      <span>{app.update.kind === "git" ? "Source" : "Image"}</span>
                      <code title={imageReference ?? app.repositoryUrl ?? undefined}>{imageReference ?? app.repositoryUrl ?? "Unknown"}</code>
                    </div>
                    <ButtonRow>
                      <button
                        type="button"
                        onClick={() => app.update.kind === "git" ? openSourceLink(app) : setImageUpdateTarget(group)}
                        disabled={app.update.kind !== "git" && group.members.length === 0}
                      >
                        More details
                      </button>
                    </ButtonRow>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {hasGitServices && (
        <div className="formHint servicesSourceHint">
          Private GitHub repositories use Deploy -&gt; Tracked GitHub repositories with a fine-grained token that has read-only Contents access.
        </div>
      )}

      {visibleGroups.length === 0 ? (
        <EmptyState
          headline={groups.length === 0 ? "No services running" : "No services match your filter"}
          hint={groups.length === 0
            ? "Deploy a compose stack or run a container and it will appear here grouped by its compose project."
            : "Adjust the search or state filter to see more services."}
        />
      ) : (
        <div className="serviceList">
          {visibleGroups.map((group) => {
            const isOpen = expanded.has(group.key);
            const busy = busyKeys.has(group.key);
            const links = publishedWebLinks(group.hostHostname, group.ports);
            const hasContainers = group.totalCount > 0;
            const selfManaged = isSelfManagementServiceGroup(group);
            const selfManagedTitle = "Lifecycle actions are disabled for ComposeBastion itself.";
            const app = appByGroupKey.get(group.key) ?? null;
            const appReadinessKey = app ? readinessKeyForApp(app) : "";
            const appReadiness = appReadinessKey ? readinessByAppKey.get(appReadinessKey) ?? null : null;
            const canLinkSource = Boolean(app?.id.startsWith("container:") && app.primaryContainerId);
            const canOpenSource = Boolean(app && (canLinkSource || (app.source === "git" && app.repositoryUrl)));
            const sourceRef = app ? sourceReferenceLabel(app, group) : null;
            const displayName = app?.name ?? group.name;
            return (
              <div key={group.key} className={`serviceCard status-${group.status}${busy ? " busy" : ""}`}>
                <div className="serviceCardHeader">
                  <button
                    type="button"
                    className="serviceExpandToggle"
                    onClick={() => toggleExpanded(group.key)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Collapse service" : "Expand service"}
                    disabled={!hasContainers}
                  >
                    {hasContainers ? (isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />) : <span className="serviceExpandSpacer" />}
                  </button>
                  <span className={`serviceStatusDot ${group.status}`} aria-hidden="true" />
                  <div className="serviceIdentity">
                    <div className="serviceTitleRow">
                      <strong>{displayName}</strong>
                      <span className={`serviceKindBadge ${group.kind}`}>
                        {group.kind === "compose" ? <Boxes size={12} /> : <Server size={12} />}
                        {group.kind === "compose" ? "Compose" : "Standalone"}
                      </span>
                      {showHost && <span className="serviceHostBadge"><Server size={12} />{group.hostName}</span>}
                      <span className="serviceCountBadge">{group.runningCount}/{group.totalCount} running</span>
                      {app && <span className={`serviceUpdateBadge ${app.update.status}`}>{updateLabel(app)}</span>}
                      {appReadiness && (
                        <span className={`readinessPill ${recoveryReadinessClass(appReadiness.status)}`} title={appReadiness.reasons[0]?.message ?? "Recovery readiness"}>
                          {recoveryReadinessLabel(appReadiness.status)} {appReadiness.score}
                        </span>
                      )}
                      {busy && <RefreshCw className="spin" size={14} />}
                    </div>
                    {app && (
                      <div className="serviceVersionRow">
                        <span className={`appSourcePill ${app.source}`}>{sourceLabel(app.source)}</span>
                        {sourceRef && <span>{sourceRef.label} <code>{compactText(sourceRef.value, 18)}</code></span>}
                        <span>{versionLabel(app, "current")} <code>{versionValue(app, "current")}</code></span>
                        <span>{versionLabel(app, "latest")} <code>{versionValue(app, "latest")}</code></span>
                        {app.update.checkedAt && <span>Checked {formatDate(app.update.checkedAt)}</span>}
                        {app.update.riskNote && <small title={app.update.riskNote}>{compactText(app.update.riskNote, 90)}</small>}
                      </div>
                    )}
                    <div className="serviceMetaRow">
                      {group.images.length > 0 && (
                        <code className="serviceMetaImage" title={group.images.join("\n")}>
                          {group.images[0]}{group.images.length > 1 ? ` +${group.images.length - 1}` : ""}
                        </code>
                      )}
                      {group.workingDir && (
                        <span className="serviceMetaPath" title={group.configFile ?? group.workingDir}>
                          <FolderGit2 size={12} />
                          {group.workingDir}
                        </span>
                      )}
                      {links.length > 0 && (
                        <span className="serviceMetaLinks">
                          {links.slice(0, 3).map((link) => (
                            <a key={link.port} href={link.url} target="_blank" rel="noreferrer" title={`Open ${link.url}`}>
                              <ExternalLink size={12} />{link.port}
                            </a>
                          ))}
                          {links.length > 3 && <span className="serviceMetaLinkMore">+{links.length - 3}</span>}
                        </span>
                      )}
                    </div>
                    <div className="serviceDataRow">
                      <span className={group.dataMounts.length ? "serviceDataState ok" : "serviceDataState warn"}>
                        Data
                      </span>
                      {group.dataMounts.length > 0 ? (
                        group.dataMounts.slice(0, 4).map((mount) => (
                          <code key={`${mount.type}:${mount.source ?? mount.name}:${mount.destination}`} title={dataMountLabel(mount)}>
                            {dataMountLabel(mount)}
                          </code>
                        ))
                      ) : (
                        <span>No persistent data mounts detected</span>
                      )}
                      {group.dataMounts.length > 4 && <span>+{group.dataMounts.length - 4}</span>}
                    </div>
                    {group.dataWarnings.length > 0 && (
                      <div className="serviceDataWarning">
                        <ShieldAlert size={13} />
                        {group.dataWarnings[0]}{group.dataWarnings.length > 1 ? ` +${group.dataWarnings.length - 1}` : ""}
                      </div>
                    )}
                    {group.stack?.lastDeployError && (
                      <div className="serviceDeployError" title={group.stack.lastDeployError}>{group.stack.lastDeployError}</div>
                    )}
                    {selfManaged && (
                      <div className="serviceSafetyWarning">
                        <ShieldAlert size={13} />
                        ComposeBastion is running here. Lifecycle actions are disabled to avoid stopping this console.
                      </div>
                    )}
                  </div>
                  <ButtonRow className="serviceActions">
                    <button
                      type="button"
                      title={group.stack && !hasContainers ? "Deploy (compose up -d)" : "Start service"}
                      disabled={busy || group.status === "running"}
                      onClick={() => void groupAction(group, "start")}
                    >
                      <Play size={15} />
                    </button>
                    <button
                      type="button"
                      title={selfManaged ? selfManagedTitle : "Stop service"}
                      disabled={busy || selfManaged || !hasContainers || group.runningCount === 0}
                      onClick={() => void groupAction(group, "stop")}
                    >
                      <Square size={15} />
                    </button>
                    <button
                      type="button"
                      title={selfManaged ? selfManagedTitle : "Restart service"}
                      disabled={busy || selfManaged || !hasContainers}
                      onClick={() => void groupAction(group, "restart")}
                    >
                      <RotateCcw size={15} />
                    </button>
                    {group.stack && (
                      <button
                        type="button"
                        title={selfManaged ? selfManagedTitle : "Redeploy (compose up -d)"}
                        disabled={busy || selfManaged}
                        onClick={() => void groupAction(group, "deploy")}
                      >
                        <UploadCloud size={15} />
                      </button>
                    )}
                    {canOpenSource && app && (
                      <button
                        type="button"
                        title={app.source === "git" && app.repositoryUrl ? `GitHub versions for ${app.name}` : app.sourceLink ? `Edit source for ${app.name}` : `Link source for ${app.name}`}
                        onClick={() => openSourceLink(app)}
                      >
                        {app.source === "git" && app.repositoryUrl ? <GitBranch size={15} /> : <Link2 size={15} />}
                      </button>
                    )}
                    {app && (
                      <button
                        type="button"
                        title={`Rename ${app.name}`}
                        disabled={busy}
                        onClick={() => openRename(app)}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                    {hasContainers && (
                      <button
                        type="button"
                        title={selfManaged ? selfManagedTitle : "Update service image tags"}
                        disabled={busy || selfManaged}
                        onClick={() => setImageUpdateTarget(group)}
                      >
                        <Tags size={15} />
                      </button>
                    )}
                    {app && (
                      <button
                        type="button"
                        className={app.update.status === "update_available" ? "servicePrimaryAction" : undefined}
                        title={app.update.status === "update_available" ? "Apply available update" : "Run update action"}
                        disabled={busy || selfManaged}
                        onClick={() => void updateApp(app)}
                      >
                        <RefreshCw size={15} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger"
                      title={selfManaged ? selfManagedTitle : group.stack ? "Compose down" : "Remove containers"}
                      disabled={busy || selfManaged || !hasContainers}
                      onClick={() => void groupAction(group, "remove")}
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      type="button"
                      title="Open in Containers"
                      onClick={() => onOpenContainers(group.projectName ?? group.members[0]?.containerName)}
                    >
                      <ExternalLink size={15} />
                    </button>
                  </ButtonRow>
                </div>

                {isOpen && hasContainers && (
                  <div className="serviceMembers">
                    {group.members.map((member) => {
                      const memberLinks = publishedWebLinks(group.hostHostname, member.ports);
                      const transitioning = memberTransitioning(member);
                      return (
                        <div key={member.externalId} className="serviceMemberRow">
                          <div className="serviceMemberName">
                            <strong>{member.serviceName}</strong>
                            <small className="monoText">{member.containerName}</small>
                          </div>
                          <code className="serviceMemberImage" title={member.image}>{member.image || "—"}</code>
                          <div className="serviceMemberState">
                            <ContainerStatePill state={memberDisplayState(member)} />
                            {transitioning && <RefreshCw className="spin" size={12} />}
                          </div>
                          <div className="serviceMemberPorts">
                            {memberLinks.length > 0 ? (
                              memberLinks.slice(0, 2).map((link) => (
                                <a key={link.port} href={link.url} target="_blank" rel="noreferrer" title={`Open ${link.url}`}>
                                  <ExternalLink size={12} />{link.port}
                                </a>
                              ))
                            ) : (
                              <span className="serviceMemberPortsEmpty" title={member.ports}>{member.ports || "No ports"}</span>
                            )}
                          </div>
                          <ButtonRow className="serviceMemberActions">
                            <button type="button" title="Start" disabled={transitioning} onClick={() => void memberAction(group, member, "container.start")}><Play size={14} /></button>
                            <button type="button" title={selfManaged ? selfManagedTitle : "Stop"} disabled={transitioning || selfManaged} onClick={() => void memberAction(group, member, "container.stop")}><Square size={14} /></button>
                            <button type="button" title={selfManaged ? selfManagedTitle : "Restart"} disabled={transitioning || selfManaged} onClick={() => void memberAction(group, member, "container.restart")}><RotateCcw size={14} /></button>
                            <button type="button" title="Open in Containers" onClick={() => onOpenContainers(member.containerName)}><ExternalLink size={14} /></button>
                          </ButtonRow>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {sourceTarget && sourceForm && (
        <form
          className="drawer appSourceDrawer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canEditSourceLink) void saveSourceLink();
            else if (sourceForm.sourceType === "git") void selectGithubVersion(sourceForm.branch, "branch");
          }}
        >
          <div className="panelHeader">
            <h3>{canEditSourceLink ? "Source" : "GitHub versions"} for {sourceTarget.name}</h3>
            <button type="button" onClick={closeSourceDrawer}>Close</button>
          </div>
          <div className="two">
            <label>
              Source
              <select value={sourceForm.sourceType} disabled={!canEditSourceLink} onChange={(event) => patchSourceForm({ sourceType: event.target.value as SourceLinkForm["sourceType"] })}>
                <option value="image">Image tag</option>
                <option value="compose">Compose folder</option>
                <option value="git">Git folder</option>
              </select>
            </label>
            <label>
              Name
              <input value={sourceForm.name} disabled={!canEditSourceLink} onChange={(event) => patchSourceForm({ name: event.target.value })} />
            </label>
          </div>
          {sourceForm.sourceType === "image" ? (
            <>
              <label>
                Image
                <input value={sourceForm.imageReference} disabled={!canEditSourceLink} onChange={(event) => patchSourceForm({ imageReference: event.target.value })} />
              </label>
              <div className="sourceChannelPicker" aria-label="Image channel">
                {sourceChannels.map((channel) => (
                  <button
                    key={channel}
                    type="button"
                    className={activeSourceChannel(sourceForm.sourceType, sourceForm.branch, sourceForm.imageReference) === channel ? "active" : ""}
                    disabled={!canEditSourceLink || !sourceForm.imageReference.trim()}
                    onClick={() => selectSourceChannel(channel)}
                  >
                    {channel}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="two">
                <label>
                  Working directory
                  <input value={sourceForm.workingDir} disabled={!canEditSourceLink} onChange={(event) => patchSourceForm({ workingDir: event.target.value })} placeholder="/srv/apps/example" />
                </label>
                <label>
                  Compose path
                  <input value={sourceForm.composePath} disabled={!canEditSourceLink} onChange={(event) => patchSourceForm({ composePath: event.target.value })} />
                </label>
              </div>
              {sourceForm.sourceType === "git" && (
                <div className="two">
                  <label>
                    Repository URL
                    <input value={sourceForm.repositoryUrl} disabled={!canEditSourceLink} onChange={(event) => patchSourceForm({ repositoryUrl: event.target.value })} />
                  </label>
                  <label>
                    Branch or tag
                    <input value={sourceForm.branch} onChange={(event) => patchSourceForm({ branch: event.target.value })} />
                  </label>
                </div>
              )}
              {sourceForm.sourceType === "git" && (
                <div className="sourceChannelPicker" aria-label="Git branch channel">
                  {sourceChannels.map((channel) => (
                    <button
                      key={channel}
                      type="button"
                      className={activeSourceChannel(sourceForm.sourceType, sourceForm.branch, sourceForm.imageReference) === channel ? "active" : ""}
                      disabled={savingSource || versionLookup.selectingRef === channel}
                      onClick={() => canEditSourceLink ? selectSourceChannel(channel) : void selectGithubVersion(channel, "branch")}
                    >
                      {channel}
                    </button>
                  ))}
                </div>
              )}
              {sourceForm.sourceType === "git" && (
                <div className="sourceVersionLookup">
                  <div className="sourceVersionToolbar">
                    <button type="button" onClick={() => void loadGithubVersions()} disabled={!canLoadGithubVersions || versionLookup.status === "loading"}>
                      <RefreshCw size={15} className={versionLookup.status === "loading" ? "spin" : undefined} />
                      Load from GitHub
                    </button>
                    {versionLookup.status === "ready" && versionLookup.data && (
                      <span>
                        {githubVersionUpdateCount} update candidate{githubVersionUpdateCount === 1 ? "" : "s"} from {versionLookup.data.options.length} GitHub ref{versionLookup.data.options.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {versionLookup.status === "loading" && <span>Loading branches, tags, and releases...</span>}
                  </div>
                  {versionLookup.status === "ready" && versionLookup.data && (
                    <input
                      value={versionQuery}
                      onChange={(event) => setVersionQuery(event.target.value)}
                      placeholder="Filter branches, tags, and releases"
                      aria-label="Filter GitHub versions"
                    />
                  )}
                  {versionLookup.status === "error" && <div className="sourceVersionError">{versionLookup.error}</div>}
                  {versionLookup.status === "ready" && versionLookup.data && (
                    <div className="sourceVersionGroups">
                      {githubVersionGroups.filter((group) => group.options.length > 0).map((group) => (
                        <section key={group.kind} className="sourceVersionGroup">
                          <h4>{group.label}<span>{group.options.length}</span></h4>
                          <div className="sourceVersionOptions">
                            {group.options.map((option: AppGithubVersionOption) => (
                              <button
                                key={`${option.kind}:${option.ref}:${option.label}`}
                                type="button"
                                className={`sourceVersionOption${option.selected ? " selected" : ""}${option.updateAvailable ? " update" : ""}`}
                                disabled={savingSource || versionLookup.selectingRef === option.ref}
                                onClick={() => void selectGithubVersion(option.ref, option.kind)}
                              >
                                <span className="sourceVersionName">
                                  <strong>{option.label}</strong>
                                  <small>{option.ref}</small>
                                </span>
                                <span className="sourceVersionMeta">
                                  <code>{shortVersionSha(option.commitSha)}</code>
                                  {option.selected && <span className="selected">selected</span>}
                                  {option.deployed && <span className="deployed">deployed</span>}
                                  {option.updateAvailable && <span className="update">update</span>}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <ButtonRow>
            {canEditSourceLink && <button type="submit" className="primary" disabled={savingSource}><Link2 size={16} />Save Source</button>}
            {sourceForm.sourceType === "git" && (
              <button
                type="button"
                className={canEditSourceLink ? undefined : "primary"}
                disabled={savingSource || !sourceForm.branch.trim() || versionLookup.selectingRef === sourceForm.branch.trim()}
                onClick={() => void selectGithubVersion(sourceForm.branch, "branch")}
              >
                <GitBranch size={16} />Set ref
              </button>
            )}
            {sourceForm.sourceType === "git" && sourceTarget && (
              <button
                type="button"
                className="primary"
                disabled={savingSource || !sourceForm.branch.trim() || versionLookup.selectingRef === sourceForm.branch.trim()}
                onClick={() => void selectGithubVersion(sourceForm.branch, "branch", true)}
              >
                <UploadCloud size={16} />Set ref and update service
              </button>
            )}
            {canEditSourceLink && <button type="button" disabled={savingSource || !sourceTarget.sourceLink} onClick={() => void clearSourceLink()}><Unlink size={16} />Clear</button>}
          </ButtonRow>
        </form>
      )}
      {renameTarget && (
        <form
          className="drawer appRenameDrawer"
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
        >
          <div className="panelHeader">
            <h3>Rename {renameTarget.name}</h3>
            <button type="button" onClick={closeRename}>Close</button>
          </div>
          <label>
            Display name
            <input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={120}
              autoFocus
            />
          </label>
          <ButtonRow>
            <button type="button" onClick={closeRename}>Cancel</button>
            <button type="submit" className="primary" disabled={savingSource || !renameValue.trim() || renameValue.trim() === renameTarget.name}>
              Save name
            </button>
          </ButtonRow>
        </form>
      )}
      {imageUpdateTarget && (
        <ServiceImageUpdateDrawer
          group={imageUpdateTarget}
          images={images}
          availableImageUpdates={imageDigestUpdatesForApp(appByGroupKey.get(imageUpdateTarget.key))}
          busy={busyKeys.has(imageUpdateTarget.key)}
          onClose={() => setImageUpdateTarget(null)}
          onUpdate={(targets) => updateServiceImages(imageUpdateTarget, targets)}
        />
      )}
    </Panel>
  );
}
