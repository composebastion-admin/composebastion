import { execFileSync } from "node:child_process";

const sentinel = {
  APP_SECRET: "compose-env-contract-secret-at-least-32-characters",
  POSTGRES_PASSWORD: "compose-env-contract-password",
  COMPOSEBASTION_BACKUP_DIR: "/tmp/composebastion-contract-backups",
  COMPOSEBASTION_VERSION: "1.0.6",
  CORS_ORIGINS: "https://console.contract.example",
  SECURE_COOKIES: "true",
  TRUST_PROXY: "2",
  ALLOW_PRIVATE_AGENT_URLS: "true",
  ALLOW_PRIVATE_WEBHOOK_URLS: "true",
  BLOCK_PRIVATE_S3_ENDPOINTS: "true",
  BACKUP_ENCRYPTION_KEYS: "contract-key:contract-secret-at-least-32-characters",
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: "contract-key",
  BACKUP_HOST_PATH_ALLOWED_ROOTS: "/srv,/home/docker",
  IMAGE_SCANNER_PROVIDER: "trivy",
  SMTP_HOST: "mail.contract.internal",
  SMTP_PORT: "2525",
  SMTP_USER: "contract-user",
  SMTP_PASS: "contract-password",
  SMTP_FROM: "alerts@contract.example",
  HOST_CHECK_INTERVAL_MS: "45000",
  INVENTORY_SYNC_INTERVAL_MS: "180000"
};

const appExpected = {
  CORS_ORIGINS: sentinel.CORS_ORIGINS,
  SECURE_COOKIES: sentinel.SECURE_COOKIES,
  TRUST_PROXY: sentinel.TRUST_PROXY,
  ALLOW_PRIVATE_AGENT_URLS: sentinel.ALLOW_PRIVATE_AGENT_URLS,
  ALLOW_PRIVATE_WEBHOOK_URLS: sentinel.ALLOW_PRIVATE_WEBHOOK_URLS,
  BLOCK_PRIVATE_S3_ENDPOINTS: sentinel.BLOCK_PRIVATE_S3_ENDPOINTS,
  BACKUP_ENCRYPTION_KEYS: sentinel.BACKUP_ENCRYPTION_KEYS,
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: sentinel.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
  BACKUP_HOST_PATH_ALLOWED_ROOTS: sentinel.BACKUP_HOST_PATH_ALLOWED_ROOTS,
  IMAGE_SCANNER_PROVIDER: sentinel.IMAGE_SCANNER_PROVIDER,
  SMTP_HOST: sentinel.SMTP_HOST,
  SMTP_PORT: sentinel.SMTP_PORT,
  SMTP_USER: sentinel.SMTP_USER,
  SMTP_PASS: sentinel.SMTP_PASS,
  SMTP_FROM: sentinel.SMTP_FROM
};

const workerExpected = {
  ALLOW_PRIVATE_WEBHOOK_URLS: sentinel.ALLOW_PRIVATE_WEBHOOK_URLS,
  BLOCK_PRIVATE_S3_ENDPOINTS: sentinel.BLOCK_PRIVATE_S3_ENDPOINTS,
  BACKUP_ENCRYPTION_KEYS: sentinel.BACKUP_ENCRYPTION_KEYS,
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: sentinel.BACKUP_ENCRYPTION_ACTIVE_KEY_ID,
  BACKUP_HOST_PATH_ALLOWED_ROOTS: sentinel.BACKUP_HOST_PATH_ALLOWED_ROOTS,
  IMAGE_SCANNER_PROVIDER: sentinel.IMAGE_SCANNER_PROVIDER,
  SMTP_HOST: sentinel.SMTP_HOST,
  SMTP_PORT: sentinel.SMTP_PORT,
  SMTP_USER: sentinel.SMTP_USER,
  SMTP_PASS: sentinel.SMTP_PASS,
  SMTP_FROM: sentinel.SMTP_FROM,
  HOST_CHECK_INTERVAL_MS: sentinel.HOST_CHECK_INTERVAL_MS,
  INVENTORY_SYNC_INTERVAL_MS: sentinel.INVENTORY_SYNC_INTERVAL_MS
};

function render(files) {
  const args = ["compose"];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json");
  const output = execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, ...sentinel },
    stdio: ["ignore", "pipe", "inherit"]
  });
  return JSON.parse(output);
}

function verifyEnvironment(label, service, expected) {
  const environment = service?.environment ?? {};
  const failures = Object.entries(expected)
    .filter(([key, value]) => String(environment[key] ?? "") !== value)
    .map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(environment[key])}`);
  if (failures.length > 0) {
    throw new Error(`${label} environment contract failed:\n${failures.join("\n")}`);
  }
}

for (const candidate of [
  { label: "published-image", files: ["docker-compose.image.yml"] },
  { label: "source-production", files: ["docker-compose.yml", "docker-compose.prod.example.yml"] }
]) {
  const config = render(candidate.files);
  verifyEnvironment(`${candidate.label} app`, config.services?.app, appExpected);
  verifyEnvironment(`${candidate.label} worker`, config.services?.worker, workerExpected);
}

console.log("Compose environment contracts passed for image and source production installs.");
