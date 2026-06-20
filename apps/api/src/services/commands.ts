import type { DockerActionRequest } from "@dockermender/shared";

export function shQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const DOCKER_SSH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin";

export function dockerEnvPrefix(socketPath = "/var/run/docker.sock") {
  return `PATH=${DOCKER_SSH_PATH}:$PATH DOCKER_HOST=${shQuote(`unix://${socketPath}`)}`;
}

export function withDockerEnv(command: string, socketPath?: string) {
  return `${dockerEnvPrefix(socketPath)} ${command}`;
}

export function dockerCommandFailureMessage(output: string, fallback: string) {
  const message = output.trim();
  if (/(\bdocker:\s+command not found\b|\bdocker:\s+not found\b|\bcommand not found:\s+docker\b)/i.test(message)) {
    return "Docker CLI was not found on the remote host. Install Docker, or make sure the docker command is available to non-interactive SSH sessions.";
  }
  if (/permission denied/i.test(message) && /(docker daemon socket|docker api|\/var\/run\/docker\.sock|unix:\/\/)/i.test(message)) {
    return "The SSH user cannot access the Docker socket. Add the user to the docker group, connect as a Docker-capable user, or use the Dockermender agent.";
  }
  return message || fallback;
}

function labelsToArgs(labels: Record<string, string>) {
  return Object.entries(labels).map(([key, value]) => `--label ${shQuote(`${key}=${value}`)}`);
}

export function buildDockerActionCommand(action: DockerActionRequest) {
  switch (action.type) {
    case "container.run": {
      const args = ["docker run -d"];
      if (action.payload.name) args.push("--name", shQuote(action.payload.name));
      if (action.payload.restartPolicy !== "no") args.push("--restart", shQuote(action.payload.restartPolicy));
      if (action.payload.network) args.push("--network", shQuote(action.payload.network));
      for (const item of action.payload.env) args.push("--env", shQuote(`${item.key}=${item.value}`));
      for (const port of action.payload.ports) args.push("--publish", shQuote(`${port.hostPort}:${port.containerPort}/${port.protocol}`));
      for (const mount of action.payload.volumes) {
        args.push("--volume", shQuote(`${mount.volumeName}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`));
      }
      args.push(shQuote(action.payload.image));
      if (action.payload.command) args.push("sh", "-lc", shQuote(action.payload.command));
      return args.join(" ");
    }
    case "container.start":
      return `docker start ${shQuote(action.payload.containerId)}`;
    case "container.stop": {
      const timeout = action.payload.timeoutSeconds ? `--time ${action.payload.timeoutSeconds}` : "";
      return `docker stop ${timeout} ${shQuote(action.payload.containerId)}`.trim();
    }
    case "container.restart": {
      const timeout = action.payload.timeoutSeconds ? `--time ${action.payload.timeoutSeconds}` : "";
      return `docker restart ${timeout} ${shQuote(action.payload.containerId)}`.trim();
    }
    case "container.rename":
      return `docker rename ${shQuote(action.payload.containerId)} ${shQuote(action.payload.name)}`;
    case "container.remove": {
      const args = ["docker rm"];
      if (action.payload.force) args.push("--force");
      if (action.payload.removeVolumes) args.push("--volumes");
      args.push(shQuote(action.payload.containerId));
      return args.join(" ");
    }
    case "image.pull":
      return `docker pull ${shQuote(action.payload.image)}`;
    case "image.remove": {
      const force = action.payload.force ? "--force " : "";
      return `docker image rm ${force}${shQuote(action.payload.imageId)}`;
    }
    case "image.prune":
      return `docker image prune --force${action.payload.all ? " --all" : ""}`;
    case "network.create": {
      if (action.payload.driver === "host" || action.payload.driver === "none") {
        throw new Error(`${action.payload.driver} is a built-in Docker network type and cannot be created as a custom network.`);
      }
      const args = ["docker network create", "--driver", shQuote(action.payload.driver)];
      if (action.payload.subnet) args.push("--subnet", shQuote(action.payload.subnet));
      if (action.payload.gateway) args.push("--gateway", shQuote(action.payload.gateway));
      if (action.payload.attachable) args.push("--attachable");
      if (action.payload.internal) args.push("--internal");
      args.push(...labelsToArgs(action.payload.labels));
      args.push(shQuote(action.payload.name));
      return args.join(" ");
    }
    case "network.remove":
      return `docker network rm ${shQuote(action.payload.networkId)}`;
    case "network.prune":
      return "docker network prune --force";
    case "volume.create": {
      const args = ["docker volume create", ...labelsToArgs(action.payload.labels), shQuote(action.payload.name)];
      return args.join(" ");
    }
    case "volume.remove": {
      const force = action.payload.force ? "--force " : "";
      return `docker volume rm ${force}${shQuote(action.payload.volumeName)}`;
    }
    case "volume.prune":
      return "docker volume prune --force";
    default:
      throw new Error(`Action ${action.type} does not map to a single Docker CLI command.`);
  }
}

export function buildComposeCommand(projectName: string, remoteComposePath: string, action: "up" | "stop" | "down" | "pull", removeVolumes = false) {
  const base = `docker compose -p ${shQuote(projectName)} -f ${shQuote(remoteComposePath)}`;
  if (action === "pull") return `${base} pull`;
  if (action === "up") return `${base} up -d --remove-orphans --force-recreate`;
  if (action === "stop") return `${base} stop`;
  return `${base} down --remove-orphans${removeVolumes ? " --volumes" : ""}`;
}

export const inventoryCommands = {
  containers: "docker ps --all --size --no-trunc --format '{{json .}}'",
  images: "docker image ls --all --no-trunc --digests --format '{{json .}}'",
  networks: "docker network ls --no-trunc --format '{{json .}}'",
  volumes: "docker volume ls --format '{{json .}}'"
} as const;
