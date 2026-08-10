import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECONCILABLE_DOCKER_MUTATION_TYPES
} from "../src/services/dockerMutationScope.js";
import { encryptSecret } from "../src/services/crypto.js";
import {
  createAndPersistComposeStackDeploymentIntent
} from "../src/services/composeStackDeploymentIntent.js";

const query = vi.hoisted(() => vi.fn());
const transactionQuery = vi.hoisted(() => vi.fn());
const withTransaction = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn());
const statHostPath = vi.hoisted(() => vi.fn());
const runAgentDockerCommand = vi.hoisted(() => vi.fn());
const inspectAgentRemoteOperation = vi.hoisted(() => vi.fn());
const inspectSshRemoteOperation = vi.hoisted(() => vi.fn());
const cleanupSshRemoteOperation = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn());
const resolveGithubDeploymentBindingAfterReconciliation = vi.hoisted(
  () => vi.fn()
);
const resolveGithubCloneDeploymentBindingAfterReconciliation = vi.hoisted(
  () => vi.fn()
);

vi.mock("../src/db/pool.js", () => ({ query, withTransaction }));
vi.mock("../src/services/agent.js", () => ({
  inspectAgentRemoteOperation,
  runAgentDockerCommand
}));
vi.mock("../src/services/audit.js", () => ({ writeAuditEvent }));
vi.mock("../src/services/files.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/files.js")>();
  return {
    ...original,
    statHostPath
  };
});
vi.mock("../src/services/hosts.js", () => ({ getHostForWorker }));
vi.mock("../src/services/ssh.js", () => ({
  cleanupSshRemoteOperation,
  inspectSshRemoteOperation,
  runSshCommand
}));
vi.mock("../src/services/githubDeploymentBinding.js", () => ({
  resolveGithubDeploymentBindingAfterReconciliation
}));
vi.mock("../src/services/githubCloneDeploymentBinding.js", () => ({
  resolveGithubCloneDeploymentBindingAfterReconciliation
}));

const {
  REMOTE_OUTCOME_NO_DISPATCH_TYPES,
  REMOTE_OUTCOME_QUIESCENCE_SECONDS,
  inspectRemoteOutcomeTarget,
  inspectRegistryTrustRemoteOutcome,
  reconcileAmbiguousRemoteOutcomes
} = await import("../src/services/remoteOutcomeReconciliation.js");

const hostId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const registry = "registry.internal:5000";

function registryTrustJob() {
  return {
    id: jobId,
    type: "host.configureRegistryTrust",
    host_id: hostId,
    error: "WORKER_LOST: Worker lease expired during attempt 1",
    payload: { registry },
    result: {
      remoteMutationProof: {
        operationId: "e".repeat(64),
        jobId,
        attemptCount: 1,
        sequence: 1,
        phase: "registry-trust-install",
        transport: "ssh",
        timeoutMs: 60_000,
        status: "terminal",
        terminalState: "completed"
      }
    },
    attempt_count: 1,
    completed_at: new Date("2026-07-30T10:00:00.000Z"),
    stack_project_name: null,
    stack_working_dir: null,
    stack_compose_path: null,
    analysis_project_name: null,
    analysis_working_dir: null,
    analysis_compose_path: null
  };
}

async function encryptedComposeStackIntent(
  overrides: Record<string, unknown> = {}
) {
  const intent = await createAndPersistComposeStackDeploymentIntent({
    jobId,
    attemptCount: 1,
    hostId,
    projectName: "app",
    name: "App",
    composeYaml: "services:\n  app:\n    image: nginx:alpine\n",
    env: "",
    source: {
      type: "git",
      repositoryUrl: "git@github.example.test:team/app.git",
      branch: "main",
      workingDir: "/srv/app",
      composePath: "/srv/app/compose.yml",
      currentCommitSha: "b".repeat(40),
      latestCommitSha: "b".repeat(40),
      environment: "",
      deploymentSourceId: null
    },
    version: {
      source: "host_files",
      note: "Deploy from /srv/app/compose.yml",
      createdBy: null
    },
    githubCloneOperationJobId: jobId,
    ...overrides
  } as any);
  return encryptSecret(JSON.stringify(intent));
}

function composeIntentTransactionQuery(writes: unknown[][]) {
  return async (sql: string, values: unknown[] = []) => {
    if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
      writes.push(values);
      return { rows: [{ id: jobId }], rowCount: 1 };
    }
    if (
      sql.includes("FROM compose_stacks")
      && sql.includes("source_environment_encrypted")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO compose_stacks")) {
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (
      sql.includes("FROM compose_stack_versions")
      && sql.includes("WHERE id = $1")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("MAX(version_number)")) {
      return { rows: [{ version_number: 1 }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO compose_stack_versions")) {
      return {
        rows: [{
          id: values[0],
          stack_id: values[1],
          version_number: values[2],
          compose_yaml: values[3],
          env: values[4],
          source: values[5],
          note: values[6],
          created_by: values[7]
        }],
        rowCount: 1
      };
    }
    if (
      sql.includes("UPDATE compose_stacks")
      && sql.includes("current_version_id")
    ) {
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (
      sql.includes("UPDATE operation_jobs")
      && sql.includes("result - $4::text")
    ) {
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

describe("ambiguous remote outcome reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    transactionQuery.mockReset();
    withTransaction.mockReset();
    withTransaction.mockImplementation(
      async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
        handler({ query: transactionQuery })
    );
    getHostForWorker.mockReset();
    runSshCommand.mockReset();
    statHostPath.mockReset();
    runAgentDockerCommand.mockReset();
    inspectAgentRemoteOperation.mockReset();
    inspectSshRemoteOperation.mockReset();
    cleanupSshRemoteOperation.mockReset();
    writeAuditEvent.mockReset();
    resolveGithubDeploymentBindingAfterReconciliation.mockReset();
    resolveGithubCloneDeploymentBindingAfterReconciliation.mockReset();

    getHostForWorker.mockResolvedValue({
      public: {
        id: hostId,
        name: "Docker Host",
        username: "docker",
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "ssh",
      ssh: { hostname: "docker.example.test", port: 22, username: "docker" },
      agent: null
    });
    cleanupSshRemoteOperation.mockResolvedValue(undefined);
    writeAuditEvent.mockResolvedValue(undefined);
    resolveGithubDeploymentBindingAfterReconciliation.mockResolvedValue({
      status: "not_applicable"
    });
    resolveGithubCloneDeploymentBindingAfterReconciliation.mockResolvedValue({
      status: "not_applicable"
    });
  });

  it("explicitly allowlists every reconciliation candidate whose dispatch is durably fenced", () => {
    expect(new Set(REMOTE_OUTCOME_NO_DISPATCH_TYPES)).toEqual(new Set([
      ...RECONCILABLE_DOCKER_MUTATION_TYPES,
      "compose.deploy",
      "compose.stop",
      "compose.remove",
      "deploy.analyze",
      "deploy.execute",
      "host.configureRegistryTrust"
    ]));
  });

  it("keeps reconciliation locked when an ambiguous outcome lacks exact proof", async () => {
    const persisted: unknown[][] = [];
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return {
          rows: [{
            ...registryTrustJob(),
            error: "REMOTE_OUTCOME_UNKNOWN: dispatch evidence is unavailable",
            result: null
          }],
          rowCount: 1
        };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        persisted.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 1
    });

    expect(JSON.parse(String(persisted[0]?.[2]))).toMatchObject({
      status: "pending",
      error: expect.stringContaining("proof is absent")
    });
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(inspectSshRemoteOperation).not.toHaveBeenCalled();
  });

  it("reconciles worker loss with no durable dispatch as not dispatched and releases the clone binding", async () => {
    const encryptedIntent = await encryptedComposeStackIntent();
    const row = {
      ...registryTrustJob(),
      type: "git.cloneDeploy",
      payload: {
        repositoryId: "33333333-3333-4333-8333-333333333333",
        repositoryUrl: "git@github.example.test:team/app.git",
        directory: "/srv/app",
        branch: "main",
        composePath: "compose.yml",
        projectName: "app",
        sourceCommitSha: "b".repeat(40),
        composeSha256: "c".repeat(64)
      },
      result: { composeStackDeploymentIntent: encryptedIntent },
      remote_mutation_proof_absent: true
    };
    const writes: unknown[][] = [];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(composeIntentTransactionQuery(writes));
    resolveGithubCloneDeploymentBindingAfterReconciliation.mockResolvedValueOnce({
      status: "failed",
      repositoryId: row.payload.repositoryId,
      stackId: "44444444-4444-4444-8444-444444444444",
      sourceCommitSha: row.payload.sourceCommitSha,
      composeSha256: row.payload.composeSha256,
      environmentBinding: "e".repeat(64),
      projectName: "app",
      workingDir: "/srv/app"
    });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });

    expect(resolveGithubCloneDeploymentBindingAfterReconciliation)
      .toHaveBeenCalledWith(
        expect.objectContaining({ query: transactionQuery }),
        jobId,
        expect.objectContaining({
          phase: "not_dispatched",
          state: "not_dispatched"
        })
      );
    expect(JSON.parse(String(writes[1]?.[2]))).toMatchObject({
      status: "reconciled",
      remoteOperation: {
        phase: "not_dispatched",
        state: "not_dispatched",
        transport: null
      },
      githubCloneDeploymentBinding: {
        status: "failed",
        sourceCommitSha: row.payload.sourceCommitSha
      }
    });
    expect(getHostForWorker).not.toHaveBeenCalled();
    expect(inspectSshRemoteOperation).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(cleanupSshRemoteOperation).not.toHaveBeenCalled();
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("NOT (result ? $6::text)")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("result - $4::text")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    )).toBe(false);
  });

  it.each([
    {
      label: "generic Docker mutation",
      type: "container.start",
      payload: { containerId: "example-container" }
    },
    {
      label: "registry trust mutation",
      type: "host.configureRegistryTrust",
      payload: { registry }
    }
  ])("reconciles $label worker loss before dispatch without target-state inspection", async ({
    type,
    payload
  }) => {
    const persisted: unknown[][] = [];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return {
          rows: [{
            ...registryTrustJob(),
            type,
            payload,
            result: null,
            remote_mutation_proof_absent: true
          }],
          rowCount: 1
        };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(
      async (sql: string, values: unknown[] = []) => {
        if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
          persisted.push(values);
          return { rows: [{ id: jobId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    );
    if (type === "host.configureRegistryTrust") {
      runSshCommand.mockResolvedValueOnce({
        code: 0,
        stdout: "absent\n",
        stderr: ""
      });
    }

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });
    const evidence = JSON.parse(String(persisted[0]?.[2]));
    expect(evidence).toMatchObject({
      status: "reconciled",
      remoteOperation: {
        phase: "not_dispatched",
        state: "not_dispatched",
        transport: null
      }
    });
    expect(resolveGithubDeploymentBindingAfterReconciliation)
      .not.toHaveBeenCalled();
    expect(resolveGithubCloneDeploymentBindingAfterReconciliation)
      .not.toHaveBeenCalled();
    if (type === "host.configureRegistryTrust") {
      expect(evidence).toMatchObject({
        registryTrustCandidateCleanup: { state: "absent" }
      });
      expect(getHostForWorker).toHaveBeenCalledWith(hostId);
      expect(runSshCommand).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: "docker.example.test" }),
        expect.stringContaining(
          `/tmp/composebastion-daemon-${jobId}-1.json`
        ),
        { timeoutMs: 30_000 }
      );
    } else {
      expect(getHostForWorker).not.toHaveBeenCalled();
      expect(runSshCommand).not.toHaveBeenCalled();
    }
    expect(runAgentDockerCommand).not.toHaveBeenCalled();
    expect(cleanupSshRemoteOperation).not.toHaveBeenCalled();
  });

  it("keeps malformed durable proof pending after worker loss", async () => {
    const persisted: unknown[][] = [];
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return {
          rows: [{
            ...registryTrustJob(),
            result: { remoteMutationProof: null }
          }],
          rowCount: 1
        };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        persisted.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 1
    });
    expect(JSON.parse(String(persisted[0]?.[2]))).toMatchObject({
      status: "pending",
      error: expect.stringContaining("proof is absent")
    });
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("refuses target inspection while the exact SSH operation remains live", async () => {
    const persisted: unknown[][] = [];
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        const row = registryTrustJob();
        return {
          rows: [{
            ...row,
            result: {
              remoteMutationProof: {
                ...(row.result as any).remoteMutationProof,
                status: "dispatched",
                terminalState: undefined
              }
            }
          }],
          rowCount: 1
        };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        persisted.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    inspectSshRemoteOperation.mockResolvedValue({
      operationId: "e".repeat(64),
      state: "running"
    });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 1
    });

    expect(JSON.parse(String(persisted[0]?.[2]))).toMatchObject({
      status: "pending",
      error: expect.stringContaining("still running")
    });
    expect(inspectSshRemoteOperation).toHaveBeenCalledOnce();
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("does not inspect an ambiguous job before bounded quiescence and lease release", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 0,
      reconciled: 0,
      pending: 0
    });

    const candidateSql = String(query.mock.calls[0]?.[0]);
    const candidateValues = query.mock.calls[0]?.[1];
    expect(candidateSql).toContain("jobs.completed_at <= now() - ($1 * interval '1 second')");
    expect(candidateSql).toContain("jobs.lease_owner IS NULL");
    expect(candidateSql).toContain("jobs.lease_expires_at IS NULL");
    expect(candidateValues?.[0]).toBe(REMOTE_OUTCOME_QUIESCENCE_SECONDS);
    expect(candidateValues?.[3]).toContain("deploy.analyze");
    expect(REMOTE_OUTCOME_QUIESCENCE_SECONDS).toBe(660);
    expect(getHostForWorker).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("reconciles an isolated deployment analysis from exact terminal proof without inspecting production targets", async () => {
    const analysisId = "33333333-3333-4333-8333-333333333333";
    const row = {
      ...registryTrustJob(),
      type: "deploy.analyze",
      payload: { analysisId },
      result: {
        remoteMutationProof: {
          operationId: "f".repeat(64),
          jobId,
          attemptCount: 1,
          sequence: 4,
          phase: "deployment-analysis-cleanup",
          transport: "ssh",
          timeoutMs: 60_000,
          status: "terminal",
          terminalState: "completed"
        }
      }
    };
    const persisted: unknown[][] = [];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        persisted.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    cleanupSshRemoteOperation.mockRejectedValueOnce(
      new Error("cleanup transport unavailable")
    );

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });

    expect(JSON.parse(String(persisted[0]?.[2]))).toMatchObject({
      status: "reconciled",
      remoteOperation: {
        operationId: "f".repeat(64),
        phase: "deployment-analysis-cleanup",
        transport: "ssh",
        state: "completed"
      },
      note: expect.stringContaining("no production deployment was executed")
    });
    expect(getHostForWorker).toHaveBeenCalledOnce();
    expect(inspectSshRemoteOperation).not.toHaveBeenCalled();
    expect(inspectAgentRemoteOperation).not.toHaveBeenCalled();
    expect(statHostPath).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(runAgentDockerCommand).not.toHaveBeenCalled();
    expect(cleanupSshRemoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "docker.example.test" }),
      "f".repeat(64)
    );
    expect(transactionQuery.mock.invocationCallOrder[0])
      .toBeLessThan(writeAuditEvent.mock.invocationCallOrder[0]!);
    expect(writeAuditEvent.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupSshRemoteOperation.mock.invocationCallOrder[0]!);
  });

  it("resolves a retained GitHub binding in the same transaction as authoritative reconciliation and audit", async () => {
    const stackId = "33333333-3333-4333-8333-333333333333";
    const row = {
      ...registryTrustJob(),
      type: "compose.deploy",
      payload: { stackId },
      result: {
        remoteMutationProof: {
          operationId: "a".repeat(64),
          jobId,
          attemptCount: 1,
          sequence: 2,
          phase: "compose.deploy",
          transport: "ssh",
          timeoutMs: 60_000,
          status: "terminal",
          terminalState: "completed"
        }
      },
      stack_project_name: "app",
      stack_working_dir: null,
      stack_compose_path: "compose.yml"
    };
    const transactionWrites: unknown[][] = [];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        transactionWrites.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    statHostPath.mockResolvedValue({
      exists: false,
      type: null,
      size: null,
      modifiedAt: null
    });
    runSshCommand.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: ""
    });
    resolveGithubDeploymentBindingAfterReconciliation.mockResolvedValueOnce({
      status: "deployed",
      repositoryId: "44444444-4444-4444-8444-444444444444",
      stackId,
      candidateSourceCommitSha: "b".repeat(40),
      deployedSourceCommitSha: "b".repeat(40),
      composeSha256: "c".repeat(64),
      customCompose: false
    });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });

    expect(resolveGithubDeploymentBindingAfterReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ query: transactionQuery }),
      jobId,
      expect.objectContaining({
        operationId: "a".repeat(64),
        phase: "compose.deploy",
        state: "completed"
      })
    );
    expect(transactionWrites).toHaveLength(2);
    expect(JSON.parse(String(transactionWrites[1]?.[2]))).toMatchObject({
      status: "reconciled",
      githubDeploymentBinding: {
        status: "deployed",
        stackId,
        deployedSourceCommitSha: "b".repeat(40)
      }
    });
    expect(transactionQuery.mock.invocationCallOrder[0])
      .toBeLessThan(
        resolveGithubDeploymentBindingAfterReconciliation.mock
          .invocationCallOrder[0]!
      );
    expect(
      resolveGithubDeploymentBindingAfterReconciliation.mock
        .invocationCallOrder[0]
    ).toBeLessThan(writeAuditEvent.mock.invocationCallOrder[0]!);
    expect(writeAuditEvent.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupSshRemoteOperation.mock.invocationCallOrder[0]!);
  });

  it("publishes tracked clone provenance only with exact completed Compose-up proof", async () => {
    const encryptedIntent = await encryptedComposeStackIntent();
    const row = {
      ...registryTrustJob(),
      type: "git.cloneDeploy",
      payload: {
        repositoryId: "33333333-3333-4333-8333-333333333333",
        repositoryUrl: "git@github.example.test:team/app.git",
        directory: "/srv/app",
        branch: "main",
        composePath: "compose.yml",
        projectName: "app",
        sourceCommitSha: "b".repeat(40),
        composeSha256: "c".repeat(64)
      },
      result: {
        composeStackDeploymentIntent: encryptedIntent,
        remoteMutationProof: {
          operationId: "d".repeat(64),
          jobId,
          attemptCount: 1,
          sequence: 3,
          phase: "compose.deployPath.up",
          transport: "ssh",
          timeoutMs: 60_000,
          status: "terminal",
          terminalState: "completed"
        }
      }
    };
    const writes: unknown[][] = [];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(composeIntentTransactionQuery(writes));
    statHostPath.mockResolvedValue({
      exists: false,
      type: null,
      size: null,
      modifiedAt: null
    });
    runSshCommand.mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: ""
    });
    resolveGithubCloneDeploymentBindingAfterReconciliation.mockResolvedValueOnce({
      status: "deployed",
      repositoryId: row.payload.repositoryId,
      stackId: "44444444-4444-4444-8444-444444444444",
      sourceCommitSha: row.payload.sourceCommitSha,
      composeSha256: row.payload.composeSha256,
      environmentBinding: "e".repeat(64),
      projectName: "app",
      workingDir: "/srv/app"
    });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });

    expect(resolveGithubCloneDeploymentBindingAfterReconciliation)
      .toHaveBeenCalledWith(
        expect.objectContaining({ query: transactionQuery }),
        jobId,
        expect.objectContaining({
          phase: "compose.deployPath.up",
          state: "completed"
        })
      );
    expect(JSON.parse(String(writes[1]?.[2]))).toMatchObject({
      status: "reconciled",
      composeStackDeployment: {
        status: "deployed",
        versionNumber: 1,
        replayed: false
      },
      githubCloneDeploymentBinding: {
        status: "deployed",
        sourceCommitSha: row.payload.sourceCommitSha,
        composeSha256: row.payload.composeSha256
      }
    });
    expect(resolveGithubCloneDeploymentBindingAfterReconciliation.mock
      .invocationCallOrder[0])
      .toBeLessThan(writeAuditEvent.mock.invocationCallOrder[0]!);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("result - $4::text")
    )).toBe(true);
    expect(writeAuditEvent.mock.invocationCallOrder[0])
      .toBeLessThan(cleanupSshRemoteOperation.mock.invocationCallOrder[0]!);
  });

  it.each(["failed", "timed_out"] as const)(
    "does not materialize a Compose stack when authoritative up proof is %s",
    async (terminalState) => {
      const encryptedIntent = await encryptedComposeStackIntent({
        githubCloneOperationJobId: null
      });
      const row = {
        ...registryTrustJob(),
        type: "compose.deployPath",
        payload: {
          workingDir: "/srv/app",
          composePath: "compose.yml",
          projectName: "app"
        },
        result: {
          composeStackDeploymentIntent: encryptedIntent,
          remoteMutationProof: {
            operationId: "a".repeat(64),
            jobId,
            attemptCount: 1,
            sequence: 3,
            phase: "compose.deployPath.up",
            transport: "ssh",
            timeoutMs: 60_000,
            status: "terminal",
            terminalState
          }
        }
      };
      const writes: unknown[][] = [];
      query.mockImplementation(async (sql: string) => {
        if (sql.includes("jobs.completed_at <= now()")) {
          return { rows: [row], rowCount: 1 };
        }
        if (sql.includes("'claimToken', $3::text")) {
          return { rows: [{ attempt_count: 1 }], rowCount: 1 };
        }
        if (sql.includes("'heartbeatAt', clock_timestamp()")) {
          return { rows: [{ id: jobId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      transactionQuery.mockImplementation(
        composeIntentTransactionQuery(writes)
      );
      statHostPath.mockResolvedValue({
        exists: false,
        type: null,
        size: null,
        modifiedAt: null
      });
      runSshCommand.mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: ""
      });

      await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
        checked: 1,
        reconciled: 1,
        pending: 0
      });

      expect(transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO compose_stacks")
      )).toBe(false);
      expect(transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO compose_stack_versions")
      )).toBe(false);
      expect(transactionQuery.mock.calls.some(([sql]) =>
        String(sql).includes("result - $4::text")
      )).toBe(true);
      expect(JSON.parse(String(writes[1]?.[2]))).toMatchObject({
        status: "reconciled",
        composeStackDeployment: {
          status: "not_materialized",
          phase: "compose.deployPath.up",
          state: terminalState
        }
      });
    }
  );

  it("keeps completed Compose up pending when its exact encrypted intent is missing", async () => {
    const row = {
      ...registryTrustJob(),
      type: "compose.deployPath",
      payload: {
        workingDir: "/srv/app",
        composePath: "compose.yml",
        projectName: "app"
      },
      result: {
        remoteMutationProof: {
          operationId: "a".repeat(64),
          jobId,
          attemptCount: 1,
          sequence: 3,
          phase: "compose.deployPath.up",
          transport: "ssh",
          timeoutMs: 60_000,
          status: "terminal",
          terminalState: "completed"
        }
      }
    };
    const transactionWrites: unknown[][] = [];
    const pendingWrites: unknown[][] = [];
    query.mockImplementation(async (
      sql: string,
      values: unknown[] = []
    ) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        pendingWrites.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(
      composeIntentTransactionQuery(transactionWrites)
    );
    statHostPath.mockResolvedValue({
      exists: false,
      type: null,
      size: null,
      modifiedAt: null
    });
    runSshCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 1
    });
    expect(JSON.parse(String(pendingWrites[0]?.[2]))).toMatchObject({
      status: "pending",
      error: "Compose stack deployment intent is invalid."
    });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("result - $4::text")
    )).toBe(false);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it("finalizes deploy.execute stack, version, source, and analysis in one reconciliation transaction", async () => {
    const analysisId = "33333333-3333-4333-8333-333333333333";
    const sourceId = "44444444-4444-4444-8444-444444444444";
    const secretEnvironment = "MODE=production\nAPI_TOKEN=never-publish-this\n";
    const protectedEnvironment = "MODE='production'\nAPI_TOKEN=''";
    const composeYaml = "services:\n  app:\n    image: nginx:alpine\n";
    const intent = await createAndPersistComposeStackDeploymentIntent({
      jobId,
      attemptCount: 1,
      hostId,
      projectName: "app",
      name: "App",
      composeYaml,
      env: protectedEnvironment,
      source: {
        type: "compose_upload",
        repositoryUrl: null,
        branch: null,
        workingDir: "/srv/app",
        composePath: "/srv/app/compose.yml",
        currentCommitSha: null,
        latestCommitSha: null,
        environment: null,
        deploymentSourceId: null
      },
      version: {
        source: "host_files",
        note: "Deploy from /srv/app/compose.yml",
        createdBy: null
      },
      githubCloneOperationJobId: null
    });
    const analysis = {
      id: analysisId,
      source_id: null,
      source_type: "compose_upload",
      display_name: "App",
      source_locator: "inline:app",
      branch: null,
      compose_path: "compose.yml",
      working_dir: "/srv/app",
      project_name: "app",
      compose_yaml: composeYaml,
      env_encrypted: encryptSecret(secretEnvironment),
      variables: [{ key: "API_TOKEN", secret: true }],
      credential_username: null,
      credential_secret_encrypted: null,
      host_id: hostId,
      status: "deploying"
    };
    const row = {
      ...registryTrustJob(),
      type: "deploy.execute",
      payload: { analysisId },
      result: {
        composeStackDeploymentIntent: encryptSecret(JSON.stringify(intent)),
        remoteMutationProof: {
          operationId: "b".repeat(64),
          jobId,
          attemptCount: 1,
          sequence: 4,
          phase: "compose.deployPath.up",
          transport: "ssh",
          timeoutMs: 60_000,
          status: "terminal",
          terminalState: "completed"
        }
      },
      analysis_project_name: "app",
      analysis_working_dir: "/srv/app",
      analysis_compose_path: "compose.yml"
    };
    const writes: unknown[][] = [];
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const baseTransactionQuery = composeIntentTransactionQuery(writes);
    transactionQuery.mockImplementation(async (
      sql: string,
      values: unknown[] = []
    ) => {
      if (sql.includes("SELECT * FROM deployment_analyses")) {
        return { rows: [analysis], rowCount: 1 };
      }
      if (
        sql.includes("SELECT id, host_id, project_name, compose_yaml")
        && sql.includes("FROM compose_stacks")
      ) {
        return {
          rows: [{
            id: intent.candidateStackId,
            host_id: hostId,
            project_name: "app",
            compose_yaml: composeYaml,
            source_working_dir: "/srv/app",
            source_compose_path: "/srv/app/compose.yml",
            deployment_source_id: null,
            current_version_id: intent.candidateVersionId
          }],
          rowCount: 1
        };
      }
      if (sql.includes("INSERT INTO deployment_sources")) {
        return {
          rows: [{ id: sourceId, source_type: "compose_upload" }],
          rowCount: 1
        };
      }
      if (
        sql.includes("UPDATE deployment_analyses")
        && sql.includes("status = 'deployed'")
      ) {
        return {
          rows: [{ ...analysis, status: "deployed", source_id: sourceId }],
          rowCount: 1
        };
      }
      if (
        sql.includes("UPDATE compose_stacks")
        && sql.includes("deployment_source_id")
      ) {
        expect(values[2]).toBe(protectedEnvironment);
        expect(String(values[2])).not.toContain("never-publish-this");
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes("UPDATE compose_stack_versions")
        && sql.includes("SET env = $2")
      ) {
        expect(values[1]).toBe(protectedEnvironment);
        return { rows: [], rowCount: 1 };
      }
      return baseTransactionQuery(sql, values);
    });
    statHostPath.mockResolvedValue({
      exists: false,
      type: null,
      size: null,
      modifiedAt: null
    });
    runSshCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });

    const insertStackIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("INSERT INTO compose_stacks")
    );
    const insertSourceIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("INSERT INTO deployment_sources")
    );
    const deployAnalysisIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("UPDATE deployment_analyses")
      && String(sql).includes("status = 'deployed'")
    );
    const discardIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("result - $4::text")
    );
    expect(insertStackIndex).toBeGreaterThanOrEqual(0);
    expect(insertSourceIndex).toBeGreaterThan(insertStackIndex);
    expect(deployAnalysisIndex).toBeGreaterThan(insertSourceIndex);
    expect(discardIndex).toBeGreaterThan(deployAnalysisIndex);
    expect(JSON.parse(String(writes[1]?.[2]))).toMatchObject({
      status: "reconciled",
      composeStackDeployment: {
        status: "deployed",
        stackId: intent.candidateStackId,
        versionId: intent.candidateVersionId
      },
      deploymentExecution: {
        status: "deployed",
        analysisId,
        sourceId,
        stackId: intent.candidateStackId
      }
    });
    expect(String(writes[1]?.[2])).not.toContain("never-publish-this");
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "operation.remote_outcome.reconciled"
      }),
      expect.objectContaining({ query: transactionQuery })
    );
  });

  it("persists sanitized proof when daemon.json and the running Docker daemon agree", async () => {
    const persisted: unknown[][] = [];
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [registryTrustJob()], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, payload")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        persisted.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    runSshCommand
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          "log-driver": "json-file",
          "insecure-registries": [registry]
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          [registry]: { Secure: false }
        }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "removed\n",
        stderr: ""
      });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });

    expect(persisted).toHaveLength(1);
    const evidence = JSON.parse(String(persisted[0]?.[2]));
    expect(evidence).toMatchObject({
      status: "reconciled",
      inspection: {
        hostId,
        registry,
        dockerReady: true,
        daemonConfigured: true,
        runtimeTrusted: true
      },
      registryTrustCandidateCleanup: { state: "removed" }
    });
    expect(JSON.stringify(evidence)).not.toMatch(/password|token|credential/i);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId,
        action: "operation.remote_outcome.reconciled",
        targetId: jobId
      }),
      expect.objectContaining({ query: transactionQuery })
    );
    expect(cleanupSshRemoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "docker.example.test" }),
      "e".repeat(64)
    );
    expect(runSshCommand.mock.calls[2]?.[1]).toContain(
      `/tmp/composebastion-daemon-${jobId}-1.json`
    );
  });

  it("keeps registry trust pending and retries idempotent candidate cleanup", async () => {
    const pendingWrites: unknown[][] = [];
    const reconciledWrites: unknown[][] = [];
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [registryTrustJob()], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, payload")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        pendingWrites.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockImplementation(
      async (sql: string, values: unknown[] = []) => {
        if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
          reconciledWrites.push(values);
          return { rows: [{ id: jobId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    );
    runSshCommand
      // First inspection succeeds.
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ "insecure-registries": [registry] }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ [registry]: { Secure: false } }),
        stderr: ""
      })
      // Candidate removal cannot be confirmed.
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "temporary cleanup unavailable"
      })
      // Retry repeats authoritative inspection.
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ "insecure-registries": [registry] }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ [registry]: { Secure: false } }),
        stderr: ""
      })
      // Idempotent cleanup observes that the candidate is already absent.
      .mockResolvedValueOnce({
        code: 0,
        stdout: "absent\n",
        stderr: ""
      });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 1
    });
    expect(JSON.parse(String(pendingWrites[0]?.[2]))).toMatchObject({
      status: "pending",
      error: "temporary cleanup unavailable",
      nextAttemptAt: expect.any(String)
    });
    expect(writeAuditEvent).not.toHaveBeenCalled();

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });
    expect(JSON.parse(String(reconciledWrites[0]?.[2]))).toMatchObject({
      status: "reconciled",
      registryTrustCandidateCleanup: { state: "absent" }
    });
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(runSshCommand.mock.calls.filter((call) =>
      String(call[1]).includes(
        `/tmp/composebastion-daemon-${jobId}-1.json`
      )
    )).toHaveLength(2);
  });

  it("keeps registry trust blocked when authoritative inspection fails", async () => {
    const persisted: unknown[][] = [];
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [registryTrustJob()], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, payload")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        persisted.push(values);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    runSshCommand.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "permission denied"
    });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 1
    });

    const evidence = JSON.parse(String(persisted[0]?.[2]));
    expect(evidence).toMatchObject({
      status: "pending",
      error: "permission denied",
      attemptCount: 1,
      nextAttemptAt: expect.any(String)
    });
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it("does not retry a pending inspection before its persisted backoff expires", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 0,
      reconciled: 0,
      pending: 0
    });

    const candidateSql = String(query.mock.calls[0]?.[0]);
    expect(candidateSql).toContain("nextAttemptAt");
    expect(candidateSql).toContain("<= now()");
    expect(query).toHaveBeenCalledTimes(1);
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("cannot persist or audit after another inspector steals its claim", async () => {
    let heartbeatCount = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [registryTrustJob()], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 2 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        heartbeatCount += 1;
        return heartbeatCount < 4
          ? { rows: [{ id: jobId }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT id, payload")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    runSshCommand
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ "insecure-registries": [registry] }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ [registry]: { Secure: false } }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "absent\n",
        stderr: ""
      });

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 0
    });
    expect(transactionQuery).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it("does not publish a reconciled result when its transactional audit fails", async () => {
    const pendingWrites: unknown[][] = [];
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("jobs.completed_at <= now()")) {
        return { rows: [registryTrustJob()], rowCount: 1 };
      }
      if (sql.includes("'claimToken', $3::text")) {
        return { rows: [{ attempt_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("'heartbeatAt', clock_timestamp()")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, payload")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("jsonb_build_object($2::text, $3::jsonb)")) {
        pendingWrites.push(values);
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    transactionQuery.mockResolvedValue({
      rows: [{ id: jobId }],
      rowCount: 1
    });
    runSshCommand
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ "insecure-registries": [registry] }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ [registry]: { Secure: false } }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "absent\n",
        stderr: ""
      });
    writeAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 0,
      pending: 1
    });
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("claimToken"),
      expect.any(Array)
    );
    expect(writeAuditEvent).toHaveBeenCalledOnce();
    expect(cleanupSshRemoteOperation).not.toHaveBeenCalled();
    expect(JSON.parse(String(pendingWrites[0]?.[2]))).toMatchObject({
      status: "pending",
      error: "audit unavailable",
      nextAttemptAt: expect.any(String)
    });
  });

  it("requires Docker runtime trust to agree with daemon.json before unlocking", async () => {
    runSshCommand
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ "insecure-registries": [registry] }),
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "{}",
        stderr: ""
      });

    await expect(
      inspectRegistryTrustRemoteOutcome(hostId, registry)
    ).rejects.toThrow("do not agree");
  });

  it("captures authoritative Compose container, network, volume, and image state", async () => {
    statHostPath.mockImplementation(async (_targetHostId: string, targetPath: string) => ({
      exists: !targetPath.endsWith("/.git/index.lock"),
      type: targetPath.endsWith("/.git/index.lock") ? null : "file",
      size: targetPath.endsWith("/.git/index.lock") ? null : 1,
      modifiedAt: targetPath.endsWith("/.git/index.lock")
        ? null
        : new Date(0).toISOString()
    }));
    runSshCommand
      .mockResolvedValueOnce({
        code: 0,
        stdout: `${JSON.stringify({
          ID: "container-id",
          Names: "web",
          Image: "registry.example.test/app:1",
          State: "running",
          Status: "Up"
        })}\n`,
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: `${JSON.stringify({
          ID: "network-id",
          Name: "demo_default",
          Driver: "bridge",
          Scope: "local"
        })}\n`,
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: `${JSON.stringify({
          Name: "demo_data",
          Driver: "local",
          Scope: "local"
        })}\n`,
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: `${JSON.stringify({
          ID: "sha256:image",
          Repository: "registry.example.test/app",
          Tag: "1",
          Digest: "sha256:digest"
        })}\n`,
        stderr: ""
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "https://git.example.test/team/app.git\tdeadbeef\n",
        stderr: ""
      });

    await expect(inspectRemoteOutcomeTarget({
      hostId,
      workingDir: "/srv/demo",
      composePath: "/srv/demo/compose.yml",
      projectName: "demo"
    })).resolves.toMatchObject({
      composeProject: {
        containerCount: 1,
        networkCount: 1,
        volumeCount: 1,
        referencedImageCount: 1,
        containers: [{ id: "container-id", name: "web" }],
        networks: [{ id: "network-id", name: "demo_default" }],
        volumes: [{ name: "demo_data" }],
        images: [{ id: "sha256:image", repository: "registry.example.test/app" }]
      }
    });

    const commands = runSshCommand.mock.calls.map(([, command]) =>
      String(command)
    );
    expect(commands.some((command) => command.includes("docker ps --all"))).toBe(true);
    expect(commands.some((command) => command.includes("docker network ls"))).toBe(true);
    expect(commands.some((command) => command.includes("docker volume ls"))).toBe(true);
    expect(commands.filter((command) =>
      command.includes("label=com.docker.compose.project=demo")
    )).toHaveLength(3);
  });
});
