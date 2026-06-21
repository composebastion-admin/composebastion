import path from "node:path";
import { getHostForWorker } from "./hosts.js";
import { readAgentRemoteFile, writeAgentRemoteFile } from "./agent.js";
import { readRemoteFile, runSshCommand, writeRemoteFile } from "./ssh.js";
import { shQuote } from "./commands.js";

export const AGENT_STACK_ROOT = "/tmp/composebastion";

export function stackRemoteDirectory(stackId: string) {
  return path.posix.join(AGENT_STACK_ROOT, stackId);
}

export async function writeHostStackFiles(
  hostId: string,
  remoteDir: string,
  composeYaml: string,
  env: string,
  options: { composePath?: string; envPath?: string } = {}
) {
  const host = await getHostForWorker(hostId);
  const composePath = options.composePath ?? path.posix.join(remoteDir, "compose.yml");
  const envPath = options.envPath ?? path.posix.join(remoteDir, ".env");

  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    await writeAgentRemoteFile(host.agent, composePath, composeYaml);
    await writeAgentRemoteFile(host.agent, envPath, env);
    return { remoteDir, composePath, envPath };
  }

  const dirs = Array.from(new Set([remoteDir, path.posix.dirname(composePath), path.posix.dirname(envPath)]));
  await runSshCommand(host.ssh, `mkdir -p ${dirs.map(shQuote).join(" ")}`, { timeoutMs: 30_000 });
  await writeRemoteFile(host.ssh, composePath, composeYaml);
  await writeRemoteFile(host.ssh, envPath, env);
  return { remoteDir, composePath, envPath };
}

export async function readHostTextFileFromWorker(hostId: string, remotePath: string) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    return readAgentRemoteFile(host.agent, remotePath);
  }
  return readRemoteFile(host.ssh, remotePath);
}
