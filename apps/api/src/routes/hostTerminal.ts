import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { auditContextFromRequest, writeAuditEvent } from "../services/audit.js";
import { requireRole } from "../services/auth.js";
import { assertHostTerminalAccess, assertHostTerminalOrigin, parseTerminalControlMessage } from "../services/hostTerminal.js";
import { getHostForWorker } from "../services/hosts.js";
import { terminalRateLimit } from "../services/rateLimits.js";
import { openSshShell, type SshShellSession } from "../services/ssh.js";

function asBuffer(raw: Buffer | ArrayBuffer | Buffer[]) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

export async function registerHostTerminalRoutes(app: FastifyInstance) {
  await app.register(websocket);

  for (const url of ["/api/hosts/:hostId/terminal", "/api/v1/hosts/:hostId/terminal"]) {
    app.get(
      url,
      { websocket: true, preHandler: requireRole(["owner", "admin"]), config: { rateLimit: terminalRateLimit } },
      (socket, request) => {
        void handleHostTerminal(socket, request);
      }
    );
  }
}

async function handleHostTerminal(
  socket: { send: (data: string | Buffer) => void; close: () => void; on: (event: string, handler: (...args: any[]) => void) => void },
  request: FastifyRequest
) {
  const { hostId } = request.params as { hostId: string };
  const user = request.user;
  if (!user) {
    socket.close();
    return;
  }

  const startedAt = Date.now();
  let bytesIn = 0;
  let bytesOut = 0;
  let shell: SshShellSession | null = null;
  let ended = false;
  let started = false;
  const auditContext = auditContextFromRequest(request);

  const finish = async (reason: string) => {
    if (ended) return;
    ended = true;
    shell?.close();
    shell = null;
    if (!started) return;
    try {
      await writeAuditEvent({
        userId: user.id,
        hostId,
        action: "host.terminal.end",
        targetKind: "host",
        targetId: hostId,
        details: {
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          bytesIn,
          bytesOut,
          reason
        },
        ...auditContext
      });
    } catch (error) {
      request.log.error({ err: error }, "Failed to write host terminal end audit");
    }
  };

  const sendError = (message: string) => {
    try {
      socket.send(JSON.stringify({ type: "error", message }));
    } catch {
      // Socket may already be closing.
    }
  };

  try {
    assertHostTerminalOrigin(request.headers.origin, request.headers.host, env.CORS_ORIGINS, env.NODE_ENV);
    const host = await getHostForWorker(hostId);
    assertHostTerminalAccess(user, host.public);
    if (host.connectionMode !== "ssh") {
      throw new Error("Host terminal requires SSH connection mode");
    }

    shell = await openSshShell(host.ssh);
    started = true;

    await writeAuditEvent({
      userId: user.id,
      hostId,
      action: "host.terminal.start",
      targetKind: "host",
      targetId: hostId,
      details: {
        hostname: host.public.hostname,
        username: host.public.username,
        startedAt: new Date(startedAt).toISOString()
      },
      ...auditContext
    });

    socket.send(JSON.stringify({ type: "ready" }));

    shell.onData((chunk) => {
      if (ended) return;
      bytesOut += chunk.length;
      try {
        socket.send(chunk);
      } catch (error) {
        request.log.error({ err: error }, "Failed to send terminal output");
        void finish("send_failed");
        socket.close();
      }
    });

    shell.onClose(() => {
      void finish("shell_closed");
      socket.close();
    });

    shell.onError((error) => {
      request.log.error({ err: error }, "SSH shell error");
      sendError(error.message);
      void finish("shell_error");
      socket.close();
    });

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[] | string) => {
      if (ended || !shell) return;
      if (typeof raw === "string") {
        const control = parseTerminalControlMessage(raw);
        if (control) {
          shell.resize(control.cols, control.rows);
          return;
        }
        bytesIn += Buffer.byteLength(raw);
        shell.write(raw);
        return;
      }
      const chunk = asBuffer(raw);
      const control = parseTerminalControlMessage(chunk.toString("utf8"));
      if (control) {
        shell.resize(control.cols, control.rows);
        return;
      }
      bytesIn += chunk.length;
      shell.write(chunk);
    });

    socket.on("close", () => {
      void finish("client_closed");
    });

    socket.on("error", (error: Error) => {
      request.log.error({ err: error }, "Host terminal websocket error");
      void finish("websocket_error");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open host terminal";
    request.log.error({ err: error }, "Host terminal setup failed");
    sendError(message);
    void finish("setup_failed");
    socket.close();
  }
}
