import { describe, expect, it } from "vitest";
import { appGithubVersionSelectSchema, appGithubVersionsSchema, appSourceLinkInputSchema, backupCreateSchema, backupListQuerySchema, backupRestoreSchema, backupScheduleCreateSchema, catalogTemplates, configExportSchema, customCatalogTemplateInputSchema, dockerActionSchema, dockerAppSchema, externalCatalogQuerySchema, githubRepositoryBranchesRequestSchema, githubRepositoryCreateSchema, githubRepositoryDeploySchema, hostPathBackupRestoreSchema, loginRequestSchema, networkDriverExplanations, setupRequestSchema, validatePasswordStrength, volumeCloneSchema } from "./index.js";

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
      defaultHostId: "00000000-0000-4000-8000-000000000001"
    });
    expect(repo.branch).toBe("main");
    expect(repo.composePath).toBe("docker-compose.yml");
    expect(githubRepositoryBranchesRequestSchema.parse({ repositoryUrl: repo.repositoryUrl }).repositoryUrl).toBe(repo.repositoryUrl);
    expect(() => githubRepositoryCreateSchema.parse({ ...repo, projectName: "SampleApp" })).toThrow();
    expect(githubRepositoryDeploySchema.parse({ projectName: "sampleapp", composeYaml: "services: {}" }).projectName).toBe("sampleapp");
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
