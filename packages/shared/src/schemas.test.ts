import { describe, expect, it } from "vitest";
import {
  appGithubVersionSelectSchema,
  appGithubVersionsSchema,
  appRenameInputSchema,
  appSourceLinkInputSchema,
  backupCreateSchema,
  backupListQuerySchema,
  backupRestoreSchema,
  backupScheduleCreateSchema,
  canonicalizeGithubRepositoryUrl,
  canonicalizeGitRepositoryUrl,
  canonicalizePlaintextHttpSourceUrl,
  catalogTemplates,
  configExportSchema,
  customCatalogTemplateInputSchema,
  deploymentAnalysisCreateSchema,
  deploymentAnalysisDeploySchema,
  deploymentAnalysisSchema,
  deploymentSourceCreateSchema,
  deploymentSourceSchema,
  deploymentSourceUpdateSchema,
  directHostActionTypeSchema,
  dockerActionSchema,
  dockerAppSchema,
  dockerHostUpdateSchema,
  externalCatalogQuerySchema,
  gitRepositoryUrlSchema,
  githubRepositoryUrlIssue,
  githubRepositoryBranchesRequestSchema,
  githubRepositoryCreateSchema,
  githubRepositoryDeploySchema,
  githubRepositoryUpdateSchema,
  hostPathBackupRestoreSchema,
  loginRequestSchema,
  networkDriverExplanations,
  registryTrustSchema,
  sanitizeDeploymentSourceLocator,
  sanitizeGitRepositoryUrl,
  sanitizeGitRepositoryUrlFields,
  sanitizeGithubRepositoryUrl,
  sanitizePlaintextHttpSourceUrl,
  sanitizeUrlDiagnosticText,
  selfUpdateConfigSchema,
  setupRequestSchema,
  validatePasswordStrength,
  volumeCloneSchema
} from "./index.js";

const sampleHostId = "00000000-0000-4000-8000-000000000001";

const strongPassword = "Very-Secure-Pass1";

describe("shared schemas", () => {
  it("validates setup password strength", () => {
    expect(validatePasswordStrength("short")).not.toHaveLength(0);
    expect(() => setupRequestSchema.parse({ username: "admin", password: "short" })).toThrow();
    expect(setupRequestSchema.parse({ username: "admin", password: strongPassword }).includeDemoData).toBe(false);
    expect(setupRequestSchema.parse({ username: "admin", email: "admin@example.com", password: strongPassword, includeDemoData: true }).includeDemoData).toBe(true);
    expect(() => setupRequestSchema.parse({ password: strongPassword })).toThrow();
    expect(loginRequestSchema.parse({ identifier: "admin", password: "secret" }).identifier).toBe("admin");
  });

  it("applies Docker action defaults", () => {
    const action = dockerActionSchema.parse({
      type: "image.prune",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: {}
    });
    expect(action.payload.all).toBe(false);
    const clone = dockerActionSchema.parse({
      type: "git.clone",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { repositoryUrl: "https://github.com/example/app.git", directory: "/home/user/app" }
    });
    expect(clone.payload.shallow).toBe(true);
    const pull = dockerActionSchema.parse({
      type: "git.pull",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { directory: "/home/user/app" }
    });
    expect(pull.payload.directory).toBe("/home/user/app");
    const cloneDeploy = dockerActionSchema.parse({
      type: "git.cloneDeploy",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: {
        repositoryId: "00000000-0000-4000-8000-000000000002",
        repositoryUrl: "git@github.com:example/app.git",
        directory: "/home/user/app",
        projectName: "sampleapp"
      }
    });
    expect(cloneDeploy.payload.composePath).toBe("docker-compose.yml");
    expect(cloneDeploy.payload.repositoryId).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("publishes the direct host-action contract separately from orchestrated jobs", () => {
    expect(directHostActionTypeSchema.parse("container.restart")).toBe("container.restart");
    for (const dedicatedType of [
      "deploy.execute",
      "host.configureRegistryTrust",
      "migration.execute",
      "recovery.restore",
      "system.self_update"
    ]) {
      expect(directHostActionTypeSchema.safeParse(dedicatedType).success).toBe(false);
    }
  });

  it("accepts safe Git transports and rejects credential-bearing repository URLs", () => {
    for (const repositoryUrl of [
      "https://git.example.test/team/app.git",
      "http://git.internal:3000/team/app.git",
      "ssh://git@git.example.test/team/app.git",
      "git://git.example.test/team/app.git",
      "git@git-host-alias:team/app.git"
    ]) {
      expect(gitRepositoryUrlSchema.parse(repositoryUrl)).toBe(repositoryUrl);
    }

    const unsafeUrls = [
      "https://git-user:git-secret@git.example.test/team/app.git",
      "https://git.example.test/team/app.git?token=git-secret",
      "https://git.example.test/team/app.git#git-secret",
      "https://git.example.test/team/app.git?",
      "https://git.example.test/team/app.git#",
      "ssh://git:git-secret@git.example.test/team/app.git",
      "file:///srv/private-repository"
    ];
    for (const type of ["git.clone", "git.testRemote"] as const) {
      for (const repositoryUrl of unsafeUrls) {
        expect(() => dockerActionSchema.parse({
          type,
          hostId: sampleHostId,
          payload: {
            repositoryUrl,
            ...(type === "git.clone" ? { directory: "/srv/app" } : {})
          }
        })).toThrow();
      }
    }

    expect(() => appSourceLinkInputSchema.parse({
      sourceType: "git",
      repositoryUrl: "https://git-user:git-secret@git.example.test/team/app.git?token=git-secret",
      workingDir: "/srv/app",
      composePath: "compose.yaml"
    })).toThrow("Repository URL must not contain credentials");

    expect(sanitizeGitRepositoryUrl(
      "https://git-user:git-secret@git.example.test/team/app.git?token=git-secret#private"
    )).toBe("https://git.example.test/team/app.git");
    expect(sanitizeGitRepositoryUrlFields({
      payload: {
        repositoryUrl: "https://git-user:git-secret@git.example.test/team/app.git?token=git-secret",
        hostCloneUrl: "ssh://git:git-secret@git.example.test/team/app.git#private",
        sourceInput: "https://git.example.test/team/app.git?token=git-secret"
      },
      error: "Clone failed for https://git-user:git-secret@git.example.test/team/app.git?token=git-secret"
    })).toEqual({
      payload: {
        repositoryUrl: "https://git.example.test/team/app.git",
        hostCloneUrl: "ssh://git@git.example.test/team/app.git",
        sourceInput: "https://git.example.test/team/app.git"
      },
      error: "Clone failed for https://git.example.test/team/app.git"
    });
  });

  it("canonicalizes and sanitizes persisted source URL variants", () => {
    expect(canonicalizeGitRepositoryUrl(" git@Git.Example.Test:Team/App.git/ "))
      .toBe("git@git.example.test:Team/App.git");
    expect(canonicalizeGitRepositoryUrl("SSH://git@Git.Example.Test/Team/App.git/"))
      .toBe("ssh://git@git.example.test/Team/App.git");
    expect(() => canonicalizeGitRepositoryUrl("file:///srv/app")).toThrow();

    expect(githubRepositoryUrlIssue("")).toContain("Use a GitHub repository URL");
    expect(githubRepositoryUrlIssue("not a URL")).toContain("Use a GitHub repository URL");
    expect(githubRepositoryUrlIssue("http://github.com/owner/app")).toContain("Use a GitHub repository URL");
    expect(githubRepositoryUrlIssue("https://github.com/owner/app/extra")).toContain("Use a GitHub repository URL");
    expect(githubRepositoryUrlIssue("https://github.com/owner/app?token=secret"))
      .toContain("must not contain credentials");
    expect(githubRepositoryUrlIssue("https://github.com/owner/app")).toBeNull();
    expect(canonicalizeGithubRepositoryUrl(" https://www.github.com/Owner/App.git/ "))
      .toBe("https://github.com/owner/app");
    expect(() => canonicalizeGithubRepositoryUrl("https://gitlab.com/owner/app")).toThrow();

    expect(canonicalizePlaintextHttpSourceUrl(" HTTPS://Compose.Example.Test/compose.yaml "))
      .toBe("https://compose.example.test/compose.yaml");
    for (const value of [
      "",
      "not a URL",
      "ftp://compose.example.test/compose.yaml",
      "https://compose.example.test/compose.yaml?token=secret"
    ]) {
      expect(() => canonicalizePlaintextHttpSourceUrl(value)).toThrow();
    }

    expect(sanitizeGitRepositoryUrl(null)).toBeNull();
    expect(sanitizeGitRepositoryUrl("git@Git.Example.Test:Team/App.git"))
      .toBe("git@git.example.test:Team/App.git");
    expect(sanitizeGitRepositoryUrl("git://user:secret@git.example.test/team/app.git?token=secret"))
      .toBe("git://git.example.test/team/app.git");
    expect(sanitizeGithubRepositoryUrl("https://github.com/Owner/App.git"))
      .toBe("https://github.com/owner/app");
    expect(sanitizeGithubRepositoryUrl(
      "https://user:secret@github.com/owner/app?token=secret",
      { owner: "Owner", repo: "App.git" }
    )).toBe("https://github.com/owner/app");
    expect(sanitizeGithubRepositoryUrl("unsafe", { owner: "bad/owner", repo: "app" }))
      .toBeNull();

    expect(sanitizePlaintextHttpSourceUrl(42)).toBeNull();
    expect(sanitizePlaintextHttpSourceUrl("not a URL")).toBeNull();
    expect(sanitizePlaintextHttpSourceUrl("file:///tmp/compose.yaml")).toBeNull();
    expect(sanitizePlaintextHttpSourceUrl(
      "https://user:secret@compose.example.test/compose.yaml?token=secret#fragment"
    )).toBe("https://compose.example.test/compose.yaml");
    expect(sanitizeDeploymentSourceLocator(null, "git")).toBeNull();
    expect(sanitizeDeploymentSourceLocator(
      "https://user:secret@git.example.test/team/app.git?token=secret",
      "git"
    )).toBe("https://git.example.test/team/app.git");
    expect(sanitizeDeploymentSourceLocator(
      "https://user:secret@compose.example.test/compose.yaml?token=secret",
      "compose_url"
    )).toBe("https://compose.example.test/compose.yaml");
    expect(sanitizeDeploymentSourceLocator("nginx:latest", "image")).toBe("nginx:latest");

    expect(sanitizeUrlDiagnosticText(42)).toBe(42);
    expect(sanitizeUrlDiagnosticText(
      "Failed (https://user:secret@git.example.test/team/app.git?token=secret)."
    )).toBe("Failed (https://git.example.test/team/app.git).");
    expect(sanitizeUrlDiagnosticText("Failed https://?token=secret"))
      .toBe("Failed [redacted-url]");
    expect(sanitizeGitRepositoryUrlFields([
      { source_locator: "https://user:secret@compose.example.test/compose.yaml?token=secret" },
      "unchanged"
    ])).toEqual([
      { source_locator: "https://compose.example.test/compose.yaml" },
      "unchanged"
    ]);
  });

  it("represents explicit Docker host secret clearing without ambiguous replacements", () => {
    expect(dockerHostUpdateSchema.parse({
      clearSshKeyPassphrase: true,
      agentUrl: null
    })).toMatchObject({
      clearSshKeyPassphrase: true,
      agentUrl: null
    });
    expect(() => dockerHostUpdateSchema.parse({
      sshPassword: "replacement",
      clearSshPassword: true
    })).toThrow("Cannot replace and clear sshPassword in the same update");
    expect(() => dockerHostUpdateSchema.parse({
      agentUrl: "file:///tmp/agent.sock"
    })).toThrow("Agent URL must use http or https");
    for (const agentUrl of [
      "https://agent-user:agent-secret@agent.example.test",
      "https://agent.example.test?token=agent-secret",
      "https://agent.example.test#agent-secret",
      "https://agent.example.test?",
      "https://agent.example.test#"
    ]) {
      expect(() => dockerHostUpdateSchema.parse({ agentUrl }))
        .toThrow("Agent URL must not contain embedded credentials");
    }
  });

  it("validates self-update configuration", () => {
    const latest = selfUpdateConfigSchema.parse({
      hostId: sampleHostId,
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "latest"
    });
    expect(latest.targetVersion).toBe("latest");
    const pinned = selfUpdateConfigSchema.parse({
      ...latest,
      versionMode: "pinned",
      targetVersion: "1.0.2"
    });
    expect(pinned.targetVersion).toBe("1.0.2");
    expect(() => selfUpdateConfigSchema.parse({ ...latest, versionMode: "pinned", targetVersion: "latest" })).toThrow();
  });

  it("validates container update and config backup requests", () => {
    const action = dockerActionSchema.parse({
      type: "container.update",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { containerId: "web", targetImage: "nginx:1.27-alpine" }
    });
    expect(action.payload.containerId).toBe("web");
    expect(action.payload.targetImage).toBe("nginx:1.27-alpine");
    const rename = dockerActionSchema.parse({
      type: "container.rename",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { containerId: "web", name: "web-renamed" }
    });
    expect(rename.payload.name).toBe("web-renamed");
    const folderDeploy = dockerActionSchema.parse({
      type: "compose.deployPath",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { projectName: "sampleapp", workingDir: "/home/user/app", composePath: "docker-compose.yml" }
    });
    expect(folderDeploy.payload.projectName).toBe("sampleapp");
    const writeDeploy = dockerActionSchema.parse({
      type: "compose.writeDeployPath",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: {
        projectName: "sampleapp",
        workingDir: "/home/user/app",
        composeYaml: "services:\n  app:\n    image: nginx:alpine\n"
      }
    });
    expect(writeDeploy.payload.composePath).toBe("docker-compose.yml");
    expect(writeDeploy.payload.overwrite).toBe(false);
    expect(writeDeploy.payload.pullBeforeDeploy).toBe(false);
    expect(() => dockerActionSchema.parse({
      type: "compose.writeDeployPath",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: {
        projectName: "SampleApp",
        workingDir: "relative/app",
        composeYaml: "services: {}"
      }
    })).toThrow();
    expect(() => dockerActionSchema.parse({
      type: "compose.writeDeployPath",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: {
        projectName: "sampleapp",
        workingDir: "/home/user/app",
        composeYaml: "x".repeat(512 * 1024 + 1)
      }
    })).toThrow();
    expect(() => configExportSchema.parse({ passphrase: "short" })).toThrow();
  });

  it("accepts tracked GitHub repository settings", () => {
    const repo = githubRepositoryCreateSchema.parse({
      name: "ComposeBastion",
      repositoryUrl: "https://github.com/composebastion-admin/composebastion",
      defaultHostId: "00000000-0000-4000-8000-000000000001",
      hostCloneUrl: "git@github.com:composebastion-admin/composebastion.git",
      hostCloneDirectory: "/srv/apps/composebastion"
    });
    expect(repo.branch).toBe("main");
    expect(repo.composePath).toBe("docker-compose.yml");
    expect(repo.hostCloneDirectory).toBe("/srv/apps/composebastion");
    expect(githubRepositoryBranchesRequestSchema.parse({ repositoryUrl: repo.repositoryUrl }).repositoryUrl).toBe(repo.repositoryUrl);
    expect(() => githubRepositoryCreateSchema.parse({ ...repo, projectName: "SampleApp" })).toThrow();
    expect(githubRepositoryDeploySchema.parse({ projectName: "sampleapp", composeYaml: "services: {}" }).projectName).toBe("sampleapp");
    expect(githubRepositoryDeploySchema.parse({
      mode: "host_clone",
      hostCloneUrl: "git@github.com:composebastion-admin/composebastion.git",
      hostCloneDirectory: "/srv/apps/composebastion"
    }).mode).toBe("host_clone");

    for (const repositoryUrl of [
      "https://git-user:git-secret@github.com/example/app",
      "https://github.com/example/app?token=git-secret",
      "https://github.com/example/app#git-secret",
      "http://github.com/example/app",
      "https://gitlab.com/example/app"
    ]) {
      expect(githubRepositoryCreateSchema.safeParse({
        name: "Unsafe",
        repositoryUrl
      }).success).toBe(false);
      expect(githubRepositoryUpdateSchema.safeParse({ repositoryUrl }).success).toBe(false);
      expect(githubRepositoryBranchesRequestSchema.safeParse({ repositoryUrl }).success).toBe(false);
    }

    for (const hostCloneUrl of [
      "https://git-user:git-secret@github.com/example/app.git",
      "ssh://git:git-secret@github.com/example/app.git",
      "git@github.com:example/app.git#private"
    ]) {
      expect(githubRepositoryCreateSchema.safeParse({
        name: "Unsafe clone",
        repositoryUrl: "https://github.com/example/app",
        hostCloneUrl
      }).success).toBe(false);
      expect(githubRepositoryDeploySchema.safeParse({ hostCloneUrl }).success).toBe(false);
    }
  });

  it("validates universal deployment requests and protected defaults", () => {
    const analysis = deploymentAnalysisCreateSchema.parse({
      hostId: sampleHostId,
      source: " https://github.com/example/app.git ",
      composePath: "deploy/compose.yaml",
      credentialUsername: "deploy-user",
      credentialSecret: "token"
    });
    expect(analysis.source).toBe("https://github.com/example/app.git");
    expect(analysis.composePath).toBe("deploy/compose.yaml");

    for (const source of [
      "https://git-user:git-secret@git.example.test/team/app.git",
      "https://git.example.test/team/app.git?token=git-secret",
      "ssh://git:git-secret@git.example.test/team/app.git"
    ]) {
      expect(deploymentAnalysisCreateSchema.safeParse({
        hostId: sampleHostId,
        sourceType: "git",
        source
      }).success).toBe(false);
      expect(deploymentSourceCreateSchema.safeParse({
        sourceType: "git",
        name: "Unsafe",
        sourceLocator: source,
        projectName: "unsafe"
      }).success).toBe(false);
    }

    for (const source of [
      "https://compose-user:compose-secret@example.test/compose.yaml",
      "https://example.test/compose.yaml?token=compose-secret",
      "https://example.test/compose.yaml#compose-secret"
    ]) {
      expect(deploymentAnalysisCreateSchema.safeParse({
        hostId: sampleHostId,
        sourceType: "compose_url",
        source
      }).success).toBe(false);
    }
    expect(deploymentSourceCreateSchema.safeParse({
      sourceType: "compose_url",
      name: "Private Compose",
      sourceLocator: "https://example.test/compose.yaml",
      projectName: "private-compose",
      credentialUsername: "user",
      credentialSecret: "secret"
    }).success).toBe(false);

    for (const composePath of ["/etc/compose.yaml", "../compose.yaml", "deploy/../../compose.yaml"]) {
      expect(() => deploymentAnalysisCreateSchema.parse({
        hostId: sampleHostId,
        source: "nginx:alpine",
        composePath
      })).toThrow("Compose path must stay inside the deployment directory");
    }

    expect(() => deploymentAnalysisCreateSchema.parse({
      hostId: sampleHostId,
      source: "https://github.com/example/private.git",
      credentialUsername: "deploy-user"
    })).toThrow("Enter both the HTTPS username and token/password");
    expect(() => deploymentAnalysisCreateSchema.parse({
      hostId: sampleHostId,
      source: "https://github.com/example/private.git",
      credentialSecret: "token"
    })).toThrow("Enter both the HTTPS username and token/password");

    const source = deploymentSourceCreateSchema.parse({
      sourceType: "git",
      name: " Example App ",
      sourceLocator: "https://github.com/example/app.git",
      projectName: "example-app",
      workingDir: "/srv/example-app",
      credentialUsername: "deploy-user",
      credentialSecret: "token"
    });
    expect(source.name).toBe("Example App");
    expect(() => deploymentSourceCreateSchema.parse({
      ...source,
      credentialSecret: undefined
    })).toThrow("Enter both the HTTPS username and token/password");

    expect(deploymentSourceUpdateSchema.parse({
      safeEnvironment: {
        APP_MODE: "production",
        PUBLIC_URL: "https://app.example.com"
      }
    }).safeEnvironment).toMatchObject({ APP_MODE: "production" });
    expect(() => deploymentSourceUpdateSchema.parse({
      safeEnvironment: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "value"])
      )
    })).toThrow("Too many environment defaults");
    expect(() => deploymentSourceUpdateSchema.parse({
      safeEnvironment: { APP_MODE: "production\nSECRET=exposed" }
    })).toThrow("Environment defaults must be single-line values");

    expect(deploymentAnalysisDeploySchema.parse({
      displayName: " Example App ",
      projectName: "example-app",
      workingDir: "/srv/example-app"
    }).displayName).toBe("Example App");
  });

  it("parses universal deployment source, analysis, and registry summaries", () => {
    const now = new Date(0).toISOString();
    expect(deploymentSourceSchema.parse({
      id: sampleHostId,
      sourceType: "image",
      name: "nginx",
      sourceLocator: "nginx:alpine",
      branch: null,
      composePath: null,
      workingDir: null,
      projectName: "nginx",
      defaultHostId: sampleHostId,
      hasCredential: false,
      metadata: {},
      lastDeployedAt: null,
      createdAt: now,
      updatedAt: now
    })).toMatchObject({
      targetHostIds: [],
      safeEnvironment: {}
    });

    const parsedAnalysis = deploymentAnalysisSchema.parse({
      id: sampleHostId,
      hostId: sampleHostId,
      sourceId: null,
      sourceType: "image",
      sourceInput: "nginx:alpine",
      sourceLocator: "nginx:alpine",
      status: "ready",
      displayName: "nginx",
      projectName: "nginx",
      branch: null,
      composePath: "compose.yaml",
      workingDir: "/srv/nginx",
      composeYaml: "services:\n  nginx:\n    image: nginx:alpine\n",
      env: "",
      summary: {
        services: [{ name: "nginx" }]
      },
      variables: [{ key: "APP_MODE" }],
      warnings: [],
      blockers: [],
      registryIssues: [],
      error: null,
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
      deployedAt: null
    });
    expect(parsedAnalysis.summary.services[0]).toMatchObject({
      image: null,
      build: null,
      ports: [],
      volumes: []
    });
    expect(parsedAnalysis.variables[0]).toMatchObject({
      value: "",
      defaultValue: null,
      required: false,
      secret: false,
      source: "compose"
    });
    expect(registryTrustSchema.parse({
      registry: "registry.internal:5000",
      insecure: true,
      trusted: false,
      canApply: true,
      requiresRestart: true,
      message: "Docker does not trust this HTTP registry"
    }).requiresRestart).toBe(true);
  });

  it("rejects path-like volume names that would become host bind mounts", () => {
    // A valid Docker volume name is accepted.
    expect(backupRestoreSchema.parse({ targetHostId: sampleHostId, targetVolumeName: "app_data" }).targetVolumeName).toBe("app_data");
    // Path/option-bearing values that would turn `-v <name>:/volume` into a bind mount must be rejected.
    for (const bad of ["/etc", "../escape", "vol:/host", "a b", "/var/lib/docker/volumes"]) {
      expect(() => backupRestoreSchema.parse({ targetHostId: sampleHostId, targetVolumeName: bad })).toThrow();
    }
    expect(() => volumeCloneSchema.parse({
      sourceHostId: sampleHostId,
      targetHostId: sampleHostId,
      sourceVolumeName: "good",
      targetVolumeName: "/root/.ssh"
    })).toThrow();
    expect(() => dockerActionSchema.parse({
      type: "volume.restore",
      hostId: sampleHostId,
      payload: { backupId: sampleHostId, targetVolumeName: "/etc" }
    })).toThrow();
  });

  it("validates host-path backup and restore requests", () => {
    const restore = hostPathBackupRestoreSchema.parse({
      targetHostId: sampleHostId,
      targetPath: "/srv/app/data"
    });
    expect(restore.targetPath).toBe("/srv/app/data");
    expect(restore.overwrite).toBe(false);

    const action = dockerActionSchema.parse({
      type: "hostPath.backup",
      hostId: sampleHostId,
      payload: { backupId: sampleHostId, sourcePath: "/srv/app/data" }
    });
    expect(action.payload.sourcePath).toBe("/srv/app/data");

    for (const bad of ["relative/path", "bad\npath", "bad\0path"]) {
      expect(() => hostPathBackupRestoreSchema.parse({ targetHostId: sampleHostId, targetPath: bad })).toThrow();
    }
  });

  it("validates backup encryption and pagination inputs", () => {
    const backup = backupCreateSchema.parse({
      hostId: sampleHostId,
      volumeName: "app_data",
      encryption: "app_secret"
    });
    expect(backup.encryption).toBe("app_secret");
    expect(backupCreateSchema.parse({ hostId: sampleHostId, volumeName: "app_data" }).encryption).toBe("none");
    expect(() => backupCreateSchema.parse({ hostId: sampleHostId, volumeName: "app_data", encryption: "passphrase" })).toThrow();

    const schedule = backupScheduleCreateSchema.parse({
      kind: "volume",
      hostId: sampleHostId,
      volumeName: "app_data",
      encryption: "app_secret",
      intervalMs: 300_000
    });
    expect(schedule.encryption).toBe("app_secret");

    const page = backupListQuerySchema.parse({ limit: "25", offset: "50", kind: "host_path" });
    expect(page).toMatchObject({ limit: 25, offset: 50, kind: "host_path" });
  });

  it("keeps container-run mounts limited to named Docker volumes", () => {
    const run = dockerActionSchema.parse({
      type: "container.run",
      hostId: sampleHostId,
      payload: {
        image: "nginx:alpine",
        volumes: [{ volumeName: "app_data", containerPath: "/var/lib/app" }]
      }
    });
    expect(run.payload.volumes[0]?.volumeName).toBe("app_data");

    for (const bad of ["/host/path", "app:/etc", "../escape", "bad name"]) {
      expect(() => dockerActionSchema.parse({
        type: "container.run",
        hostId: sampleHostId,
        payload: {
          image: "nginx:alpine",
          volumes: [{ volumeName: bad, containerPath: "/var/lib/app" }]
        }
      })).toThrow();
    }
  });

  it("documents all network drivers exposed by the UI", () => {
    expect(Object.keys(networkDriverExplanations)).toEqual(["bridge", "host", "overlay", "macvlan", "ipvlan", "none"]);
  });

  it("includes the expanded built-in catalog set", () => {
    const ids = new Set(catalogTemplates.map((template) => template.id));
    for (const id of ["nextcloud", "jellyfin", "home-assistant", "vaultwarden", "grafana", "prometheus", "node-red", "minio", "mariadb", "mongodb", "caddy", "traefik", "pihole", "adguard-home"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("validates custom catalog template input", () => {
    const template = customCatalogTemplateInputSchema.parse({
      id: "home-lab-app",
      name: "Home Lab App",
      description: "Reusable local compose template",
      category: "utility",
      composeYaml: "services:\n  app:\n    image: nginx:alpine"
    });
    expect(template.defaultEnv).toEqual({});
    expect(template.suggestedPorts).toEqual([]);
    expect(template.suggestedVolumes).toEqual([]);
    expect(() => customCatalogTemplateInputSchema.parse({
      id: "Bad App",
      name: "Bad App",
      description: "Invalid id",
      category: "utility",
      composeYaml: "services: {}"
    })).toThrow();
  });

  it("parses external catalog query values from URLs", () => {
    expect(externalCatalogQuerySchema.parse({ limit: "50", includeArchived: "false" })).toMatchObject({
      source: "awesome-selfhosted",
      limit: 50,
      includeArchived: false
    });
    expect(externalCatalogQuerySchema.parse({ includeArchived: "true" }).includeArchived).toBe(true);
  });

  it("validates the unified Docker app contract", () => {
    const app = dockerAppSchema.parse({
      id: "git:00000000-0000-4000-8000-000000000123",
      hostId: "00000000-0000-4000-8000-000000000001",
      hostName: "Home Server",
      hostHostname: "homeserver.local",
      name: "Open WebUI",
      source: "git",
      status: "running",
      imageReferences: ["ghcr.io/open-webui/open-webui:main"],
      ports: "0.0.0.0:3000->8080/tcp",
      containerIds: ["open-webui"],
      primaryContainerId: "open-webui",
      stackId: "00000000-0000-4000-8000-000000000002",
      repositoryId: "00000000-0000-4000-8000-000000000003",
      repositoryUrl: "https://github.com/open-webui/open-webui",
      branch: "main",
      projectName: "openwebui",
      sourceLink: null,
      update: {
        status: "update_available",
        kind: "git",
        currentVersion: "abc123",
        availableVersion: "def456"
      },
      updatedAt: new Date(0).toISOString()
    });
    expect(app.source).toBe("git");
    expect(app.update.status).toBe("update_available");
    const link = appSourceLinkInputSchema.parse({
      sourceType: "git",
      repositoryUrl: "https://github.com/open-webui/open-webui",
      branch: "main",
      workingDir: "/srv/open-webui",
      composePath: "docker-compose.yml"
    });
    expect(link.sourceType).toBe("git");
    expect(appRenameInputSchema.parse({ name: " Example App " }).name).toBe("Example App");
    expect(() => appRenameInputSchema.parse({ name: "" })).toThrow();
    expect(() => appSourceLinkInputSchema.parse({ sourceType: "git", workingDir: "/srv/app" })).toThrow();
  });

  it("validates GitHub version discovery responses", () => {
    const versions = appGithubVersionsSchema.parse({
      repositoryUrl: "https://github.com/example/app",
      selectedRef: "main",
      currentCommitSha: "abc123",
      options: [
        {
          kind: "branch",
          name: "main",
          ref: "main",
          label: "main",
          commitSha: "def456",
          publishedAt: null,
          htmlUrl: null,
          selected: true,
          deployed: false,
          updateAvailable: true
        }
      ]
    });
    expect(versions.options[0]?.updateAvailable).toBe(true);
    expect(appGithubVersionSelectSchema.parse({ ref: "beta", kind: "branch" }).ref).toBe("beta");
  });
});
