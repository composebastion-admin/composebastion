export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "REGISTRY_UNAVAILABLE"
  | "ACCOUNT_LOCKED"
  | "INTERNAL_ERROR";

export function sendApiError(
  reply: { request?: { id?: string }; code: (status: number) => { send: (body: unknown) => unknown } },
  status: number,
  code: ApiErrorCode,
  error: string,
  extra?: Record<string, unknown>
) {
  return reply.code(status).send({ error, code, requestId: reply.request?.id ?? null, ...extra });
}
