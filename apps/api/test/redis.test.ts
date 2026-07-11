import { afterEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { createRedis, redisErrorType } from "../src/services/redis.js";

const originalRedisUrl = env.REDIS_URL;

afterEach(() => {
  env.REDIS_URL = originalRedisUrl;
});

describe("Redis connection roles", () => {
  it("reduces connection failures to credential-safe diagnostic types", () => {
    expect(redisErrorType(Object.assign(new Error("redis://user:secret@host"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED");
    expect(redisErrorType(new Error("sensitive detail"))).toBe("Error");
  });

  it("keeps command clients one-shot and subscriber clients reconnectable", () => {
    env.REDIS_URL = "redis://127.0.0.1:6379";
    const command = createRedis();
    const subscriber = createRedis({ reconnect: true });
    try {
      expect(command?.options.connectTimeout).toBe(2_000);
      expect(command?.options.maxRetriesPerRequest).toBe(1);
      expect(command?.options.retryStrategy?.(1)).toBeNull();

      expect(subscriber?.options.autoResubscribe).toBe(false);
      expect(subscriber?.options.maxRetriesPerRequest).toBeNull();
      expect(subscriber?.options.retryStrategy?.(1)).toBe(1_000);
      expect(subscriber?.options.retryStrategy?.(20)).toBe(10_000);
    } finally {
      command?.disconnect();
      subscriber?.disconnect();
    }
  });
});
