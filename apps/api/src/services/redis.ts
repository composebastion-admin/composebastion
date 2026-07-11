import { Redis } from "ioredis";
import { env } from "../config/env.js";

export type RedisConnectionOptions = {
  reconnect?: boolean;
};

export function redisErrorType(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code ?? "REDIS_ERROR");
  }
  return error instanceof Error ? error.name : "REDIS_ERROR";
}

export function createRedis(options: RedisConnectionOptions = {}) {
  if (!env.REDIS_URL) return null;
  const reconnect = options.reconnect === true;
  return new Redis(env.REDIS_URL, {
    autoResubscribe: !reconnect,
    connectTimeout: 2_000,
    lazyConnect: true,
    maxRetriesPerRequest: reconnect ? null : 1,
    retryStrategy: reconnect
      ? (attempt) => Math.min(attempt * 1_000, 10_000)
      : () => null
  });
}
