import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/services/crypto.js";
import {
  finalizeDeploymentExecutionInTransaction
} from "../src/services/deploymentExecutionFinalization.js";

const analysisId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const stackId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";

function analysisRow(status = "failed") {
  return {
    id: analysisId,
    host_id: hostId,
    source_id: null,
    source_type: "compose_upload",
    source_locator: "inline-compose:qualified",
    status,
    display_name: "Qualified",
    project_name: "qualified",
    branch: null,
    compose_path: "compose.yaml",
    working_dir: "/srv/qualified",
    compose_yaml: "services:\n  app:\n    image: nginx:alpine\n",
    env_encrypted: encryptSecret(
      "APP_MODE=production\nDATABASE_PASSWORD=secret-value\n"
    ),
    credential_username: null,
    credential_secret_encrypted: null,
    variables: [
      { key: "APP_MODE", secret: false },
      { key: "DATABASE_PASSWORD", secret: true }
    ]
  };
}

function stackRow(deploymentSourceId: string | null = null) {
  return {
    id: stackId,
    host_id: hostId,
    project_name: "qualified",
    compose_yaml: analysisRow().compose_yaml,
    source_working_dir: "/srv/qualified",
    source_compose_path: "/srv/qualified/compose.yaml",
    deployment_source_id: deploymentSourceId,
    current_version_id: "55555555-5555-4555-8555-555555555555"
  };
}

describe("deployment execution terminal finalization", () => {
  const query = vi.fn();
  const client = { query };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("atomically reconstructs source, stack binding, protected version, and analysis", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deployment_analyses")) {
        return { rows: [analysisRow()] };
      }
      if (sql.includes("FROM compose_stacks") && sql.includes("FOR UPDATE")) {
        return { rows: [stackRow()] };
      }
      if (sql.includes("INSERT INTO deployment_sources")) {
        return { rows: [{ id: sourceId }] };
      }
      if (sql.includes("UPDATE deployment_analyses")) {
        return {
          rows: [{ ...analysisRow("deployed"), source_id: sourceId }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(finalizeDeploymentExecutionInTransaction(
      client as any,
      analysisId,
      stackId
    )).resolves.toMatchObject({
      stackId,
      source: { id: sourceId },
      analysis: { status: "deployed", source_id: sourceId },
      replayed: false
    });

    const stackUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE compose_stacks")
    );
    expect(stackUpdate?.[1]?.[1]).toBe(sourceId);
    expect(stackUpdate?.[1]?.[2]).toContain("APP_MODE='production'");
    expect(stackUpdate?.[1]?.[2]).toContain("DATABASE_PASSWORD=''");
    expect(stackUpdate?.[1]?.[2]).not.toContain("secret-value");
    const versionUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE compose_stack_versions")
    );
    expect(versionUpdate?.[1]?.[1]).not.toContain("secret-value");
    expect(query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE deployment_analyses")
    )?.[0]).toContain("credential_secret_encrypted = null");
  });

  it("is idempotent after the analysis/source binding already committed", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          ...analysisRow("deployed"),
          source_id: sourceId
        }]
      })
      .mockResolvedValueOnce({
        rows: [stackRow(sourceId)]
      })
      .mockResolvedValueOnce({
        rows: [{ id: sourceId }]
      });

    await expect(finalizeDeploymentExecutionInTransaction(
      client as any,
      analysisId,
      stackId
    )).resolves.toMatchObject({
      replayed: true,
      source: { id: sourceId }
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO deployment_sources")
    )).toBe(false);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE deployment_analyses")
    )).toBe(false);
  });

  it("fails closed when the reconstructed stack does not match the analysis", async () => {
    query
      .mockResolvedValueOnce({ rows: [analysisRow()] })
      .mockResolvedValueOnce({
        rows: [{ ...stackRow(), project_name: "other-project" }]
      });

    await expect(finalizeDeploymentExecutionInTransaction(
      client as any,
      analysisId,
      stackId
    )).rejects.toThrow("no longer matches its durable analysis");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
