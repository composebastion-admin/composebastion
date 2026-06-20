import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import type { AdminUser, Backup, DockerHost, OperationJob, ResourceSnapshot } from "@dockermender/shared";
import type { Jobish } from "../../lib/dashboardTypes.js";
import type { Theme } from "../../lib/theme.js";
import { AuditPanel } from "./AuditPanel.js";
import { AlertsPanel } from "./AlertsPanel.js";
import { JobsPanel } from "./JobsPanel.js";
import { OperationsPanel } from "./OperationsPanel.js";
import { RegistriesPanel } from "./RegistriesPanel.js";
import { UsersPanel } from "./UsersPanel.js";
import { GlobalSettingsPanel } from "../settings/GlobalSettingsPanel.js";
import { HostSettingsPanel } from "../settings/HostSettingsPanel.js";
import { SessionsPanel } from "../settings/SessionsPanel.js";
import { ButtonRow, Panel } from "../ui/primitives.js";

type AdminSection =
  | "settings"
  | "operations"
  | "appearance"
  | "alerts"
  | "registries"
  | "users"
  | "jobs"
  | "audit";

const adminSections: Array<{ id: AdminSection; label: string }> = [
  { id: "settings", label: "Settings" },
  { id: "operations", label: "Operations" },
  { id: "appearance", label: "Appearance" },
  { id: "alerts", label: "Alerts" },
  { id: "registries", label: "Registries" },
  { id: "users", label: "Users" },
  { id: "jobs", label: "Jobs" },
  { id: "audit", label: "Audit" }
];

export function AdminPanel({
  defaultSection = "settings",
  user,
  hosts,
  selectedHost,
  jobs,
  resources,
  refresh,
  runJob,
  theme,
  onToggleTheme
}: {
  defaultSection?: AdminSection;
  user: AdminUser;
  hosts: DockerHost[];
  selectedHost: DockerHost | null;
  backups: Backup[];
  jobs: OperationJob[];
  resources: ResourceSnapshot[];
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [section, setSection] = useState<AdminSection>(defaultSection);

  useEffect(() => {
    setSection(defaultSection);
  }, [defaultSection]);

  return (
    <div className="adminShell">
      <div className="adminHeader">
        <div>
          <h3>Admin</h3>
          <p>Settings, security records, users, registries, and operator tools live here instead of crowding the daily Docker workflow.</p>
        </div>
      </div>
      <div className="adminLayout">
        <nav className="adminNav" aria-label="Admin sections">
          {adminSections.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? "active" : ""}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="adminPane">
          {section === "settings" && (
            <>
              <SessionsPanel />
              {selectedHost ? <HostSettingsPanel host={selectedHost} onChanged={refresh} /> : <GlobalSettingsPanel onChanged={refresh} />}
            </>
          )}
          {section === "operations" && <OperationsPanel />}
          {section === "appearance" && (
            <Panel title="Appearance">
              <p>Choose the interface theme for this browser.</p>
              <ButtonRow>
                <button type="button" className="primary" onClick={onToggleTheme}>
                  {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                  {theme === "dark" ? "Use light mode" : "Use dark mode"}
                </button>
              </ButtonRow>
            </Panel>
          )}
          {section === "alerts" && <AlertsPanel hosts={hosts} containers={resources.filter((resource) => resource.kind === "container")} refresh={refresh} userRole={user.role} />}
          {section === "registries" && selectedHost && <RegistriesPanel hosts={hosts} selectedHost={selectedHost} refresh={refresh} runJob={runJob} />}
          {section === "registries" && !selectedHost && <Panel title="Registries"><p>Add a host before logging it into registries.</p></Panel>}
          {section === "users" && <UsersPanel />}
          {section === "jobs" && <JobsPanel jobs={jobs} userRole={user.role} refresh={refresh} />}
          {section === "audit" && <AuditPanel />}
        </div>
      </div>
    </div>
  );
}
