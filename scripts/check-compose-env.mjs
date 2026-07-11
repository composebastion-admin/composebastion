import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  appOnlyEnvironment,
  composeSentinels,
  documentedComposeVariables,
  documentedRuntimeOnlyVariables,
  sentinelEnvironmentServices,
  sharedServiceEnvironment,
  workerOnlyEnvironment
} from "./compose-env-contract.mjs";

function render(files, { unset = [] } = {}) {
  // Never let a developer's ignored .env satisfy or override this contract.
  const args = ["compose", "--env-file", "/dev/null"];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json");
  const env = { ...process.env, ...composeSentinels };
  for (const key of unset) delete env[key];
  return JSON.parse(execFileSync("docker", args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"]
  }));
}

function fail(label, failures) {
  if (failures.length > 0) throw new Error(`${label} contract failed:\n${failures.join("\n")}`);
}

function verifyUniqueSentinels() {
  const ownerByValue = new Map();
  const failures = [];
  for (const [key, value] of Object.entries(composeSentinels)) {
    const previous = ownerByValue.get(value);
    if (previous) failures.push(`${previous} and ${key} share ${JSON.stringify(value)}`);
    ownerByValue.set(value, key);
  }
  const sentinelKeys = Object.keys(composeSentinels).sort();
  const routedKeys = Object.keys(sentinelEnvironmentServices).sort();
  if (JSON.stringify(sentinelKeys) !== JSON.stringify(routedKeys)) {
    failures.push("sentinelEnvironmentServices must classify every Compose sentinel exactly once");
  }
  fail("Compose sentinel uniqueness", failures);
}

function verifyEnvironment(label, serviceName, service, required, forbidden) {
  const environment = service?.environment ?? {};
  const failures = [];
  for (const key of required) {
    const expected = composeSentinels[key];
    if (String(environment[key] ?? "") !== expected) {
      failures.push(`${serviceName}.${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(environment[key])}`);
    }
  }
  for (const key of forbidden) {
    if (Object.hasOwn(environment, key)) failures.push(`${serviceName}.${key}: must not be routed to this service`);
  }
  const databaseUrl = String(environment.DATABASE_URL ?? "");
  if (!databaseUrl.includes(encodeURIComponent(composeSentinels.POSTGRES_PASSWORD)) && !databaseUrl.includes(composeSentinels.POSTGRES_PASSWORD)) {
    failures.push(`${serviceName}.DATABASE_URL: POSTGRES_PASSWORD sentinel was not interpolated`);
  }
  fail(label, failures);
}

function sentinelEnvironmentLeakage(config) {
  const failures = [];
  for (const [serviceName, service] of Object.entries(config.services ?? {})) {
    for (const [environmentKey, rawValue] of Object.entries(service?.environment ?? {})) {
      const value = String(rawValue ?? "");
      for (const [sentinelName, allowedServices] of Object.entries(sentinelEnvironmentServices)) {
        const sentinel = composeSentinels[sentinelName];
        const containsSentinel = sentinelName === "POSTGRES_PASSWORD"
          ? value.includes(sentinel)
          : value === sentinel;
        if (!containsSentinel) continue;
        if (!allowedServices.includes(serviceName)) {
          failures.push(`${serviceName}.${environmentKey}: contains ${sentinelName} outside allowed services ${allowedServices.join(", ") || "(none)"}`);
        }
      }
    }
  }
  return failures;
}

function verifyNoSentinelEnvironmentLeakage(label, config) {
  fail(`${label} wrong-service leakage`, sentinelEnvironmentLeakage(config));
}

function verifyLeakageDetector() {
  const proof = sentinelEnvironmentLeakage({
    services: {
      redis: { environment: { LEAKED_SMTP_SECRET: composeSentinels.SMTP_PASS } },
      app: { environment: { LEAKED_AGENT_TOKEN: composeSentinels.AGENT_TOKEN } },
      "composebastion-agent": { environment: { LEAKED_APP_SECRET: composeSentinels.APP_SECRET } }
    }
  });
  fail("Compose wrong-service leakage detector self-test", proof.length === 3
    ? []
    : [`expected three synthetic leaks to be rejected, got ${proof.length}`]);
}

function publishedPort(service, target) {
  return (service?.ports ?? []).find((port) => Number(port.target) === target);
}

function verifyManager(label, config, expectPublishedPort, expectedImage = null) {
  const app = config.services?.app;
  const worker = config.services?.worker;
  verifyEnvironment(`${label} app`, "app", app, [...sharedServiceEnvironment, ...appOnlyEnvironment], workerOnlyEnvironment);
  verifyEnvironment(`${label} worker`, "worker", worker, [...sharedServiceEnvironment, ...workerOnlyEnvironment], appOnlyEnvironment);
  verifyNoSentinelEnvironmentLeakage(label, config);

  const failures = [];
  const postgresPassword = config.services?.postgres?.environment?.POSTGRES_PASSWORD;
  if (String(postgresPassword ?? "") !== composeSentinels.POSTGRES_PASSWORD) {
    failures.push(`postgres.POSTGRES_PASSWORD: expected ${JSON.stringify(composeSentinels.POSTGRES_PASSWORD)}, got ${JSON.stringify(postgresPassword)}`);
  }
  for (const [serviceName, service] of [["app", app], ["worker", worker]]) {
    const mount = (service?.volumes ?? []).find((volume) => volume.target === "/data/backups");
    if (mount?.source !== composeSentinels.COMPOSEBASTION_BACKUP_DIR) {
      failures.push(`${serviceName} backup mount: expected ${composeSentinels.COMPOSEBASTION_BACKUP_DIR}, got ${mount?.source ?? "missing"}`);
    }
    if (expectedImage) {
      if (service?.image !== expectedImage) failures.push(`${serviceName}.image: expected ${expectedImage}, got ${service?.image ?? "missing"}`);
    } else {
      if (service?.image) failures.push(`${serviceName}.image: source production must remain build-based`);
      if (!service?.build) failures.push(`${serviceName}.build: source production build configuration is missing`);
    }
    const redisDependency = service?.depends_on?.redis;
    if (redisDependency?.condition !== "service_started") {
      failures.push(`${serviceName}.depends_on.redis: expected service_started, got ${redisDependency?.condition ?? "missing"}`);
    }
    if (redisDependency?.required !== false) {
      failures.push(`${serviceName}.depends_on.redis.required: Redis must remain an optional wake-up optimization`);
    }
  }
  const port = publishedPort(app, 8080);
  if (expectPublishedPort) {
    if (String(port?.published ?? "") !== composeSentinels.COMPOSEBASTION_HTTP_PORT) failures.push("app HTTP published port is not routed correctly");
    if (String(port?.host_ip ?? "") !== composeSentinels.COMPOSEBASTION_HTTP_BIND_ADDRESS) failures.push("app HTTP bind address is not routed correctly");
  } else if (port) {
    failures.push("source production app must not publish its HTTP port");
  }
  fail(label, failures);
}

function verifySecureCookieDefault(label, files) {
  const config = render(files, { unset: ["SECURE_COOKIES"] });
  const actual = String(config.services?.app?.environment?.SECURE_COOKIES ?? "");
  fail(label, actual === "true" ? [] : [`app.SECURE_COOKIES: expected production default "true", got ${JSON.stringify(actual)}`]);
}

function verifyAgent(label, file, expectedImage = null) {
  const config = render([file]);
  verifyNoSentinelEnvironmentLeakage(label, config);
  const agent = config.services?.["composebastion-agent"];
  const port = publishedPort(agent, 8090);
  const failures = [];
  if (agent?.environment?.AGENT_TOKEN !== composeSentinels.AGENT_TOKEN) failures.push("AGENT_TOKEN is not routed to the agent");
  if (agent?.environment?.AGENT_HOST !== "0.0.0.0") failures.push("AGENT_HOST must listen inside the container");
  if (String(port?.published ?? "") !== composeSentinels.COMPOSEBASTION_AGENT_PORT) failures.push("agent published port is not routed correctly");
  if (String(port?.host_ip ?? "") !== composeSentinels.COMPOSEBASTION_AGENT_BIND_ADDRESS) failures.push("agent bind address is not routed correctly");
  if (!agent?.healthcheck?.test) failures.push("agent authenticated healthcheck is missing");
  if (expectedImage) {
    if (agent?.image !== expectedImage) failures.push(`agent.image: expected ${expectedImage}, got ${agent?.image ?? "missing"}`);
  } else {
    if (agent?.image) failures.push("agent.image: source agent must remain build-based");
    if (!agent?.build) failures.push("agent.build: source agent build configuration is missing");
  }
  fail(label, failures);
}

function verifyDocumentedVariables() {
  const declared = new Set(
    readFileSync(".env.example", "utf8")
      .split(/\r?\n/)
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter(Boolean)
  );
  const classified = new Set([...documentedComposeVariables, ...documentedRuntimeOnlyVariables]);
  const failures = [
    ...[...classified].filter((key) => !declared.has(key)).map((key) => `${key}: classified but missing`),
    ...[...declared].filter((key) => !classified.has(key)).map((key) => `${key}: documented but not classified by the Compose contract`)
  ];
  fail(".env.example", failures);
}

verifyUniqueSentinels();
verifyLeakageDetector();
verifyDocumentedVariables();
const managerImage = `${composeSentinels.COMPOSEBASTION_IMAGE}:${composeSentinels.COMPOSEBASTION_VERSION}`;
const agentImage = `${composeSentinels.COMPOSEBASTION_AGENT_IMAGE}:${composeSentinels.COMPOSEBASTION_AGENT_VERSION}`;
verifyManager("published-image", render(["docker-compose.image.yml"]), true, managerImage);
verifyManager("source-production", render(["docker-compose.yml", "docker-compose.prod.example.yml"]), false);
verifySecureCookieDefault("published-image secure-cookie default", ["docker-compose.image.yml"]);
verifySecureCookieDefault("source-production secure-cookie default", ["docker-compose.yml", "docker-compose.prod.example.yml"]);
verifyAgent("source-agent", "agent-compose.example.yml");
verifyAgent("published-agent", "agent-compose.image.example.yml", agentImage);

console.log("Compose environment contracts passed for manager and agent production installs.");
