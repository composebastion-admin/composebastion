import { Redis } from "ioredis";
import { env } from "../config/env.js";

export function createRedis() {
  if (!env.REDIS_URL) return null;
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true
  });
}
