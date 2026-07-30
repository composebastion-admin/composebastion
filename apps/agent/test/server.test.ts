import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import packageJson from "../package.json";

type ExecResult = {
  stdout?: string;
  stderr?: string;
  error?: Error & { code?: number | string };
};

const state = vi.hoisted(() => ({
  routes: new Map<string, { options: any; handler: (...args: any[]) => any }>(),
  preHandler: undefined as ((request: any, reply: any) => Promise<void>) | undefined,
  execResults: new Map<string, ExecResult>(),
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
  execFile: vi.fn((_file: string, args: string[], _options: unknown, callback: (...args: any[]) => void) => {
    const result = state.execResults.get(args.join("\0")) ?? {
      error: Object.assign(new Error(`Unexpected docker command: ${args.join(" ")}`), { code: 1 })
    };
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
    return { stdin: { end: state.stdinEnd } };
  }),
  spawn: state.spawn
}));

const token = "agent-server-test-token-that-is-long-enough";
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
  process.env.AGENT_HOST = "127.0.0.1";
  process.env.AGENT_PORT = "19091";
  process.env.AGENT_TOKEN = token;
  process.env.AGENT_READ_RATE_LIMIT = "240";
  process.env.AGENT_RUN_RATE_LIMIT = "45";
  process.env.AGENT_FILE_RATE_LIMIT = "90";
  process.env.AGENT_STREAM_RATE_LIMIT = "20";

  const server = await import("../src/server.js");
  parseDockerStatsLine = server.parseDockerStatsLine;
  await server.main();
  await vi.waitFor(() => expect(state.routes.size).toBeGreaterThanOrEqual(9));
});

beforeEach(() => {
  state.execResults.clear();
  state.stdinEnd.mockClear();
  state.spawn.mockReset();
  state.spawn.mockImplementation(() => {
    throw new Error("Streaming spawn was not expected in this test");
  });
});

afterAll(() => {
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
