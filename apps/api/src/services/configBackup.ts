import { CONFIG_BACKUP_FORMAT_VERSION } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { decryptConfigPayload, decryptSecret, encryptConfigPayload, encryptSecret, type EncryptedConfigPayload } from "./crypto.js";
import { exportBackupTargetSecrets } from "./recoveryBackupTargets.js";
import { APP_VERSION } from "./version.js";

const CONFIG_BACKUP_APP_NAME = "ComposeBastion";

type ConfigBackupPayload = {
  app: string;
  formatVersion: number;
  version: string;
  exportedAt: string;
  hosts: Array<Record<string, any>>;
  composeStacks: Array<Record<string, any>>;
  registries: Array<Record<string, any>>;
  notificationChannels: Array<Record<string, any>>;
  alertRules: Array<Record<string, any>>;
  favoriteImages: Array<Record<string, any>>;
  githubRepositories: Array<Record<string, any>>;
  appSourceLinks?: Array<Record<string, any>>;
  backupTargets?: Array<Record<string, any>>;
};

function decryptNullable(value: string | null | undefined) {
  return value ? decryptSecret(value) : null;
}

function encryptNullable(value: unknown) {
  return typeof value === "string" && value.length > 0 ? encryptSecret(value) : null;
}

function configImportError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function decryptConfigBackupPayload(backup: Record<string, unknown>, passphrase: string) {
  try {
    return decryptConfigPayload<ConfigBackupPayload>(backup as unknown as EncryptedConfigPayload, passphrase);
  } catch {
    throw configImportError("Config backup could not be decrypted. Check the passphrase and JSON file.");
  }
}

const payloadArrayFields = [
  "hosts",
  "composeStacks",
  "registries",
  "notificationChannels",
  "alertRules",
  "favoriteImages",
  "githubRepositories"
] as const;

function validateConfigBackupPayload(payload: ConfigBackupPayload) {
  if (payload.app !== CONFIG_BACKUP_APP_NAME) {
    throw configImportError("This is not a ComposeBastion config backup");
  }
  if (payload.formatVersion !== CONFIG_BACKUP_FORMAT_VERSION) {
    throw configImportError(`Unsupported ComposeBastion config backup format version ${String(payload.formatVersion)}`);
  }
  for (const field of payloadArrayFields) {
    if (!Array.isArray(payload[field])) {
      throw configImportError(`Config backup is missing the ${field} list`);
    }
  }
  if (payload.appSourceLinks !== undefined && !Array.isArray(payload.appSourceLinks)) {
    throw configImportError("Config backup appSourceLinks must be a list");
  }
  if (payload.backupTargets !== undefined && !Array.isArray(payload.backupTargets)) {
    throw configImportError("Config backup backupTargets must be a list");
  }
}

export async function exportConfigBackup(passphrase: string) {
  const [hosts, composeStacks, registries, notificationChannels, alertRules, favoriteImages, githubRepositories, appSourceLinks, backupTargets] = await Promise.all([
    query("SELECT * FROM docker_hosts ORDER BY name ASC"),
    query("SELECT * FROM compose_stacks ORDER BY name ASC"),
    query("SELECT * FROM registries ORDER BY name ASC"),
    query("SELECT * FROM notification_channels ORDER BY name ASC"),
    query("SELECT * FROM alert_rules ORDER BY name ASC"),
    query("SELECT * FROM favorite_images ORDER BY image ASC"),
    query("SELECT * FROM github_repositories ORDER BY name ASC"),
    query("SELECT * FROM app_source_links ORDER BY host_id, name ASC"),
    query("SELECT * FROM backup_targets ORDER BY name ASC")
  ]);

  const payload: ConfigBackupPayload = {
    app: CONFIG_BACKUP_APP_NAME,
    formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    hosts: hosts.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      port: Number(row.port),
      username: row.username,
      connectionMode: row.connection_mode ?? "ssh",
      sshAuthType: row.ssh_auth_type ?? "key",
      dockerSocketPath: row.docker_socket_path,
      tags: row.tags ?? [],
      agentUrl: row.agent_url,
      secrets: {
        sshPrivateKey: decryptNullable(row.ssh_key_encrypted),
        sshKeyPassphrase: decryptNullable(row.ssh_key_passphrase_encrypted),
        sshPassword: decryptNullable(row.ssh_password_encrypted),
        agentToken: decryptNullable(row.agent_token_encrypted)
      }
    })),
    composeStacks: composeStacks.rows.map((row: any) => ({
      id: row.id,
      hostId: row.host_id,
      name: row.name,
      projectName: row.project_name,
      composeYaml: row.compose_yaml,
      env: row.env ?? "",
      status: row.status,
      sourceType: row.source_type ?? "ui",
      sourceRepositoryUrl: row.source_repository_url,
      sourceBranch: row.source_branch,
      sourceWorkingDir: row.source_working_dir,
      sourceComposePath: row.source_compose_path,
      sourceCurrentCommitSha: row.source_current_commit_sha,
      sourceLatestCommitSha: row.source_latest_commit_sha
    })),
    registries: registries.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      username: row.username,
      insecure: row.insecure,
      password: decryptNullable(row.password_encrypted)
    })),
    notificationChannels: notificationChannels.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      emailTo: row.email_to,
      webhookUrl: row.webhook_url,
      enabled: row.enabled,
      config: row.config ?? {}
    })),
    alertRules: alertRules.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      condition: row.condition,
      hostId: row.host_id,
      containerId: row.container_id,
      channelId: row.channel_id,
      enabled: row.enabled
    })),
    favoriteImages: favoriteImages.rows.map((row: any) => ({
      id: row.id,
      image: row.image,
      name: row.name,
      notes: row.notes ?? ""
    })),
    githubRepositories: githubRepositories.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      repositoryUrl: row.repository_url,
      owner: row.owner,
      repo: row.repo,
      branch: row.branch,
      composePath: row.compose_path,
      projectName: row.project_name,
      env: row.env ?? "",
      defaultHostId: row.default_host_id,
      githubToken: decryptNullable(row.github_token_encrypted)
    })),
    appSourceLinks: appSourceLinks.rows.map((row: any) => ({
      id: row.id,
      hostId: row.host_id,
      containerExternalId: row.container_external_id,
      sourceType: row.source_type,
      name: row.name,
      repositoryUrl: row.repository_url,
      branch: row.branch,
      workingDir: row.working_dir,
      composePath: row.compose_path,
      imageReference: row.image_reference,
      currentCommitSha: row.current_commit_sha,
      latestCommitSha: row.latest_commit_sha
    })),
    backupTargets: backupTargets.rows.map((row: any) => {
      const secrets = exportBackupTargetSecrets(row);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        config: row.config ?? {},
        accessKeyId: secrets.accessKeyId,
        secretAccessKey: secrets.secretAccessKey,
        provider: secrets.provider,
        remotePath: secrets.remotePath,
        localCachePolicy: secrets.localCachePolicy,
        rcloneConfig: secrets.rcloneConfig,
        rcloneCredentials: secrets.rcloneCredentials
      };
    })
  };

  return encryptConfigPayload(payload, passphrase);
}

export async function importConfigBackup(backup: Record<string, unknown>, passphrase: string) {
  const payload = decryptConfigBackupPayload(backup, passphrase);
  validateConfigBackupPayload(payload);

  const summary = await withTransaction(async (client) => {
    const counts = {
      hosts: 0,
      composeStacks: 0,
      registries: 0,
      notificationChannels: 0,
      alertRules: 0,
      favoriteImages: 0,
      githubRepositories: 0,
      appSourceLinks: 0,
      backupTargets: 0
    };

    for (const host of payload.hosts ?? []) {
      await client.query(
        `INSERT INTO docker_hosts
          (id, name, hostname, port, username, connection_mode, ssh_auth_type, ssh_key_encrypted,
           ssh_key_passphrase_encrypted, ssh_password_encrypted, agent_url, agent_token_encrypted, docker_socket_path, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       hostname = EXCLUDED.hostname,
                       port = EXCLUDED.port,
                       username = EXCLUDED.username,
                       connection_mode = EXCLUDED.connection_mode,
                       ssh_auth_type = EXCLUDED.ssh_auth_type,
                       ssh_key_encrypted = EXCLUDED.ssh_key_encrypted,
                       ssh_key_passphrase_encrypted = EXCLUDED.ssh_key_passphrase_encrypted,
                       ssh_password_encrypted = EXCLUDED.ssh_password_encrypted,
                       agent_url = EXCLUDED.agent_url,
                       agent_token_encrypted = EXCLUDED.agent_token_encrypted,
                       docker_socket_path = EXCLUDED.docker_socket_path,
                       tags = EXCLUDED.tags,
                       updated_at = now()`,
        [
          host.id,
          host.name,
          host.hostname,
          Number(host.port ?? 22),
          host.username,
          host.connectionMode ?? "ssh",
          host.sshAuthType ?? "key",
          encryptNullable(host.secrets?.sshPrivateKey),
          encryptNullable(host.secrets?.sshKeyPassphrase),
          encryptNullable(host.secrets?.sshPassword),
          host.agentUrl ?? null,
          encryptNullable(host.secrets?.agentToken),
          host.dockerSocketPath ?? "/var/run/docker.sock",
          host.tags ?? []
        ]
      );
      counts.hosts += 1;
    }

    for (const image of payload.favoriteImages ?? []) {
      await client.query(
        `INSERT INTO favorite_images (id, image, name, notes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (image)
         DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now()`,
        [image.id, image.image, image.name ?? null, image.notes ?? ""]
      );
      counts.favoriteImages += 1;
    }

    for (const registry of payload.registries ?? []) {
      await client.query(
        `INSERT INTO registries (id, name, url, username, password_encrypted, insecure)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       url = EXCLUDED.url,
                       username = EXCLUDED.username,
                       password_encrypted = EXCLUDED.password_encrypted,
                       insecure = EXCLUDED.insecure,
                       updated_at = now()`,
        [registry.id, registry.name, registry.url, registry.username ?? null, encryptNullable(registry.password), registry.insecure ?? false]
      );
      counts.registries += 1;
    }

    for (const channel of payload.notificationChannels ?? []) {
      await client.query(
        `INSERT INTO notification_channels (id, name, type, email_to, webhook_url, enabled, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       type = EXCLUDED.type,
                       email_to = EXCLUDED.email_to,
                       webhook_url = EXCLUDED.webhook_url,
                       enabled = EXCLUDED.enabled,
                       config = EXCLUDED.config,
                       updated_at = now()`,
        [channel.id, channel.name, channel.type, channel.emailTo ?? null, channel.webhookUrl ?? null, channel.enabled ?? true, channel.config ?? {}]
      );
      counts.notificationChannels += 1;
    }

    for (const repo of payload.githubRepositories ?? []) {
      await client.query(
        `INSERT INTO github_repositories
          (id, name, repository_url, owner, repo, branch, compose_path, project_name, env, default_host_id, github_token_encrypted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (owner, repo, branch, compose_path)
         DO UPDATE SET name = EXCLUDED.name,
                       repository_url = EXCLUDED.repository_url,
                       project_name = EXCLUDED.project_name,
                       env = EXCLUDED.env,
                       default_host_id = EXCLUDED.default_host_id,
                       github_token_encrypted = EXCLUDED.github_token_encrypted,
                       updated_at = now()`,
        [
          repo.id,
          repo.name,
          repo.repositoryUrl,
          repo.owner,
          repo.repo,
          repo.branch ?? "main",
          repo.composePath ?? "docker-compose.yml",
          repo.projectName,
          repo.env ?? "",
          repo.defaultHostId ?? null,
          encryptNullable(repo.githubToken)
        ]
      );
      counts.githubRepositories += 1;
    }

    for (const stack of payload.composeStacks ?? []) {
      await client.query(
        `INSERT INTO compose_stacks (
           id, host_id, name, project_name, compose_yaml, env, status,
           source_type, source_repository_url, source_branch, source_working_dir, source_compose_path,
           source_current_commit_sha, source_latest_commit_sha
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (host_id, project_name)
         DO UPDATE SET name = EXCLUDED.name,
                       compose_yaml = EXCLUDED.compose_yaml,
                       env = EXCLUDED.env,
                       status = EXCLUDED.status,
                       source_type = EXCLUDED.source_type,
                       source_repository_url = EXCLUDED.source_repository_url,
                       source_branch = EXCLUDED.source_branch,
                       source_working_dir = EXCLUDED.source_working_dir,
                       source_compose_path = EXCLUDED.source_compose_path,
                       source_current_commit_sha = EXCLUDED.source_current_commit_sha,
                       source_latest_commit_sha = EXCLUDED.source_latest_commit_sha,
                       updated_at = now()`,
        [
          stack.id,
          stack.hostId,
          stack.name,
          stack.projectName,
          stack.composeYaml,
          stack.env ?? "",
          stack.status ?? "created",
          stack.sourceType ?? "ui",
          stack.sourceRepositoryUrl ?? null,
          stack.sourceBranch ?? null,
          stack.sourceWorkingDir ?? null,
          stack.sourceComposePath ?? null,
          stack.sourceCurrentCommitSha ?? null,
          stack.sourceLatestCommitSha ?? null
        ]
      );
      counts.composeStacks += 1;
    }

    for (const link of payload.appSourceLinks ?? []) {
      await client.query(
        `INSERT INTO app_source_links (
           id, host_id, container_external_id, source_type, name, repository_url, branch,
           working_dir, compose_path, image_reference, current_commit_sha, latest_commit_sha
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (host_id, container_external_id)
         DO UPDATE SET source_type = EXCLUDED.source_type,
                       name = EXCLUDED.name,
                       repository_url = EXCLUDED.repository_url,
                       branch = EXCLUDED.branch,
                       working_dir = EXCLUDED.working_dir,
                       compose_path = EXCLUDED.compose_path,
                       image_reference = EXCLUDED.image_reference,
                       current_commit_sha = EXCLUDED.current_commit_sha,
                       latest_commit_sha = EXCLUDED.latest_commit_sha,
                       updated_at = now()`,
        [
          link.id,
          link.hostId,
          link.containerExternalId,
          link.sourceType,
          link.name ?? null,
          link.repositoryUrl ?? null,
          link.branch ?? null,
          link.workingDir ?? null,
          link.composePath ?? null,
          link.imageReference ?? null,
          link.currentCommitSha ?? null,
          link.latestCommitSha ?? null
        ]
      );
      counts.appSourceLinks += 1;
    }

    for (const rule of payload.alertRules ?? []) {
      await client.query(
        `INSERT INTO alert_rules (id, name, condition, host_id, container_id, channel_id, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       condition = EXCLUDED.condition,
                       host_id = EXCLUDED.host_id,
                       container_id = EXCLUDED.container_id,
                       channel_id = EXCLUDED.channel_id,
                       enabled = EXCLUDED.enabled,
                       updated_at = now()`,
        [rule.id, rule.name, rule.condition, rule.hostId, rule.containerId ?? null, rule.channelId, rule.enabled ?? true]
      );
      counts.alertRules += 1;
    }

    for (const target of payload.backupTargets ?? []) {
      const rcloneCredentials = target.rcloneCredentials && typeof target.rcloneCredentials === "object" && !Array.isArray(target.rcloneCredentials)
        ? target.rcloneCredentials
        : null;
      await client.query(
        `INSERT INTO backup_targets (
           id, name, kind, enabled, config, access_key_id, secret_access_key_encrypted,
           provider, remote_path, local_cache_policy, generic_config_encrypted,
           generic_credentials_encrypted
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       kind = EXCLUDED.kind,
                       enabled = EXCLUDED.enabled,
                       config = EXCLUDED.config,
                       access_key_id = EXCLUDED.access_key_id,
                       secret_access_key_encrypted = EXCLUDED.secret_access_key_encrypted,
                       provider = EXCLUDED.provider,
                       remote_path = EXCLUDED.remote_path,
                       local_cache_policy = EXCLUDED.local_cache_policy,
                       generic_config_encrypted = EXCLUDED.generic_config_encrypted,
                       generic_credentials_encrypted = EXCLUDED.generic_credentials_encrypted,
                       updated_at = now()`,
        [
          target.id,
          target.name,
          target.kind,
          target.enabled ?? true,
          target.config ?? {},
          target.accessKeyId ?? null,
          encryptNullable(target.secretAccessKey),
          target.provider ?? null,
          target.remotePath ?? null,
          target.localCachePolicy ?? "keep",
          encryptNullable(target.rcloneConfig),
          rcloneCredentials ? encryptSecret(JSON.stringify(rcloneCredentials)) : null
        ]
      );
      counts.backupTargets += 1;
    }

    return counts;
  });

  return { imported: summary, exportedAt: payload.exportedAt, version: payload.version };
}
