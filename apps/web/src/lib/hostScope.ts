import type { DockerHost } from "@dockermender/shared";
import { emptyToUndefined } from "./format.js";
import type { HostScope } from "./navigation.js";

export function hostFormPayload(form: {
  name: string;
  hostname: string;
  port: number;
  username: string;
  connectionMode: string;
  sshAuthType?: string;
  sshPrivateKey?: string;
  sshKeyPassphrase?: string;
  sshPassword?: string;
  agentUrl?: string;
  agentToken?: string;
  dockerSocketPath: string;
  tags?: string;
}) {
  return {
    name: form.name,
    hostname: form.hostname,
    port: Number(form.port),
    username: form.username,
    connectionMode: form.connectionMode,
    sshAuthType: form.connectionMode === "ssh" ? form.sshAuthType ?? "password" : undefined,
    sshPrivateKey: form.connectionMode === "ssh" && form.sshAuthType === "key" ? emptyToUndefined(form.sshPrivateKey ?? "") : undefined,
    sshKeyPassphrase: form.connectionMode === "ssh" && form.sshAuthType === "key" ? emptyToUndefined(form.sshKeyPassphrase ?? "") : undefined,
    sshPassword: form.connectionMode === "ssh" && form.sshAuthType === "password" ? emptyToUndefined(form.sshPassword ?? "") : undefined,
    agentUrl: form.connectionMode === "agent" ? emptyToUndefined(form.agentUrl ?? "") : undefined,
    agentToken: form.connectionMode === "agent" ? emptyToUndefined(form.agentToken ?? "") : undefined,
    dockerSocketPath: form.dockerSocketPath,
    tags: form.tags ? form.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : []
  };
}

export function normalizeComposeProjectName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80);
}

export function hostName(hosts: DockerHost[], hostId: string) {
  return hosts.find((host) => host.id === hostId)?.name ?? "Unknown host";
}

export function getScopedHostIds(hosts: DockerHost[], selectedHostId: string | null, scope: HostScope, customHostIds: string[]) {
  const knownIds = new Set(hosts.map((host) => host.id));
  const fallbackHostId = selectedHostId && knownIds.has(selectedHostId) ? selectedHostId : hosts[0]?.id ?? null;
  if (scope === "all") return hosts.map((host) => host.id);
  if (scope === "custom") {
    const scoped = customHostIds.filter((hostId) => knownIds.has(hostId));
    return scoped.length > 0 ? scoped : fallbackHostId ? [fallbackHostId] : [];
  }
  return fallbackHostId ? [fallbackHostId] : [];
}

export function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function jobLabel(type: string) {
  return type
    .split(".")
    .map((part) => part.replace(/_/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
