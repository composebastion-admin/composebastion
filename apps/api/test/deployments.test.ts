import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  canonicalizeDeploymentSource,
  detectDeploymentSourceType,
  extractDeploymentVariables,
  generatedDockerfileCompose,
  lanComposeResolver,
  mergeDockerDaemonRegistryTrust,
  selectComposeCandidates,
  selectGeneratedHostPorts
} from "../src/services/deployments.js";

describe("universal deployment source detection", () => {
  it.each([
    ["https://github.com/acme/app", "git"],
    ["http://10.0.21.40:3000/kobuslabs/linuxclitogui", "git"],
    ["git@gitlab.example:team/app.git", "git"],
    ["https://example.test/compose.yaml", "compose_url"],
    ["ghcr.io/example/app:latest", "image"],
    ["http://10.0.21.40:3000/acme/app:latest", "image"],
    ["services:\n  app:\n    image: nginx", "compose_upload"]
  ])("detects %s as %s", (source, expected) => {
    expect(detectDeploymentSourceType(source)).toBe(expected);
  });

  it("strips an explicit registry protocol from image references", () => {
    expect(canonicalizeDeploymentSource("http://10.0.21.40:3000/acme/app:latest", "image"))
      .toBe("10.0.21.40:3000/acme/app:latest");
  });

  it("rejects credentials embedded in manually selected URL sources", () => {
    expect(() => canonicalizeDeploymentSource("https://user:token@git.example.test/team/app", "git"))
      .toThrow("URLs containing credentials");
  });
});

describe("Compose analysis helpers", () => {
  it("prioritizes root Compose files in the documented order", () => {
    expect(selectComposeCandidates([
      "examples/compose.yaml",
      "docker-compose.yml",
      "compose.yml",
      "compose.yaml"
    ])).toEqual([
      "compose.yaml",
      "compose.yml",
      "docker-compose.yml",
      "examples/compose.yaml"
    ]);
  });

  it("generates a persistent Dockerfile Compose draft", () => {
    const compose = parse(generatedDockerfileCompose(`
      FROM node:24
      EXPOSE 80 3000/tcp
      VOLUME ["/data"]
    `));
    expect(compose.services.app).toMatchObject({
      build: ".",
      restart: "unless-stopped",
      ports: ["8080:80", "3000:3000"],
      volumes: ["app-data-1:/data"]
    });
    expect(compose.volumes).toHaveProperty("app-data-1");
  });

  it("keeps secret-looking values blank while retaining safe defaults", () => {
    const variables = extractDeploymentVariables(
      "services:\n  app:\n    image: acme/app:${TAG:-latest}\n    environment:\n      API_TOKEN: ${API_TOKEN}\n",
      "TAG=stable\nAPI_TOKEN=do-not-return\nPORT=3000\n"
    );
    expect(variables.find((item) => item.key === "TAG")).toMatchObject({
      value: "stable",
      secret: false
    });
    expect(variables.find((item) => item.key === "API_TOKEN")).toMatchObject({
      value: "",
      secret: true,
      required: true
    });
    expect(variables.find((item) => item.key === "PORT")).toMatchObject({
      value: "3000",
      secret: false
    });
  });

  it("maps privileged web ports and increments occupied ports", () => {
    expect(selectGeneratedHostPorts([80, 443, 3000], new Set([8080, 3000]))).toEqual([
      { containerPort: 80, hostPort: 8081 },
      { containerPort: 443, hostPort: 8443 },
      { containerPort: 3000, hostPort: 3001 }
    ]);
  });

  it("allows RFC1918 Compose sources but blocks loopback and metadata ranges", async () => {
    await expect(lanComposeResolver("10.0.21.40")).resolves.toEqual([{ address: "10.0.21.40", family: 4 }]);
    await expect(lanComposeResolver("127.0.0.1")).rejects.toThrow("blocked address");
    await expect(lanComposeResolver("169.254.169.254")).rejects.toThrow("blocked address");
    await expect(lanComposeResolver("::ffff:127.0.0.1")).rejects.toThrow("blocked address");
    await expect(lanComposeResolver("::ffff:7f00:1")).rejects.toThrow("blocked address");
  });

  it("merges insecure registry trust without discarding daemon settings", () => {
    expect(mergeDockerDaemonRegistryTrust({
      "log-driver": "local",
      "features": { containerdSnapshotter: true },
      "insecure-registries": ["registry.old.test:5000"]
    }, "10.0.21.40:3000")).toEqual({
      "log-driver": "local",
      "features": { containerdSnapshotter: true },
      "insecure-registries": ["10.0.21.40:3000", "registry.old.test:5000"]
    });
  });
});
