import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Download, Play, RefreshCw, Search, ShieldAlert, Star, Trash2 } from "lucide-react";
import type { DockerHost, FavoriteImage, ImageCleanupCandidate, ImageCleanupTarget, ImageScanResult, ImageUpdateCheck, ResourceSnapshot } from "@composebastion/shared";
import { containerData, containerStateLabel, imageReference } from "@composebastion/shared";
import { api, deleteJson, postJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useToast } from "../ToastProvider.js";
import { ButtonRow, DataTable, EmptyState, InlineForm, Panel, VirtualDataTable } from "../ui/primitives.js";
import { ContainerRunForm } from "../containers/ContainerRunForm.js";
import { useAuthorization } from "../AuthorizationContext.js";

function normalizeImageId(value: string) {
  return value.trim().split("@")[0] ?? "";
}

function imageKey(hostId: string, image: string) {
  return `${hostId}:${normalizeImageId(image)}`;
}

function isDanglingImage(row: ResourceSnapshot) {
  const data = row.data as Record<string, unknown>;
  const repository = String(data.Repository ?? "");
  const tag = String(data.Tag ?? "");
  const reference = imageReference(row);
  return repository === "<none>" || tag === "<none>" || reference === "<none>" || reference === "<none>:<none>";
}

function compactVulnerabilities(scan: ImageScanResult | undefined) {
  if (!scan) return <span className="muted">Not scanned</span>;
  const { critical, high, medium, low } = scan.severityCounts;
  if (critical === 0 && high === 0 && medium === 0 && low === 0) {
    return <span className="pill ok">Clean</span>;
  }
  return (
    <span className="imageVulnerabilityCell">
      {critical > 0 && <span className="pill danger" title="Critical">C:{critical}</span>}
      {high > 0 && <span className="pill warning" title="High">H:{high}</span>}
      {medium > 0 && <span className="pill info" title="Medium">M:{medium}</span>}
      {low > 0 && <span className="pill muted" title="Low">L:{low}</span>}
    </span>
  );
}

function updateStatusLabel(update?: ImageUpdateCheck) {
  if (!update) return "Not checked";
  if (update.status === "up_to_date") return "Up to date";
  if (update.status === "update_available") return "Update available";
  if (update.status === "error") return "Check failed";
  if (update.status === "local") return "Local image";
  return "Unknown";
}

function updateStatusClass(update?: ImageUpdateCheck) {
  if (!update || update.status === "unknown" || update.status === "local") return "stopped";
  if (update.status === "up_to_date") return "completed";
  if (update.status === "update_available") return "warning";
  return "danger";
}

function imageUsedText(usage: { running: string[]; all: string[] } | undefined, fallback: string[]) {
  const names = usage?.all.length ? usage.all : fallback;
  if (names.length === 0) {
    return <span className="muted">No containers</span>;
  }
  const runningText = usage && usage.running.length > 0 ? `${usage.running.length} running` : "none running";
  const preview = names.slice(0, 2).map((item) => item).join(", ");
  const remaining = names.length > 2 ? ` +${names.length - 2}` : "";
  return (
    <span className="imageUsedByCell" title={names.join(", ")}>
      <strong>{names.length} used</strong>
      <small>{runningText}</small>
      <span>{preview}{remaining}</span>
    </span>
  );
}

type CleanupRow = ImageCleanupCandidate & { id: string };

export function ImagesPanel({
  host,
  hosts,
  images,
  containers,
  networks,
  favoriteImages,
  onAction,
  refresh,
  listQuery,
  listQueryKey = 0
}: {
  host: DockerHost;
  hosts: DockerHost[];
  images: ResourceSnapshot[];
  containers: ResourceSnapshot[];
  networks: ResourceSnapshot[];
  favoriteImages: FavoriteImage[];
  onAction: (type: string, payload?: Record<string, unknown>, hostId?: string) => Promise<void>;
  refresh: () => Promise<void>;
  listQuery?: string;
  listQueryKey?: number;
}) {
  const { canOperate } = useAuthorization();
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [image, setImage] = useState("");
  const [showPullTools, setShowPullTools] = useState(false);
  const [showRunTools, setShowRunTools] = useState(false);
  const [showFavorites, setShowFavorites] = useState(false);
  const [showCleanupTools, setShowCleanupTools] = useState(false);
  const [showDanglingImages, setShowDanglingImages] = useState(false);
  const [runPreset, setRunPreset] = useState<{ image: string; hostId: string; nonce: number } | null>(null);
  const [favorite, setFavorite] = useState({ image: "", name: "", notes: "" });
  const [scans, setScans] = useState<ImageScanResult[]>([]);
  const [updates, setUpdates] = useState<ImageUpdateCheck[]>([]);
  const [scanningImages, setScanningImages] = useState<Set<string>>(new Set());
  const [cleanupRows, setCleanupRows] = useState<CleanupRow[]>([]);
  const [selectedCleanupIds, setSelectedCleanupIds] = useState<Set<string>>(new Set());
  const [cleanupLoading, setCleanupLoading] = useState(false);

  const isFavoriteImage = useMemo(
    () => new Set(favoriteImages.map((item) => item.image)),
    [favoriteImages]
  );
  const containerUsageByImage = useMemo(() => {
    const map = new Map<string, { running: string[]; all: string[] }>();
    for (const container of containers) {
      const data = containerData(container);
      const imageRef = normalizeImageId(String(data.Image ?? ""));
      if (!imageRef) continue;
      const state = containerStateLabel(String(data.State ?? ""));
      const names = map.get(imageKey(container.hostId, imageRef)) ?? { running: [], all: [] };
      names.all.push(String(data.Names ?? container.name));
      if (state === "running") names.running.push(String(data.Names ?? container.name));
      map.set(imageKey(container.hostId, imageRef), names);
    }
    return map;
  }, [containers]);

  const imageLookup = useMemo(() => {
    const map = new Map<string, ImageUpdateCheck>();
    for (const item of updates) {
      map.set(imageKey(item.hostId, item.imageReference), item);
    }
    return map;
  }, [updates]);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast("Copied to clipboard", "success");
    } catch {
      pushToast("Failed to copy", "error");
    }
  };

  const runHost = hosts.find((item) => item.id === runPreset?.hostId) ?? host;

  const imageHostIds = useMemo(
    () => Array.from(new Set(images.map((item) => item.hostId ?? host.id))),
    [host.id, images]
  );

  const loadScans = useCallback(async () => {
    const results = await Promise.all(
      imageHostIds.length
        ? imageHostIds.map((hostId) => api<{ scans: ImageScanResult[] }>(`/api/image-scans?hostId=${encodeURIComponent(hostId)}`))
        : [api<{ scans: ImageScanResult[] }>(`/api/image-scans?hostId=${encodeURIComponent(host.id)}`)]
    );
    setScans(results.flatMap((result) => result.scans));
  }, [host.id, imageHostIds]);

  const loadUpdates = useCallback(async () => {
    const results = await Promise.all(
      imageHostIds.length
        ? imageHostIds.map((hostId) => api<{ updates: ImageUpdateCheck[] }>(`/api/image-updates?hostId=${encodeURIComponent(hostId)}`))
        : [api<{ updates: ImageUpdateCheck[] }>(`/api/image-updates?hostId=${encodeURIComponent(host.id)}`)]
    );
    setUpdates(results.flatMap((result) => result.updates));
  }, [host.id, imageHostIds]);

  const refreshImageInventory = useCallback(async () => {
    await refresh();
    await Promise.all([loadScans(), loadUpdates()]);
  }, [loadScans, loadUpdates, refresh]);

  useEffect(() => {
    void loadScans();
    void loadUpdates();
  }, [loadScans, loadUpdates]);

  const runImage = (imageName: string, hostId = host.id) => {
    setRunPreset({ image: imageName, hostId, nonce: Date.now() });
    setShowRunTools(true);
    setShowPullTools(false);
    setShowFavorites(false);
    setShowCleanupTools(false);
  };

  async function pullImage(imageName: string, hostId = host.id) {
    await onAction("image.pull", { image: imageName }, hostId);
    setImage("");
    await refreshImageInventory();
  }

  async function handleScan(imageName: string, hostId = host.id) {
    const scanKey = imageKey(hostId, imageName);
    setScanningImages((current) => {
      const next = new Set(current);
      next.add(scanKey);
      return next;
    });
    try {
      await postJson("/api/image-scans", { hostId, imageReference: imageName });
      pushToast("Image scan completed", "success");
      await loadScans();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setScanningImages((current) => {
        const next = new Set(current);
        next.delete(scanKey);
        return next;
      });
    }
  }

  async function loadCleanupPreview() {
    setShowCleanupTools(true);
    setShowPullTools(false);
    setShowRunTools(false);
    setShowFavorites(false);
    setCleanupLoading(true);
    try {
      const result = await api<{ candidates: ImageCleanupCandidate[] }>(`/api/hosts/${host.id}/image-cleanup`);
      const rows = result.candidates.map((candidate) => ({
        ...candidate,
        id: `${candidate.imageId}:${candidate.reference}`
      }));
      setCleanupRows(rows);
      setSelectedCleanupIds(new Set(rows.filter((row) => row.eligible).map((row) => row.id)));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setCleanupLoading(false);
    }
  }

  async function cleanSelectedImages() {
    const targets: ImageCleanupTarget[] = cleanupRows
      .filter((row) => row.eligible && selectedCleanupIds.has(row.id))
      .map((row) => ({ imageId: row.imageId, reference: row.reference }));
    if (!targets.length) return;
    const ok = await confirm({
      title: "Clean unused images",
      tone: "danger",
      confirmLabel: "Delete selected",
      message: `Delete ${targets.length} unused image${targets.length === 1 ? "" : "s"} from ${host.name}? Images used by any container are blocked.`
    });
    if (!ok) return;
    await onAction("image.cleanup", { targets }, host.id);
    await refreshImageInventory();
    await loadCleanupPreview();
  }

  useEffect(() => {
    if (listQuery !== undefined) setImage(listQuery);
  }, [listQuery, listQueryKey]);

  const hasImageInput = image.trim().length > 0;
  const danglingImageCount = useMemo(() => images.filter(isDanglingImage).length, [images]);
  const visibleImages = useMemo(
    () => showDanglingImages ? images : images.filter((item) => !isDanglingImage(item)),
    [images, showDanglingImages]
  );
  const eligibleCleanupRows = cleanupRows.filter((row) => row.eligible);
  const selectedCleanupCount = eligibleCleanupRows.filter((row) => selectedCleanupIds.has(row.id)).length;

  return (
    <Panel title="Images" count={visibleImages.length}>
      <div className="resourceHeader imagesPanelHeader">
        <div>
          <strong>{visibleImages.length} images</strong>
          <span>Inventory, health, and maintenance actions for local images.</span>
        </div>
          <ButtonRow className="imagesPanelToolbar">
            <button
              type="button"
              className="imagesPanelToolbarButton"
              disabled={danglingImageCount === 0}
              onClick={() => setShowDanglingImages((value) => !value)}
            >
              {showDanglingImages ? "Hide dangling" : `Show dangling (${danglingImageCount})`}
            </button>
            {canOperate && <>
            <button type="button" className="imagesPanelToolbarButton" onClick={() => {
              setShowPullTools((value) => !value);
              setShowFavorites(false);
              setShowCleanupTools(false);
            }}><Download size={16} />Pull image</button>
            <button type="button" className="imagesPanelToolbarButton" disabled={!hasImageInput} onClick={() => {
              if (!image.trim()) return;
              runImage(image.trim(), host.id);
              setShowRunTools(true);
            }}><Play size={16} />Run image</button>
            <button type="button" className="imagesPanelToolbarButton" onClick={() => {
              setShowFavorites((value) => !value);
              setShowPullTools(false);
              setShowRunTools(false);
              setShowCleanupTools(false);
            }}><Star size={16} />Saved images</button>
            <button type="button" className="imagesPanelToolbarButton" onClick={() => void loadCleanupPreview()}>
              <Search size={16} />Clean unused
            </button>
            <button
              type="button"
              className="imagesPanelToolbarButton"
              onClick={() => void (async () => {
                if (await confirm({ title: "Prune dangling layers", tone: "danger", confirmLabel: "Prune", message: "Remove dangling image layers on this host? Tagged images are not removed." })) {
                  void onAction("image.prune", { all: false }, host.id);
                  await refreshImageInventory();
                }
            })()}
          ><Trash2 size={16} />Prune dangling</button>
          </>}
        </ButtonRow>
        {danglingImageCount > 0 && !showDanglingImages && (
          <div className="imagesFilterNote">
            Hiding {danglingImageCount} dangling or untagged image layer{danglingImageCount === 1 ? "" : "s"}. Use Prune dangling to remove unused layers from the selected host.
          </div>
        )}
      </div>
      {visibleImages.length === 0 ? (
        <EmptyState
          headline={images.length === 0 ? "No images found" : "Only dangling images hidden"}
          hint={images.length === 0 ? "Sync this host to discover local images. Then run image checks, vulnerability scans, and maintenance actions." : "Show dangling image layers if you need to inspect or remove the untagged entries."}
          actionLabel={images.length > 0 ? "Show dangling" : undefined}
          onAction={images.length > 0 ? () => setShowDanglingImages(true) : undefined}
        />
      ) : (
        <VirtualDataTable
          rows={visibleImages}
          maxRows={300}
          columns={["Image", "Tags", "Used by", "Update status", "Vulnerabilities", "Size", ...(canOperate ? ["Actions"] : [])]}
          compact
          tableClassName="imagesTable"
          render={(imageRow) => {
            const data = imageRow.data as Record<string, unknown>;
            const imageName = imageReference(imageRow);
            const rowHostId = String(imageRow.hostId ?? host.id);
            const repository = String(data.Repository ?? imageName.split(":").slice(0, -1).join(":") ?? imageName);
            const tag = String(data.Tag ?? "latest");
            const dangling = isDanglingImage(imageRow);
            const lookupImage = normalizeImageId(imageName || "");
            const lookupKey = imageKey(rowHostId, lookupImage);
            const containerUsages = lookupImage ? containerUsageByImage.get(lookupKey) : undefined;
            const update = lookupImage ? imageLookup.get(lookupKey) : undefined;
            const affectedContainers = update?.affectedContainers?.map((item) => item.name) ?? [];
            const scan = scans.find((item) => item.hostId === rowHostId && normalizeImageId(item.imageReference) === lookupImage);
            const isScanning = scanningImages.has(lookupKey);
            return [
              <div key="image" className="copyContainer">
                <span>{repository}</span>
                <button className="copyButton" title="Copy image reference" onClick={() => void handleCopy(imageName)}>
                  <Copy size={12} />
                </button>
              </div>,
              <code key="tag">{tag}</code>,
              imageUsedText(containerUsages, affectedContainers),
              <span key="update" className={`pill ${updateStatusClass(update)}`} title={update?.riskNote ?? ""}>
                {updateStatusLabel(update)}
              </span>,
              <span key="vulnerabilities">{compactVulnerabilities(scan)}</span>,
              <span key="size" className="monoText">{String(data.Size ?? "—")}</span>,
              ...(canOperate ? [<ButtonRow key="actions" className="imageActionRow">
                <button
                  className="imageActionButton"
                  title={dangling ? "Dangling images cannot be scanned" : "Scan image"}
                  disabled={isScanning || dangling}
                  onClick={() => void handleScan(imageName, rowHostId)}
                >
                  {isScanning ? <RefreshCw className="spin" size={14} /> : <ShieldAlert size={14} />}
                </button>
                <button
                  className={`imageActionButton ${update?.status === "update_available" ? "imagesActionButtonPrimary" : ""}`}
                  title={dangling ? "Dangling images cannot be pulled by tag" : "Pull latest"}
                  disabled={dangling}
                  onClick={() => void pullImage(imageName, rowHostId)}
                >
                  <Download size={14} />
                </button>
                <button className="imageActionButton" title={dangling ? "Dangling images cannot be saved as favorites" : "Add to favorites"} disabled={dangling} onClick={() => void postJson("/api/favorite-images", { image: imageName }).then(() => {
                  void refreshImageInventory();
                })}>
                  <Star size={14} className={isFavoriteImage.has(imageName) ? "imagesFavorite" : undefined} />
                </button>
                <button className="imageActionButton" title={dangling ? "Dangling images cannot be run by tag" : "Run image"} disabled={dangling} onClick={() => runImage(imageName, rowHostId)}>
                  <Play size={14} />
                </button>
                <button
                  className="imageActionButton danger"
                  title="Remove image"
                  onClick={() => void onAction("image.remove", { imageId: imageRow.externalId, force: false }, rowHostId)}
                >
                  <Trash2 size={14} />
                </button>
              </ButtonRow>] : [])
            ];
          }}
        />
      )}
      {canOperate && showPullTools && (
        <div className="compactDrawer">
          <div className="compactDrawerHeader">
            <h4>Pull image</h4>
            <button type="button" onClick={() => setShowPullTools(false)}>Close</button>
          </div>
          <InlineForm onSubmit={() => pullImage(image)}>
            <input placeholder="nginx:alpine" value={image} onChange={(event) => setImage(event.target.value)} required />
            <button className="primary" disabled={!image.trim()}><Download size={16} />Pull</button>
            <button
              type="button"
              className="imagesPanelToolbarButton"
              disabled={!image.trim()}
              onClick={() => runImage(image, host.id)}
            >
              <Play size={16} />Run
            </button>
          </InlineForm>
        </div>
      )}
      {canOperate && showRunTools && runPreset && (
        <div className="compactDrawer">
          <div className="compactDrawerHeader">
            <h4>Run image</h4>
            <button type="button" onClick={() => setShowRunTools(false)}>Close</button>
          </div>
          <ContainerRunForm
            host={runHost}
            networks={networks.filter((network) => network.hostId === runHost.id)}
            imagePreset={runPreset}
            buttonLabel="Run Image"
            hint={`Create a new container on ${runHost.name} from ${runPreset.image}.`}
            onCreateNetwork={(payload) => onAction("network.create", payload, runHost.id)}
            onRun={async (payload) => {
              await onAction("container.run", payload, runHost.id);
              await refreshImageInventory();
              setRunPreset(null);
              setShowRunTools(false);
            }}
          />
        </div>
      )}
      {canOperate && showCleanupTools && (
        <div className="compactDrawer">
          <div className="compactDrawerHeader">
            <h4>Clean unused images</h4>
            <ButtonRow>
              <button type="button" onClick={() => void loadCleanupPreview()} disabled={cleanupLoading}>
                <RefreshCw size={14} className={cleanupLoading ? "spin" : undefined} />Refresh
              </button>
              <button type="button" onClick={() => setShowCleanupTools(false)}>Close</button>
            </ButtonRow>
          </div>
          {cleanupLoading ? (
            <div className="notice">Checking image usage on {host.name}…</div>
          ) : (
            <>
              <div className="imagesCleanupSummary">
                <span><strong>{eligibleCleanupRows.length}</strong> removable</span>
                <span><strong>{cleanupRows.length - eligibleCleanupRows.length}</strong> blocked</span>
                <span><strong>{selectedCleanupCount}</strong> selected</span>
              </div>
              <DataTable
                compact
                tableClassName="imagesCleanupTable"
                rows={cleanupRows}
                columns={["", "Image", "Size", "Status", "Reason", "Used by"]}
                render={(row) => [
                  <input
                    key="select"
                    type="checkbox"
                    checked={row.eligible && selectedCleanupIds.has(row.id)}
                    disabled={!row.eligible}
                    aria-label={`Select ${row.reference}`}
                    onChange={() => setSelectedCleanupIds((current) => {
                      const next = new Set(current);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })}
                  />,
                  <code key="image">{row.reference}</code>,
                  <span key="size" className="monoText">{row.size || "—"}</span>,
                  <span key="status" className={`pill ${row.eligible ? "completed" : "stopped"}`}>{row.eligible ? "Removable" : "Blocked"}</span>,
                  row.reason,
                  row.usedBy.length ? row.usedBy.map((usage) => `${usage.name} (${usage.state})`).join(", ") : "—"
                ]}
              />
              <ButtonRow className="recoveryActionRow">
                <button type="button" className="danger" disabled={selectedCleanupCount === 0} onClick={() => void cleanSelectedImages()}>
                  <Trash2 size={16} />Delete selected
                </button>
              </ButtonRow>
            </>
          )}
        </div>
      )}
      {canOperate && showFavorites && (
        <div className="compactDrawer">
          <div className="compactDrawerHeader">
            <h4>Saved images</h4>
            <button type="button" onClick={() => setShowFavorites(false)}>Close</button>
          </div>
          <form
            className="inlineForm"
            onSubmit={(event) => {
              event.preventDefault();
              void postJson("/api/favorite-images", favorite).then(() => {
                setFavorite({ image: "", name: "", notes: "" });
                void refreshImageInventory();
              });
            }}
          >
            <input placeholder="Image reference" value={favorite.image} onChange={(event) => setFavorite({ ...favorite, image: event.target.value })} required />
            <input placeholder="Name" value={favorite.name} onChange={(event) => setFavorite({ ...favorite, name: event.target.value })} />
            <input placeholder="Notes" value={favorite.notes} onChange={(event) => setFavorite({ ...favorite, notes: event.target.value })} />
            <button className="primary"><Star size={14} />Save</button>
          </form>
          {favoriteImages.length > 0 && (
            <div className="favoriteGrid">
              {favoriteImages.map((item) => (
                <div className="favoriteItem" key={item.id}>
                  <strong>{item.name || item.image}</strong>
                  <code>{item.image}</code>
                  {item.notes && <small>{item.notes}</small>}
                  <ButtonRow>
                    <button title={`Pull image on ${host.name}`} onClick={() => void pullImage(item.image)}><Download size={14} />Pull</button>
                    <button title="Run image" onClick={() => runImage(item.image)}><Play size={14} />Run</button>
                    <button title="Remove favorite" className="danger" onClick={() => void deleteJson(`/api/favorite-images/${item.id}`).then(refreshImageInventory)}><Trash2 size={14} />Remove</button>
                  </ButtonRow>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
