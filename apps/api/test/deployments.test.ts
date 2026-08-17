import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  canonicalizeDeploymentSource,
  deploymentAnalysisInternals,
  detectDeploymentSourceType,
  extractDeploymentVariables,
  generatedDockerfileCompose,
  lanComposeResolver,
  mergeDockerDaemonRegistryTrust,
  normalizeRegistryTrustAuthority,
  selectComposeCandidates,
  selectGeneratedHostPorts
} from "../src/services/deployments.js";

const {
  iso,
  jsonValue,
  mapSource,
  mapAnalysis,
  projectName,
  displayName,
  sourceBasename,
  isYamlText,
  isGitLikeUrl,
  homeDeploymentRoot,
  scalar,
  summarizedPort,
  summarizeCompose,
  parseEnvText,
  rawEnvValues,
  serializeEnv,
  sanitizeEnvForResponse,
  mergeStoredAnalysisEnv,
  mergeRequestedEnv,
  variablesToEnv,
  referencedImages,
  normalizedGitUrl,
  imageAuthority,
  parseImageInspect,
  declaredHostPort,
  dockerRegistryTrust
} = deploymentAnalysisInternals;

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
      .toThrow("Repository URL must not contain credentials");
    for (const [source, sourceType] of [
      ["https://git.example.test/team/app.git?token=secret", "git"],
      ["ssh://git:secret@git.example.test/team/app.git", "git"],
      ["git://git:secret@git.example.test/team/app.git", "git"],
      ["https://compose-user:secret@example.test/compose.yaml", "compose_url"],
      ["https://example.test/compose.yaml?token=secret", "compose_url"],
      ["https://example.test/compose.yaml#secret", "compose_url"]
    ] as const) {
      expect(() => canonicalizeDeploymentSource(source, sourceType)).toThrow();
    }
  });
});

describe("Compose analysis helpers", () => {
  it("preserves exact Git filenames from NUL-delimited source inventory", () => {
    expect(deploymentAnalysisInternals.trackedGitFiles(
      "compose.yaml\0dir/line\nbreak.env\0 leading-space\0unicodé.env\0"
    )).toEqual([
      "compose.yaml",
      "dir/line\nbreak.env",
      " leading-space",
      "unicodé.env"
    ]);
  });

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

describe("deployment analyzer parsing and redaction branches", () => {
  it("maps persisted sources and analyses into redacted API records", () => {
    const timestamp = "2026-07-25T00:00:00.000Z";
    expect(iso(timestamp)).toBe(timestamp);
    expect(iso(null)).toBeNull();
    expect(jsonValue({ ok: true }, {})).toEqual({ ok: true });
    expect(jsonValue(null, { fallback: true })).toEqual({ fallback: true });

    expect(mapSource({
      id: "21212121-2121-4121-8121-212121212121",
      source_type: "git",
      name: "Example App",
      source_locator: "https://git.example.test/team/app",
      branch: null,
      compose_path: null,
      working_dir: null,
      project_name: "example-app",
      default_host_id: null,
      target_host_ids: null,
      env_encrypted: null,
      credential_secret_encrypted: null,
      metadata: null,
      last_deployed_at: null,
      created_at: timestamp,
      updated_at: timestamp
    })).toMatchObject({
      name: "Example App",
      branch: null,
      targetHostIds: [],
      safeEnvironment: {},
      hasCredential: false,
      metadata: {},
      lastDeployedAt: null,
      createdAt: timestamp
    });

    const legacySource = mapSource({
      id: "23232323-2323-4232-8232-232323232323",
      source_type: "git",
      name: "Legacy App",
      source_locator: "https://git-user:git-secret@git.example.test/team/app.git?token=git-secret",
      branch: null,
      compose_path: null,
      working_dir: null,
      project_name: "legacy-app",
      default_host_id: null,
      target_host_ids: [],
      env_encrypted: null,
      credential_secret_encrypted: null,
      metadata: {},
      last_deployed_at: null,
      created_at: timestamp,
      updated_at: timestamp
    });
    expect(legacySource.sourceLocator).toBe("https://git.example.test/team/app.git");

    const mapped = mapAnalysis({
      id: "22222222-2222-4222-8222-222222222222",
      host_id: "11111111-1111-4111-8111-111111111111",
      source_id: null,
      source_type: "image",
      source_input: "nginx:latest",
      source_locator: "nginx:latest",
      status: "ready",
      display_name: null,
      project_name: null,
      branch: null,
      compose_path: null,
      working_dir: null,
      compose_yaml: null,
      env_encrypted: null,
      summary: null,
      variables: null,
      warnings: null,
      blockers: null,
      registry_issues: null,
      error: null,
      expires_at: "2999-07-25T00:00:00.000Z",
      created_at: timestamp,
      updated_at: timestamp,
      deployed_at: null
    });
    expect(mapped).toMatchObject({
      status: "ready",
      displayName: null,
      env: "",
      summary: {
        services: [],
        composeCandidates: [],
        dockerfileGenerated: false,
        trackedEnvFile: false
      },
      variables: [],
      warnings: [],
      blockers: [],
      registryIssues: [],
      deployedAt: null
    });
    const legacyAnalysis = mapAnalysis({
      id: "24242424-2424-4242-8242-242424242424",
      host_id: mapped.hostId,
      source_id: null,
      source_type: "compose_url",
      source_input: "https://compose-user:compose-secret@example.test/compose.yaml?token=compose-secret",
      source_locator: "https://compose-user:compose-secret@example.test/compose.yaml#compose-secret",
      status: "failed",
      display_name: null,
      project_name: null,
      branch: null,
      compose_path: null,
      working_dir: null,
      compose_yaml: null,
      env_encrypted: null,
      summary: null,
      variables: null,
      warnings: null,
      blockers: null,
      registry_issues: null,
      error: "Fetch failed for https://compose-user:compose-secret@example.test/compose.yaml?token=compose-secret",
      expires_at: "2999-07-25T00:00:00.000Z",
      created_at: timestamp,
      updated_at: timestamp,
      deployed_at: null
    });
    expect(legacyAnalysis).toMatchObject({
      sourceInput: "https://example.test/compose.yaml",
      sourceLocator: "https://example.test/compose.yaml",
      error: "Fetch failed for https://example.test/compose.yaml"
    });
    expect(mapAnalysis({
      ...{
        id: mapped.id,
        host_id: mapped.hostId,
        source_type: mapped.sourceType,
        source_input: mapped.sourceInput,
        status: "failed",
        expires_at: "2000-01-01T00:00:00.000Z",
        created_at: timestamp,
        updated_at: timestamp
      }
    }).status).toBe("expired");
  });

  it("normalizes safe project and display names", () => {
    expect(projectName("My Fancy.App.git")).toBe("my-fancy-app");
    expect(projectName("___")).toBe("deployed-app");
    expect(projectName(`A${"b".repeat(100)}`)).toHaveLength(80);
    expect(displayName("my_fancy-app.git")).toBe("My Fancy App");
    expect(displayName("")).toBe("Deployed App");
  });

  it("extracts source names from URL and SCP-like Git forms", () => {
    expect(sourceBasename("https://git.example.test/team/app.git/")).toBe("app.git");
    expect(sourceBasename("git@git.example.test:team/app.git")).toBe("app.git");
    expect(sourceBasename("https://git.example.test/")).toBe("git.example.test");
  });

  it("distinguishes YAML, Git URLs, and direct Compose URLs", () => {
    expect(isYamlText("---\nname: app\nservices:\n  app: {}")).toBe(true);
    expect(isYamlText("name: app")).toBe(false);
    expect(isGitLikeUrl("ssh://git@git.example.test/team/app.git")).toBe(true);
    expect(isGitLikeUrl("git@git.example.test:team/app.git")).toBe(true);
    expect(isGitLikeUrl("https://git.example.test/team/app")).toBe(true);
    expect(isGitLikeUrl("https://example.test/compose.yaml")).toBe(false);
    expect(isGitLikeUrl("nginx:latest")).toBe(false);
  });

  it("builds host deployment roots and scalar values", () => {
    expect(homeDeploymentRoot("root")).toBe("/root/composebastion");
    expect(homeDeploymentRoot("deploy")).toBe("/home/deploy/composebastion");
    expect(scalar("value")).toBe("value");
    expect(scalar(42)).toBe("42");
    expect(scalar({})).toBeNull();
  });

  it("summarizes Compose short and long syntax", () => {
    expect(summarizeCompose(`
services:
  web:
    image: nginx:latest
    ports:
      - "8080:80"
      - target: 443
        published: 8443
        host_ip: 127.0.0.1
        protocol: tcp
      - {}
    volumes:
      - web-data:/data
      - source: cache
        target: /cache
      - target: /tmp
      - {}
  worker:
    build:
      context: ./worker
  empty:
`)).toEqual([
      {
        name: "web",
        image: "nginx:latest",
        build: null,
        ports: ["8080:80", "127.0.0.1:8443:443/tcp"],
        volumes: ["web-data:/data", "cache:/cache", "/tmp"]
      },
      { name: "worker", image: null, build: "./worker", ports: [], volumes: [] },
      { name: "empty", image: null, build: null, ports: [], volumes: [] }
    ]);
    expect(summarizedPort(8080)).toBe("8080");
    expect(summarizedPort({ target: 3000 })).toBe("3000");
    expect(summarizedPort({ published: 8080 })).toBeNull();
    expect(summarizedPort(null)).toBeNull();
  });

  it.each([
    ["null"],
    ["services: []"],
    ["services: {}"]
  ])("rejects invalid or empty Compose documents", (yaml) => {
    expect(() => summarizeCompose(yaml)).toThrow();
  });

  it("parses, serializes, redacts, and merges environment files", () => {
    const parsed = parseEnvText(
      "export PORT='3000'\nAPI_TOKEN=\"secret\"\nEMPTY=\nIGNORED\n",
      "example_env"
    );
    expect(parsed.get("PORT")).toMatchObject({ value: "3000", required: false, secret: false });
    expect(parsed.get("API_TOKEN")).toMatchObject({ value: "", required: true, secret: true });
    expect(parsed.get("EMPTY")).toMatchObject({ value: "", required: true, defaultValue: null });
    expect(parsed.has("IGNORED")).toBe(false);

    const raw = rawEnvValues("A=one\nexport B=\"two\"\nC='three'\ninvalid\n");
    expect(Array.from(raw.entries())).toEqual([["A", "one"], ["B", "two"], ["C", "three"]]);
    expect(serializeEnv(raw)).toBe("A='one'\nB='two'\nC='three'");
    expect(sanitizeEnvForResponse("PORT=3000\nAPI_TOKEN=secret", new Set(["API_TOKEN"])))
      .toBe("PORT='3000'\nAPI_TOKEN=''");

    const variables = [
      { key: "PORT", value: "3000", defaultValue: "3000", required: false, secret: false, source: "compose" as const },
      { key: "API_TOKEN", value: "", defaultValue: null, required: true, secret: true, source: "compose" as const },
      { key: "OPTIONAL", value: "", defaultValue: null, required: false, secret: false, source: "compose" as const }
    ];
    expect(mergeStoredAnalysisEnv("PORT=3000", "PORT=4000\nAPI_TOKEN=stored", variables)).toEqual({
      env: "PORT='4000'\nAPI_TOKEN='stored'",
      variables: [
        { ...variables[0], value: "4000" },
        variables[1],
        variables[2]
      ]
    });
    expect(mergeRequestedEnv(
      "API_TOKEN=stored\nPORT=3000",
      "API_TOKEN=\nPORT=4000\nNEW=value",
      variables
    )).toBe("API_TOKEN='stored'\nPORT='4000'\nNEW='value'");
    expect(variablesToEnv(variables)).toBe("PORT='3000'\nOPTIONAL=''");
  });

  it("filters unresolved images and normalizes Git remotes", () => {
    expect(referencedImages([
      { name: "one", image: "nginx:latest", build: null, ports: [], volumes: [] },
      { name: "two", image: "${IMAGE}", build: null, ports: [], volumes: [] },
      { name: "three", image: null, build: ".", ports: [], volumes: [] }
    ])).toEqual(["nginx:latest"]);
    expect(normalizedGitUrl(" HTTPS://Git.Example/Test/App.git/ ")).toBe("https://git.example/test/app");
  });

  it("parses image authority and inspect metadata defensively", () => {
    expect(imageAuthority("ghcr.io/example/app:latest")).toBe("ghcr.io");
    expect(imageAuthority("localhost:5000/app")).toBe("localhost:5000");
    expect(imageAuthority("nginx:latest")).toBeNull();
    expect(parseImageInspect(JSON.stringify([{
      Config: {
        ExposedPorts: { "80/tcp": {}, "not-a-port/tcp": {} },
        Volumes: { "/data": {}, relative: {} },
        Env: ["PORT=80"]
      }
    }]))).toEqual({ ports: ["80"], volumes: ["/data"], env: ["PORT=80"] });
    expect(parseImageInspect("not json")).toEqual({ ports: [], volumes: [], env: [] });
  });

  it("extracts declared host ports and Docker registry trust", () => {
    expect(declaredHostPort("127.0.0.1:8080:80/tcp")).toBe(8080);
    expect(declaredHostPort("8080:80")).toBe(8080);
    expect(declaredHostPort("80")).toBeNull();
    expect(declaredHostPort("0:80")).toBeNull();
    expect(declaredHostPort("70000:80")).toBeNull();
    expect(dockerRegistryTrust(null, "registry.test:5000")).toBe(false);
    expect(dockerRegistryTrust({
      "http://registry.test:5000/": { Secure: false },
      "https://secure.test": { Secure: true }
    }, "REGISTRY.TEST:5000")).toBe(true);
    expect(dockerRegistryTrust({ "https://secure.test": { Secure: true } }, "secure.test")).toBe(false);
  });

  it("normalizes registry trust authorities with shared DNS, IP, and port validation", () => {
    expect(normalizeRegistryTrustAuthority("Registry.Example.Test:5000"))
      .toBe("registry.example.test:5000");
    expect(normalizeRegistryTrustAuthority("https://[2001:db8::1]:5000/"))
      .toBe("[2001:db8::1]:5000");
    for (const registry of [
      "bad_host.example:5000",
      "registry.example.test:65536",
      "2001:db8::1:5000",
      "https://registry.example.test/path",
      "https://registry.example.test?",
      "https://user:secret@registry.example.test",
      "ftp://registry.example.test"
    ]) {
      expect(() => normalizeRegistryTrustAuthority(registry)).toThrow();
    }
  });

  it("handles remaining source canonicalization variants", () => {
    expect(canonicalizeDeploymentSource("git@example.test:team/app.git/", "git"))
      .toBe("git@example.test:team/app.git");
    expect(() => canonicalizeDeploymentSource(
      "https://example.test/team/app.git?token=no#fragment",
      "git"
    )).toThrow();
    expect(canonicalizeDeploymentSource("docker://nginx:latest/", "image")).toBe("nginx:latest");
    expect(() => canonicalizeDeploymentSource(
      "https://example.test/compose.yaml?raw=1#fragment",
      "compose_url"
    )).toThrow();
    expect(canonicalizeDeploymentSource("services:\n  app: {}\n", "compose_upload"))
      .toMatch(/^inline-compose:[a-f0-9]{16}$/);
    expect(canonicalizeDeploymentSource("", "compose_upload")).toBe("uploaded-compose.yaml");
    expect(detectDeploymentSourceType("anything", "services:\n  app: {}")).toBe("compose_upload");
  });

  it("rejects impossible generated ports and omits empty generated sections", () => {
    expect(() => selectGeneratedHostPorts([65535], new Set([65535]))).toThrow("No free host port");
    expect(parse(generatedDockerfileCompose("FROM scratch"))).toEqual({
      services: { app: { build: ".", restart: "unless-stopped" } }
    });
  });
});
