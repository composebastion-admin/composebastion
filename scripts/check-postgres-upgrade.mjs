import { execFileSync, spawnSync } from "node:child_process";
const postgresImage = "postgres:16.6-alpine3.20@sha256:1e59919c179e296eaf3cc701f4d50bab5c393d7ed9746c188c9d519489c998dc";
const suffix = `${process.pid}-${Date.now()}`;
const container = `composebastion-postgres-upgrade-${suffix}`;
const network = `${container}-network`;
const volume = `${container}-data`;
const database = "composebastion";
const user = "composebastion";
const legacyPassword = "legacy-composebastion-password";
const replacementPassword = "replacement-composebastion-password";

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

try {
  docker(["network", "create", network]);
  docker(["volume", "create", volume]);
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

  console.log("Existing PostgreSQL volumes retain connectivity through the DATABASE_URL compatibility override.");
} finally {
  removeContainer();
  spawnSync("docker", ["volume", "rm", "-f", volume], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
}
