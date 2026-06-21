import type { FastifyReply, FastifyRequest } from "fastify";
import type { OperationJob } from "@composebastion/shared";

export function errorCode(error: unknown) {
  const explicit = (error as { code?: unknown })?.code;
  if (typeof explicit === "string" && explicit) return explicit;
  const status = Number((error as { statusCode?: unknown; status?: unknown })?.statusCode ?? (error as { status?: unknown })?.status);
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status >= 500) return "INTERNAL_ERROR";
  return "OPERATION_ERROR";
}

export function apiLogFields(request: FastifyRequest, reply: FastifyReply, startedAtMs: number) {
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const hostId = typeof params.hostId === "string" ? params.hostId : typeof params.id === "string" && request.routeOptions.url?.startsWith("/api/hosts/") ? params.id : undefined;
  const jobId = typeof params.id === "string" && request.routeOptions.url?.startsWith("/api/jobs/") ? params.id : undefined;
  return {
    requestId: request.id,
    hostId,
    jobId,
    action: request.routeOptions.url ?? request.url,
    durationMs: Date.now() - startedAtMs,
    status: reply.statusCode,
    errorCode: reply.statusCode >= 400 ? errorCode({ statusCode: reply.statusCode }) : undefined
  };
}

export function workerJobLogFields(job: Pick<OperationJob, "id" | "hostId" | "type">, status: string, startedAtMs: number, error?: unknown) {
  return {
    jobId: job.id,
    hostId: job.hostId,
    action: job.type,
    durationMs: Date.now() - startedAtMs,
    status,
    errorCode: error ? errorCode(error) : undefined
  };
}
