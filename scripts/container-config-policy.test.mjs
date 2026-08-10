import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateContainerConfigReport,
  expectedTrivyVersion
} from "./container-config-policy.mjs";

function report(target, userStatus, options = {}) {
  const targetName = target.split("/").at(-1);
  const userCheck = options.omitUserCheck
    ? []
    : [{
        ID: "DS-0002",
        Title: "Image user should not be 'root'",
        Severity: options.userSeverity ?? "HIGH",
        Status: userStatus
      }];
  return {
    Trivy: { Version: options.version ?? expectedTrivyVersion },
    ArtifactName: options.artifactName ?? target,
    ArtifactType: "filesystem",
    Results: [{
      Target: targetName,
      Type: "dockerfile",
      Misconfigurations: [...userCheck, ...(options.extraFindings ?? [])]
    }]
  };
}

test("manager DS-0002 pass needs no exception", () => {
  const result = evaluateContainerConfigReport("Dockerfile", report("Dockerfile", "PASS"));
  assert.deepEqual(result, { failures: [], admitted: [] });
});

test("only the exact agent DS-0002 failure is admitted", () => {
  const result = evaluateContainerConfigReport(
    "Dockerfile.agent",
    report("Dockerfile.agent", "FAIL")
  );
  assert.equal(result.failures.length, 0);
  assert.equal(result.admitted.length, 1);
  assert.match(result.admitted[0], /^Dockerfile\.agent:DS-0002 /);
});

test("missing DS-0002 result fails closed", () => {
  const result = evaluateContainerConfigReport(
    "Dockerfile.agent",
    report("Dockerfile.agent", "FAIL", { omitUserCheck: true })
  );
  assert.ok(result.failures.some((failure) => failure.includes("exactly one DS-0002")));
  assert.ok(result.failures.some((failure) => failure.includes("not observed exactly once")));
});

test("wrong Trivy version and artifact binding fail closed", () => {
  const result = evaluateContainerConfigReport(
    "Dockerfile",
    report("Dockerfile", "PASS", { version: "0.73.0", artifactName: "other/Dockerfile" })
  );
  assert.ok(result.failures.some((failure) => failure.includes("expected 0.72.0")));
  assert.ok(result.failures.some((failure) => failure.includes("exact requested")));
});

test("changed exception status or severity fails closed", () => {
  const passed = evaluateContainerConfigReport(
    "Dockerfile.agent",
    report("Dockerfile.agent", "PASS")
  );
  assert.ok(passed.failures.length > 0);

  const lowerSeverity = evaluateContainerConfigReport(
    "Dockerfile.agent",
    report("Dockerfile.agent", "FAIL", { userSeverity: "MEDIUM" })
  );
  assert.ok(lowerSeverity.failures.length > 0);
});

test("any unrelated HIGH or CRITICAL failure is rejected", () => {
  const result = evaluateContainerConfigReport(
    "Dockerfile.agent",
    report("Dockerfile.agent", "FAIL", {
      extraFindings: [{
        ID: "DS-9999",
        Title: "Unexpected test finding",
        Severity: "CRITICAL",
        Status: "FAIL"
      }]
    })
  );
  assert.ok(result.failures.some((failure) => failure.includes("DS-9999")));
});
