import path from "node:path";

export const expectedTrivyVersion = "0.72.0";

export const reviewedContainerConfigExceptions = new Map([
  [
    "Dockerfile.agent:DS-0002",
    "The agent mounts the root-owned Docker socket; Docker API access is already host-root-equivalent."
  ],
  [
    "infra/dev/sshhost.Dockerfile:DS-0002",
    "The development-only SSH fixture runs sshd, provisions root credentials, and models a root Docker host."
  ]
]);

const expectedUserChecks = new Map([
  ["Dockerfile", { status: "PASS", severity: "HIGH" }],
  ["Dockerfile.agent", { status: "FAIL", severity: "HIGH" }],
  ["infra/dev/sshhost.Dockerfile", { status: "FAIL", severity: "HIGH" }]
]);
const highSeverities = new Set(["HIGH", "CRITICAL"]);

export function evaluateContainerConfigReport(target, report) {
  const failures = [];
  const admitted = [];
  const expectedUserCheck = expectedUserChecks.get(target);
  if (!expectedUserCheck) {
    return { failures: [`${target}: target is not part of the reviewed container configuration policy`], admitted };
  }

  if (report?.Trivy?.Version !== expectedTrivyVersion) {
    failures.push(
      `${target}: report used Trivy ${report?.Trivy?.Version ?? "unknown"}, expected ${expectedTrivyVersion}`
    );
  }
  if (report?.ArtifactName !== target || report?.ArtifactType !== "filesystem") {
    failures.push(`${target}: Trivy report is not bound to the exact requested filesystem artifact`);
  }

  const matchingResults = (report?.Results ?? []).filter(
    (result) => result?.Type === "dockerfile"
      && path.basename(String(result.Target ?? "")) === path.basename(target)
  );
  if (matchingResults.length !== 1) {
    failures.push(`${target}: expected exactly one Dockerfile result, got ${matchingResults.length}`);
  }
  const findings = matchingResults.flatMap((result) => result.Misconfigurations ?? []);
  const userChecks = findings.filter((finding) => finding?.ID === "DS-0002");
  if (userChecks.length !== 1) {
    failures.push(`${target}: expected exactly one DS-0002 result, got ${userChecks.length}`);
  } else {
    const userCheck = userChecks[0];
    if (userCheck.Status !== expectedUserCheck.status || userCheck.Severity !== expectedUserCheck.severity) {
      failures.push(
        `${target}: DS-0002 must be ${expectedUserCheck.severity}/${expectedUserCheck.status}, got `
        + `${userCheck.Severity ?? "unknown"}/${userCheck.Status ?? "unknown"}`
      );
    }
  }

  for (const finding of findings) {
    if (finding?.Status !== "FAIL" || !highSeverities.has(finding?.Severity)) continue;
    const key = `${target}:${finding.ID}`;
    const reason = reviewedContainerConfigExceptions.get(key);
    if (!reason || finding.ID !== "DS-0002" || finding.Severity !== "HIGH") {
      failures.push(`${key}: ${finding.Severity} ${finding.Title}`);
      continue;
    }
    admitted.push(`${key} (${reason})`);
  }

  if (expectedUserCheck.status === "FAIL" && admitted.length !== 1) {
    failures.push(`${target}: the reviewed DS-0002 exception was not observed exactly once`);
  }
  if (expectedUserCheck.status === "PASS" && admitted.length !== 0) {
    failures.push(`${target}: the manager must not use a container-user exception`);
  }

  return { failures, admitted };
}
