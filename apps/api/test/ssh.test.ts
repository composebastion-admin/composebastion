import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ssh2Mock = vi.hoisted(() => ({
  clients: [] as Array<{
    channel: {
      emit: (event: string, ...args: unknown[]) => boolean;
      stderr: { emit: (event: string, ...args: unknown[]) => boolean };
      end: ReturnType<typeof vi.fn>;
    };
    sftpSession: { emit: (event: string, ...args: unknown[]) => boolean };
    exec: ReturnType<typeof vi.fn>;
    sftp: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>
}));

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeChannel extends EventEmitter {
    readonly stderr = new EventEmitter();
    readonly end = vi.fn();
    readonly destroy = vi.fn();
    readonly close = vi.fn();
    readonly write = vi.fn();
    readonly setWindow = vi.fn();
  }

  class FakeSftp extends EventEmitter {
    readonly writeFile = vi.fn();
    readonly stat = vi.fn();
    readonly readFile = vi.fn();
  }

  class FakeClient extends EventEmitter {
    readonly channel = new FakeChannel();
    readonly sftpSession = new FakeSftp();
    readonly end = vi.fn();
    readonly connect = vi.fn(() => queueMicrotask(() => this.emit("ready")));
    readonly exec = vi.fn((_command: string, callback: (error: Error | undefined, stream: FakeChannel) => void) => {
      callback(undefined, this.channel);
    });
    readonly sftp = vi.fn((callback: (error: Error | undefined, sftp: FakeSftp) => void) => {
      callback(undefined, this.sftpSession);
    });
    readonly shell = vi.fn((_options: unknown, callback: (error: Error | undefined, stream: FakeChannel) => void) => {
      callback(undefined, this.channel);
    });

    constructor() {
      super();
      ssh2Mock.clients.push(this);
    }
  }

  return { Client: FakeClient };
});

import {
  inspectSshRemoteOperation,
  openSshShell,
  runSshCommand,
  sshRemoteOperationInternals,
  streamSshCommandLines,
  writeRemoteFile
} from "../src/services/ssh.js";
import {
  RemoteMutationOutcomeUnknownError,
  withRemoteMutationContext
} from "../src/services/remoteMutationProof.js";

const target = {
  hostname: "ssh.example.test",
  port: 22,
  username: "operator",
  privateKey: "test-key"
};

async function connectedClient() {
  await vi.waitFor(() => expect(ssh2Mock.clients).toHaveLength(1));
  return ssh2Mock.clients[0]!;
}

async function connectedClientAt(index: number) {
  await vi.waitFor(() => expect(ssh2Mock.clients.length).toBeGreaterThan(index));
  return ssh2Mock.clients[index]!;
}

describe("SSH command completion", () => {
  beforeEach(() => {
    ssh2Mock.clients.length = 0;
  });

  it("rejects once and absorbs repeated transport errors during a failed handshake", async () => {
    const result = runSshCommand(target, "docker info");
    expect(ssh2Mock.clients).toHaveLength(1);
    const client = ssh2Mock.clients[0]!;
    const failure = new Error("connection lost before handshake");

    client.emit("error", failure);

    expect(() => client.emit("error", new Error("late socket close error"))).not.toThrow();
    await expect(result).rejects.toBe(failure);
    expect(client.exec).not.toHaveBeenCalled();
  });

  it("rejects a channel close that has no authoritative exit status", async () => {
    const result = runSshCommand(target, "docker info");
    const client = await connectedClient();

    client.channel.emit("close", null);

    await expect(result).rejects.toThrow("SSH command closed without an exit status");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects a mid-command stream failure exactly once", async () => {
    const result = runSshCommand(target, "docker ps");
    const client = await connectedClient();
    const failure = new Error("channel transport lost");

    client.channel.emit("error", failure);
    client.channel.emit("close", 0);

    await expect(result).rejects.toBe(failure);
    expect(client.end).toHaveBeenCalledOnce();
    expect(() => client.emit("error", new Error("second close-time transport error"))).not.toThrow();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects a client transport failure after command startup", async () => {
    const result = runSshCommand(target, "docker version");
    const client = await connectedClient();
    const failure = new Error("socket disconnected");

    client.emit("error", failure);

    await expect(result).rejects.toBe(failure);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("still returns stdout, stderr, exit status, and signal on a normal close", async () => {
    const result = runSshCommand(target, "printf ok");
    const client = await connectedClient();

    client.channel.emit("data", Buffer.from("ok"));
    client.channel.stderr.emit("data", Buffer.from("warning"));
    client.channel.emit("close", 0, "SIGTERM");

    await expect(result).resolves.toEqual({
      stdout: "ok",
      stderr: "warning",
      code: 0,
      signal: "SIGTERM"
    });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("uses a detached server-side timeout, PID-start proof, and dead-input scrubbing", () => {
    const command = sshRemoteOperationInternals.buildDurableRemoteOperationCommand(
      "a".repeat(64),
      "docker compose up -d",
      10 * 60_000,
      {
        byteLength: 15,
        sha256: "b".repeat(64)
      }
    );
    expect(command).toContain("timeout -k 5s");
    expect(command).toContain("setsid nohup");
    expect(command).not.toContain("--kill-after");
    expect(command).not.toContain("setsid -f");
    expect(command).toContain("/proc/$$/stat");
    expect(command).toContain("pid_start");
    expect(command.indexOf("pid_start.tmp")).toBeLessThan(
      command.indexOf('running > "$dir/state.tmp"')
    );
    expect(command).toContain("test ! -e \"$dir/state\"");
    expect(command).toContain("COMPOSEBASTION_REMOTE_INPUT=\"$dir/input\"");
    expect(command).toContain("test ! -L \"$dir/input\"");
    expect(command).toContain("(umask 077; set -C; cat > \"$dir/input\")");
    expect(command).toContain("command -v sha256sum");
    expect(command).toContain("actual_bytes=$(wc -c");
    expect(command).toContain("actual_sha256=$(sha256sum");
    expect(command).toContain("b".repeat(64));
    expect(command.indexOf('trap \'rm -f -- "$dir/input"\''))
      .toBeLessThan(command.indexOf('cat > "$dir/input"'));
    expect(command.indexOf("setsid nohup"))
      .toBeLessThan(command.indexOf("trap - 0 1 2 15"));
    expect(command).toContain('test ! -L "$dir/identity"');
    expect(command).toContain("rm -f -- \"$dir/input\"");
    expect(command).toContain("proof_unavailable");
    expect(command).not.toContain("registry-password");

    const inspection = sshRemoteOperationInternals.buildInspectRemoteOperationCommand(
      "a".repeat(64)
    );
    expect(inspection).toContain("operation_is_live");
    expect(inspection).toContain("missing -1");
    expect(inspection).not.toContain('mkdir "$dir"');
    expect(inspection).toContain("rm -f -- \"$dir/input\"");
    expect(inspection).toContain('test -L "$dir/identity"');
    expect(inspection).toContain("proof_unavailable");
  });

  it("builds symlink-safe atomic writes and bounded terminal-proof sweeps", () => {
    const writeCommand =
      sshRemoteOperationInternals.buildAtomicRemoteFileWriteCommand(
        "/srv/app/compose.yml"
      );
    expect(writeCommand).toContain('test -d "$parent" && test ! -L "$parent"');
    expect(writeCommand).toContain(
      'test -f "$target" && test ! -L "$target"'
    );
    expect(writeCommand).toContain("mktemp");
    expect(writeCommand).toContain('cat > "$tmp"');
    expect(writeCommand).toContain('chmod 0600 "$tmp"');
    expect(writeCommand).toContain('mv -fT -- "$tmp" "$target"');
    expect(writeCommand).not.toContain("services:");

    const protectedOperationId = "b".repeat(64);
    const sweepCommand =
      sshRemoteOperationInternals.buildSweepTerminalRemoteOperationsCommand(
        [protectedOperationId],
        { maxScanned: 5, maxRemoved: 2, graceSeconds: 60 }
      );
    expect(sweepCommand).toContain("timeout -k 5s 30s");
    expect(sweepCommand).toContain(`${protectedOperationId}) continue`);
    expect(sweepCommand).toContain('test "${#name}" -eq 64');
    expect(sweepCommand).toContain(
      'test "$(cat "$dir/identity" 2>/dev/null || true)" = "$name"'
    );
    expect(sweepCommand).toContain(
      "case \"$state\" in completed|failed|timed_out)"
    );
    expect(sweepCommand).toContain('test "$scanned" -gt 5');
    expect(sweepCommand).toContain('test "$removed" -ge 2');
    expect(sweepCommand.indexOf(`${protectedOperationId}) continue`))
      .toBeLessThan(sweepCommand.indexOf("scanned=$((scanned + 1))"));
    expect(sweepCommand.indexOf('test ! -L "$dir/identity"'))
      .toBeLessThan(sweepCommand.indexOf("scanned=$((scanned + 1))"));
  });

  it("records authoritative terminal proof for the exact fenced SSH operation", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
      rowCount: 1
    }));
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 3,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(callback: (client: any) => Promise<T>) => (
        callback({ query })
      )
    };
    const result = withRemoteMutationContext(
      fence,
      "compose.deploy",
      () => runSshCommand(target, "docker compose up -d", {
        timeoutMs: 10 * 60_000
      })
    );
    const client = await connectedClient();

    client.channel.emit(
      "data",
      Buffer.from("__COMPOSEBASTION_REMOTE_OPERATION__ completed 0\ncreated\n")
    );
    client.channel.emit("close", 0);
    const cleanupClient = await connectedClientAt(1);
    cleanupClient.channel.emit("close", 0);

    await expect(result).resolves.toEqual({
      stdout: "created\n",
      stderr: "",
      code: 0
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain("dispatchedAt");
    expect(String(query.mock.calls[1]?.[0])).toContain("'terminal'");
  });

  it("maps a proven server-side SSH timeout to structured remote ambiguity", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
      rowCount: 1
    }));
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 4,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(callback: (client: any) => Promise<T>) => (
        callback({ query })
      )
    };
    const result = withRemoteMutationContext(
      fence,
      "git.pull",
      () => runSshCommand(target, "git pull --ff-only", {
        timeoutMs: 10 * 60_000
      })
    );
    const client = await connectedClient();

    client.channel.emit(
      "data",
      Buffer.from("__COMPOSEBASTION_REMOTE_OPERATION__ timed_out 124\n")
    );
    client.channel.emit("close", 0);
    const cleanupClient = await connectedClientAt(1);
    cleanupClient.channel.emit("close", 0);

    await expect(result).rejects.toBeInstanceOf(
      RemoteMutationOutcomeUnknownError
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reports an exact running SSH operation as non-terminal", async () => {
    const operationId = "d".repeat(64);
    const result = inspectSshRemoteOperation(target, operationId);
    const client = await connectedClient();

    client.channel.emit(
      "data",
      Buffer.from("__COMPOSEBASTION_REMOTE_OPERATION__ running -1\n")
    );
    client.channel.emit("close", 0);

    await expect(result).resolves.toEqual({
      operationId,
      state: "running",
      code: -1
    });
  });

  it("uses supervised SSH stdin and an atomic rename for a fenced file write", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
      rowCount: 1
    }));
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 5,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(callback: (client: any) => Promise<T>) => (
        callback({ query })
      )
    };
    const contents = "services:\n  web:\n    image: private.example/app:1\n";
    const result = withRemoteMutationContext(
      fence,
      "compose.write",
      () => writeRemoteFile(target, "/srv/app/compose.yml", contents)
    );
    const client = await connectedClient();
    const remoteCommand = String(client.exec.mock.calls[0]?.[0]);

    expect(remoteCommand).toContain("mktemp");
    expect(remoteCommand).toContain('cat > "$tmp"');
    expect(remoteCommand).toContain('mv -fT -- "$tmp" "$target"');
    expect(remoteCommand).toContain(
      createHash("sha256").update(contents).digest("hex")
    );
    expect(remoteCommand).toContain(
      `test "$actual_bytes" != '${Buffer.byteLength(contents)}'`
    );
    expect(remoteCommand).not.toContain(contents);
    expect(client.channel.end).toHaveBeenCalledWith(contents);
    expect(client.sftp).not.toHaveBeenCalled();

    client.channel.emit(
      "data",
      Buffer.from("__COMPOSEBASTION_REMOTE_OPERATION__ completed 0\n")
    );
    client.channel.emit("close", 0);
    const cleanupClient = await connectedClientAt(1);
    cleanupClient.channel.emit("close", 0);

    await expect(result).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("retains exact target receipt when transport is lost after an atomic write", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
      rowCount: 1
    }));
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 6,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(callback: (client: any) => Promise<T>) => (
        callback({ query })
      )
    };
    const contents = "services:\n  web:\n    image: fixture.example/app:2\n";
    const write = withRemoteMutationContext(
      fence,
      "compose.write-after-loss",
      () => writeRemoteFile(target, "/srv/app/compose.yml", contents)
    );
    const client = await connectedClient();
    const dispatchedProof = JSON.parse(
      String(query.mock.calls[0]?.[1]?.[2])
    ) as { operationId: string };

    expect(client.channel.end).toHaveBeenCalledWith(contents);
    expect(client.sftp).not.toHaveBeenCalled();
    client.emit("error", new Error("transport lost after target rename"));

    await expect(write).rejects.toMatchObject({
      name: "RemoteMutationOutcomeUnknownError",
      operationId: dispatchedProof.operationId,
      remoteState: "transport_lost"
    });
    expect(query).toHaveBeenCalledTimes(1);

    const inspection = inspectSshRemoteOperation(
      target,
      dispatchedProof.operationId
    );
    const inspectionClient = await connectedClientAt(1);
    inspectionClient.channel.emit(
      "data",
      Buffer.from("__COMPOSEBASTION_REMOTE_OPERATION__ completed 0\n")
    );
    inspectionClient.channel.emit("close", 0);

    await expect(inspection).resolves.toEqual({
      operationId: dispatchedProof.operationId,
      state: "completed",
      code: 0
    });
  });

  it("forwards a streaming client failure and closes the transport", async () => {
    const onError = vi.fn();
    const cleanup = await streamSshCommandLines(target, "docker events", vi.fn(), onError);
    const client = await connectedClient();
    const failure = new Error("stream socket disconnected");

    client.emit("error", failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(client.end).toHaveBeenCalledOnce();
    cleanup();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects an SFTP write when the client fails before the write callback", async () => {
    const result = writeRemoteFile(target, "/srv/app/compose.yml", "services: {}");
    const client = await connectedClient();
    const failure = new Error("SFTP transport disconnected");

    client.emit("error", failure);

    await expect(result).rejects.toBe(failure);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects a write on a fatal SFTP protocol error without an uncaught event", async () => {
    const result = writeRemoteFile(target, "/srv/app/compose.yml", "services: {}");
    const client = await connectedClient();
    const failure = new Error("fatal SFTP protocol error");

    expect(() => client.sftpSession.emit("error", failure)).not.toThrow();

    await expect(result).rejects.toBe(failure);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("forwards a shell client failure to a registered session handler", async () => {
    const session = await openSshShell(target);
    const client = await connectedClient();
    const onError = vi.fn();
    const failure = new Error("shell transport disconnected");
    session.onError(onError);

    client.emit("error", failure);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(client.end).toHaveBeenCalledOnce();
  });
});
