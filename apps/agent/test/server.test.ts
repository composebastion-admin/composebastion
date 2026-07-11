import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ExecResult = {
  stdout?: string;
  stderr?: string;
  error?: Error & { code?: number | string };
};

const state = vi.hoisted(() => ({
  routes: new Map<string, (...args: any[]) => any>(),
  preHandler: undefined as ((request: any, reply: any) => Promise<void>) | undefined,
  execResults: new Map<string, ExecResult>(),
  listen: vi.fn(async () => undefined),
  register: vi.fn(async () => undefined),
  stdinEnd: vi.fn()
}));

vi.mock("@fastify/rate-limit", () => ({ default: Symbol("rate-limit-plugin") }));

vi.mock("fastify", () => ({
  default: () => ({
    register: state.register,
    addHook: vi.fn((name: string, hook: typeof state.preHandler) => {
      if (name === "preHandler") state.preHandler = hook;
    }),
    get: vi.fn((path: string, _options: unknown, handler: (...args: any[]) => any) => {
      state.routes.set(`GET ${path}`, handler);
    }),
    post: vi.fn((path: string, _options: unknown, handler: (...args: any[]) => any) => {
      state.routes.set(`POST ${path}`, handler);
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
  spawn: vi.fn(() => {
    throw new Error("Streaming spawn was not expected in this test");
  })
}));

const token = "agent-server-test-token-that-is-long-enough";
const originalEnvironment = {
  AGENT_HOST: process.env.AGENT_HOST,
  AGENT_PORT: process.env.AGENT_PORT,
  AGENT_TOKEN: process.env.AGENT_TOKEN
};

function setExecResult(args: string[], result: ExecResult) {
  state.execResults.set(args.join("\0"), result);
}

function route(method: "GET" | "POST", path: string) {
  const handler = state.routes.get(`${method} ${path}`);
  if (!handler) throw new Error(`Route was not registered: ${method} ${path}`);
  return handler;
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

  const { main } = await import("../src/server.js");
  await main();
  await vi.waitFor(() => expect(state.routes.size).toBeGreaterThanOrEqual(9));
});

beforeEach(() => {
  state.execResults.clear();
  state.stdinEnd.mockClear();
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

  it("reports healthy only when both Docker and Compose respond", async () => {
    setExecResult(["version", "--format", "{{.Server.Version}}"], { stdout: "29.6.1\n" });
    setExecResult(["compose", "version", "--short"], { stdout: "5.3.1\n" });

    const healthyReply = createReply();
    const healthy = await route("GET", "/api/health")({}, healthyReply);
    expect(healthyReply.statusCode).toBe(200);
    expect(healthy).toMatchObject({
      ok: true,
      agentVersion: "1.1.0",
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
      error: Object.assign(new Error("daemon unavailable"), { code: 1 }),
      stderr: "daemon unavailable"
    });
    const failedReply = createReply();
    await expect(route("GET", "/api/containers/usage")({}, failedReply)).resolves.toEqual({
      error: "daemon unavailable"
    });
    expect(failedReply.statusCode).toBe(503);
  });
});
