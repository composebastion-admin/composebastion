import type { AdminUser, DockerHost } from "@composebastion/shared";
import { isDemoHost } from "./demo.js";
import { isAllowedCorsOrigin, isSameHostOrigin } from "./httpSecurity.js";

export class HostTerminalAccessError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "HostTerminalAccessError";
    this.statusCode = statusCode;
  }
}

export function assertHostTerminalAccess(
  user: Pick<AdminUser, "role">,
  host: Pick<DockerHost, "tags" | "connectionMode">
) {
  if (user.role !== "owner" && user.role !== "admin") {
    throw new HostTerminalAccessError("Insufficient permissions", 403);
  }
  if (isDemoHost(host)) {
    throw new HostTerminalAccessError("Terminal is not available for demo hosts", 403);
  }
  if (host.connectionMode !== "ssh") {
    throw new HostTerminalAccessError("Host terminal requires SSH connection mode", 400);
  }
}

export function assertHostTerminalOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: string[],
  nodeEnv: string
) {
  if (isSameHostOrigin(origin, host)) return;
  if (!isAllowedCorsOrigin(origin, allowedOrigins, nodeEnv)) {
    throw new HostTerminalAccessError("Origin is not allowed for host terminal access", 403);
  }
}

export function parseTerminalControlMessage(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { type?: string; cols?: unknown; rows?: unknown };
    if (parsed.type !== "resize") return null;
    const cols = Number(parsed.cols);
    const rows = Number(parsed.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 200) {
      return null;
    }
    return { type: "resize" as const, cols, rows };
  } catch {
    return null;
  }
}
