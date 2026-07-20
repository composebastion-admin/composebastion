import { describe, expect, it } from "vitest";
import {
  buildComposeServiceBindMounts,
  buildCloneRestoreProjectName,
  buildCloneVolumeName,
  buildComposeProjectVolumeName,
  buildManagedRestoreBindPath,
  composeVolumeNameFromEngineName,
  buildPortRemap,
  detectPortConflicts,
  extractPublishedPorts,
  remapComposeYaml,
  resolveRestoredBindMountPath,
  resolveHostFolderRestorePath,
  shouldRestartSourceAfterFailure
} from "../src/services/recoveryRestoreUtils.js";
import type { ContainerManifest } from "../src/services/recoveryManifest.js";

function manifestContainer(input: {
  id: string;
  service: string;
  source: string;
  destination: string;
}): ContainerManifest {
  return {
    id: input.id,
    name: input.id,
    image: "alpine",
    state: "running",
    running: true,
    ports: [],
    networks: ["bridge"],
    labels: { "com.docker.compose.service": input.service },
    restartPolicy: "no",
    env: [],
    volumes: [],
    bindMounts: [{ source: input.source, destination: input.destination, readOnly: false }],
    entrypoint: [],
    command: [],
    user: null,
    workingDir: null
  };
}

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

  it("forces same-host Compose artifacts beneath the managed restore root", () => {
    expect(resolveHostFolderRestorePath({
      restoreRoot: "/var/lib/composebastion/restores",
      recoveryPointId: "rp-1",
      sourcePath: "/home/docker/DemoApp",
      restorePath: "/home/docker/DemoApp",
      forceManaged: true
    })).toBe("/var/lib/composebastion/restores/rp-1/home_docker_DemoApp");
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

    expect(result).toContain("data:/data");
    expect(result).toContain("source: /var/lib/composebastion/restores/rp-1/srv_app");
    expect(result).toMatch(/published: ["']?18081["']?/);
    expect(result).toMatch(/^\s{2}data:\s*$/m);
    expect(result).toContain("name: demo-restore_data");
    expect(result).not.toMatch(/^\s+external: true\s*$/m);
    expect(result).toContain("demo-restore_frontend:");
    expect(result).toContain("name: demo-restore_frontend");
    expect(result).toContain("ipv4_address: 172.28.0.10");
  });

  it("remaps Docker Desktop bind aliases back to their managed restore paths", () => {
    const yaml = [
      "services:",
      "  short:",
      "    image: alpine",
      "    volumes:",
      "      - /tmp/composebastion-data:/data",
      "  structured:",
      "    image: alpine",
      "    volumes:",
      "      - type: bind",
      "        source: /private/tmp/composebastion-data",
      "        target: /data"
    ].join("\n");
    const restoredPath = "/var/lib/composebastion/restores/rp-1/host_mnt_private_tmp_composebastion-data";

    const result = remapComposeYaml(yaml, {
      bindMounts: {
        "/host_mnt/private/tmp/composebastion-data": restoredPath
      }
    });

    expect(result.match(new RegExp(restoredPath, "g"))).toHaveLength(2);
    expect(result).not.toContain("/tmp/composebastion-data:/data");
    expect(result).not.toContain("source: /private/tmp/composebastion-data");
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

  it("mounts the exact pre-restored volume instead of a project-prefixed empty volume", () => {
    const yaml = [
      "services:",
      "  workload:",
      "    image: alpine",
      "    volumes:",
      "      - workload-data:/data",
      "volumes:",
      "  workload-data:"
    ].join("\n");

    const result = remapComposeYaml(yaml, {
      volumes: {
        "source_workload-data": "clone-restore-abc12345_workload-data",
        "workload-data": "clone-restore-abc12345_workload-data"
      }
    });

    expect(result).toContain("workload-data:/data");
    expect(result).toContain("name: clone-restore-abc12345_workload-data");
    expect(result).not.toContain("clone-restore-abc12345_clone-restore-abc12345-workload-data");
    expect(result).not.toContain("external: true");
  });

  it("maps Compose keys backed by explicitly named source volumes", () => {
    const yaml = [
      "services:",
      "  workload:",
      "    image: alpine",
      "    volumes:",
      "      - data:/data",
      "volumes:",
      "  data:",
      "    name: shared-source-data",
      "    external: true"
    ].join("\n");

    const result = remapComposeYaml(yaml, {
      volumes: { "shared-source-data": "clone-restore-abc12345_data" }
    });

    expect(result).toContain("data:/data");
    expect(result).toContain("name: clone-restore-abc12345_data");
    expect(result).not.toContain("shared-source-data");
    expect(result).not.toContain("external: true");
  });
});

describe("destination-aware Compose bind remapping", () => {
  it("derives nested bind targets from the longest restored parent artifact", () => {
    const bindMounts = {
      "/srv/project": "/var/lib/composebastion/restores/rp-1/project",
      "/srv/project/data": "/var/lib/composebastion/restores/rp-1/project-data",
      "/srv/projected": "/var/lib/composebastion/restores/rp-1/projected"
    };

    expect(resolveRestoredBindMountPath("/srv/project/data/cache", bindMounts))
      .toBe("/var/lib/composebastion/restores/rp-1/project-data/cache");
    expect(resolveRestoredBindMountPath("/srv/project/config", bindMounts))
      .toBe("/var/lib/composebastion/restores/rp-1/project/config");
    expect(resolveRestoredBindMountPath("/srv/project-other/data", bindMounts)).toBeUndefined();
  });

  it("derives nested targets through Docker Desktop aliases", () => {
    expect(resolveRestoredBindMountPath("/tmp/project/data", {
      "/host_mnt/private/tmp/project": "/var/lib/composebastion/restores/rp-1/project"
    })).toBe("/var/lib/composebastion/restores/rp-1/project/data");
  });

  it("rewrites a relative Compose bind from its captured working-directory artifact", () => {
    const containers = [manifestContainer({
      id: "one",
      service: "workload",
      source: "/srv/project/data",
      destination: "/data"
    })];
    const serviceBindMounts = buildComposeServiceBindMounts(containers, {
      "/srv/project": "/var/lib/composebastion/restores/rp-1/project"
    });
    const result = remapComposeYaml([
      "services:",
      "  workload:",
      "    image: alpine",
      "    volumes:",
      "      - './data:/data:ro'"
    ].join("\n"), { serviceBindMounts });

    expect(result).toContain("/var/lib/composebastion/restores/rp-1/project/data:/data:ro");
    expect(result).not.toContain("./data:/data");
  });

  it("rewrites interpolated, defaulted, relative, and structured bind sources", () => {
    const yaml = [
      "services:",
      "  workload:",
      "    image: alpine",
      "    volumes:",
      "      - '${DATA_DIR}:/data:ro,z'",
      "      - './cache:/cache'",
      "      - type: bind",
      "        source: ${CONFIG_DIR:-/srv/config}",
      "        target: /config",
      "        read_only: true",
      "        bind:",
      "          create_host_path: false"
    ].join("\n");

    const result = remapComposeYaml(yaml, {
      serviceBindMounts: new Map([["workload", new Map([
        ["/data", "/var/lib/composebastion/restores/rp-1/data"],
        ["/cache", "/var/lib/composebastion/restores/rp-1/cache"],
        ["/config", "/var/lib/composebastion/restores/rp-1/config"]
      ])]])
    });

    expect(result).toContain("/var/lib/composebastion/restores/rp-1/data:/data:ro,z");
    expect(result).toContain("/var/lib/composebastion/restores/rp-1/cache:/cache");
    expect(result).toContain("source: /var/lib/composebastion/restores/rp-1/config");
    expect(result).toContain("target: /config");
    expect(result).toContain("read_only: true");
    expect(result).toContain("create_host_path: false");
    expect(result).not.toContain("${DATA_DIR}");
    expect(result).not.toContain("${CONFIG_DIR:-/srv/config}");
  });

  it("coalesces matching replicas and rejects conflicting restored paths", () => {
    const replicas = [
      manifestContainer({ id: "one", service: "workload", source: "/srv/data", destination: "/data" }),
      manifestContainer({ id: "two", service: "workload", source: "/srv/data", destination: "/data" })
    ];
    expect(buildComposeServiceBindMounts(replicas, {
      "/srv/data": "/var/lib/composebastion/restores/rp-1/data"
    })).toEqual(new Map([["workload", new Map([
      ["/data", "/var/lib/composebastion/restores/rp-1/data"]
    ])]]));

    const conflicting = [
      replicas[0],
      manifestContainer({ id: "two", service: "workload", source: "/srv/other", destination: "/data" })
    ];
    expect(() => buildComposeServiceBindMounts(conflicting, {
      "/srv/data": "/var/lib/composebastion/restores/rp-1/data",
      "/srv/other": "/var/lib/composebastion/restores/rp-1/other"
    })).toThrow("conflicting restored paths");
  });

  it("fails closed when a required service destination is missing or YAML is invalid", () => {
    const serviceBindMounts = new Map([["workload", new Map([
      ["/data", "/var/lib/composebastion/restores/rp-1/data"]
    ])]]);
    expect(() => remapComposeYaml("services:\n  workload:\n    image: alpine", {
      serviceBindMounts
    })).toThrow("workload:/data");
    expect(() => remapComposeYaml("services:\n  workload: [", {
      serviceBindMounts
    })).toThrow("could not be parsed");
  });

  it("supports service names that are properties on Object.prototype", () => {
    const serviceNames = ["__proto__", "constructor", "hasOwnProperty"];
    const containers = serviceNames.map((service, index) => manifestContainer({
      id: `container-${index}`,
      service,
      source: `/srv/${service}`,
      destination: "/data"
    }));
    const bindMounts = Object.fromEntries(serviceNames.map((service) => [
      `/srv/${service}`,
      `/var/lib/composebastion/restores/rp-1/${service}`
    ]));
    const mappings = buildComposeServiceBindMounts(containers, bindMounts);

    expect([...mappings.keys()]).toEqual(serviceNames);
    for (const service of serviceNames) {
      expect(mappings.get(service)?.get("/data"))
        .toBe(`/var/lib/composebastion/restores/rp-1/${service}`);
    }
    expect(({} as Record<string, unknown>)["/data"]).toBeUndefined();

    const result = remapComposeYaml([
      "services:",
      ...serviceNames.flatMap((service) => [
        `  ${service}:`,
        "    image: alpine",
        "    volumes:",
        "      - '${DATA_DIR}:/data'"
      ])
    ].join("\n"), { serviceBindMounts: mappings });
    for (const service of serviceNames) {
      expect(result).toContain(`/var/lib/composebastion/restores/rp-1/${service}:/data`);
    }
  });

  it("rejects missing service identity, destination, and restored artifact coverage", () => {
    const base = manifestContainer({
      id: "unsafe-container",
      service: "workload",
      source: "/srv/data",
      destination: "/data"
    });
    expect(() => buildComposeServiceBindMounts([{ ...base, labels: {} }], {
      "/srv/data": "/var/lib/composebastion/restores/rp-1/data"
    })).toThrow("unsafe-container from /srv/data: the com.docker.compose.service label is missing or blank");
    expect(() => buildComposeServiceBindMounts([{ ...base, labels: { "com.docker.compose.service": " " } }], {
      "/srv/data": "/var/lib/composebastion/restores/rp-1/data"
    })).toThrow("label is missing or blank");
    expect(() => buildComposeServiceBindMounts([{
      ...base,
      bindMounts: [{ ...base.bindMounts[0]!, destination: "" }]
    }], {
      "/srv/data": "/var/lib/composebastion/restores/rp-1/data"
    })).toThrow("unsafe-container from /srv/data: the inspected destination is empty");
    expect(() => buildComposeServiceBindMounts([base], {}))
      .toThrow("no completed restored host-folder artifact covers the inspected source");
  });

  it("rejects ambiguous restored artifacts and explicit non-bind long syntax", () => {
    const container = manifestContainer({
      id: "one",
      service: "workload",
      source: "/tmp/project",
      destination: "/data"
    });
    expect(() => buildComposeServiceBindMounts([container], {
      "/host_mnt/private/tmp/project": "/var/lib/composebastion/restores/rp-1/one",
      "/private/tmp/project": "/var/lib/composebastion/restores/rp-1/two"
    })).toThrow("are ambiguous");

    const mappings = new Map([["workload", new Map([
      ["/data", "/var/lib/composebastion/restores/rp-1/data"]
    ])]]);
    expect(() => remapComposeYaml([
      "services:",
      "  workload:",
      "    image: alpine",
      "    volumes:",
      "      - type: volume",
      "        source: data",
      "        target: /data",
      "volumes:",
      "  data:"
    ].join("\n"), { serviceBindMounts: mappings }))
      .toThrow("workload:/data");
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
