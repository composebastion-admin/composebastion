import http from "node:http";
import https from "node:https";
import type { HostDisk } from "@composebastion/shared";
import { env } from "../config/env.js";
import { createAgentLookup, shouldAllowPrivateAgentUrls } from "./ssrf.js";

export interface AgentTarget {
  url: string;
  token: string;
}

type AgentRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_AGENT_REQUEST_TIMEOUT_MS = 30_000;
export const MIN_COMPATIBLE_AGENT_VERSION = "0.9.0";

function agentUrl(target: AgentTarget, path: string) {
  return new URL(path, target.url.endsWith("/") ? target.url : `${target.url}/`).toString();
}

async function agentRequest(target: AgentTarget, path: string, init: AgentRequestInit = {}) {
  const url = new URL(agentUrl(target, path));
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) throw new Error("Agent URL must use http or https");

  const headers = { ...init.headers };
  if (init.body && !Object.keys(headers).some((header) => header.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(init.body));
  }

  const timeoutMs = init.timeoutMs ?? DEFAULT_AGENT_REQUEST_TIMEOUT_MS;
  return new Promise<{ ok: boolean; status: number; body: string }>((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest;
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abortRequest);
      handler();
    };
    const timeoutError = () => Object.assign(new Error(`Agent request timed out after ${timeoutMs}ms`), { code: "AGENT_REQUEST_TIMEOUT" });
    const abortRequest = () => {
      request.destroy(Object.assign(new Error("Agent request was aborted"), { code: "ABORT_ERR" }));
    };
    const timeout = setTimeout(() => request.destroy(timeoutError()), timeoutMs);
    request = transport.request(url, {
      method: init.method ?? "GET",
      headers,
      lookup: createAgentLookup(shouldAllowPrivateAgentUrls(env.NODE_ENV, env.ALLOW_PRIVATE_AGENT_URLS))
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        finish(() => resolve({ ok: status >= 200 && status < 300, status, body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    if (init.signal?.aborted) abortRequest();
    else init.signal?.addEventListener("abort", abortRequest, { once: true });
    request.on("error", (error) => finish(() => reject(error)));
    if (init.body) request.write(init.body);
    request.end();
  });
}

function parseAgentJson<T>(body: string): T {
  if (!body.trim()) return {} as T;
  return JSON.parse(body) as T;
}

export async function runAgentDockerCommand(target: AgentTarget, command: string, timeoutMs = 120_000) {
  const response = await agentRequest(target, "api/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.token}`
    },
    body: JSON.stringify({ command }),
    timeoutMs
  });
  const data = parseAgentJson<{ stdout?: string; stderr?: string; code?: number; error?: string }>(response.body);
  if (!response.ok || data.code) {
    throw new Error(data.error ?? data.stderr ?? `Agent command failed with code ${data.code}`);
  }
  return { stdout: data.stdout ?? "", stderr: data.stderr ?? "", code: data.code ?? 0 };
}

export async function writeAgentRemoteFile(target: AgentTarget, remotePath: string, content: string) {
  const response = await agentRequest(target, "api/files/write", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.token}`
    },
    body: JSON.stringify({ path: remotePath, content })
  });
  const data = parseAgentJson<{ error?: string }>(response.body);
  if (!response.ok) throw new Error(data.error ?? `Agent file write failed with ${response.status}`);
}

export async function readAgentRemoteFile(target: AgentTarget, remotePath: string) {
  const response = await agentRequest(target, `api/files/read?path=${encodeURIComponent(remotePath)}`, {
    headers: { Authorization: `Bearer ${target.token}` }
  });
  const data = parseAgentJson<{ content?: string; error?: string }>(response.body);
  if (!response.ok) throw new Error(data.error ?? `Agent file read failed with ${response.status}`);
  return data.content ?? "";
}

export async function statAgentRemoteFile(target: AgentTarget, remotePath: string) {
  const response = await agentRequest(target, `api/files/stat?path=${encodeURIComponent(remotePath)}`, {
    headers: { Authorization: `Bearer ${target.token}` }
  });
  const data = parseAgentJson<{ exists?: boolean; path?: string; type?: "file" | "directory" | "other"; size?: number; error?: string }>(response.body);
  if (!response.ok) throw new Error(data.error ?? `Agent file stat failed with ${response.status}`);
  return {
    exists: data.exists ?? false,
    path: data.path ?? remotePath,
    type: data.type ?? null,
    size: typeof data.size === "number" ? data.size : null
  };
}

export async function checkAgent(target: AgentTarget) {
  const response = await agentRequest(target, "api/health", {
    headers: { Authorization: `Bearer ${target.token}` }
  });
  if (!response.ok) throw new Error(`Agent health check failed with ${response.status}`);
  return parseAgentJson<{ ok: boolean; agentVersion?: string; dockerVersion?: string; composeVersion?: string }>(response.body);
}

function versionParts(version: string | null | undefined) {
  const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:-pre\.(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? null : Number(match[4])
  };
}

export function agentCompatibilityStatus(version: string | null | undefined) {
  const current = versionParts(version);
  const minimum = versionParts(MIN_COMPATIBLE_AGENT_VERSION)!;
  if (!current) {
    return {
      status: "unknown" as const,
      message: "Agent version is unknown; upgrade the agent if live logs or host stats are unavailable."
    };
  }
  const compatible = current.major !== minimum.major
    ? current.major > minimum.major
    : current.minor !== minimum.minor
      ? current.minor > minimum.minor
      : current.patch !== minimum.patch
        ? current.patch > minimum.patch
        : current.pre === null || (minimum.pre !== null && current.pre >= minimum.pre);
  return compatible
    ? { status: "compatible" as const, message: `Agent ${version} supports the current pre-v1 API surface.` }
    : { status: "outdated" as const, message: `Agent ${version} is older than ${MIN_COMPATIBLE_AGENT_VERSION}; upgrade it for live logs and host metrics parity.` };
}

export type AgentHostStatsResponse = {
  stat: string;
  meminfo: string;
  loadavg: string;
  uptime: string;
  netdev: string;
  mounts: string;
  disks: HostDisk[];
};

export async function getAgentHostStats(target: AgentTarget, timeoutMs = 15_000) {
  const response = await agentRequest(target, "api/host-stats", {
    headers: { Authorization: `Bearer ${target.token}` },
    timeoutMs
  });
  const data = parseAgentJson<AgentHostStatsResponse & { error?: string }>(response.body);
  if (!response.ok) throw new Error(data.error ?? `Agent host stats failed with ${response.status}`);
  return data;
}

export function consumeAgentSseChunk(buffer: { value: string }, chunk: Buffer, onEvent: (event: string, data: string) => void) {
  buffer.value += chunk.toString("utf8");
  const events = buffer.value.split(/\n\n/);
  buffer.value = events.pop() ?? "";
  for (const raw of events) {
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
    }
    if (data.length > 0) onEvent(event, data.join("\n"));
  }
}

export async function streamAgentContainerLogs(
  target: AgentTarget,
  containerId: string,
  tail: number,
  onLine: (line: string) => void,
  onError: (error: Error) => void
) {
  const safeTail = Math.min(Math.max(Number(tail) || 500, 1), 5000);
  const url = new URL(agentUrl(target, `api/containers/${encodeURIComponent(containerId)}/logs-stream?tail=${safeTail}`));
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) throw new Error("Agent URL must use http or https");

  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const request = transport.request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${target.token}` },
      lookup: createAgentLookup(shouldAllowPrivateAgentUrls(env.NODE_ENV, env.ALLOW_PRIVATE_AGENT_URLS))
    }, (response) => {
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        reject(new Error(`Agent log stream failed with ${response.statusCode ?? 0}`));
        response.resume();
        return;
      }
      settled = true;
      const buffer = { value: "" };
      response.on("data", (chunk: Buffer) => {
        consumeAgentSseChunk(buffer, chunk, (event, data) => {
          try {
            const payload = JSON.parse(data) as { line?: string; error?: string };
            if (event === "error") onError(new Error(payload.error ?? "Agent log stream error"));
            else if (event === "message") onLine(payload.line ?? "");
          } catch (error) {
            onError(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      response.on("error", onError);
      response.on("end", () => undefined);
      resolve(() => request.destroy());
    });
    request.on("error", (error) => {
      if (settled) onError(error);
      else reject(error);
    });
    request.end();
  });
}
