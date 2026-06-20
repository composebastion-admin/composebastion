import path from "node:path";

export const AGENT_STACK_ROOT = "/tmp/composebastion";

export function validateAgentFilePath(input: string) {
  const normalized = path.posix.normalize(input);
  if (!normalized.startsWith(`${AGENT_STACK_ROOT}/`)) {
    throw new Error("Agent file access is limited to /tmp/composebastion");
  }
  return normalized;
}
