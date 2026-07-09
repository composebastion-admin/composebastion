import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const secret = () => randomBytes(24).toString("hex");
const env = {
  ...process.env,
  COMPOSEBASTION_ACCEPTANCE_IMAGE: "composebastion-app:1.0.7-rc.1",
  APP_SECRET: secret(),
  POSTGRES_PASSWORD: secret(),
  MINIO_ROOT_USER: "acceptance",
  MINIO_ROOT_PASSWORD: secret(),
  SAMBA_USER: "acceptance",
  SAMBA_PASSWORD: secret(),
  COMPOSEBASTION_SSH_AUTHORIZED_KEYS: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcceptanceConfigOnly composebastion"
};

const result = spawnSync("docker", ["compose", "-f", "docker-compose.acceptance.yml", "config", "--quiet"], {
  cwd: new URL("../..", import.meta.url),
  env,
  stdio: "inherit"
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("Acceptance Compose configuration is valid.");
