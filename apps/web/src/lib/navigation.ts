import {
  ArchiveRestore,
  Activity,
  Bell,
  BookOpen,
  Box,
  Boxes,
  Copy,
  Database,
  Eye,
  FileText,
  Github,
  Grid3x3,
  HardDrive,
  KeyRound,
  Layers,
  Network,
  RefreshCw,
  Settings,
  Server,
  ShieldCheck,
  Terminal,
  Users
} from "lucide-react";

export type Tab =
  | "overview"
  | "apps"
  | "services"
  | "containers"
  | "images"
  | "hosts"
  | "ssh"
  | "host-metrics"
  | "networks"
  | "volumes"
  | "catalog"
  | "deploy"
  | "files"
  | "compose"
  | "updates"
  | "backups"
  | "recovery"
  | "recovery-move"
  | "recovery-schedules"
  | "recovery-targets"
  | "recovery-runs"
  | "recovery-backups"
  | "migrate"
  | "alerts"
  | "registries"
  | "users"
  | "jobs"
  | "audit"
  | "admin"
  | "settings"
  | "learn";

export type HostScope = "selected" | "all" | "custom";

export const tabs: Array<{ id: Tab; label: string; icon: typeof Box; beta?: boolean }> = [
  { id: "overview", label: "Dashboard", icon: Activity },
  { id: "services", label: "Services", icon: Boxes },
  { id: "containers", label: "Containers", icon: Box },
  { id: "networks", label: "Networks", icon: Network },
  { id: "volumes", label: "Volumes", icon: HardDrive },
  { id: "hosts", label: "Hosts", icon: Server },
  { id: "ssh", label: "SSH", icon: Terminal },
  { id: "host-metrics", label: "Metrics", icon: Activity },
  { id: "apps", label: "Apps", icon: Grid3x3 },
  { id: "images", label: "Images", icon: Layers },
  { id: "catalog", label: "Catalog", icon: Grid3x3 },
  { id: "deploy", label: "Deploy", icon: Github },
  { id: "files", label: "Files", icon: FileText },
  { id: "compose", label: "Compose", icon: Database },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "backups", label: "Backups", icon: ShieldCheck },
  { id: "recovery", label: "Recovery Points", icon: ArchiveRestore },
  { id: "recovery-move", label: "Migrate App", icon: Copy },
  { id: "recovery-schedules", label: "Schedules", icon: RefreshCw },
  { id: "recovery-targets", label: "Backup Storage", icon: HardDrive },
  { id: "recovery-runs", label: "Restore Runs", icon: Activity, beta: true },
  { id: "recovery-backups", label: "Backups", icon: ShieldCheck, beta: true },
  { id: "migrate", label: "Migrate App", icon: Copy },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "registries", label: "Registries", icon: KeyRound },
  { id: "users", label: "Users", icon: Users },
  { id: "jobs", label: "Jobs", icon: Activity },
  { id: "audit", label: "Audit", icon: Eye },
  { id: "admin", label: "Admin", icon: Settings },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "learn", label: "Guide", icon: BookOpen }
];

export const hostlessTabs = new Set<Tab>([
  "admin",
  "hosts",
  "ssh",
  "catalog",
  "settings",
  "users",
  "jobs",
  "audit",
  "learn",
  "updates",
  "migrate",
  "recovery",
  "recovery-move",
  "recovery-schedules",
  "recovery-targets",
  "recovery-runs",
  "recovery-backups"
]);

export const navigationGroups: Array<{ title: string; items: Tab[] }> = [
  { title: "Docker", items: ["overview", "services", "containers", "images", "networks", "volumes", "hosts", "ssh", "host-metrics"] },
  { title: "Deploy", items: ["compose", "catalog", "deploy", "files"] },
  { title: "Recovery", items: ["recovery", "recovery-move", "recovery-schedules", "recovery-runs", "recovery-backups"] },
  { title: "System", items: ["admin"] },
  { title: "Guide", items: ["learn"] }
];

export const emptyCompose = `services:
  app:
    image: nginx:alpine
    ports:
      - "8088:80"
`;
