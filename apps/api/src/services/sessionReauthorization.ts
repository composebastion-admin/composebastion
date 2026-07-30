import type { AdminUser } from "@composebastion/shared";
import type { FastifyRequest } from "fastify";
import { readSession } from "./auth.js";

export const SESSION_REAUTHORIZATION_INTERVAL_MS = 30_000;

export type SessionReauthorizationFailure =
  | "authorization_revoked"
  | "authorization_check_failed";

export function startSessionReauthorization(
  request: FastifyRequest,
  allowedRoles: readonly AdminUser["role"][],
  onFailure: (
    reason: SessionReauthorizationFailure,
    error?: unknown
  ) => void,
  intervalMs = SESSION_REAUTHORIZATION_INTERVAL_MS
) {
  let stopped = false;
  let checkInFlight = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const check = async () => {
    if (stopped || checkInFlight) return;
    checkInFlight = true;
    let failure: SessionReauthorizationFailure | null = null;
    let failureError: unknown;
    try {
      const currentUser = await readSession(request, { touch: false });
      if (!currentUser || !allowedRoles.includes(currentUser.role)) {
        failure = "authorization_revoked";
      }
    } catch (error) {
      failure = "authorization_check_failed";
      failureError = error;
    } finally {
      checkInFlight = false;
    }

    if (!failure || stopped) return;
    stop();
    try {
      onFailure(failure, failureError);
    } catch {
      // The authorization timer must never create an unhandled rejection.
      // Callers close their transport in onFailure before doing other work.
    }
  };

  timer = setInterval(() => {
    void check();
  }, intervalMs);
  timer.unref?.();
  return stop;
}
