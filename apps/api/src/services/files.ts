import path from "node:path";
import { getHostForWorker } from "./hosts.js";
import { runSshCommand, readRemoteFile, writeRemoteFile } from "./ssh.js";
import { shQuote } from "./commands.js";
import { statAgentRemoteFile, writeAgentRemoteFile } from "./agent.js";
import { isDemoHost, listDemoDirectory, readDemoTextFile, statDemoPath, writeDemoTextFile } from "./demo.js";

export function normalizeRemotePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) throw new Error("Path contains invalid characters");
  if (!trimmed.startsWith("/")) throw new Error("Use an absolute Linux path, for example /home/user/app");
  return path.posix.normalize(trimmed);
}

export function parentRemotePath(value: string) {
  const normalized = normalizeRemotePath(value);
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "/" : parent;
}

export async function listHostDirectory(hostId: string, directory: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return listDemoDirectory(hostId, directory);
  if (host.connectionMode !== "ssh") throw new Error("Host file browsing currently requires SSH host mode.");
  const normalized = normalizeRemotePath(directory);
  const command = [
    `test -d ${shQuote(normalized)}`,
    `find ${shQuote(normalized)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\t%TY-%Tm-%Td %TH:%TM\\n' | sort -f`
  ].join(" && ");
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Failed to list directory");
  return {
    path: normalized,
    parent: normalized === "/" ? null : parentRemotePath(normalized),
    entries: result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name = "", kind = "", size = "0", modified = ""] = line.split("\t");
      return {
        name,
        path: path.posix.join(normalized, name),
        type: kind === "d" ? "directory" : kind === "l" ? "link" : "file",
        size: Number(size) || 0,
        modified
      };
    })
  };
}

export async function readHostTextFile(hostId: string, filePath: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return readDemoTextFile(hostId, filePath);
  if (host.connectionMode !== "ssh") throw new Error("Host file editing currently requires SSH host mode.");
  const normalized = normalizeRemotePath(filePath);
  const content = await readRemoteFile(host.ssh, normalized);
  return { path: normalized, content };
}

export async function statHostPath(hostId: string, filePath: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return statDemoPath(hostId, filePath);
  const normalized = normalizeRemotePath(filePath);
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    return statAgentRemoteFile(host.agent, normalized);
  }
  const command = [
    `if test -f ${shQuote(normalized)}; then printf 'file\\t%s\\n' "$(wc -c < ${shQuote(normalized)})";`,
    `elif test -d ${shQuote(normalized)}; then printf 'directory\\t0\\n';`,
    `elif test -e ${shQuote(normalized)}; then printf 'other\\t0\\n';`,
    "else printf 'missing\\t0\\n'; fi"
  ].join(" ");
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Failed to stat path");
  const [type = "missing", size = "0"] = result.stdout.trim().split("\t");
  return {
    path: normalized,
    exists: type !== "missing",
    type: type === "missing" ? null : type,
    size: type === "file" ? Number(size) || 0 : null
  };
}

export async function writeHostTextFile(hostId: string, filePath: string, content: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return writeDemoTextFile(hostId, filePath, content);
  const normalized = normalizeRemotePath(filePath);
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    await writeAgentRemoteFile(host.agent, normalized, content);
    return { path: normalized };
  }
  if (host.connectionMode !== "ssh") throw new Error("Host file editing currently requires SSH host mode.");
  await runSshCommand(host.ssh, `mkdir -p ${shQuote(parentRemotePath(normalized))}`, { timeoutMs: 30_000 });
  await writeRemoteFile(host.ssh, normalized, content);
  return { path: normalized };
}
