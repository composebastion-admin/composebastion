import { createHash } from "node:crypto";
import { z } from "zod";

export const DEFAULT_APP_SECRET = "change-me-to-a-long-random-secret-at-least-32-characters";

function parseOriginList(value: unknown) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return origin;
      }
    });
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  APP_SECRET: z.string().min(32).default(DEFAULT_APP_SECRET),
  DATABASE_URL: z.string().url().default("postgres://dockermender:dockermender@localhost:5432/dockermender"),
  REDIS_URL: z.string().url().optional(),
  BACKUP_DIR: z.string().default("/data/backups"),
  BACKUP_ENCRYPTION_KEYS: z.preprocess(optionalString, z.string()).default(""),
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: z.preprocess(optionalString, z.string()).default("app_secret"),
  BACKUP_HOST_PATH_ALLOWED_ROOTS: z.preprocess(optionalString, z.string()).default(""),
  WEB_DIST_DIR: z.string().optional(),
  CORS_ORIGINS: z.preprocess(parseOriginList, z.array(z.string().url())).default([]),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().default("dockermender@example.com"),
  HOST_CHECK_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  INVENTORY_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
  SECURE_COOKIES: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  ALLOW_PRIVATE_AGENT_URLS: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  ALLOW_PRIVATE_WEBHOOK_URLS: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  BLOCK_PRIVATE_S3_ENDPOINTS: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  // Controls how request.ip / X-Forwarded-For is interpreted. Leave "false" when the
  // API is directly exposed; set to "true", a hop count, or a comma-separated list of
  // trusted proxy IPs/subnets when running behind nginx/traefik/etc.
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((value) => {
      if (value === "true") return true;
      if (value === "false") return false;
      if (/^\d+$/.test(value)) return Number(value);
      return value;
    }),
  IMAGE_SCANNER_PROVIDER: z.string().default("auto"),
  MIGRATIONS_DIR: z.string().optional()
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === "production" && value.APP_SECRET === DEFAULT_APP_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["APP_SECRET"],
      message: "Set APP_SECRET to a unique random value before running in production"
    });
  }
});

export function parseEnv(input: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(input);
  // In production, ship Secure session cookies unless the operator explicitly opts out.
  if (parsed.NODE_ENV === "production" && input.SECURE_COOKIES === undefined) {
    parsed.SECURE_COOKIES = true;
  }
  return parsed;
}

export const env = parseEnv();

export const appSecretKey = createHash("sha256").update(env.APP_SECRET).digest();
