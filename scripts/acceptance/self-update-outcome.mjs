import assert from "node:assert/strict";

const outcomeKeys = [
  "schema",
  "job_id",
  "status",
  "stage",
  "rollback",
  "target_version",
  "exit_code"
];

export function parseSelfUpdateOutcome(contents, { expectedJobId, expectedTargetVersion }) {
  const fields = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    assert(separator > 0, "self-update outcome contains an invalid field");
    const key = line.slice(0, separator);
    assert(!fields.has(key), "self-update outcome contains a duplicate field");
    fields.set(key, line.slice(separator + 1));
  }

  assert(fields.size === outcomeKeys.length
    && [...fields.keys()].every((key) => outcomeKeys.includes(key)),
  "self-update outcome has an unexpected schema");
  assert(fields.get("schema") === "1", "self-update outcome has an unsupported schema");
  assert(fields.get("job_id") === expectedJobId, "self-update outcome belongs to a different job");
  assert(fields.get("target_version") === expectedTargetVersion,
    "self-update outcome targets a different version");

  const outcome = Object.fromEntries(fields);
  assert(outcome.status === "passed" || outcome.status === "failed",
    "self-update outcome has an invalid status");
  assert(/^[a-z][a-z0-9_]{0,63}$/.test(outcome.stage),
    "self-update outcome has an invalid stage");
  assert(["not_required", "succeeded", "failed"].includes(outcome.rollback),
    "self-update outcome has an invalid rollback status");
  assert(/^(?:0|[1-9][0-9]{0,2})$/.test(outcome.exit_code),
    "self-update outcome has an invalid exit code");
  return outcome;
}

export function assertSelfUpdateOutcomeStatus(outcome, expectedStatus) {
  assert(outcome.status === expectedStatus,
    `updater outcome mismatch: status=${outcome.status} stage=${outcome.stage} rollback=${outcome.rollback} exit_code=${outcome.exit_code}; expected status=${expectedStatus}`);
}
