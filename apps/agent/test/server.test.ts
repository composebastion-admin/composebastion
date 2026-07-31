import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import packageJson from "../package.json";
import { AGENT_STACK_ROOT } from "../src/paths.js";

type ExecResult = {
  stdout?: string;
  stderr?: string;
  error?: Error & {
    code?: number | string;
    killed?: boolean;
    signal?: string;
  };
};

const state = vi.hoisted(() => ({
  routes: new Map<string, { options: any; handler: (...args: any[]) => any }>(),
  preHandler: undefined as ((request: any, reply: any) => Promise<void>) | undefined,
  execResults: new Map<string, ExecResult>(),
  execOptions: [] as Array<{ args: string[]; options: Record<string, unknown> }>,
  listen: vi.fn(async () => undefined),
  register: vi.fn(async () => undefined),
  stdinEnd: vi.fn(),
  logInfo: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error("Streaming spawn was not expected in this test");
  })
}));

vi.mock("@fastify/rate-limit", () => ({ default: Symbol("rate-limit-plugin") }));

vi.mock("fastify", () => ({
  default: () => ({
    register: state.register,
    addHook: vi.fn((name: string, hook: typeof state.preHandler) => {
      if (name === "preHandler") state.preHandler = hook;
    }),
    log: { info: state.logInfo },
    get: vi.fn((path: string, options: unknown, handler: (...args: any[]) => any) => {
      state.routes.set(`GET ${path}`, { options, handler });
    }),
    post: vi.fn((path: string, options: unknown, handler: (...args: any[]) => any) => {
      state.routes.set(`POST ${path}`, { options, handler });
    }),
    listen: state.listen
  })
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file: string, args: string[], options: Record<string, unknown>, callback: (...args: any[]) => void) => {
    state.execOptions.push({ args, options });
    const result = state.execResults.get(args.join("\0")) ?? {
      error: Object.assign(new Error(`Unexpected docker command: ${args.join(" ")}`), { code: 1 })
    };
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
    return { stdin: { end: state.stdinEnd } };
  }),
  spawn: state.spawn
}));

const token = "agent-server-test-token-that-is-long-enough";
let agentFileFixtureRoot: string;
let agentFileOutsideRoot: string;
const dockerStatsTombstone = {
  BlockIO: "0B / 0B",
  CPUPerc: "0.00%",
  Container: "5fb479d76eb43580fcd59f1739151aa4922d80b8292d25fecc76af9a149b7398",
  ID: "",
  MemPerc: "0.00%",
  MemUsage: "0B / 0B",
  Name: "--",
  NetIO: "0B / 0B",
  PIDs: "0"
};
const originalEnvironment = {
  AGENT_HOST: process.env.AGENT_HOST,
  AGENT_PORT: process.env.AGENT_PORT,
  AGENT_TOKEN: process.env.AGENT_TOKEN,
  AGENT_READ_RATE_LIMIT: process.env.AGENT_READ_RATE_LIMIT,
  AGENT_RUN_RATE_LIMIT: process.env.AGENT_RUN_RATE_LIMIT,
  AGENT_FILE_RATE_LIMIT: process.env.AGENT_FILE_RATE_LIMIT,
  AGENT_STREAM_RATE_LIMIT: process.env.AGENT_STREAM_RATE_LIMIT
};
let parseDockerStatsLine: typeof import("../src/server.js").parseDockerStatsLine;
let signalDetachedProcessGroup: typeof import("../src/server.js").signalDetachedProcessGroup;

function setExecResult(args: string[], result: ExecResult) {
  state.execResults.set(args.join("\0"), result);
}

function route(method: "GET" | "POST", path: string) {
  const registration = state.routes.get(`${method} ${path}`);
  if (!registration) throw new Error(`Route was not registered: ${method} ${path}`);
  return registration.handler;
}

function createReply() {
  const reply = {
    statusCode: 200,
    payload: undefined as unknown,
    code: vi.fn<(code: number) => typeof reply>(),
    send: vi.fn<(payload: unknown) => unknown>()
  };
  reply.code.mockImplementation((code) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send.mockImplementation((payload) => {
    reply.payload = payload;
    return payload;
  });
  return reply;
}

beforeAll(async () => {
  await mkdir(AGENT_STACK_ROOT, { recursive: true, mode: 0o700 });
  agentFileFixtureRoot = await mkdtemp(
    path.join(AGENT_STACK_ROOT, "agent-operation-test-")
  );
  agentFileOutsideRoot = await mkdtemp(
    path.join(tmpdir(), "composebastion-agent-outside-")
  );
  process.env.AGENT_HOST = "127.0.0.1";
  process.env.AGENT_PORT = "19091";
  process.env.AGENT_TOKEN = token;
  process.env.AGENT_READ_RATE_LIMIT = "240";
  process.env.AGENT_RUN_RATE_LIMIT = "45";
  process.env.AGENT_FILE_RATE_LIMIT = "90";
  process.env.AGENT_STREAM_RATE_LIMIT = "20";

  const server = await import("../src/server.js");
  parseDockerStatsLine = server.parseDockerStatsLine;
  signalDetachedProcessGroup = server.signalDetachedProcessGroup;
  await server.main();
  await vi.waitFor(() => expect(state.routes.size).toBeGreaterThanOrEqual(9));
});

beforeEach(() => {
  state.execResults.clear();
  state.execOptions.length = 0;
  state.stdinEnd.mockClear();
  state.spawn.mockReset();
  state.spawn.mockImplementation(() => {
    throw new Error("Streaming spawn was not expected in this test");
  });
});

afterAll(async () => {
  await rm(agentFileFixtureRoot, { recursive: true, force: true });
  await rm(agentFileOutsideRoot, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("agent server", () => {
  it("starts on the configured address and enforces bearer authentication", async () => {
    expect(state.register).toHaveBeenCalledOnce();
    expect(state.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 19091 });

    const missingReply = createReply();
    await state.preHandler?.({ headers: {} }, missingReply);
    expect(missingReply.statusCode).toBe(401);
    expect(missingReply.payload).toEqual({ error: "Invalid agent token" });

    const wrongReply = createReply();
    await state.preHandler?.({ headers: { authorization: "Bearer incorrect-token-with-enough-characters" } }, wrongReply);
    expect(wrongReply.statusCode).toBe(401);

    const authorizedReply = createReply();
    await state.preHandler?.({ headers: { authorization: `Bearer ${token}` } }, authorizedReply);
    expect(authorizedReply.send).not.toHaveBeenCalled();
  });

  it("applies and logs every configured route limiter", () => {
    const expected = new Map([
      ["GET /api/health", 240],
      ["GET /api/host-stats", 240],
      ["GET /api/operations/:id", 240],
      ["GET /api/containers/usage", 240],
      ["GET /api/containers/usage-stream", 20],
      ["POST /api/run", 45],
      ["GET /api/containers/:id/logs-stream", 45],
      ["POST /api/files/write", 90],
      ["GET /api/files/stat", 90],
      ["GET /api/files/read", 90]
    ]);
    for (const [key, max] of expected) {
      expect(state.routes.get(key)?.options.config.rateLimit).toEqual({ max, timeWindow: "1 minute" });
    }
    expect(state.logInfo).toHaveBeenCalledWith({
      rateLimits: { read: 240, run: 45, file: 90, stream: 20 },
      maxConcurrentUsageStreams: 4
    }, "Agent rate limits configured");
  });

  it("honors the requested bounded timeout and exposes terminal operation proof", async () => {
    const operationId = "a".repeat(64);
    setExecResult(["pull", "registry.example.test/app:1"], {
      stdout: "pulled\n"
    });
    const reply = createReply();
    await expect(route("POST", "/api/run")({
      body: {
        command: "docker pull registry.example.test/app:1",
        timeoutMs: 5 * 60_000,
        operationId
      }
    }, reply)).resolves.toMatchObject({
      stdout: "pulled\n",
      code: 0,
      outcome: "completed",
      operation: {
        operationId,
        status: "completed",
        timeoutMs: 5 * 60_000
      }
    });
    expect(reply.statusCode).toBe(200);
    expect(state.execOptions.at(-1)?.options).toMatchObject({
      timeout: 5 * 60_000,
      killSignal: "SIGTERM",
      detached: true
    });

    const statusReply = createReply();
    await expect(route("GET", "/api/operations/:id")({
      params: { id: operationId }
    }, statusReply)).resolves.toMatchObject({
      operationId,
      status: "completed",
      timeoutMs: 5 * 60_000
    });
  });

  it("returns structured ambiguity on a server-side timeout without replaying the operation id", async () => {
    const operationId = "b".repeat(64);
    setExecResult(["compose", "up", "-d"], {
      error: Object.assign(new Error("Docker command timed out"), {
        code: "ETIMEDOUT",
        killed: true,
        signal: "SIGTERM"
      })
    });
    const payload = {
      command: "docker compose up -d",
      timeoutMs: 5 * 60_000,
      operationId
    };

    const firstReply = createReply();
    await expect(route("POST", "/api/run")({ body: payload }, firstReply)).resolves.toMatchObject({
      code: 124,
      outcome: "timed_out",
      operation: {
        operationId,
        status: "timed_out"
      }
    });
    expect(firstReply.statusCode).toBe(504);
    const executions = state.execOptions.length;

    const duplicateReply = createReply();
    await expect(route("POST", "/api/run")({ body: payload }, duplicateReply)).resolves.toMatchObject({
      code: 124,
      outcome: "timed_out",
      operation: {
        operationId,
        status: "timed_out"
      }
    });
    expect(duplicateReply.statusCode).toBe(504);
    expect(state.execOptions).toHaveLength(executions);
  });

  it("atomically receipts and deduplicates an exact agent file write", async () => {
    const operationId = "d".repeat(64);
    const directory = path.join(agentFileFixtureRoot, "dedupe");
    const target = path.join(directory, "compose.yml");
    await rm(directory, { recursive: true, force: true });
    const payload = {
      path: target,
      content: "services:\n  web:\n    image: nginx:alpine\n",
      operationId
    };

    const firstReply = createReply();
    await expect(
      route("POST", "/api/files/write")(
        { body: payload },
        firstReply
      )
    ).resolves.toMatchObject({
      ok: true,
      path: target,
      operation: {
        operationId,
        status: "completed",
        timeoutMs: 30_000
      }
    });
    expect(firstReply.statusCode).toBe(200);
    expect(await readFile(target, "utf8")).toBe(payload.content);
    expect((await stat(target)).mode & 0o777).toBe(0o600);

    // Replacing the target with a sentinel makes a replay observable. An exact
    // duplicate must return the retained receipt without executing the write
    // a second time.
    await rm(target);
    await writeFile(target, "retained-replay-sentinel\n", { mode: 0o600 });
    const duplicateReply = createReply();
    await expect(
      route("POST", "/api/files/write")(
        { body: payload },
        duplicateReply
      )
    ).resolves.toMatchObject({
      operation: { operationId, status: "completed" }
    });
    const replayTarget = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    try {
      expect(await replayTarget.readFile("utf8"))
        .toBe("retained-replay-sentinel\n");
    } finally {
      await replayTarget.close();
    }

    const statusReply = createReply();
    await expect(
      route("GET", "/api/operations/:id")(
        { params: { id: operationId } },
        statusReply
      )
    ).resolves.toMatchObject({
      operationId,
      status: "completed"
    });

    const mismatchReply = createReply();
    await expect(
      route("POST", "/api/files/write")(
        {
          body: {
            ...payload,
            content: "services:\n  changed: {}\n"
          }
        },
        mismatchReply
      )
    ).resolves.toMatchObject({
      code: "REMOTE_OPERATION_IDENTITY_MISMATCH"
    });
    expect(mismatchReply.statusCode).toBe(409);
  });

  it("atomically replaces a file symlink without changing its link target", async () => {
    const operationId = "e".repeat(64);
    const directory = `${agentFileFixtureRoot}/symlink`;
    const target = `${directory}/compose.yml`;
    const sentinel = `${directory}/sentinel`;
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(sentinel, "sentinel", { mode: 0o600 });
    await symlink(sentinel, target);

    const reply = createReply();
    await expect(
      route("POST", "/api/files/write")(
        {
          body: {
            path: target,
            content: "services: {}\n",
            operationId
          }
        },
        reply
      )
    ).resolves.toMatchObject({
      ok: true,
      operation: { operationId, status: "completed" }
    });

    const targetFile = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    try {
      expect((await targetFile.stat()).isSymbolicLink()).toBe(false);
      expect(await targetFile.readFile("utf8")).toBe("services: {}\n");
    } finally {
      await targetFile.close();
    }
    expect(await readFile(sentinel, "utf8")).toBe("sentinel");
  });

  it("rejects symlinked parents and final file links for every file route", async () => {
    const operationId = "f".repeat(64);
    const safeDirectory = `${agentFileFixtureRoot}/confinement`;
    const linkedParent = `${safeDirectory}/outside`;
    const escapedTarget = `${linkedParent}/escaped.yml`;
    const outsideTarget = `${agentFileOutsideRoot}/escaped.yml`;
    const outsideSentinel = `${agentFileOutsideRoot}/sentinel`;
    const linkedFile = `${safeDirectory}/linked-file`;
    await rm(safeDirectory, { recursive: true, force: true });
    await mkdir(safeDirectory, { recursive: true });
    await writeFile(outsideSentinel, "outside-sentinel", { mode: 0o600 });
    await symlink(agentFileOutsideRoot, linkedParent);
    await symlink(outsideSentinel, linkedFile);

    const writeReply = createReply();
    await expect(
      route("POST", "/api/files/write")(
        {
          body: {
            path: escapedTarget,
            content: "services: {}\n",
            operationId
          }
        },
        writeReply
      )
    ).resolves.toMatchObject({
      code: "AGENT_PATH_CONFINEMENT",
      operation: {
        operationId,
        status: "failed"
      }
    });
    expect(writeReply.statusCode).toBe(400);
    await expect(readFile(outsideTarget, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    await expect(
      route("GET", "/api/files/stat")(
        { query: { path: escapedTarget } },
        createReply()
      )
    ).rejects.toMatchObject({ code: "AGENT_PATH_CONFINEMENT" });
    await expect(
      route("GET", "/api/files/read")(
        { query: { path: escapedTarget } },
        createReply()
      )
    ).rejects.toMatchObject({ code: "AGENT_PATH_CONFINEMENT" });
    await expect(
      route("GET", "/api/files/stat")(
        { query: { path: linkedFile } },
        createReply()
      )
    ).rejects.toMatchObject({ code: "AGENT_PATH_CONFINEMENT" });
    await expect(
      route("GET", "/api/files/read")(
        { query: { path: linkedFile } },
        createReply()
      )
    ).rejects.toMatchObject({ code: "AGENT_PATH_CONFINEMENT" });
    expect(await readFile(outsideSentinel, "utf8")).toBe(
      "outside-sentinel"
    );
  });

  it("force-kills the detached process group even after its direct leader exits", () => {
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const directKill = vi.fn(() => true);
    const child = {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: directKill
    };

    signalDetachedProcessGroup(child as any, "SIGTERM");
    child.signalCode = "SIGTERM";
    signalDetachedProcessGroup(child as any, "SIGKILL", true);
    signalDetachedProcessGroup(child as any, "SIGKILL");

    expect(groupKill).toHaveBeenNthCalledWith(1, -4242, "SIGTERM");
    expect(groupKill).toHaveBeenNthCalledWith(2, -4242, "SIGKILL");
    expect(groupKill).toHaveBeenCalledTimes(2);
    expect(directKill).not.toHaveBeenCalled();
    groupKill.mockRestore();
  });

  it("reports healthy only when both Docker and Compose respond", async () => {
    setExecResult(["version", "--format", "{{.Server.Version}}"], { stdout: "29.6.1\n" });
    setExecResult(["compose", "version", "--short"], { stdout: "5.3.1\n" });

    const healthyReply = createReply();
    const healthy = await route("GET", "/api/health")({}, healthyReply);
    expect(healthyReply.statusCode).toBe(200);
    expect(healthy).toMatchObject({
      ok: true,
      agentVersion: packageJson.version,
      dockerVersion: "29.6.1",
      composeVersion: "5.3.1",
      dockerError: null,
      composeError: null
    });

    const composeError = Object.assign(new Error("compose unavailable"), { code: 127 });
    setExecResult(["compose", "version", "--short"], { error: composeError, stderr: "compose unavailable" });
    const unhealthyReply = createReply();
    const unhealthy = await route("GET", "/api/health")({}, unhealthyReply);
    expect(unhealthyReply.statusCode).toBe(503);
    expect(unhealthy).toMatchObject({ ok: false, composeError: "compose unavailable" });
  });

  it("returns usage snapshots and distinguishes Docker and payload failures", async () => {
    const statsArgs = ["stats", "--no-stream", "--format", "{{json .}}"];
    setExecResult(statsArgs, {
      stdout: '{"Name":"web","CPUPerc":"1.2%"}\n{"Name":"db","CPUPerc":"0.3%"}\n'
    });
    const successReply = createReply();
    await expect(route("GET", "/api/containers/usage")({}, successReply)).resolves.toEqual({
      usage: [
        { Name: "web", CPUPerc: "1.2%" },
        { Name: "db", CPUPerc: "0.3%" }
      ]
    });

    setExecResult(statsArgs, { stdout: "not-json\n" });
    const malformedReply = createReply();
    await expect(route("GET", "/api/containers/usage")({}, malformedReply)).resolves.toEqual({
      error: "Docker returned malformed container stats"
    });
    expect(malformedReply.statusCode).toBe(502);

    setExecResult(statsArgs, {
      stdout: '{"ID":"web","Name":"web","CPUPerc":"1.2%"}\n{"CPUPerc":"0.3%","MemPerc":"2.0%"}\n'
    });
    const identitylessReply = createReply();
    await expect(route("GET", "/api/containers/usage")({}, identitylessReply)).resolves.toEqual({
      error: "Docker returned malformed container stats"
    });
    expect(identitylessReply.statusCode).toBe(502);

    setExecResult(statsArgs, {
      error: Object.assign(new Error("daemon unavailable"), { code: 1 }),
      stderr: "daemon unavailable"
    });
    const failedReply = createReply();
    await expect(route("GET", "/api/containers/usage")({}, failedReply)).resolves.toEqual({
      error: "daemon unavailable"
    });
    expect(failedReply.statusCode).toBe(503);
  });

  it("parses continuous Docker stats rows after removing terminal repaint sequences", () => {
    expect(
      parseDockerStatsLine(
        '\u001b[H{"ID":"abc123","Name":"web","CPUPerc":"1.2%","PIDs":"2"}\u001b[K'
      )
    ).toEqual({
      ID: "abc123",
      Name: "web",
      CPUPerc: "1.2%",
      PIDs: "2"
    });
    expect(
      parseDockerStatsLine(
        '{"ID":"def456","Name":"db","CPUPerc":"0.3%","PIDs":"4"}\u001b[K'
      )
    ).toMatchObject({ ID: "def456", Name: "db" });
    expect(parseDockerStatsLine(JSON.stringify(dockerStatsTombstone))).toBeNull();
    expect(
      parseDockerStatsLine(JSON.stringify({
        ...dockerStatsTombstone,
        CPUPerc: "0%",
        MemUsage: "0 bytes / 0 bytes",
        PIDs: 0
      }))
    ).toBeNull();
    expect(
      parseDockerStatsLine(JSON.stringify({ ...dockerStatsTombstone, ID: "5fb479d76eb4" }))
    ).toMatchObject({ ID: "5fb479d76eb4", Name: "--" });
    expect(parseDockerStatsLine("\u001b[K")).toBeNull();
    expect(() => parseDockerStatsLine("null")).toThrow("must be a JSON object");
    expect(() => parseDockerStatsLine("[]")).toThrow("must be a JSON object");
    expect(() => parseDockerStatsLine('{"CPUPerc":"1.2%","MemPerc":"3.4%"}')).toThrow("must include a container identity");
    expect(() => parseDockerStatsLine('{"Name":"--","CPUPerc":"0.0%"}')).toThrow("must include a container identity");
    expect(() => parseDockerStatsLine('{"Container":"5fb479d76eb4","CPUPerc":"1.2%"}')).toThrow("must include a container identity");
    expect(() => parseDockerStatsLine("\u001b[Hnot-json\u001b[K")).toThrow();
  });

  it("streams ANSI stats, ignores lifecycle tombstones, and reports malformed JSON", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      killed: false,
      kill: vi.fn(function (this: { killed: boolean }) {
        this.killed = true;
        return true;
      })
    });
    state.spawn.mockReturnValueOnce(child);

    const raw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn()
    });
    const reply = {
      hijack: vi.fn(),
      raw
    };
    await route("GET", "/api/containers/usage-stream")({ raw }, reply);

    stdout.emit(
      "data",
      Buffer.from(
        `\u001b[H{"ID":"abc123","Name":"web","CPUPerc":"1.2%","PIDs":"2"}\u001b[K\n`
        + `\u001b[H${JSON.stringify(dockerStatsTombstone)}\u001b[K\n`
      )
    );
    const writesBeforeMalformed = raw.write.mock.calls.map(([chunk]) => String(chunk));
    expect(writesBeforeMalformed).toEqual([
      'data: {"stats":{"ID":"abc123","Name":"web","CPUPerc":"1.2%","PIDs":"2"}}\n\n'
    ]);

    stdout.emit(
      "data",
      Buffer.from(
        '\u001b[H{"CPUPerc":"1.2%","MemPerc":"3.4%"}\u001b[K\n'
        + "\u001b[H[]\u001b[K\n"
        + "\u001b[Hnot-json\u001b[K\n"
      )
    );
    const writes = raw.write.mock.calls.map(([chunk]) => String(chunk));
    expect(writes).toEqual([
      'data: {"stats":{"ID":"abc123","Name":"web","CPUPerc":"1.2%","PIDs":"2"}}\n\n',
      'event: error\ndata: {"error":"Docker returned malformed container stats"}\n\n',
      'event: error\ndata: {"error":"Docker returned malformed container stats"}\n\n',
      'event: error\ndata: {"error":"Docker returned malformed container stats"}\n\n'
    ]);

    raw.emit("close");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
