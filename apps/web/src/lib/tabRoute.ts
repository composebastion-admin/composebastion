import { hostlessTabs, tabs, type Tab } from "./navigation.js";

const tabIds = new Set<Tab>(tabs.map((item) => item.id));

export function isTab(value: string | undefined): value is Tab {
  return Boolean(value && tabIds.has(value as Tab));
}

export function tabFromPath(segment: string | undefined, fallback: Tab = "overview"): Tab {
  if (segment === "compose") return "services";
  return isTab(segment) ? segment : fallback;
}

export function tabPath(tab: Tab) {
  if (tab === "compose") return "/services";
  return `/${tab}`;
}

export function tabRequiresHost(tab: Tab) {
  return !hostlessTabs.has(tab);
}
