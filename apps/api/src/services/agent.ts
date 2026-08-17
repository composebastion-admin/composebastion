import http from "node:http";
import https from "node:https";
import {
  compareReleaseVersions,
  isDockerStatsLifecycleTombstone,
  isDockerStatsRecord,
  parseReleaseVersion,
  type DockerStatsRecord,
  type HostDisk
} from "@composebastion/shared";
import { env } from "../config/env.js";
import { createAgentLookup, shouldAllowPrivateAgentUrls } from "./ssrf.js";
import {
  currentRemoteMutationContext,
  normalizeRemoteMutationTimeoutMs,
  recordRemoteMutationDispatch,
  recordRemoteMutationTerminal,
  REMOTE_MUTATION_COMPLETION_GRACE_MS,
  RemoteMutationOutcomeUnknownError,
  type RemoteMutationRuntimeState,
  type RemoteMutationRuntimeStatus
} from "./remoteMutationProof.js";

export interface AgentTarget {
  url: string;
  token: string;
}

export class AgentHttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "AgentHttpError";
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function runAgentDockerCommandResult(
  target: AgentTarget,
  command: string,
  timeoutMs = 120_000
) {
  const boundedTimeoutMs = normalizeRemoteMutationTimeoutMs(timeoutMs);
  const context = currentRemoteMutationContext();
  if (context) {
    await recordRemoteMutationDispatch(context, "agent", boundedTimeoutMs);
  }
  let response: Awaited<ReturnType<typeof agentRequest>>;
  try {
    response = await agentRequest(target, "api/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.token}`
      },
      body: JSON.stringify({
        command,
        timeoutMs: boundedTimeoutMs,
        ...(context ? { operationId: context.operationId } : {})
      }),
      timeoutMs: boundedTimeoutMs + REMOTE_MUTATION_COMPLETION_GRACE_MS
    });
  } catch (error) {
    if (!context) throw error;
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "agent",
      "transport_lost",
      error
    );
  }
  let data: {
    stdout?: string;
    stderr?: string;
    code?: number;
    error?: string;
    outcome?: "completed" | "failed" | "timed_out";
    operation?: {
      operationId?: string;
      status?: RemoteMutationRuntimeState;
    };
  };
  try {
    data = parseAgentJson(response.body);
  } catch (error) {
    if (!context) throw error;
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "agent",
      "proof_unavailable",
      error
    );
  }
  if (context) {
    const operationMatches = data.operation?.operationId === context.operationId;
    const state = operationMatches
      ? data.operation?.status
      : data.outcome;
    if (state === "completed" || state === "failed" || state === "timed_out") {
      await recordRemoteMutationTerminal(context, state);
      if (state === "timed_out") {
        throw new RemoteMutationOutcomeUnknownError(
          context.operationId,
          context.phase,
          "agent",
          state
        );
      }
    } else if (response.ok) {
      // A compatible older agent may not return operation metadata, but a
      // complete successful response is still authoritative.
      await recordRemoteMutationTerminal(context, "completed");
    } else {
      throw new RemoteMutationOutcomeUnknownError(
        context.operationId,
        context.phase,
        "agent",
        state === "running" || state === "missing" || state === "proof_unavailable"
          ? state
          : "proof_unavailable"
      );
    }
  }
  return {
    stdout: data.stdout ?? "",
    stderr: data.stderr ?? data.error ?? "",
    code: data.code ?? (response.ok ? 0 : response.status || 1)
  };
}

export async function runAgentDockerCommand(target: AgentTarget, command: string, timeoutMs = 120_000) {
  const result = await runAgentDockerCommandResult(
    target,
    command,
    timeoutMs
  );
  if (result.code) {
    throw new Error(
      result.stderr
      || `Agent command failed with code ${result.code}`
    );
  }
  return result;
}

export async function inspectAgentRemoteOperation(
  target: AgentTarget,
  operationId: string
): Promise<RemoteMutationRuntimeStatus> {
  if (!/^[0-9a-f]{64}$/.test(operationId)) {
    throw new Error("Remote operation id must be a 64-character lowercase hexadecimal digest");
  }
  const response = await agentRequest(
    target,
    `api/operations/${operationId}`,
    {
      headers: {
        Authorization: `Bearer ${target.token}`
      },
      timeoutMs: 30_000
    }
  );
  const data = parseAgentJson<{
    operationId?: string;
    status?: RemoteMutationRuntimeState;
    startedAt?: string | null;
    completedAt?: string | null;
  }>(response.body);
  if (response.status === 404) {
    return {
      operationId,
      state: "missing"
    };
  }
  if (!response.ok) {
    throw new AgentHttpError(
      `Agent remote operation inspection failed with ${response.status}`,
      response.status
    );
  }
  if (
    data.operationId !== operationId
    || (
      data.status !== "running"
      && data.status !== "completed"
      && data.status !== "failed"
      && data.status !== "timed_out"
    )
  ) {
    return {
      operationId,
      state: "proof_unavailable"
    };
  }
  return {
    operationId,
    state: data.status,
    startedAt: data.startedAt ?? null,
    completedAt: data.completedAt ?? null
  };
}

export async function writeAgentRemoteFile(target: AgentTarget, remotePath: string, content: string) {
  const context = currentRemoteMutationContext();
  if (context) {
    await recordRemoteMutationDispatch(context, "agent", 30_000);
  }
  let response: Awaited<ReturnType<typeof agentRequest>>;
  try {
    response = await agentRequest(target, "api/files/write", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.token}`
      },
      body: JSON.stringify({
        path: remotePath,
        content,
        ...(context ? { operationId: context.operationId } : {})
      }),
      timeoutMs: 30_000 + REMOTE_MUTATION_COMPLETION_GRACE_MS
    });
  } catch (error) {
    if (!context) throw error;
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "agent",
      "transport_lost",
      error
    );
  }
  let data: {
    error?: string;
    operation?: {
      operationId?: string;
      status?: RemoteMutationRuntimeState;
    };
  };
  try {
    data = parseAgentJson(response.body);
  } catch (error) {
    if (!context) throw error;
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "agent",
      "proof_unavailable",
      error
    );
  }
  if (context) {
    if (data.operation) {
      const operationMatches =
        data.operation.operationId === context.operationId;
      const state = operationMatches
        ? data.operation.status
        : "proof_unavailable";
      if (
        state === "completed"
        || state === "failed"
        || state === "timed_out"
      ) {
        await recordRemoteMutationTerminal(context, state);
      } else {
        throw new RemoteMutationOutcomeUnknownError(
          context.operationId,
          context.phase,
          "agent",
          state === "running" ? state : "proof_unavailable"
        );
      }
    } else if (response.ok) {
      // Preserve compatibility with an older agent when the synchronous
      // response itself is authoritative. Lost responses require the new
      // operation receipt and remain safely ambiguous.
      await recordRemoteMutationTerminal(context, "completed");
    } else {
      throw new RemoteMutationOutcomeUnknownError(
        context.operationId,
        context.phase,
        "agent",
        "proof_unavailable"
      );
    }
  }
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
  if (!response.ok) throw new AgentHttpError(`Agent health check failed with ${response.status}`, response.status);
  const data = parseAgentJson<{ ok?: boolean; agentVersion?: string; dockerVersion?: string; composeVersion?: string }>(response.body);
  if (data.ok !== true) throw new Error("Agent reported that Docker or Compose is unavailable");
  return { ...data, ok: true as const };
}

export async function getAgentContainerUsage(target: AgentTarget, timeoutMs = 15_000) {
  const response = await agentRequest(target, "api/containers/usage", {
    headers: { Authorization: `Bearer ${target.token}` },
    timeoutMs
  });
  const data = parseAgentJson<{ usage?: unknown; error?: string }>(response.body);
  if (!response.ok) {
    throw new AgentHttpError(data.error ?? `Agent container usage failed with ${response.status}`, response.status);
  }
  if (!Array.isArray(data.usage)) throw new Error("Agent returned malformed container usage data");
  const usage: DockerStatsRecord[] = [];
  for (const row of data.usage) {
    if (isDockerStatsLifecycleTombstone(row)) continue;
    if (!isDockerStatsRecord(row)) throw new Error("Agent returned malformed container usage data");
    usage.push(row);
  }
  return usage;
}

export function agentCompatibilityStatus(version: string | null | undefined) {
  const current = parseReleaseVersion(version);
  const comparison = compareReleaseVersions(current, MIN_COMPATIBLE_AGENT_VERSION);
  if (!current || comparison === null) {
    return {
      status: "unknown" as const,
      message: "Agent version is unknown; upgrade the agent if live logs or host stats are unavailable."
    };
  }
  const compatible = comparison >= 0;
  return compatible
    ? { status: "compatible" as const, message: `Agent ${version} supports the current V1 agent API surface.` }
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

async function streamAgentEvents(
  target: AgentTarget,
  path: string,
  onEvent: (event: string, data: string) => void,
  onError: (error: Error) => void,
  connectionTimeoutMs = 15_000
) {
  const url = new URL(agentUrl(target, path));
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) throw new Error("Agent URL must use http or https");

  return new Promise<() => void>((resolve, reject) => {
    let connected = false;
    let connectionSettled = false;
    const request = transport.request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${target.token}` },
      lookup: createAgentLookup(shouldAllowPrivateAgentUrls(env.NODE_ENV, env.ALLOW_PRIVATE_AGENT_URLS))
    }, (response) => {
      clearTimeout(connectionTimer);
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        connectionSettled = true;
        reject(new AgentHttpError(`Agent stream failed with ${status}`, status));
        response.resume();
        return;
      }
      connected = true;
      connectionSettled = true;
      const buffer = { value: "" };
      response.on("data", (chunk: Buffer) => consumeAgentSseChunk(buffer, chunk, onEvent));
      response.on("error", onError);
      response.on("end", () => onError(new Error("Agent stream ended")));
      resolve(() => request.destroy());
    });
    const connectionTimer = setTimeout(() => {
      request.destroy(new Error(`Agent stream connection timed out after ${connectionTimeoutMs}ms`));
    }, connectionTimeoutMs);
    request.on("error", (error) => {
      clearTimeout(connectionTimer);
      if (connected) onError(error);
      else if (!connectionSettled) {
        connectionSettled = true;
        reject(error);
      }
    });
    request.end();
  });
}

export async function streamAgentContainerLogs(
  target: AgentTarget,
  containerId: string,
  tail: number,
  onLine: (line: string) => void,
  onError: (error: Error) => void
) {
  const safeTail = Math.min(Math.max(Number(tail) || 500, 1), 5000);
  return streamAgentEvents(
    target,
    `api/containers/${encodeURIComponent(containerId)}/logs-stream?tail=${safeTail}`,
    (event, data) => {
      try {
        const payload = JSON.parse(data) as { line?: string; error?: string };
        if (event === "error") onError(new Error(payload.error ?? "Agent log stream error"));
        else if (event === "message") onLine(payload.line ?? "");
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onError
  );
}

export async function streamAgentContainerUsage(
  target: AgentTarget,
  onStats: (stats: Record<string, unknown>) => void,
  onError: (error: Error) => void,
  connectionTimeoutMs = 15_000
) {
  return streamAgentEvents(
    target,
    "api/containers/usage-stream",
    (event, data) => {
      try {
        const payload: unknown = JSON.parse(data);
        if (event === "error") {
          const message = isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "Agent usage stream error";
          onError(new Error(message));
        } else if (event === "message") {
          const stats = isRecord(payload) ? payload.stats : undefined;
          if (isDockerStatsLifecycleTombstone(stats)) return;
          if (!isDockerStatsRecord(stats)) {
            onError(new Error("Agent returned malformed container usage stream data"));
            return;
          }
          onStats(stats);
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onError,
    connectionTimeoutMs
  );
}
