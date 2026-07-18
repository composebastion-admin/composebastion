import { z } from "zod";

export const REPOSITORY_AGENT_TOKEN_PLACEHOLDERS = Object.freeze([
  "change-this-to-a-long-random-token",
  "replace-this-with-a-long-random-token",
  "replace-with-a-long-random-token",
  "composebastion-agent-token",
  "your-composebastion-agent-token",
  "ci-test-agent-token-which-is-at-least-32-chars-long",
  "compose-contract-agent-token-0123456789abcdef",
  "9f6fef649ab34306b881ec545f728771"
]);
const knownPlaceholderTokens = new Set(REPOSITORY_AGENT_TOKEN_PLACEHOLDERS);

export function isKnownPlaceholderAgentToken(value: string) {
  return knownPlaceholderTokens.has(value.trim().toLowerCase());
}

export const agentTokenSchema = z.string()
  .trim()
  .min(24, "AGENT_TOKEN must contain at least 24 characters")
  .refine((value) => !isKnownPlaceholderAgentToken(value), "AGENT_TOKEN must not use a documented placeholder value");

export function parseAgentEnvironment(source: NodeJS.ProcessEnv) {
  return z.object({
    AGENT_HOST: z.string().default("0.0.0.0"),
    AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
    AGENT_TOKEN: agentTokenSchema,
    AGENT_READ_RATE_LIMIT: z.coerce.number().int().min(1).default(120),
    AGENT_RUN_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
    AGENT_FILE_RATE_LIMIT: z.coerce.number().int().min(1).default(60),
    AGENT_STREAM_RATE_LIMIT: z.coerce.number().int().min(1).default(10)
  }).parse(source);
}

export function resolveAgentVersion(configuredVersion: string | undefined, packageVersion: string | undefined) {
  const configured = configuredVersion?.trim();
  if (configured && !["source", "unknown"].includes(configured.toLowerCase())) return configured;
  return packageVersion?.trim() || "unknown";
}
