import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import type { SshShellSession } from "../src/services/ssh.js";

const readSession = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn(async () => undefined));
const getHostForWorker = vi.hoisted(() => vi.fn());
const openSshShell = vi.hoisted(() => vi.fn());

vi.mock("../src/services/auth.js", () => ({
  readSession,
  requireRole: vi.fn(() => async () => undefined)
}));

vi.mock("../src/services/audit.js", () => ({
  auditContextFromRequest: vi.fn(() => ({
    ipAddress: "203.0.113.10",
    userAgent: "qualification-test"
  })),
  writeAuditEvent
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker
}));

vi.mock("../src/services/ssh.js", () => ({
  openSshShell
}));

const {
  handleHostTerminal,
  HOST_TERMINAL_REAUTH_INTERVAL_MS
} = await import("../src/routes/hostTerminal.js");

const admin = {
  id: "00000000-0000-4000-8000-000000000001",
  role: "admin"
};

function fakeShell(): SshShellSession {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn()
  };
}

function fakeSocket() {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  let closed = false;
  const emit = (event: string, ...args: any[]) => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };
  return {
    send: vi.fn(),
    close: vi.fn(() => {
      if (closed) return;
      closed = true;
      emit("close");
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    emit
  };
}

function fakeRequest() {
  return {
    params: { hostId: "00000000-0000-4000-8000-000000000002" },
    user: admin,
    cookies: { cb_session: "session-token" },
    headers: {
      origin: "https://manager.example.test",
      host: "manager.example.test"
    },
    log: {
      error: vi.fn()
    }
  } as unknown as FastifyRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getHostForWorker.mockResolvedValue({
    public: {
      hostname: "docker.example.test",
      username: "docker-admin",
      tags: [],
      connectionMode: "ssh"
    },
    connectionMode: "ssh",
    ssh: {
      hostname: "docker.example.test",
      port: 22,
      username: "docker-admin"
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("host terminal session reauthorization", () => {
  it.each([
    ["revoked or disabled", null],
    ["demoted", { ...admin, role: "operator" }]
  ])("closes an established shell when the session is %s", async (_label, nextUser) => {
    vi.useFakeTimers();
    const shell = fakeShell();
    const socket = fakeSocket();
    readSession
      .mockResolvedValueOnce(admin)
      .mockResolvedValueOnce(nextUser);
    openSshShell.mockResolvedValueOnce(shell);

    await handleHostTerminal(socket, fakeRequest());
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "ready" }));

    await vi.advanceTimersByTimeAsync(HOST_TERMINAL_REAUTH_INTERVAL_MS);

    expect(readSession).toHaveBeenLastCalledWith(
      expect.anything(),
      { touch: false }
    );
    expect(shell.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "host.terminal.end",
      details: expect.objectContaining({ reason: "authorization_revoked" })
    }));
  });

  it("does not leave an SSH shell open when the client disconnects during setup", async () => {
    let resolveShell: ((shell: SshShellSession) => void) | undefined;
    const opening = new Promise<SshShellSession>((resolve) => {
      resolveShell = resolve;
    });
    const shell = fakeShell();
    const socket = fakeSocket();
    readSession.mockResolvedValueOnce(admin);
    openSshShell.mockReturnValueOnce(opening);

    const handling = handleHostTerminal(socket, fakeRequest());
    await vi.waitFor(() => expect(openSshShell).toHaveBeenCalledTimes(1));
    socket.emit("close");
    resolveShell?.(shell);
    await handling;

    expect(shell.close).toHaveBeenCalledTimes(1);
    expect(socket.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "ready" }));
  });
});
