import { describe, expect, it, vi } from "vitest";
import type { DockerMutationScope } from "../src/services/dockerMutationScope.js";
import {
  buildRecoverySourceDockerMutationScope,
  conservativeRecoveryDockerMutationScope,
  RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY,
  lockRecoveryOperationAdmission
} from "../src/services/recoveryOperationAdmission.js";

const hostId = "00000000-0000-4000-8000-000000000201";
const activeJobId = "00000000-0000-4000-8000-000000000202";

function scope(
  kind: DockerMutationScope["targets"][number]["kind"],
  value: string
): DockerMutationScope {
  return {
    type: "compose.deployPath",
    hostIds: [hostId],
    targets: [{ hostId, kind, value }]
  };
}

function clientWithActive(
  type: "recovery.capture" | "recovery.restore",
  source: DockerMutationScope[],
  target: DockerMutationScope[]
) {
  const query = vi.fn(async (sql: string) => {
    if (
      sql.includes("FROM operation_jobs job")
      && sql.includes("LEFT JOIN recovery_points")
    ) {
      return {
        rows: [{
          id: activeJobId,
          type,
          host_id: hostId,
          payload: {
            [RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY]: {
              source,
              target
            }
          },
          point_host_id: null,
          point_app_identity: null,
          point_metadata: {},
          migration_source_host_id: null,
          migration_source_app_identity: null,
          migration_recovery_point_id: null,
          migration_plan: {}
        }]
      };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query };
}

describe("recovery operation admission", () => {
  it("locks host admission domains before sorted target domains", async () => {
    const client = clientWithActive("recovery.restore", [], []);
    await lockRecoveryOperationAdmission(client as any, {
      kind: "restore",
      targetDockerScopes: [
        scope("host-path", "/srv/qualification")
      ]
    });

    const advisoryKeys = client.query.mock.calls
      .filter(([sql]) => sql.includes("pg_advisory_xact_lock"))
      .map(([, values]) => values?.[0]);
    expect(advisoryKeys.slice(0, 3)).toEqual([
      `docker-mutation-admission:${hostId}`,
      `deployment-target:path:${hostId}:*`,
      `deployment-target:path:${hostId}:/srv/qualification`
    ]);
  });

  it("retains exact host paths while adding a conservative per-host path domain", () => {
    expect(conservativeRecoveryDockerMutationScope(
      scope("host-path", "/srv/qualification/a")
    ).targets).toEqual([
      {
        hostId,
        kind: "host-path",
        value: "/srv/qualification/a"
      },
      {
        hostId,
        kind: "host-path",
        value: "*"
      }
    ]);
    expect(buildRecoverySourceDockerMutationScope(
      hostId,
      {
        kind: "standalone",
        containerIds: ["client-web"]
      },
      { workingDir: "/srv/qualification/a" }
    ).targets).toEqual(expect.arrayContaining([
      {
        hostId,
        kind: "host-path",
        value: "/srv/qualification/a"
      },
      {
        hostId,
        kind: "host-path",
        value: "*"
      }
    ]));
  });

  it("rejects different lexical host paths on the same SSH host", async () => {
    const client = clientWithActive(
      "recovery.restore",
      [],
      [scope("host-path", "/srv/qualification/alias-a")]
    );

    await expect(lockRecoveryOperationAdmission(client as any, {
      kind: "capture",
      sourceDockerScopes: [
        scope("host-path", "/srv/qualification/alias-b")
      ]
    })).rejects.toMatchObject({
      statusCode: 409,
      activeJobId
    });
  });

  it.each([
    ["volume", "client-data", "client-data"],
    ["container", "client-web", "client-web"],
    ["compose-project", "client-app", "client-app"],
    ["host-path", "/srv/client-app/data", "/srv/client-app"]
  ] as const)(
    "rejects a proposed %s source that overlaps an active restore target",
    async (kind, sourceValue, targetValue) => {
      const existingTarget = scope(kind, targetValue);
      const client = clientWithActive(
        "recovery.restore",
        [],
        [existingTarget]
      );

      await expect(lockRecoveryOperationAdmission(client as any, {
        kind: "capture",
        sourceDockerScopes: [scope(kind, sourceValue)]
      })).rejects.toMatchObject({
        statusCode: 409,
        activeJobId
      });
    }
  );

  it.each([
    ["volume", "client-data", "client-data"],
    ["container", "client-web", "client-web"],
    ["compose-project", "client-app", "client-app"],
    ["host-path", "/srv/client-app", "/srv/client-app/data"]
  ] as const)(
    "rejects a proposed %s target that overlaps an active capture source",
    async (kind, targetValue, sourceValue) => {
      const existingSource = scope(kind, sourceValue);
      const client = clientWithActive(
        "recovery.capture",
        [existingSource],
        []
      );

      await expect(lockRecoveryOperationAdmission(client as any, {
        kind: "restore",
        targetDockerScopes: [scope(kind, targetValue)]
      })).rejects.toMatchObject({
        statusCode: 409,
        activeJobId
      });
    }
  );

  it("preserves capture source/source exclusion", async () => {
    const source = scope("volume", "client-data");
    const client = clientWithActive(
      "recovery.capture",
      [source],
      []
    );

    await expect(lockRecoveryOperationAdmission(client as any, {
      kind: "capture",
      sourceDockerScopes: [source]
    })).rejects.toMatchObject({
      statusCode: 409,
      activeJobId
    });
  });
});
