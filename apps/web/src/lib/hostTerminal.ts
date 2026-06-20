import type { AdminUser, DockerHost } from "@dockermender/shared";

const DEMO_TAG = "demo";

export function isDemoHost(host: Pick<DockerHost, "tags">) {
  return Array.isArray(host.tags) && host.tags.includes(DEMO_TAG);
}

export function canOpenHostTerminal(
  user: Pick<AdminUser, "role">,
  host: Pick<DockerHost, "tags" | "connectionMode">
) {
  if (user.role !== "owner" && user.role !== "admin") return false;
  if (isDemoHost(host)) return false;
  if (host.connectionMode !== "ssh") return false;
  return true;
}

export function hostTerminalUrl(hostId: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/hosts/${hostId}/terminal`;
}
