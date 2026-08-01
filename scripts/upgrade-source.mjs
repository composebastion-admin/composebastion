import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const dockerBin = process.env.COMPOSEBASTION_SOURCE_UPGRADE_DOCKER_BIN || "docker";
if (dockerBin !== "docker" && !path.isAbsolute(dockerBin)) {
  throw new Error("COMPOSEBASTION_SOURCE_UPGRADE_DOCKER_BIN must be docker or an absolute path");
}

function parseFiles(argv) {
  const files = [];
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--file" || argument === "-f") {
      const file = args.shift();
      if (!file) throw new Error(`${argument} requires a Compose file`);
      files.push(file);
      continue;
    }
    throw new Error(`Unknown source-upgrade argument: ${argument}`);
  }
  return files.length > 0 ? files : ["docker-compose.yml", "docker-compose.prod.example.yml"];
}

const composeFiles = parseFiles(process.argv.slice(2));
const composePrefix = composeFiles.flatMap((file) => ["-f", file]);

function docker(args, { capture = false, composeOverride = null } = {}) {
  const command = args[0] === "compose"
    ? ["compose", ...composePrefix, ...(composeOverride ? ["-f", composeOverride] : []), ...args.slice(1)]
    : args;
  const output = execFileSync(dockerBin, command, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  return typeof output === "string" ? output.trim() : "";
}

function containerId(service) {
  return docker(["compose", "ps", "-q", service], { capture: true }).split(/\r?\n/)[0]?.trim() || "";
}

function inspect(container, format) {
  return docker(["inspect", "--format", format, container], { capture: true });
}

function runningIdentity(service) {
  const id = containerId(service);
  if (!id) throw new Error(`Source upgrade requires a running ${service} container`);
  const imageId = inspect(id, "{{.Image}}");
  const version = inspect(id, '{{ index .Config.Labels "org.opencontainers.image.version" }}');
  const revision = inspect(id, '{{ index .Config.Labels "org.opencontainers.image.revision" }}');
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId) || !version || version === "unknown") {
    throw new Error(`Running ${service} container does not have a rollback-safe image identity`);
  }
  return { id, imageId, version, revision };
}

async function waitForStack(expectedVersion, expectedAppImage = null, expectedWorkerImage = null) {
  const attempts = Number(process.env.COMPOSEBASTION_SOURCE_UPGRADE_VERIFY_ATTEMPTS ?? "60");
  const intervalMs = Number(process.env.COMPOSEBASTION_SOURCE_UPGRADE_VERIFY_INTERVAL_MS ?? "2000");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 600) {
    throw new Error("COMPOSEBASTION_SOURCE_UPGRADE_VERIFY_ATTEMPTS must be between 1 and 600");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
    throw new Error("COMPOSEBASTION_SOURCE_UPGRADE_VERIFY_INTERVAL_MS must be between 0 and 60000");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const appId = containerId("app");
      const workerId = containerId("worker");
      if (appId && workerId
          && inspect(appId, "{{.State.Running}}") === "true"
          && inspect(appId, "{{.State.Health.Status}}") === "healthy"
          && inspect(workerId, "{{.State.Running}}") === "true"
          && inspect(appId, '{{ index .Config.Labels "org.opencontainers.image.version" }}').replace(/^v/, "") === expectedVersion.replace(/^v/, "")
          && inspect(workerId, '{{ index .Config.Labels "org.opencontainers.image.version" }}').replace(/^v/, "") === expectedVersion.replace(/^v/, "")
          && (!expectedAppImage || inspect(appId, "{{.Image}}") === expectedAppImage)
          && (!expectedWorkerImage || inspect(workerId, "{{.Image}}") === expectedWorkerImage)) {
        docker([
          "compose", "exec", "-T", "app", "node", "-e",
          "fetch('http://127.0.0.1:8080/api/health/ready').then(async r=>{const b=await r.json();if(!r.ok||!b.ok||!b.checks?.worker?.ok)process.exit(1)}).catch(()=>process.exit(1))"
        ], { capture: true });
        return;
      }
    } catch {
      // The stack can be transiently unavailable while containers restart.
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`ComposeBastion ${expectedVersion} did not become ready`);
}

function preparationArgs(stateDirectory, mode) {
  return [
    "compose", "run", "--rm", "--no-deps", "--user", "0:0",
    "--volume", `${stateDirectory}:/run/composebastion-upgrade`,
    "app", "node", "/app/scripts/prepare-compose-upgrade.mjs", mode,
    "--compose-config", "/run/composebastion-upgrade/compose-config.json",
    "--state-file", "/run/composebastion-upgrade/database-transition.json"
  ];
}

const previousApp = runningIdentity("app");
const previousWorker = runningIdentity("worker");
const stateDirectory = path.join(root, `.composebastion-source-upgrade-${randomUUID()}`);
const configPath = path.join(stateDirectory, "compose-config.json");
const rollbackPath = path.join(stateDirectory, "rollback.yml");
let servicesTouched = false;
let rollbackSucceeded = false;

try {
  await mkdir(stateDirectory, { mode: 0o700 });
  console.info(`Building ComposeBastion ${candidateVersion} from the current source checkout.`);
  docker(["compose", "build", "app", "worker"]);
  const renderedConfig = docker(["compose", "config", "--format", "json"], { capture: true });
  const candidateServices = JSON.parse(renderedConfig).services;
  const candidateAppReference = candidateServices?.app?.image;
  const candidateWorkerReference = candidateServices?.worker?.image;
  if (!candidateAppReference || !candidateWorkerReference) {
    throw new Error("Rendered candidate Compose configuration is missing app or worker images");
  }
  const candidateAppImage = docker(["image", "inspect", "--format", "{{.Id}}", candidateAppReference], { capture: true });
  const candidateWorkerImage = docker(["image", "inspect", "--format", "{{.Id}}", candidateWorkerReference], { capture: true });
  if (!/^sha256:[a-f0-9]{64}$/i.test(candidateAppImage)
      || !/^sha256:[a-f0-9]{64}$/i.test(candidateWorkerImage)) {
    throw new Error("Built candidate app or worker image identity is invalid");
  }
  await writeFile(configPath, `${renderedConfig}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);

  servicesTouched = true;
  docker(["compose", "stop", "app", "worker"]);
  docker(preparationArgs(stateDirectory, "reconcile"));
  docker(["compose", "up", "-d", "--no-deps", "--force-recreate", "app", "worker"]);
  await waitForStack(candidateVersion, candidateAppImage, candidateWorkerImage);
  await rm(stateDirectory, { recursive: true, force: true });
  console.info(`Source upgrade to ${candidateVersion} completed successfully.`);
} catch (error) {
  if (servicesTouched) {
    try {
      docker(["compose", "stop", "app", "worker"]);
    } catch {
      // Continue into credential and image rollback.
    }
    try {
      try {
        await access(path.join(stateDirectory, "database-transition.json"));
        docker(preparationArgs(stateDirectory, "restore-legacy"));
      } catch (stateError) {
        if (!(stateError instanceof Error && "code" in stateError && stateError.code === "ENOENT")) throw stateError;
      }
      await writeFile(rollbackPath, [
        "services:",
        "  app:",
        `    image: ${previousApp.imageId}`,
        "    pull_policy: never",
        "  worker:",
        `    image: ${previousWorker.imageId}`,
        "    pull_policy: never",
        ""
      ].join("\n"), { mode: 0o600 });
      docker(
        ["compose", "up", "-d", "--pull", "never", "--no-deps", "--force-recreate", "app", "worker"],
        { composeOverride: rollbackPath }
      );
      await waitForStack(previousApp.version, previousApp.imageId, previousWorker.imageId);
      rollbackSucceeded = true;
      await rm(stateDirectory, { recursive: true, force: true });
    } catch (rollbackError) {
      console.error(`Automatic source rollback failed: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`);
    }
  } else {
    rollbackSucceeded = true;
    await rm(stateDirectory, { recursive: true, force: true });
  }

  const previousRevision = /^[a-f0-9]{40}$/i.test(previousApp.revision)
    ? `git switch --detach ${previousApp.revision}`
    : "restore the previous source revision from version control";
  const recovery = rollbackSucceeded
    ? `Prior containers are healthy. To restore the matching checkout, run: ${previousRevision}`
    : `Recovery state was retained at ${stateDirectory}. Do not delete it; restore the recorded credential and prior images before retrying.`;
  throw new Error(`Source upgrade failed: ${error instanceof Error ? error.message : error}. ${recovery}`);
}
