import { describe, expect, it } from "vitest";
import {
  buildCloneRestoreProjectName,
  buildCloneVolumeName,
  buildComposeProjectVolumeName,
  buildManagedRestoreBindPath,
  composeVolumeNameFromEngineName,
  buildPortRemap,
  detectPortConflicts,
  extractPublishedPorts,
  remapComposeYaml,
  resolveHostFolderRestorePath,
  shouldRestartSourceAfterFailure
} from "../src/services/recoveryRestoreUtils.js";

describe("recovery restore naming", () => {
  it("builds clone restore project names with short recovery id suffix", () => {
    const name = buildCloneRestoreProjectName("demoapp", "00000000-0000-4000-8000-000000000001");
    expect(name).toBe("demoapp-restore-00000000");
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it("derives new volume names for clone restore", () => {
    expect(buildCloneVolumeName("demoapp_data", "demoapp-restore-abc12345")).toContain("demoapp_data");
    expect(buildCloneVolumeName("demoapp_data", "demoapp-restore-abc12345")).not.toBe("demoapp_data");
  });

  it("derives compose project volume names from Docker engine volume names", () => {
    expect(composeVolumeNameFromEngineName("demoapp_data", "demoapp")).toBe("data");
    expect(composeVolumeNameFromEngineName("demoapp_demoapp_data", "demoapp")).toBe("demoapp_data");
    expect(buildComposeProjectVolumeName("demoapp-restore-abc12345", "data")).toBe("demoapp-restore-abc12345_data");
  });

  it("places bind mounts under a managed restore root", () => {
    expect(buildManagedRestoreBindPath("/var/lib/composebastion/restores", "rp-1", "/srv/app/data"))
      .toBe("/var/lib/composebastion/restores/rp-1/srv_app_data");
  });

  it("restores compose working directory artifacts to their original path", () => {
    expect(resolveHostFolderRestorePath({
      restoreRoot: "/var/lib/composebastion/restores",
      recoveryPointId: "rp-1",
      sourcePath: "/home/docker/DemoApp",
      restorePath: "/home/docker/DemoApp"
    })).toBe("/home/docker/DemoApp");
  });

  it("keeps ordinary bind mounts under the managed restore root", () => {
    expect(resolveHostFolderRestorePath({
      restoreRoot: "/var/lib/composebastion/restores",
      recoveryPointId: "rp-1",
      sourcePath: "/srv/app/data"
    })).toBe("/var/lib/composebastion/restores/rp-1/srv_app_data");
  });

  it("rejects unsafe same-path host folder restore targets", () => {
    expect(() => resolveHostFolderRestorePath({
      restoreRoot: "/var/lib/composebastion/restores",
      recoveryPointId: "rp-1",
      sourcePath: "/var/run/docker.sock",
      restorePath: "/var/run/docker.sock"
    })).toThrow("not allowed");
  });
});

describe("port conflict behavior", () => {
  it("detects occupied host ports on the target", () => {
    const sourcePorts = extractPublishedPorts([{
      id: "1",
      name: "demoapp-web-1",
      image: "nginx",
      state: "running",
      running: true,
      ports: [{ host: "8080", container: "80", protocol: "tcp" }],
      networks: ["bridge"],
      labels: {},
      restartPolicy: "unless-stopped",
      env: [],
      volumes: [],
      bindMounts: [],
      entrypoint: [],
      command: [],
      user: null,
      workingDir: null
    }]);
    const targetUsed = new Map([["8080/tcp", "other-web"]]);
    expect(detectPortConflicts(sourcePorts, targetUsed)).toEqual([{
      hostPort: "8080",
      protocol: "tcp",
      sourceContainer: "demoapp-web-1",
      reason: "Host port 8080/tcp is already used by other-web"
    }]);
  });

  it("builds remap suggestions for conflicting ports", () => {
    const remap = buildPortRemap([{
      hostPort: "8080",
      protocol: "tcp",
      sourceContainer: "demoapp-web-1",
      reason: "conflict"
    }], new Set(["8080/tcp", "18080/tcp"]));
    expect(remap["8080"]).toBe("18081");
  });

  it("rewrites compose publish mappings when remapping ports", () => {
    const yaml = "services:\n  web:\n    ports:\n      - \"8080:80\"";
    expect(remapComposeYaml(yaml, { portRemap: { "8080": "18081" } })).toContain("18081:80");
  });

  it("rewrites structured compose volumes, bind paths, and published ports", () => {
    const yaml = [
      "services:",
      "  web:",
      "    volumes:",
      "      - data:/data",
      "      - type: bind",
      "        source: /srv/app",
      "        target: /config",
      "    ports:",
      "      - target: 80",
      "        published: \"8080\"",
      "        protocol: tcp",
      "    networks:",
      "      frontend:",
      "        ipv4_address: 172.28.0.10",
      "volumes:",
      "  data: {}",
      "networks:",
      "  frontend:",
      "    ipam:",
      "      config:",
      "        - subnet: 172.28.0.0/16"
    ].join("\n");

    const result = remapComposeYaml(yaml, {
      volumes: { data: "demo-restore_data" },
      bindMounts: { "/srv/app": "/var/lib/composebastion/restores/rp-1/srv_app" },
      portRemap: { "8080": "18081" },
      networks: { frontend: "demo-restore_frontend" }
    });

    expect(result).toContain("demo-restore_data:/data");
    expect(result).toContain("source: /var/lib/composebastion/restores/rp-1/srv_app");
    expect(result).toMatch(/published: ["']?18081["']?/);
    expect(result).toContain("demo-restore_data:");
    expect(result).toContain("demo-restore_frontend:");
    expect(result).toContain("name: demo-restore_frontend");
    expect(result).toContain("ipv4_address: 172.28.0.10");
  });

  it("drops overlapping IPAM and static addresses for same-host clone networks", () => {
    const yaml = [
      "services:",
      "  web:",
      "    networks:",
      "      frontend:",
      "        ipv4_address: 172.28.0.10",
      "networks:",
      "  frontend:",
      "    driver: bridge",
      "    ipam:",
      "      config:",
      "        - subnet: 172.28.0.0/16"
    ].join("\n");

    const result = remapComposeYaml(yaml, {
      networks: { frontend: "demo-restore_frontend" },
      resetNetworkAddressing: true
    });

    expect(result).toContain("demo-restore_frontend:");
    expect(result).toContain("external: true");
    expect(result).not.toContain("ipv4_address");
    expect(result).not.toContain("172.28.0.0/16");
  });
});

describe("migration rollback source restart", () => {
  it("restarts source only when it was stopped during a move strategy", () => {
    expect(shouldRestartSourceAfterFailure({
      strategy: "safe_move",
      sourceWasStopped: true,
      sourceHadRunningContainers: true
    })).toBe(true);
    expect(shouldRestartSourceAfterFailure({
      strategy: "clone",
      sourceWasStopped: false,
      sourceHadRunningContainers: true
    })).toBe(false);
    expect(shouldRestartSourceAfterFailure({
      strategy: "warm_move",
      sourceWasStopped: true,
      sourceHadRunningContainers: false
    })).toBe(false);
  });
});
