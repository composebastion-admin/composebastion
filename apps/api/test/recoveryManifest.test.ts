import { describe, expect, it } from "vitest";
import {
	  bindMountArtifactName,
	  buildContainerManifest,
	  buildNetworkManifest,
	  buildRecoveryManifest,
  composeWorkingDirHostFolder,
  containersToRestart,
  filterBindMounts,
  isAllowedBindMountPath,
  isHostPathInside,
  recordRunningStates,
  wasAnyContainerRunning
} from "../src/services/recoveryManifest.js";

describe("recovery manifest", () => {
  it("filters dangerous bind mount paths", () => {
    expect(isAllowedBindMountPath("/srv/app/data")).toBe(true);
    expect(isAllowedBindMountPath("/etc/passwd")).toBe(false);
    expect(isAllowedBindMountPath("/var/lib/docker/volumes/app/_data")).toBe(false);
    expect(isAllowedBindMountPath("/var/run/docker.sock")).toBe(false);
    expect(isAllowedBindMountPath("/../etc/passwd")).toBe(false);

    const allowed = filterBindMounts([
      { source: "/srv/app/data", destination: "/data", readOnly: false },
      { source: "/etc/nginx/nginx.conf", destination: "/etc/nginx/nginx.conf", readOnly: true }
    ]);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].source).toBe("/srv/app/data");
  });

  it("models compose working directories as same-path host folders", () => {
    expect(composeWorkingDirHostFolder("/home/docker/DemoApp")).toMatchObject({
      source: "/home/docker/DemoApp",
      role: "compose_working_dir",
      restorePath: "/home/docker/DemoApp"
    });
    expect(composeWorkingDirHostFolder("/var/run/docker.sock")).toBeNull();
    expect(isHostPathInside("/home/docker/DemoApp", "/home/docker/DemoApp/data")).toBe(true);
    expect(isHostPathInside("/home/docker/DemoApp", "/home/docker/Other")).toBe(false);
  });

  it("builds container manifests from docker inspect output", () => {
    const manifest = buildContainerManifest({
      Id: "abc123",
      Name: "/web",
      State: { Running: true, Status: "running" },
      Config: {
        Image: "nginx:1.27-alpine",
        Env: ["FOO=bar"],
        Labels: { "com.docker.compose.project": "demoapp" }
      },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
      NetworkSettings: {
        Ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
        Networks: { bridge: {} }
      },
      Mounts: [
        { Type: "volume", Name: "demoapp_data", Destination: "/data", RW: true },
        { Type: "bind", Source: "/srv/app/config", Destination: "/config", RW: true },
        { Type: "bind", Source: "/etc/hosts", Destination: "/etc/hosts", RW: true }
      ]
    });

    expect(manifest.image).toBe("nginx:1.27-alpine");
    expect(manifest.volumes).toHaveLength(1);
    expect(manifest.bindMounts).toHaveLength(1);
    expect(manifest.labels["com.docker.compose.project"]).toBe("demoapp");
    expect(manifest.ports[0].host).toBe("8080");
    expect(manifest.ports[0]).toEqual({ host: "8080", container: "80", protocol: "tcp" });
  });

  it("builds network manifests with IPAM data", () => {
    const network = buildNetworkManifest({
      Id: "net123",
      Name: "demo_frontend",
      Driver: "bridge",
      Scope: "local",
      Internal: false,
      Attachable: true,
      EnableIPv6: false,
      IPAM: {
        Driver: "default",
        Options: { "com.docker.network.bridge.name": "br-demo" },
        Config: [{ Subnet: "172.28.0.0/16", Gateway: "172.28.0.1" }]
      },
      Labels: { app: "demo" },
      Options: { encrypted: "false" }
    });

    expect(network).toMatchObject({
      name: "demo_frontend",
      id: "net123",
      driver: "bridge",
      attachable: true,
      ipam: {
        driver: "default",
        config: [{ Subnet: "172.28.0.0/16", Gateway: "172.28.0.1" }]
      },
      labels: { app: "demo" }
    });
  });

  it("records running state and restart targets for stop-first mode", () => {
    const states = recordRunningStates([
      { id: "a", inspect: { Name: "/web", State: { Running: true } } },
      { id: "b", inspect: { Name: "/worker", State: { Running: false } } }
    ]);
    expect(wasAnyContainerRunning(states)).toBe(true);
    expect(containersToRestart(states)).toEqual(["a"]);
    expect(bindMountArtifactName("/srv/app/data")).toBe("srv_app_data");
  });

  it("builds a recovery manifest with docker versions and artifacts", () => {
    const manifest = buildRecoveryManifest({
      recoveryPointId: "00000000-0000-4000-8000-000000000001",
      hostId: "00000000-0000-4000-8000-000000000002",
      appIdentity: { kind: "compose", projectName: "demoapp" },
      captureMode: "stop-first",
      originalRunningState: [{ id: "a", name: "web", running: true }],
      docker: { serverVersion: "29.0.0", composeVersion: "2.34.0" },
	      compose: {
        projectName: "demoapp",
        stackId: null,
        workingDir: "/srv/demoapp",
        composePath: "docker-compose.yml",
        yaml: "services:\n  web:\n    image: nginx\n",
        env: "FOO=bar\n"
	      },
	      containers: [],
	      networks: [buildNetworkManifest({ Name: "demoapp_frontend", Driver: "bridge" })],
	      artifacts: [{ kind: "volume", storageKey: "volumes/data.tar.gz", metadata: { volumeName: "data" } }]
	    });

    expect(manifest.version).toBe(2);
    expect(manifest.captureMode).toBe("stop-first");
    expect(manifest.docker.composeVersion).toBe("2.34.0");
    expect(manifest.networks[0]?.name).toBe("demoapp_frontend");
    expect(manifest.restoreOptions.inPlaceRestoreEnabled).toBe(false);
    expect(manifest.artifacts).toHaveLength(1);
  });
});
