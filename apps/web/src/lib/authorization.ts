import type { AdminUser } from "@composebastion/shared";
import { tabs, type Tab } from "./navigation.js";

export type AdminSection =
  | "settings"
  | "operations"
  | "appearance"
  | "alerts"
  | "registries"
  | "users"
  | "jobs"
  | "audit"
  | "about";

export type Authorization = {
  role: AdminUser["role"];
  canOperate: boolean;
  canAdminister: boolean;
  canUseTerminal: boolean;
  allowedTabs: ReadonlySet<Tab>;
  allowedAdminSections: readonly AdminSection[];
};

const viewerTabs = new Set<Tab>([
  "overview",
  "apps",
  "services",
  "containers",
  "images",
  "hosts",
  "host-metrics",
  "networks",
  "volumes",
  "compose",
  "backups",
  "recovery",
  "recovery-runs",
  "recovery-backups",
  "alerts",
  "jobs",
  "admin",
  "settings",
  "learn"
]);

const operatorTabs = new Set<Tab>([
  ...viewerTabs,
  "ssh",
  "catalog",
  "deploy",
  "files",
  "updates",
  "recovery-move",
  "recovery-schedules",
  "recovery-targets",
  "migrate",
  "registries"
]);

const administratorTabs = new Set<Tab>(tabs.map((tab) => tab.id));

const viewerAdminSections: readonly AdminSection[] = [
  "settings",
  "operations",
  "appearance",
  "alerts",
  "jobs",
  "about"
];
const operatorAdminSections: readonly AdminSection[] = [
  ...viewerAdminSections,
  "registries"
];
const administratorAdminSections: readonly AdminSection[] = [
  "settings",
  "operations",
  "appearance",
  "alerts",
  "registries",
  "users",
  "jobs",
  "audit",
  "about"
];

const authorizations: Record<AdminUser["role"], Authorization> = {
  viewer: {
    role: "viewer",
    canOperate: false,
    canAdminister: false,
    canUseTerminal: false,
    allowedTabs: viewerTabs,
    allowedAdminSections: viewerAdminSections
  },
  operator: {
    role: "operator",
    canOperate: true,
    canAdminister: false,
    canUseTerminal: false,
    allowedTabs: operatorTabs,
    allowedAdminSections: operatorAdminSections
  },
  admin: {
    role: "admin",
    canOperate: true,
    canAdminister: true,
    canUseTerminal: true,
    allowedTabs: administratorTabs,
    allowedAdminSections: administratorAdminSections
  },
  owner: {
    role: "owner",
    canOperate: true,
    canAdminister: true,
    canUseTerminal: true,
    allowedTabs: administratorTabs,
    allowedAdminSections: administratorAdminSections
  }
};

export function authorizationForRole(role: AdminUser["role"]): Authorization {
  return authorizations[role];
}

export function resolveAuthorizedTab(requested: Tab, allowedTabs: ReadonlySet<Tab>, fallback: Tab = "overview") {
  return allowedTabs.has(requested) ? requested : fallback;
}

export function resolveAdminSection(requested: AdminSection, allowedSections: readonly AdminSection[]) {
  return allowedSections.includes(requested) ? requested : allowedSections[0] ?? "about";
}
