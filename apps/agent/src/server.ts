import { timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, open, readFile, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z } from "zod";
import { parseAgentEnvironment, resolveAgentVersion } from "./config.js";
import { isPermittedDockerCommand, parsePermittedDockerCommand, type ParsedDockerCommand } from "./security.js";
import { validateAgentFilePath } from "./paths.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const AGENT_VERSION = resolveAgentVersion(process.env.COMPOSEBASTION_AGENT_VERSION, packageJson.version);
const env = parseAgentEnvironment(process.env);

const runSchema = z.object({
  command: z.string().min(1).max(8000)
    .refine((command) => !/[\0\r]/.test(command), "Command contains invalid control characters")
    .refine((command) => isPermittedDockerCommand(command), "Agent only accepts ComposeBastion Docker commands")
});

const containerLogParamsSchema = z.object({
  id: z.string().min(1).max(256).refine((value) => !/[\0\r\n]/.test(value), "Container id contains invalid control characters")
});

const containerLogQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(5000).default(500)
});

const agentReadRateLimit = { max: 120, timeWindow: "1 minute" } as const;
const agentRunRateLimit = { max: 30, timeWindow: "1 minute" } as const;
const agentFileRateLimit = { max: 60, timeWindow: "1 minute" } as const;
const agentStreamRateLimit = { max: 10, timeWindow: "1 minute" } as const;
const MAX_CONCURRENT_USAGE_STREAMS = 4;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(header: string | undefined) {
  const [scheme, token] = header?.split(" ") ?? [];
  return scheme === "Bearer" && token ? token : null;
}

function writeSseLine(reply: { raw: { destroyed: boolean; write: (chunk: string) => void } }, event: string, payload: unknown) {
  if (reply.raw.destroyed) return;
  reply.raw.write(`${event === "message" ? "" : `event: ${event}\n`}data: ${JSON.stringify(payload)}\n\n`);
}

function streamLinesFromBuffer(buffer: { value: string }, chunk: Buffer, onLine: (line: string) => void) {
  buffer.value += chunk.toString("utf8");
  const lines = buffer.value.split(/\r?\n/);
  buffer.value = lines.pop() ?? "";
  for (const line of lines) onLine(line);
}

async function execDocker(parsed: ParsedDockerCommand, timeout: number) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = execFile("docker", parsed.args, {
      cwd: parsed.cwd,
      env: parsed.env ? { ...process.env, ...parsed.env } : process.env,
      timeout,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr, code: 0 });
        return;
      }
      resolve({
        stdout,
        stderr: stderr || error.message,
        code: typeof error.code === "number" ? error.code : 1
      });
    });
    if (parsed.stdin !== undefined) child.stdin?.end(parsed.stdin);
  });
}

async function run(command: string, timeout = 120_000) {
  const parsed = parsePermittedDockerCommand(command);
  if (!parsed) return { stdout: "", stderr: "Agent only accepts ComposeBastion Docker commands", code: 1 };
  return execDocker(parsed, timeout);
}

function parseDockerStats(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const pseudoMountTypes = new Set([
  "autofs",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "securityfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs"
]);

function decodeMountField(value: string) {
  return value
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

function isRealMount(mount: { source: string; mountpoint: string; type: string }) {
  if (!mount.mountpoint.startsWith("/")) return false;
  if (pseudoMountTypes.has(mount.type)) return false;
  if (mount.mountpoint === "/") return true;
  return !["/proc", "/sys", "/dev", "/run"].some((prefix) => mount.mountpoint === prefix || mount.mountpoint.startsWith(`${prefix}/`));
}

async function collectDiskStats(mountsText: string) {
  const mounts = mountsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [source, mountpoint, type] = line.split(/\s+/);
      if (!source || !mountpoint || !type) return [];
      return [{ source: decodeMountField(source), mountpoint: decodeMountField(mountpoint), type }];
    })
    .filter(isRealMount);
  const seen = new Set<string>();
  const disks = [];
  for (const mount of mounts) {
    if (seen.has(mount.mountpoint)) continue;
    seen.add(mount.mountpoint);
    try {
      const stats = await statfs(mount.mountpoint);
      const totalBytes = stats.bsize * stats.blocks;
      const availableBytes = stats.bsize * stats.bavail;
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      disks.push({
        mount: mount.mountpoint,
        totalBytes,
        usedBytes,
        usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
      });
    } catch {
      // Mounts can disappear while /proc/mounts is being sampled.
    }
  }
  return disks;
}

export async function main() {
  const app = Fastify({ logger: true, bodyLimit: 16 * 1024 });
  let activeUsageStreams = 0;
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute"
  });

  app.addHook("preHandler", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token || !safeEqual(token, env.AGENT_TOKEN)) {
      reply.code(401).send({ error: "Invalid agent token" });
    }
  });

  app.get("/api/health", { config: { rateLimit: agentReadRateLimit } }, async (_request, reply) => {
    const [docker, compose] = await Promise.all([
      run("docker version --format '{{.Server.Version}}'", 30_000),
      run("docker compose version --short", 30_000)
    ]);
    const ok = docker.code === 0 && compose.code === 0;
    if (!ok) reply.code(503);
    return {
      ok,
      agentVersion: AGENT_VERSION,
      revision: process.env.COMPOSEBASTION_AGENT_REVISION || null,
      buildDate: process.env.COMPOSEBASTION_AGENT_BUILD_DATE || null,
      dockerVersion: docker.stdout.trim(),
      composeVersion: compose.stdout.trim(),
      dockerError: docker.code === 0 ? null : docker.stderr,
      composeError: compose.code === 0 ? null : compose.stderr
    };
  });

  app.get("/api/host-stats", { config: { rateLimit: agentReadRateLimit } }, async () => {
    const [statText, meminfo, loadavg, uptime, netdev, mounts] = await Promise.all([
      readFile("/proc/stat", "utf8"),
      readFile("/proc/meminfo", "utf8"),
      readFile("/proc/loadavg", "utf8"),
      readFile("/proc/uptime", "utf8"),
      readFile("/proc/net/dev", "utf8"),
      readFile("/proc/mounts", "utf8")
    ]);
    return {
      stat: statText.split(/\r?\n/).find((line) => line.startsWith("cpu ")) ?? "",
      meminfo,
      loadavg,
      uptime,
      netdev,
      mounts,
      disks: await collectDiskStats(mounts)
    };
  });

  app.post("/api/run", { config: { rateLimit: agentRunRateLimit } }, async (request, reply) => {
    const body = runSchema.parse(request.body);
    const result = await run(body.command);
    if (result.code !== 0) reply.code(500);
    return result;
  });

  app.get("/api/containers/usage", { config: { rateLimit: agentReadRateLimit } }, async (_request, reply) => {
    const result = await run("docker stats --no-stream --format '{{json .}}'", 60_000);
    if (result.code !== 0) {
      reply.code(503);
      return { error: result.stderr || "Docker stats failed" };
    }
    try {
      return { usage: parseDockerStats(result.stdout) };
    } catch {
      reply.code(502);
      return { error: "Docker returned malformed container stats" };
    }
  });

  app.get("/api/containers/usage-stream", { config: { rateLimit: agentStreamRateLimit } }, async (request, reply) => {
    if (activeUsageStreams >= MAX_CONCURRENT_USAGE_STREAMS) {
      reply.code(429);
      return { error: "Too many concurrent container usage streams" };
    }
    activeUsageStreams += 1;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const child = spawn("docker", ["stats", "--format", "{{json .}}"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = { value: "" };
    const stderr = { value: "" };
    const heartbeat = setInterval(() => writeSseLine(reply, "ping", { ok: true }), 25_000);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      activeUsageStreams = Math.max(0, activeUsageStreams - 1);
      clearInterval(heartbeat);
      if (!child.killed) child.kill("SIGTERM");
    };
    const emitStats = (line: string) => {
      if (!line.trim()) return;
      try {
        writeSseLine(reply, "message", { stats: JSON.parse(line) as Record<string, unknown> });
      } catch {
        writeSseLine(reply, "error", { error: "Docker returned malformed container stats" });
      }
    };
    request.raw.on("close", cleanup);
    child.stdout.on("data", (chunk: Buffer) => streamLinesFromBuffer(stdout, chunk, emitStats));
    child.stderr.on("data", (chunk: Buffer) => streamLinesFromBuffer(stderr, chunk, (line) => {
      if (line.trim()) writeSseLine(reply, "error", { error: line });
    }));
    child.on("error", (error) => writeSseLine(reply, "error", { error: error.message }));
    child.on("close", (code) => {
      if (stdout.value) emitStats(stdout.value);
      if (stderr.value.trim()) writeSseLine(reply, "error", { error: stderr.value });
      writeSseLine(reply, "end", { code: code ?? 0 });
      cleanup();
      if (!reply.raw.destroyed) reply.raw.end();
    });
  });

  app.get("/api/containers/:id/logs-stream", { config: { rateLimit: agentRunRateLimit } }, async (request, reply) => {
    const { id } = containerLogParamsSchema.parse(request.params);
    const { tail } = containerLogQuerySchema.parse(request.query);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const child = spawn("docker", ["logs", "-f", "--tail", String(tail), id], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = { value: "" };
    const stderr = { value: "" };
    const heartbeat = setInterval(() => writeSseLine(reply, "ping", { ok: true }), 25_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      if (!child.killed) child.kill("SIGTERM");
    };
    request.raw.on("close", cleanup);
    child.stdout.on("data", (chunk: Buffer) => streamLinesFromBuffer(stdout, chunk, (line) => writeSseLine(reply, "message", { line })));
    child.stderr.on("data", (chunk: Buffer) => streamLinesFromBuffer(stderr, chunk, (line) => {
      if (line.trim()) writeSseLine(reply, "error", { error: line });
    }));
    child.on("error", (error) => writeSseLine(reply, "error", { error: error.message }));
    child.on("close", (code) => {
      clearInterval(heartbeat);
      if (stdout.value) writeSseLine(reply, "message", { line: stdout.value });
      if (stderr.value.trim()) writeSseLine(reply, "error", { error: stderr.value });
      writeSseLine(reply, "end", { code: code ?? 0 });
      if (!reply.raw.destroyed) reply.raw.end();
    });
  });

  app.post("/api/files/write", { bodyLimit: 1024 * 1024, config: { rateLimit: agentFileRateLimit } }, async (request) => {
    const body = z.object({
      path: z.string().min(1).max(1024),
      content: z.string().max(512 * 1024)
    }).parse(request.body);
    const target = validateAgentFilePath(body.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body.content, { mode: 0o600 });
    return { ok: true, path: target };
  });

  app.get("/api/files/stat", { config: { rateLimit: agentFileRateLimit } }, async (request) => {
    const query = z.object({ path: z.string().min(1).max(1024) }).parse(request.query);
    const target = validateAgentFilePath(query.path);
    try {
      const info = await stat(target);
      return {
        exists: true,
        path: target,
        type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
        size: info.size
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, path: target };
      throw error;
    }
  });

  app.get("/api/files/read", { config: { rateLimit: agentFileRateLimit } }, async (request, reply) => {
    const query = z.object({ path: z.string().min(1).max(1024) }).parse(request.query);
    const target = validateAgentFilePath(query.path);
    const file = await open(target, "r");
    try {
      const info = await file.stat();
      if (info.size > 512 * 1024) {
        reply.code(413);
        return { error: "File is too large to read" };
      }
      return { path: target, content: await file.readFile("utf8") };
    } finally {
      await file.close();
    }
  });

  await app.listen({ host: env.AGENT_HOST, port: env.AGENT_PORT });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
