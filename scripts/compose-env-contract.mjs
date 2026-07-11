import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const candidateVersion = require("../package.json").version;

export const composeSentinels = Object.freeze({
  APP_SECRET: "compose-contract-app-secret-0123456789abcdef",
  POSTGRES_PASSWORD: "compose-contract-postgres-password",
  REDIS_URL: "redis://contract-redis.internal:6380",
  COMPOSEBASTION_BACKUP_DIR: "/tmp/compose-contract-backups",
  COMPOSEBASTION_IMAGE: "registry.contract.example/composebastion/manager",
  COMPOSEBASTION_VERSION: `${candidateVersion}-manager-contract`,
  COMPOSEBASTION_HTTP_PORT: "18881",
  COMPOSEBASTION_HTTP_BIND_ADDRESS: "127.0.0.7",
  COMPOSEBASTION_UID: "12345",
  COMPOSEBASTION_GID: "23456",
  COMPOSEBASTION_AGENT_IMAGE: "registry.contract.example/composebastion/agent",
  COMPOSEBASTION_AGENT_VERSION: `${candidateVersion}-agent-contract`,
  COMPOSEBASTION_AGENT_PORT: "18891",
  COMPOSEBASTION_AGENT_BIND_ADDRESS: "127.0.0.9",
  AGENT_TOKEN: "compose-contract-agent-token-0123456789abcdef",
  CORS_ORIGINS: "https://console.contract.example",
  // Exercise the documented explicit opt-out while the separate default
  // render gate below proves production still defaults to secure cookies.
  SECURE_COOKIES: "false",
  TRUST_PROXY: "2",
  ALLOW_PRIVATE_AGENT_URLS: "compose-contract-allow-private-agent-urls",
  ALLOW_PRIVATE_WEBHOOK_URLS: "compose-contract-allow-private-webhook-urls",
  BLOCK_PRIVATE_S3_ENDPOINTS: "compose-contract-block-private-s3-endpoints",
  BACKUP_ENCRYPTION_KEYS: "contract-key:contract-encryption-secret-0123456789",
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: "contract-key",
  BACKUP_HOST_PATH_ALLOWED_ROOTS: "/srv/contract,/home/contract",
  IMAGE_SCANNER_PROVIDER: "trivy",
  SMTP_HOST: "mail.contract.internal",
  SMTP_PORT: "25251",
  SMTP_USER: "contract-smtp-user",
  SMTP_PASS: "contract-smtp-password",
  SMTP_FROM: "alerts@contract.example",
  HOST_CHECK_INTERVAL_MS: "45001",
  INVENTORY_SYNC_INTERVAL_MS: "180001"
});

export const sharedServiceEnvironment = Object.freeze([
  "APP_SECRET",
  "REDIS_URL",
  "ALLOW_PRIVATE_AGENT_URLS",
  "ALLOW_PRIVATE_WEBHOOK_URLS",
  "BLOCK_PRIVATE_S3_ENDPOINTS",
  "BACKUP_ENCRYPTION_KEYS",
  "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
  "BACKUP_HOST_PATH_ALLOWED_ROOTS",
  "IMAGE_SCANNER_PROVIDER",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM"
]);

export const appOnlyEnvironment = Object.freeze([
  "CORS_ORIGINS",
  "SECURE_COOKIES",
  "TRUST_PROXY"
]);

export const workerOnlyEnvironment = Object.freeze([
  "HOST_CHECK_INTERVAL_MS",
  "INVENTORY_SYNC_INTERVAL_MS"
]);

// Every sentinel is assigned the only services where its value may appear in
// an environment entry. Sentinels used exclusively for images, mounts, or
// published ports intentionally have no allowed environment service. This lets
// the render gate catch both same-key leakage and a secret copied under an
// unexpected environment key.
export const sentinelEnvironmentServices = Object.freeze({
  APP_SECRET: Object.freeze(["app", "worker"]),
  POSTGRES_PASSWORD: Object.freeze(["app", "worker", "postgres"]),
  REDIS_URL: Object.freeze(["app", "worker"]),
  COMPOSEBASTION_BACKUP_DIR: Object.freeze([]),
  COMPOSEBASTION_IMAGE: Object.freeze([]),
  COMPOSEBASTION_VERSION: Object.freeze([]),
  COMPOSEBASTION_HTTP_PORT: Object.freeze([]),
  COMPOSEBASTION_HTTP_BIND_ADDRESS: Object.freeze([]),
  COMPOSEBASTION_UID: Object.freeze([]),
  COMPOSEBASTION_GID: Object.freeze([]),
  COMPOSEBASTION_AGENT_IMAGE: Object.freeze([]),
  COMPOSEBASTION_AGENT_VERSION: Object.freeze([]),
  COMPOSEBASTION_AGENT_PORT: Object.freeze([]),
  COMPOSEBASTION_AGENT_BIND_ADDRESS: Object.freeze([]),
  AGENT_TOKEN: Object.freeze(["composebastion-agent"]),
  CORS_ORIGINS: Object.freeze(["app"]),
  SECURE_COOKIES: Object.freeze(["app"]),
  TRUST_PROXY: Object.freeze(["app"]),
  ALLOW_PRIVATE_AGENT_URLS: Object.freeze(["app", "worker"]),
  ALLOW_PRIVATE_WEBHOOK_URLS: Object.freeze(["app", "worker"]),
  BLOCK_PRIVATE_S3_ENDPOINTS: Object.freeze(["app", "worker"]),
  BACKUP_ENCRYPTION_KEYS: Object.freeze(["app", "worker"]),
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: Object.freeze(["app", "worker"]),
  BACKUP_HOST_PATH_ALLOWED_ROOTS: Object.freeze(["app", "worker"]),
  IMAGE_SCANNER_PROVIDER: Object.freeze(["app", "worker"]),
  SMTP_HOST: Object.freeze(["app", "worker"]),
  SMTP_PORT: Object.freeze(["app", "worker"]),
  SMTP_USER: Object.freeze(["app", "worker"]),
  SMTP_PASS: Object.freeze(["app", "worker"]),
  SMTP_FROM: Object.freeze(["app", "worker"]),
  HOST_CHECK_INTERVAL_MS: Object.freeze(["worker"]),
  INVENTORY_SYNC_INTERVAL_MS: Object.freeze(["worker"])
});

export const documentedComposeVariables = Object.freeze([
  ...new Set([...Object.keys(composeSentinels), "DATABASE_URL"])
]);

// These variables are documented for direct process execution or describe
// fixed in-container paths. Production Compose intentionally owns their
// values rather than forwarding host overrides.
export const documentedRuntimeOnlyVariables = Object.freeze([
  "BACKUP_DIR",
  "API_HOST",
  "API_PORT",
  "WEB_DIST_DIR"
]);
