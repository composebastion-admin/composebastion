import { beforeEach, describe, expect, it, vi } from "vitest";

const ssh2Mock = vi.hoisted(() => ({
  clients: [] as Array<{
    channel: {
      emit: (event: string, ...args: unknown[]) => boolean;
      stderr: { emit: (event: string, ...args: unknown[]) => boolean };
    };
    sftpSession: { emit: (event: string, ...args: unknown[]) => boolean };
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
  openSshShell,
  runSshCommand,
  streamSshCommandLines,
  writeRemoteFile
} from "../src/services/ssh.js";

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

describe("SSH command completion", () => {
  beforeEach(() => {
    ssh2Mock.clients.length = 0;
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
