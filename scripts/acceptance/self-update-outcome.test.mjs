import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSelfUpdateOutcomeStatus,
  parseSelfUpdateOutcome
} from "./self-update-outcome.mjs";

const failedOutcome = [
  "schema=1",
  "job_id=job-123",
  "status=failed",
  "stage=verification",
  "rollback=succeeded",
  "target_version=1.2.0",
  "exit_code=1",
  ""
].join("\n");

test("parses only the exact non-secret updater outcome schema", () => {
  assert.deepEqual(parseSelfUpdateOutcome(failedOutcome, {
    expectedJobId: "job-123",
    expectedTargetVersion: "1.2.0"
  }), {
    schema: "1",
    job_id: "job-123",
    status: "failed",
    stage: "verification",
    rollback: "succeeded",
    target_version: "1.2.0",
    exit_code: "1"
  });
  assert.throws(() => parseSelfUpdateOutcome(`${failedOutcome}secret=value\n`, {
    expectedJobId: "job-123",
    expectedTargetVersion: "1.2.0"
  }), /unexpected schema/);
});

test("reports a terminal mismatch with sanitized stage, rollback, and exit evidence", () => {
  const outcome = parseSelfUpdateOutcome(failedOutcome, {
    expectedJobId: "job-123",
    expectedTargetVersion: "1.2.0"
  });
  assert.throws(() => assertSelfUpdateOutcomeStatus(outcome, "passed"),
    /status=failed stage=verification rollback=succeeded exit_code=1; expected status=passed/);
});
