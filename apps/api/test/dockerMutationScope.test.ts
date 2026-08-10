import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeDockerMutationScope,
  dockerMutationAdmissionKeys,
  dockerMutationScope,
  dockerMutationScopesConflict
} from "../src/services/dockerMutationScope.js";

const hostId = "11111111-1111-4111-8111-111111111111";

function scope(input: Parameters<typeof dockerMutationScope>[0]) {
  const resolved = dockerMutationScope(input);
  if (!resolved) throw new Error("Expected a Docker mutation scope");
  return resolved;
}

describe("Docker mutation scopes", () => {
  it("serializes host paths conservatively across remote symlink aliases", () => {
    const clone = scope({
      type: "git.clone",
      hostId,
      payload: {
        repositoryUrl: "https://git.example.test/team/app.git",
        directory: "/srv/apps/example"
      }
    });
    const nested = scope({
      type: "host.mkdir",
      hostId,
      payload: { path: "/srv/apps/example/data" }
    });
    const unrelated = scope({
      type: "host.mkdir",
      hostId,
      payload: { path: "/srv/apps/other" }
    });

    expect(dockerMutationScopesConflict(clone, nested)).toBe(true);
    expect(dockerMutationScopesConflict(clone, unrelated)).toBe(true);
    expect(clone.targets).toEqual(expect.arrayContaining([
      { hostId, kind: "host-path", value: "/srv/apps/example" },
      { hostId, kind: "host-path", value: "*" }
    ]));
  });

  it("orders host admission locks before target locks", () => {
    const compose = scope({
      type: "compose.deployPath",
      hostId,
      payload: {
        workingDir: "/srv/apps/example",
        projectName: "example"
      }
    });

    expect(dockerMutationAdmissionKeys(compose)).toEqual([
      `docker-mutation-admission:${hostId}`,
      `deployment-target:path:${hostId}:*`,
      `deployment-target:path:${hostId}:/srv/apps/example`,
      `deployment-target:project:${hostId}:example`
    ]);
  });

  it("maps a Docker name and ID to one canonical resource", async () => {
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (
        sql.includes("external_id = ANY")
        && values[1] === "container"
      ) {
        return {
          rows: [{
            external_id: "sha256:container-id",
            name: "web",
            data: { Labels: {} }
          }]
        };
      }
      return { rows: [] };
    });
    const byId = await canonicalizeDockerMutationScope(
      { query } as any,
      scope({
        type: "container.stop",
        hostId,
        payload: { containerId: "sha256:container-id" }
      })
    );
    const byName = await canonicalizeDockerMutationScope(
      { query } as any,
      scope({
        type: "container.remove",
        hostId,
        payload: { containerId: "web", force: false }
      })
    );

    expect(dockerMutationScopesConflict(byId, byName)).toBe(true);
    expect(byId.targets).toEqual(expect.arrayContaining([
      { hostId, kind: "container", value: "sha256:container-id" },
      { hostId, kind: "container", value: "web" }
    ]));
  });

  it("fails closed when an existing Docker alias is absent from inventory", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const missing = await canonicalizeDockerMutationScope(
      { query } as any,
      scope({
        type: "container.stop",
        hostId,
        payload: { containerId: "stale-name" }
      })
    );
    const other = scope({
      type: "container.restart",
      hostId,
      payload: { containerId: "another-container" }
    });

    expect(missing.targets).toContainEqual({
      hostId,
      kind: "container",
      value: "*"
    });
    expect(dockerMutationScopesConflict(missing, other)).toBe(true);
  });

  it("keeps different known standalone Docker objects concurrent", async () => {
    const snapshots = [
      {
        external_id: "sha256:first",
        name: "first",
        data: { Labels: {} }
      },
      {
        external_id: "sha256:second",
        name: "second",
        data: { Labels: {} }
      }
    ];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (!sql.includes("external_id = ANY")) return { rows: [] };
      const requested = new Set(values[2] as string[]);
      return {
        rows: snapshots.filter((row) =>
          requested.has(row.external_id) || requested.has(row.name)
        )
      };
    });
    const first = await canonicalizeDockerMutationScope(
      { query } as any,
      scope({
        type: "container.stop",
        hostId,
        payload: { containerId: "first" }
      })
    );
    const second = await canonicalizeDockerMutationScope(
      { query } as any,
      scope({
        type: "container.stop",
        hostId,
        payload: { containerId: "second" }
      })
    );

    expect(dockerMutationScopesConflict(first, second)).toBe(false);
    expect(first.targets).not.toContainEqual({
      hostId,
      kind: "container",
      value: "*"
    });
  });

  it("maps a Compose project to its live managed objects", async () => {
    const managed = [
      {
        kind: "container",
        external_id: "sha256:web",
        name: "demo-web-1",
        data: {
          Image: "registry.example.test/demo:1",
          Labels: { "com.docker.compose.project": "demo" }
        }
      },
      {
        kind: "network",
        external_id: "sha256:network",
        name: "demo_default",
        data: { Labels: "com.docker.compose.project=demo" }
      },
      {
        kind: "volume",
        external_id: "demo_data",
        name: "demo_data",
        data: { Labels: { "com.docker.compose.project": "demo" } }
      }
    ];
    const query = vi.fn(async (sql: string) => (
      sql.includes("kind IN ('container', 'network', 'volume')")
        ? { rows: managed }
        : { rows: [] }
    ));
    const compose = await canonicalizeDockerMutationScope(
      { query } as any,
      scope({
        type: "compose.deployPath",
        hostId,
        payload: {
          workingDir: "/srv/demo",
          projectName: "demo",
          _scopeKnown: true
        }
      })
    );

    for (const direct of [
      scope({
        type: "container.stop",
        hostId,
        payload: { containerId: "sha256:web" }
      }),
      scope({
        type: "network.remove",
        hostId,
        payload: { networkId: "demo_default" }
      }),
      scope({
        type: "volume.remove",
        hostId,
        payload: { volumeName: "demo_data", force: false }
      }),
      scope({
        type: "image.remove",
        hostId,
        payload: { imageId: "registry.example.test/demo:1", force: false }
      })
    ]) {
      expect(dockerMutationScopesConflict(compose, direct)).toBe(true);
    }
    expect(compose.targets).toEqual(expect.arrayContaining([
      { hostId, kind: "container", value: "*" },
      { hostId, kind: "image", value: "*" },
      { hostId, kind: "network", value: "*" },
      { hostId, kind: "volume", value: "*" }
    ]));
  });

  it("fails closed for an uninspected path Compose definition", () => {
    const compose = scope({
      type: "compose.writeDeployPath",
      hostId,
      payload: {
        workingDir: "/srv/new-app",
        projectName: "new-app",
        composePath: "compose.yml",
        composeYaml: "services: {}\n",
        overwrite: false,
        pullBeforeDeploy: false
      }
    });
    const direct = scope({
      type: "network.remove",
      hostId,
      payload: { networkId: "some-network" }
    });

    expect(dockerMutationScopesConflict(compose, direct)).toBe(true);
  });

  it("fails closed for resources introduced by an existing Compose project", () => {
    const compose = scope({
      type: "compose.deployPath",
      hostId,
      payload: {
        workingDir: "/srv/existing-app",
        projectName: "existing-app",
        _scopeKnown: true
      }
    });
    const futureMutations = [
      scope({
        type: "container.run",
        hostId,
        payload: {
          image: "registry.example.test/future:1",
          name: "future-container"
        }
      }),
      scope({
        type: "image.pull",
        hostId,
        payload: { image: "registry.example.test/future:1" }
      }),
      scope({
        type: "network.create",
        hostId,
        payload: { name: "future-network" }
      }),
      scope({
        type: "volume.create",
        hostId,
        payload: { volumeName: "future-volume" }
      }),
      scope({
        type: "host.mkdir",
        hostId,
        payload: { path: "/srv/future-bind" }
      })
    ];

    for (const mutation of futureMutations) {
      expect(dockerMutationScopesConflict(compose, mutation)).toBe(true);
    }
  });

  it("serializes automatic registry logins with the shared Docker auth file", () => {
    const explicitLogin = scope({
      type: "registry.login",
      hostId,
      payload: { registryId: "22222222-2222-4222-8222-222222222222" }
    });
    const imagePull = scope({
      type: "image.pull",
      hostId,
      payload: { image: "registry.example.test/team/app:latest" }
    });
    const compose = scope({
      type: "compose.deployPath",
      hostId,
      payload: {
        projectName: "app",
        workingDir: "/srv/app",
        composePath: "compose.yml"
      }
    });

    expect(dockerMutationScopesConflict(explicitLogin, imagePull)).toBe(true);
    expect(dockerMutationScopesConflict(explicitLogin, compose)).toBe(true);
  });
});
