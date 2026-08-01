import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const postgresImage = "postgres:16.6-alpine3.20@sha256:1e59919c179e296eaf3cc701f4d50bab5c393d7ed9746c188c9d519489c998dc";
const nodeImage = "node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a";
const alpineImage = "alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suffix = `${process.pid}-${Date.now()}`;
const container = `composebastion-postgres-upgrade-${suffix}`;
const network = `${container}-network`;
const volume = `${container}-data`;
const backupVolume = `${container}-backups`;
const externalVolume = `${container}-external`;
const database = "composebastion";
const user = "composebastion";
const legacyPassword = "composebastion";
const replacementPassword = "replacement-composebastion-password";
const transitionDirectory = mkdtempSync(path.join(os.tmpdir(), "composebastion-postgres-transition-"));
const composeConfigPath = path.join(transitionDirectory, "compose-config.json");
const transitionStatePath = path.join(transitionDirectory, "database-transition.json");

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env
  });
}

function removeContainer() {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
}

function startPostgres(password) {
  docker([
    "run", "-d",
    "--name", container,
    "--network", network,
    "--network-alias", "postgres",
    "--env", `POSTGRES_DB=${database}`,
    "--env", `POSTGRES_USER=${user}`,
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--volume", `${volume}:/var/lib/postgresql/data`,
    postgresImage
  ]);
}

async function waitForPostgres() {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const ready = spawnSync("docker", ["exec", container, "psql", "-U", user, "-d", database, "-c", "select 1"], {
      stdio: "ignore"
    });
    if (ready.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = docker(["logs", container]);
  throw new Error(`PostgreSQL did not become ready:\n${logs}`);
}

function renderCompose(files, databaseUrl) {
  const args = ["compose", "--env-file", "/dev/null"];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json");
  return JSON.parse(docker(args, {
    env: {
      ...process.env,
      APP_SECRET: "postgres-upgrade-contract-app-secret-0123456789abcdef",
      POSTGRES_PASSWORD: replacementPassword,
      DATABASE_URL: databaseUrl,
      COMPOSEBASTION_BACKUP_DIR: "/tmp/composebastion-postgres-upgrade-backups",
      COMPOSEBASTION_IMAGE: "registry.contract.example/composebastion/manager",
      COMPOSEBASTION_VERSION: "1.1.1-upgrade-contract",
      COMPOSEBASTION_HTTP_PORT: "18881",
      COMPOSEBASTION_HTTP_BIND_ADDRESS: "127.0.0.7"
    }
  }));
}

function query(password) {
  return spawnSync("docker", [
    "run", "--rm",
    "--network", network,
    "--env", `PGPASSWORD=${password}`,
    postgresImage,
    "psql",
    "--no-psqlrc",
    "--set", "VERBOSITY=verbose",
    "--host", "postgres",
    "--username", user,
    "--dbname", database,
    "--tuples-only",
    "--no-align",
    "--command", "select current_user, current_database()"
  ], { encoding: "utf8" });
}

function assertLegacyConnectivity() {
  const result = query(legacyPassword);
  if (result.status !== 0) {
    throw new Error(`Legacy PostgreSQL credentials were rejected:\n${String(result.stderr).trim()}`);
  }
  const identity = String(result.stdout).trim();
  if (identity !== `${user}|${database}`) {
    throw new Error(`Unexpected PostgreSQL identity: ${JSON.stringify(identity)}`);
  }
}

function runCompatibilityPreparation(mode) {
  docker([
    "run", "--rm", "--user", "0:0",
    "--network", network,
    "--volume", `${root}:/workspace:ro`,
    "--volume", `${transitionDirectory}:/transition`,
    "--volume", `${backupVolume}:/data/backups`,
    "--volume", `${externalVolume}:/outside`,
    "--workdir", "/workspace",
    nodeImage,
    "node", "scripts/prepare-compose-upgrade.mjs", mode,
    "--compose-config", "/transition/compose-config.json",
    "--state-file", "/transition/database-transition.json"
  ]);
}

try {
  docker(["network", "create", network]);
  docker(["volume", "create", volume]);
  docker(["volume", "create", backupVolume]);
  docker(["volume", "create", externalVolume]);
  startPostgres(legacyPassword);
  await waitForPostgres();

  // Recreating the container with a new POSTGRES_PASSWORD does not change the
  // role password stored in an existing PostgreSQL data volume.
  removeContainer();
  startPostgres(replacementPassword);
  await waitForPostgres();

  const internalLegacyUrl = `postgres://${user}:${legacyPassword}@postgres:5432/${database}`;

  const replacementResult = query(replacementPassword);
  if (replacementResult.status === 0) {
    throw new Error("The fixture did not preserve its legacy role password across container recreation");
  }

  const variants = [
    ["published-image", ["docker-compose.image.yml"]],
    ["published-image hardening", ["docker-compose.image.yml", "docker-compose.hardened.yml"]],
    ["source-production", ["docker-compose.yml", "docker-compose.prod.example.yml"]],
    ["source-production hardening", ["docker-compose.yml", "docker-compose.prod.example.yml", "docker-compose.hardened.yml"]]
  ];
  for (const [label, files] of variants) {
    const config = renderCompose(files, internalLegacyUrl);
    for (const serviceName of ["app", "worker"]) {
      const actual = config.services?.[serviceName]?.environment?.DATABASE_URL;
      if (actual !== internalLegacyUrl) {
        throw new Error(`${label} ${serviceName} did not preserve the legacy DATABASE_URL: ${JSON.stringify(actual)}`);
      }
      assertLegacyConnectivity();
    }
  }

  writeFileSync(composeConfigPath, `${JSON.stringify({
    services: {
      app: {
        user: "1000:1000",
        environment: { DATABASE_URL: internalLegacyUrl }
      },
      worker: {
        environment: { DATABASE_URL: internalLegacyUrl }
      },
      postgres: {
        environment: { POSTGRES_PASSWORD: replacementPassword }
      }
    }
  })}\n`, { mode: 0o600 });
  chmodSync(composeConfigPath, 0o600);
  docker([
    "run", "--rm",
    "--volume", `${backupVolume}:/data/backups`,
    "--volume", `${externalVolume}:/outside`,
    alpineImage,
    "sh", "-ceu",
    "mkdir -p /data/backups/recovery/nested; echo retained >/data/backups/recovery/nested/root-owned; chown -R 0:0 /data/backups; echo external >/outside/target; chown 123:456 /outside/target; ln -s /outside/target /data/backups/.composebastion-storage-owner"
  ]);

  runCompatibilityPreparation("reconcile");
  if (query(replacementPassword).status !== 0 || query(legacyPassword).status === 0) {
    throw new Error("Candidate compatibility entrypoint did not rotate and verify the exact managed legacy credential");
  }
  // A retry after rotation must retain the changed-state receipt so rollback
  // remains authorized after an interrupted updater.
  runCompatibilityPreparation("reconcile");
  runCompatibilityPreparation("restore-legacy");
  assertLegacyConnectivity();
  // Reverse rotation is idempotent and verifies the already-restored state.
  runCompatibilityPreparation("restore-legacy");

  const backupEvidence = docker([
    "run", "--rm",
    "--volume", `${backupVolume}:/data/backups:ro`,
    "--volume", `${externalVolume}:/outside:ro`,
    alpineImage,
    "sh", "-ceu",
    "test \"$(stat -c %u:%g /data/backups/recovery/nested/root-owned)\" = 1000:1000; test -L /data/backups/.composebastion-storage-owner; test \"$(stat -c %u:%g /outside/target)\" = 123:456; test \"$(cat /outside/target)\" = external; printf safe"
  ]).trim();
  if (backupEvidence !== "safe") {
    throw new Error("Recursive backup ownership compatibility evidence is incomplete");
  }

  console.log("Existing PostgreSQL volumes, credential rollback, and recursive storage preparation passed.");
} finally {
  removeContainer();
  spawnSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" });
  spawnSync("docker", ["volume", "rm", "-f", backupVolume], { stdio: "ignore" });
  spawnSync("docker", ["volume", "rm", "-f", externalVolume], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  rmSync(transitionDirectory, { recursive: true, force: true });
}
