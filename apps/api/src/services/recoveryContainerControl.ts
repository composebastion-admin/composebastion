import { shQuote, withDockerEnv } from "./commands.js";
import { isDemoHost } from "./demo.js";
import { getHostForWorker } from "./hosts.js";
import { runSshCommand } from "./ssh.js";

export type SshCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ContainerStopError = Error & {
  stoppedIds?: string[];
  restartFailedIds?: string[];
};

type ContainerRestartError = Error & {
  restartFailedIds: string[];
};

async function runHostDockerCommand(hostId: string, command: string, timeoutMs = 5 * 60_000): Promise<SshCommandResult> {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return { code: 0, stdout: "", stderr: "" };
  }
  const wrapped = withDockerEnv(command, host.public.dockerSocketPath);
  const result = await runSshCommand(host.ssh, wrapped, { timeoutMs });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

export async function stopContainersOneByOne(hostId: string, containerIds: string[]) {
  const stoppedIds: string[] = [];
  for (const containerId of containerIds) {
    let result: SshCommandResult;
    try {
      result = await runHostDockerCommand(hostId, `docker stop ${shQuote(containerId)}`);
    } catch (cause) {
      const error = new Error(
        cause instanceof Error ? cause.message : String(cause),
        { cause }
      ) as ContainerStopError;
      // A transport failure makes the current command outcome ambiguous.
      // Restarting an already-running container is idempotent, so include it.
      error.stoppedIds = [...stoppedIds, containerId];
      throw error;
    }
    if (result.code !== 0) {
      const error = new Error(
        result.stderr || result.stdout || `Failed to stop container ${containerId}`
      ) as ContainerStopError;
      error.stoppedIds = [...stoppedIds];
      throw error;
    }
    stoppedIds.push(containerId);
  }
  return stoppedIds;
}

export async function startContainersOneByOne(hostId: string, containerIds: string[]) {
  const failures: Array<{ id: string; message: string }> = [];
  for (const containerId of containerIds) {
    try {
      const result = await runHostDockerCommand(hostId, `docker start ${shQuote(containerId)}`);
      if (result.code !== 0) {
        failures.push({
          id: containerId,
          message: result.stderr || result.stdout || `Failed to start container ${containerId}`
        });
      }
    } catch (error) {
      failures.push({
        id: containerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (failures.length) {
    const error = new Error(
      `Failed to restart container${failures.length === 1 ? "" : "s"}: `
        + failures.map(({ id, message }) => `${id} (${message})`).join("; ")
    ) as ContainerRestartError;
    error.restartFailedIds = failures.map(({ id }) => id);
    throw error;
  }
}

export async function stopContainersWithRestartOnFailure(
  hostId: string,
  containerIds: string[],
  restartIds: string[]
) {
  try {
    return await stopContainersOneByOne(hostId, containerIds);
  } catch (error) {
    const stoppedIds = (error as ContainerStopError).stoppedIds ?? [];
    const toRestart = restartIds.filter((id) => stoppedIds.includes(id));
    if (toRestart.length) {
      try {
        await startContainersOneByOne(hostId, toRestart);
      } catch (restartError) {
        const stopMessage = error instanceof Error ? error.message : String(error);
        const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
        const combined = new Error(
          `${stopMessage}; ${restartMessage}`
        ) as ContainerStopError;
        combined.stoppedIds = stoppedIds;
        combined.restartFailedIds =
          (restartError as Partial<ContainerRestartError>).restartFailedIds ?? toRestart;
        throw combined;
      }
    }
    throw error;
  }
}
