import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { JobExecutionFence } from "./jobs.js";

export const REMOTE_MUTATION_PROOF_KEY = "remoteMutationProof";
export const REMOTE_MUTATION_MAX_TIMEOUT_MS = 10 * 60_000;
export const REMOTE_MUTATION_COMPLETION_GRACE_MS = 15_000;

export type RemoteMutationTransport = "ssh" | "agent";
export type RemoteMutationTerminalState = "completed" | "failed" | "timed_out";
export type RemoteMutationRuntimeState =
  | RemoteMutationTerminalState
  | "running"
  | "missing"
  | "proof_unavailable";

export type RemoteMutationRuntimeStatus = {
  operationId: string;
  state: RemoteMutationRuntimeState;
  code?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type RemoteMutationProof = {
  operationId: string;
  jobId: string;
  attemptCount: number;
  sequence: number;
  phase: string;
  transport: RemoteMutationTransport;
  timeoutMs: number;
  status: "dispatched" | "terminal";
  terminalState?: RemoteMutationTerminalState;
  dispatchedAt?: string;
  completedAt?: string;
};

export type RemoteMutationContext = {
  operationId: string;
  jobId: string;
  attemptCount: number;
  sequence: number;
  phase: string;
  fence: JobExecutionFence;
  dispatched: boolean;
};

const contextStorage = new AsyncLocalStorage<RemoteMutationContext>();
const sequenceByFence = new WeakMap<JobExecutionFence, number>();
const OPERATION_ID = /^[0-9a-f]{64}$/;

export class RemoteMutationOutcomeUnknownError extends Error {
  readonly code = "REMOTE_MUTATION_OUTCOME_UNKNOWN";

  constructor(
    readonly operationId: string,
    readonly phase: string,
    readonly transport: RemoteMutationTransport,
    readonly remoteState: RemoteMutationRuntimeState | "transport_lost",
    cause?: unknown
  ) {
    super(
      `REMOTE_OUTCOME_UNKNOWN: Remote mutation '${phase}' (${operationId}) has no authoritative completion response `
      + `(${transport}:${remoteState}). Reconciliation must verify this exact operation is terminal before retrying.`,
      cause === undefined ? undefined : { cause }
    );
    this.name = "RemoteMutationOutcomeUnknownError";
  }
}

export function isRemoteMutationOutcomeUnknown(error: unknown) {
  return error instanceof RemoteMutationOutcomeUnknownError
    || Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "REMOTE_MUTATION_OUTCOME_UNKNOWN"
    );
}

function boundedTimeoutMs(timeoutMs: number | undefined) {
  const requested = Number.isFinite(timeoutMs) ? Math.floor(Number(timeoutMs)) : 120_000;
  return Math.max(1_000, Math.min(requested, REMOTE_MUTATION_MAX_TIMEOUT_MS));
}

export function normalizeRemoteMutationTimeoutMs(timeoutMs: number | undefined) {
  return boundedTimeoutMs(timeoutMs);
}

function nextContext(
  fence: JobExecutionFence | undefined,
  phase: string
): RemoteMutationContext | null {
  if (
    !fence
    || typeof fence.jobId !== "string"
    || !fence.jobId
    || !Number.isInteger(fence.attemptCount)
    || Number(fence.attemptCount) < 1
  ) {
    return null;
  }
  const attemptCount = Number(fence.attemptCount);
  const operationId = createHash("sha256")
    .update(`${fence.jobId}\0${attemptCount}\0${0}\0${phase}`, "utf8")
    .digest("hex");
  return {
    operationId,
    jobId: fence.jobId,
    attemptCount,
    sequence: 0,
    phase: phase.slice(0, 160),
    fence,
    dispatched: false
  };
}

export async function withRemoteMutationContext<T>(
  fence: JobExecutionFence | undefined,
  phase: string,
  operation: () => Promise<T>
) {
  const context = nextContext(fence, phase);
  return context
    ? contextStorage.run(context, operation)
    : operation();
}

export function currentRemoteMutationContext() {
  return contextStorage.getStore();
}

export async function recordRemoteMutationDispatch(
  context: RemoteMutationContext,
  transport: RemoteMutationTransport,
  timeoutMs: number | undefined
) {
  const sequence = (sequenceByFence.get(context.fence) ?? 0) + 1;
  sequenceByFence.set(context.fence, sequence);
  context.sequence = sequence;
  context.operationId = createHash("sha256")
    .update(
      `${context.jobId}\0${context.attemptCount}\0${sequence}\0${context.phase}`,
      "utf8"
    )
    .digest("hex");
  context.dispatched = false;
  const boundedTimeout = boundedTimeoutMs(timeoutMs);
  const proof: RemoteMutationProof = {
    operationId: context.operationId,
    jobId: context.jobId,
    attemptCount: context.attemptCount,
    sequence: context.sequence,
    phase: context.phase,
    transport,
    timeoutMs: boundedTimeout,
    status: "dispatched"
  };
  await context.fence.withActiveLease(async (client) => {
    const persisted = await client.query(
      `UPDATE operation_jobs
       SET result = COALESCE(result, '{}'::jsonb)
         || jsonb_build_object(
              $2::text,
              $3::jsonb
                || jsonb_build_object('dispatchedAt', clock_timestamp())
            ),
           updated_at = now()
       WHERE id = $1
         AND status = 'running'
         AND attempt_count = $4
       RETURNING id`,
      [
        context.jobId,
        REMOTE_MUTATION_PROOF_KEY,
        JSON.stringify(proof),
        context.attemptCount
      ]
    );
    if (!persisted.rows[0]) {
      throw Object.assign(
        new Error(`Job ${context.jobId} cannot dispatch remote operation ${context.operationId}`),
        { code: "JOB_LEASE_LOST" }
      );
    }
  });
  context.dispatched = true;
  return boundedTimeout;
}

export async function recordRemoteMutationTerminal(
  context: RemoteMutationContext,
  terminalState: RemoteMutationTerminalState
) {
  if (!context.dispatched) return;
  await context.fence.withActiveLease(async (client) => {
    const persisted = await client.query(
      `UPDATE operation_jobs
       SET result = COALESCE(result, '{}'::jsonb)
         || jsonb_build_object(
              $2::text,
              (result-> $2)
                || jsonb_build_object(
                     'status', 'terminal',
                     'terminalState', $3::text,
                     'completedAt', clock_timestamp()
                   )
            ),
           updated_at = now()
       WHERE id = $1
         AND status = 'running'
         AND attempt_count = $4
         AND result-> $2 ->> 'operationId' = $5
       RETURNING id`,
      [
        context.jobId,
        REMOTE_MUTATION_PROOF_KEY,
        terminalState,
        context.attemptCount,
        context.operationId
      ]
    );
    if (!persisted.rows[0]) {
      throw Object.assign(
        new Error(`Job ${context.jobId} lost remote operation ${context.operationId}`),
        { code: "JOB_LEASE_LOST" }
      );
    }
  });
  context.dispatched = false;
}

export function remoteMutationProofFromResult(result: unknown): RemoteMutationProof | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[REMOTE_MUTATION_PROOF_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proof = value as Record<string, unknown>;
  if (
    typeof proof.operationId !== "string"
    || !OPERATION_ID.test(proof.operationId)
    || typeof proof.jobId !== "string"
    || !proof.jobId
    || !Number.isInteger(proof.attemptCount)
    || Number(proof.attemptCount) < 1
    || !Number.isInteger(proof.sequence)
    || Number(proof.sequence) < 1
    || typeof proof.phase !== "string"
    || !proof.phase
    || (proof.transport !== "ssh" && proof.transport !== "agent")
    || !Number.isInteger(proof.timeoutMs)
    || Number(proof.timeoutMs) < 1_000
    || Number(proof.timeoutMs) > REMOTE_MUTATION_MAX_TIMEOUT_MS
    || (proof.status !== "dispatched" && proof.status !== "terminal")
  ) {
    return null;
  }
  if (
    proof.status === "terminal"
    && proof.terminalState !== "completed"
    && proof.terminalState !== "failed"
    && proof.terminalState !== "timed_out"
  ) {
    return null;
  }
  return proof as RemoteMutationProof;
}
