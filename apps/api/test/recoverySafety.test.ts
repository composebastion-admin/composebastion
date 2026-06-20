import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async () => ({ rows: [] }))
}));

import {
  assertAllowedRestoreRoot,
  buildBindMountCaptureCommand,
  buildBindMountRestoreCommand,
  buildCloneContainerName,
  buildManagedRestoreBindPath,
  buildStandaloneContainerCreateCommand,
  MANAGED_RESTORE_ROOT
} from "../src/services/recoveryRestoreUtils.js";
import { buildContainerManifest } from "../src/services/recoveryManifest.js";

const standaloneContainer = {
  id: "abc",
  name: "worker-1",
  image: "nginx:alpine",
  state: "running",
  running: true,
  ports: [{ host: "8080", container: "80", protocol: "tcp" }],
  networks: ["bridge"],
  labels: { "com.example": "worker" },
  restartPolicy: "unless-stopped",
  env: ["FOO=bar"],
  volumes: [{ name: "demoapp_data", destination: "/data", readOnly: false }],
  bindMounts: [{ source: "/srv/app/data", destination: "/data", readOnly: false }],
  entrypoint: [],
  command: ["nginx", "-g", "daemon off;"],
  user: null,
  workingDir: "/app"
};

describe("restore root validation", () => {
  it("accepts the managed restore root and descendants", () => {
    expect(assertAllowedRestoreRoot()).toBe(MANAGED_RESTORE_ROOT);
    expect(assertAllowedRestoreRoot("/var/lib/dockermender/restores/rp-1")).toBe(
      "/var/lib/dockermender/restores/rp-1"
    );
  });

  it("rejects unsafe restore roots", () => {
    for (const root of ["/", "/etc", "/root", "/var/lib/docker", "/tmp/../../etc"]) {
      expect(() => assertAllowedRestoreRoot(root)).toThrow("not allowed");
    }
  });
});

describe("bind mount capture and restore paths", () => {
  it("builds managed restore bind paths for clone restore", () => {
    expect(buildManagedRestoreBindPath("/var/lib/dockermender/restores", "rp-1", "/srv/app/data"))
      .toBe("/var/lib/dockermender/restores/rp-1/srv_app_data");
  });

  it("captures and restores bind archives into the exact managed target directory", () => {
    const source = "/srv/app/data";
    const target = buildManagedRestoreBindPath(MANAGED_RESTORE_ROOT, "rp-1", source);
    expect(buildBindMountCaptureCommand(source)).toBe("tar czf - -C '/srv/app/data' .");
    expect(buildBindMountRestoreCommand(target)).toBe(
      "mkdir -p '/var/lib/dockermender/restores/rp-1/srv_app_data' && tar xzf - -C '/var/lib/dockermender/restores/rp-1/srv_app_data'"
    );
  });
});

describe("standalone container restore commands", () => {
  it("builds docker create commands with remapped volumes, binds, and ports", () => {
    const projectName = "worker-restore-abc12345";
    const name = buildCloneContainerName("worker-1", projectName);
    const command = buildStandaloneContainerCreateCommand({
      container: standaloneContainer,
      name,
      volumeMap: { demoapp_data: `${projectName}_demoapp_data` },
      bindMap: {
        "/srv/app/data": buildManagedRestoreBindPath(MANAGED_RESTORE_ROOT, "rp-1", "/srv/app/data")
      },
      portRemap: { "8080": "18081" }
    });

    expect(command).toContain(`--name '${name}'`);
    expect(command).toContain(`${projectName}_demoapp_data:/data`);
    expect(command).toContain("/var/lib/dockermender/restores/rp-1/srv_app_data:/data");
    expect(command).toContain("-p '18081:80/tcp'");
    expect(command).toContain("'nginx:alpine'");
    expect(command).toContain("'nginx'");
  });

  it("uses manifest-derived Docker inspect ports in docker create commands", () => {
    const container = buildContainerManifest({
      Id: "abc",
      Name: "/web",
      State: { Running: true, Status: "running" },
      Config: { Image: "nginx:alpine", Env: [], Labels: {} },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
      NetworkSettings: {
        Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
        Networks: { bridge: {} }
      },
      Mounts: []
    });

    const command = buildStandaloneContainerCreateCommand({
      container,
      name: buildCloneContainerName("web", "web-restore-abc12345"),
      volumeMap: {},
      bindMap: {},
      portRemap: {}
    });

    expect(command).toContain("-p '8080:80/tcp'");
    expect(command).not.toContain("8080:tcp/80");
  });
});

describe("in-place restore guard", () => {
  it("rejects in_place restore before mutating host state", async () => {
    const { runRecoveryRestore } = await import("../src/services/recoveryRestore.js");
    await expect(runRecoveryRestore("00000000-0000-4000-8000-000000000099", {
      recoveryPointId: "00000000-0000-4000-8000-000000000001",
      targetHostId: "00000000-0000-4000-8000-000000000099",
      options: { mode: "in_place" }
    })).rejects.toThrow("In-place restore is disabled");
  });
});
