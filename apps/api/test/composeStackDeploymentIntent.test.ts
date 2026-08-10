import { describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/services/crypto.js";
import {
  COMPOSE_STACK_DEPLOYMENT_INTENT_KEY,
  createAndPersistComposeStackDeploymentIntent,
  deriveComposeStackDeploymentIntentIds,
  discardComposeStackDeploymentIntent,
  finalizeComposeStackDeploymentIntent,
  parseComposeStackDeploymentIntent,
  type ComposeStackDeploymentIntent,
  type ComposeStackDeploymentIntentInput
} from "../src/services/composeStackDeploymentIntent.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const createdBy = "33333333-3333-4333-8333-333333333333";
const githubCloneOperationJobId =
  "44444444-4444-4444-8444-444444444444";
const composeYaml = [
  "services:",
  "  api:",
  "    image: ghcr.io/example/private-api:1.0.0"
].join("\n");
const environment = "DATABASE_PASSWORD=never-store-this-in-job-json";

function intentInput(
  overrides: Partial<ComposeStackDeploymentIntentInput> = {}
): ComposeStackDeploymentIntentInput {
  return {
    jobId,
    attemptCount: 2,
    hostId,
    projectName: "qualified-app",
    name: "Qualified App",
    composeYaml,
    env: environment,
    source: {
      type: "git",
      repositoryUrl: "https://github.example.test/acme/qualified-app.git",
      branch: "main",
      workingDir: "/srv/qualified-app",
      composePath: "/srv/qualified-app/compose.yaml",
      currentCommitSha: "a".repeat(40),
      latestCommitSha: "a".repeat(40),
      environment,
      deploymentSourceId: null
    },
    version: {
      source: "host_files",
      note: "Qualified deployment",
      createdBy
    },
    githubCloneOperationJobId,
    ...overrides
  };
}

async function persistedIntent(
  overrides: Partial<ComposeStackDeploymentIntentInput> = {}
) {
  let result: Record<string, unknown> = { priorEvidence: { retained: true } };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (!sql.includes("UPDATE operation_jobs")) {
      throw new Error(`Unexpected query: ${sql}`);
    }
    result = {
      ...result,
      [String(values[3])]: String(values[4])
    };
    return { rows: [{ id: values[0] }], rowCount: 1 };
  });
  const input = intentInput(overrides);
  const intent = await createAndPersistComposeStackDeploymentIntent(
    input,
    {
      jobId: input.jobId,
      attemptCount: input.attemptCount,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    } as any
  );
  return { intent, result, query };
}

describe("Compose stack deployment intent", () => {
  it("persists one encrypted job/attempt-bound payload with no Compose or environment plaintext", async () => {
    const { intent, result, query } = await persistedIntent();
    const encrypted = result[COMPOSE_STACK_DEPLOYMENT_INTENT_KEY];
    const serialized = JSON.stringify(result);

    expect(typeof encrypted).toBe("string");
    expect(String(encrypted)).toMatch(/^v1:/);
    expect(serialized).not.toContain(composeYaml);
    expect(serialized).not.toContain(environment);
    expect(serialized).not.toContain("qualified-app");
    expect(result.priorEvidence).toEqual({ retained: true });
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "attempt_count = $2"
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      jobId,
      2,
      hostId,
      COMPOSE_STACK_DEPLOYMENT_INTENT_KEY,
      encrypted
    ]);

    expect(parseComposeStackDeploymentIntent(result, {
      jobId,
      attemptCount: 2,
      hostId
    })).toEqual(intent);

    const localOnly = await createAndPersistComposeStackDeploymentIntent(
      intentInput({ attemptCount: 3 })
    );
    expect(localOnly.candidateStackId).toBe(
      deriveComposeStackDeploymentIntentIds(jobId, 3).candidateStackId
    );
  });

  it("fails closed for a different attempt, host, ciphertext, or deterministic identifier", async () => {
    const { result } = await persistedIntent();
    expect(() => parseComposeStackDeploymentIntent(result, {
      jobId,
      attemptCount: 1,
      hostId
    })).toThrow("intent is invalid");
    expect(() => parseComposeStackDeploymentIntent(result, {
      jobId,
      attemptCount: 2,
      hostId: "55555555-5555-4555-8555-555555555555"
    })).toThrow("intent is invalid");

    const encrypted = String(result[COMPOSE_STACK_DEPLOYMENT_INTENT_KEY]);
    const tamperedCiphertext = `${encrypted.slice(0, -2)}${
      encrypted.endsWith("A") ? "B" : "A"
    }`;
    expect(() => parseComposeStackDeploymentIntent({
      [COMPOSE_STACK_DEPLOYMENT_INTENT_KEY]: tamperedCiphertext
    }, {
      jobId,
      attemptCount: 2,
      hostId
    })).toThrow("intent is invalid");

    const tamperedPayload = JSON.parse(decryptSecret(encrypted));
    tamperedPayload.candidateVersionId =
      "66666666-6666-4666-8666-666666666666";
    expect(() => parseComposeStackDeploymentIntent({
      [COMPOSE_STACK_DEPLOYMENT_INTENT_KEY]: encryptSecret(
        JSON.stringify(tamperedPayload)
      )
    }, {
      jobId,
      attemptCount: 2,
      hostId
    })).toThrow("intent is invalid");
  });

  it("atomically publishes exactly one deterministic version and validates replay content", async () => {
    const intent = await createAndPersistComposeStackDeploymentIntent(
      intentInput()
    );
    let stack: {
      id: string;
      sourceEnvironmentEncrypted: string | null;
      sourceEnvironmentBinding: string | null;
      currentVersionId: string | null;
    } | null = null;
    const versions = new Map<string, {
      id: string;
      stack_id: string;
      version_number: number;
      compose_yaml: string;
      env: string;
      source: string;
      note: string | null;
      created_by: string | null;
    }>();
    let versionInsertCount = 0;

    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (
        sql.includes("FROM compose_stacks")
        && sql.includes("source_environment_encrypted")
      ) {
        return {
          rows: stack
            ? [{
                id: stack.id,
                source_environment_encrypted:
                  stack.sourceEnvironmentEncrypted,
                source_environment_binding:
                  stack.sourceEnvironmentBinding
              }]
            : [],
          rowCount: stack ? 1 : 0
        };
      }
      if (sql.includes("INSERT INTO compose_stacks")) {
        stack ??= {
          id: String(values[0]),
          sourceEnvironmentEncrypted: null,
          sourceEnvironmentBinding: null,
          currentVersionId: null
        };
        stack.sourceEnvironmentEncrypted = values[6] as string | null;
        stack.sourceEnvironmentBinding = values[7] as string | null;
        return { rows: [{ id: stack.id }], rowCount: 1 };
      }
      if (
        sql.includes("FROM compose_stack_versions")
        && sql.includes("WHERE id = $1")
      ) {
        const version = versions.get(String(values[0]));
        return {
          rows: version ? [{ ...version }] : [],
          rowCount: version ? 1 : 0
        };
      }
      if (
        sql.includes("MAX(version_number)")
        && sql.includes("compose_stack_versions")
      ) {
        const maximum = Math.max(
          0,
          ...[...versions.values()]
            .filter((version) => version.stack_id === values[0])
            .map((version) => version.version_number)
        );
        return {
          rows: [{ version_number: maximum + 1 }],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO compose_stack_versions")) {
        versionInsertCount += 1;
        const version = {
          id: String(values[0]),
          stack_id: String(values[1]),
          version_number: Number(values[2]),
          compose_yaml: String(values[3]),
          env: String(values[4]),
          source: String(values[5]),
          note: values[6] as string | null,
          created_by: values[7] as string | null
        };
        versions.set(version.id, version);
        return { rows: [{ ...version }], rowCount: 1 };
      }
      if (
        sql.includes("UPDATE compose_stacks")
        && sql.includes("current_version_id")
      ) {
        if (!stack || stack.id !== values[0]) {
          return { rows: [], rowCount: 0 };
        }
        stack.currentVersionId = String(values[1]);
        return { rows: [{ id: stack.id }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query } as any;

    const first = await finalizeComposeStackDeploymentIntent(client, intent);
    const persistedSourceCiphertext = stack!.sourceEnvironmentEncrypted;
    const replay = await finalizeComposeStackDeploymentIntent(client, intent);

    expect(first).toEqual({
      stackId: intent.candidateStackId,
      versionId: intent.candidateVersionId,
      versionNumber: 1,
      replayed: false,
      githubCloneOperationJobId
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(versionInsertCount).toBe(1);
    expect(versions.size).toBe(1);
    expect(stack!.currentVersionId).toBe(intent.candidateVersionId);
    expect(stack!.sourceEnvironmentEncrypted).toBe(
      persistedSourceCiphertext
    );
    expect(decryptSecret(stack!.sourceEnvironmentEncrypted!)).toBe(
      environment
    );
    const stackUpserts = query.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO compose_stacks")
    );
    expect(stackUpserts).toHaveLength(2);
    for (const [sql] of stackUpserts) {
      expect(String(sql)).toContain("'deployed'");
      expect(String(sql)).not.toContain("$17");
    }

    versions.get(intent.candidateVersionId)!.env = "tampered=true";
    await expect(
      finalizeComposeStackDeploymentIntent(client, intent)
    ).rejects.toThrow("deterministic Compose stack version");
    expect(versionInsertCount).toBe(1);
  });

  it("discards only the exact job-attempt intent key", async () => {
    const stored = {
      [COMPOSE_STACK_DEPLOYMENT_INTENT_KEY]: "v1:ciphertext",
      remoteMutationProof: { status: "terminal" }
    };
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      expect(sql).toContain("result - $4::text");
      expect(values).toEqual([
        jobId,
        2,
        hostId,
        COMPOSE_STACK_DEPLOYMENT_INTENT_KEY
      ]);
      delete stored[COMPOSE_STACK_DEPLOYMENT_INTENT_KEY];
      return { rows: [{ id: jobId }], rowCount: 1 };
    });

    await discardComposeStackDeploymentIntent({ query } as any, {
      jobId,
      attemptCount: 2,
      hostId
    });

    expect(stored).toEqual({
      remoteMutationProof: { status: "terminal" }
    });
    expect(query).toHaveBeenCalledOnce();
  });
});
