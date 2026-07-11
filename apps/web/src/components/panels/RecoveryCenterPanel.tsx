import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  Backup,
  BackupTarget,
  DockerApp,
  DockerHost,
  MigrationPlan,
  MigrationRun,
  MigrationStrategy,
  OperationJob,
  RecoveryPointListItem,
  RecoveryReadiness,
  RecoverySchedule,
  ResourceSnapshot
} from "@composebastion/shared";
import type { Jobish } from "../../lib/dashboardTypes.js";
import { api } from "../../api.js";
import { recoveryReadinessClass, recoveryReadinessLabel } from "../../lib/recovery.js";
import { BackupsPanel } from "./BackupsPanel.js";
import { RecoveryPointsPanel } from "./recovery/RecoveryPointsPanel.js";
import { MoveAppPanel } from "./recovery/MoveAppPanel.js";
import { RecoverySchedulesPanel } from "./recovery/RecoverySchedulesPanel.js";
import { StorageTargetsPanel } from "./recovery/StorageTargetsPanel.js";
import { RecoveryRunsPanel } from "./recovery/RecoveryRunsPanel.js";
import { useAuthorization } from "../AuthorizationContext.js";

export type RecoverySection =
  | "points"
  | "move"
  | "schedules"
  | "targets"
  | "runs"
  | "volume-backups";

const recoverySections: Array<{ id: RecoverySection; label: string }> = [
  { id: "points", label: "Recovery Points" },
  { id: "move", label: "Migrate App" },
  { id: "schedules", label: "Schedules" },
  { id: "targets", label: "Backup Storage" },
  { id: "runs", label: "Restore / Migration Runs" },
  { id: "volume-backups", label: "Backups" }
];

function recoverySectionLabel(section: RecoverySection) {
  return recoverySections.find((item) => item.id === section)?.label ?? "Recovery";
}

export function RecoveryCenterPanel({
  hosts,
  apps,
  readiness,
  resources,
  backups,
  jobs,
  refresh,
  runJob,
  section,
  onSectionChange
}: {
  hosts: DockerHost[];
  apps: DockerApp[];
  readiness?: RecoveryReadiness[];
  resources: ResourceSnapshot[];
  backups: Backup[];
  jobs: OperationJob[];
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  section?: RecoverySection;
  onSectionChange?: (section: RecoverySection) => void;
}) {
  const { canOperate } = useAuthorization();
  const [localSection, setLocalSection] = useState<RecoverySection>(section ?? "points");
  const [points, setPoints] = useState<RecoveryPointListItem[]>([]);
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [schedules, setSchedules] = useState<RecoverySchedule[]>([]);
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const [readinessItems, setReadinessItems] = useState<RecoveryReadiness[]>(readiness ?? []);
  const [plannedRun, setPlannedRun] = useState<MigrationRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetNames = useMemo(
    () => Object.fromEntries(targets.map((target) => [target.id, target.name])),
    [targets]
  );
  const visibleSections = useMemo(
    () => recoverySections.filter((item) => canOperate || item.id === "points" || item.id === "runs" || item.id === "volume-backups"),
    [canOperate]
  );
  const requestedSection = section ?? localSection;
  const activeSection = visibleSections.some((item) => item.id === requestedSection) ? requestedSection : "points";
  const setActiveSection = onSectionChange ?? setLocalSection;
  const readinessSummary = useMemo(() => ({
    ready: readinessItems.filter((item) => item.status === "ready").length,
    needs_profile: readinessItems.filter((item) => item.status === "needs_profile").length,
    risky: readinessItems.filter((item) => item.status === "risky").length,
    blocked: readinessItems.filter((item) => item.status === "blocked").length
  }), [readinessItems]);

  useEffect(() => {
    setReadinessItems(readiness ?? []);
  }, [readiness]);

  const loadRecoveryData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pointsResult, targetsResult, schedulesResult, runsResult, readinessResult] = await Promise.all([
        api<{ points: RecoveryPointListItem[] }>("/api/recovery/points"),
        api<{ targets: BackupTarget[] }>("/api/recovery/targets"),
        canOperate
          ? api<{ schedules: RecoverySchedule[] }>("/api/recovery/schedules")
          : Promise.resolve({ schedules: [] as RecoverySchedule[] }),
        api<{ runs: MigrationRun[] }>("/api/recovery/migrations"),
        api<{ readiness: RecoveryReadiness[] }>("/api/recovery/readiness")
      ]);
      setPoints(pointsResult.points);
      setTargets(targetsResult.targets);
      setSchedules(schedulesResult.schedules);
      setRuns(runsResult.runs);
      setReadinessItems(readinessResult.readiness);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [canOperate]);

  useEffect(() => {
    void loadRecoveryData();
  }, [loadRecoveryData]);

  useEffect(() => {
    if (requestedSection === activeSection) return;
    if (onSectionChange) onSectionChange(activeSection);
    else setLocalSection(activeSection);
  }, [activeSection, onSectionChange, requestedSection]);

  useEffect(() => {
    if (activeSection !== "move") setPlannedRun(null);
  }, [activeSection]);

  return (
    <div className="adminShell recoveryShell">
      <div className={section ? "recoveryContentHeader" : "adminHeader"}>
        <div>
          <h3>{section ? recoverySectionLabel(activeSection) : "Recovery Center"}</h3>
          {!section && <p>App-level recovery points, host migrations, backup targets, and restore history.</p>}
        </div>
        <button type="button" className="topbarRefresh" onClick={() => void loadRecoveryData()} disabled={loading} title="Refresh recovery data">
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="readinessSummaryPanel">
        {(["ready", "needs_profile", "risky", "blocked"] as const).map((status) => (
          <button
            key={status}
            type="button"
            className={`readinessSummaryItem ${recoveryReadinessClass(status)}`}
            onClick={() => setActiveSection("points")}
            title={`${recoveryReadinessLabel(status)} apps`}
          >
            <span>{recoveryReadinessLabel(status)}</span>
            <strong>{readinessSummary[status]}</strong>
          </button>
        ))}
        <button type="button" className="topbarRefresh readinessRefresh" onClick={() => void loadRecoveryData()} disabled={loading} title="Refresh readiness">
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </button>
      </div>
      <div className="adminLayout">
        <nav className="adminNav" aria-label="Recovery Center sections">
          {visibleSections.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeSection === item.id ? "active" : ""}
              onClick={() => setActiveSection(item.id)}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="adminPane">
          {activeSection === "points" && (
            <RecoveryPointsPanel
              hosts={hosts}
              apps={apps}
              points={points}
              readiness={readinessItems}
              targets={targets}
              targetNames={targetNames}
              refresh={async () => {
                await loadRecoveryData();
                await refresh();
              }}
              runJob={runJob}
            />
          )}
          {activeSection === "move" && (
            <MoveAppPanel
              hosts={hosts}
              apps={apps}
              resources={resources}
              jobs={jobs}
              plannedRun={plannedRun}
              onPlanned={setPlannedRun}
              refresh={async () => {
                await loadRecoveryData();
                await refresh();
              }}
              runJob={runJob}
            />
          )}
          {activeSection === "schedules" && (
            <RecoverySchedulesPanel
              hosts={hosts}
              apps={apps}
              targets={targets}
              schedules={schedules}
              refresh={loadRecoveryData}
            />
          )}
          {activeSection === "targets" && (
            <StorageTargetsPanel targets={targets} refresh={loadRecoveryData} />
          )}
          {activeSection === "runs" && (
            <RecoveryRunsPanel hosts={hosts} runs={runs} jobs={jobs} refresh={loadRecoveryData} />
          )}
          {activeSection === "volume-backups" && (
            <BackupsPanel hosts={hosts} backups={backups} jobs={jobs} refresh={refresh} runJob={runJob} />
          )}
        </div>
      </div>
    </div>
  );
}

export type { MigrationPlan, MigrationStrategy, MigrationRun };
