import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceScenarioManifest } from "./scenario-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reportPath = process.argv[2] ?? path.join(root, "test-results", "acceptance", "report.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const failures = [];

function evidenceValue(detail, pathExpression) {
  return pathExpression.split(".").reduce((value, key) => value?.[key], detail);
}

function hasEvidence(value) {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

if (report.status !== "passed") failures.push(`status is ${JSON.stringify(report.status)}, expected "passed"`);
if (report.releaseQualification?.automatedAcceptanceQualifying !== true) {
  failures.push("automatedAcceptanceQualifying is not true");
}
if (report.releaseQualification?.manifestComplete !== true) failures.push("manifestComplete is not true");
if ((report.releaseQualification?.nonqualifyingReasons ?? []).length !== 0) {
  failures.push("nonqualifyingReasons is not empty");
}
const expectedDeferredGates = ["real-nas", "real-cloud", "go-module-legal-review", "release-governance"];
const actualDeferredGates = (report.releaseQualification?.deferredGates ?? []).map((gate) => gate.id);
if (JSON.stringify(actualDeferredGates) !== JSON.stringify(expectedDeferredGates)) {
  failures.push(`deferred gate IDs are ${JSON.stringify(actualDeferredGates)}, expected ${JSON.stringify(expectedDeferredGates)}`);
}
for (const gate of report.releaseQualification?.deferredGates ?? []) {
  if (!gate.status || !gate.detail) failures.push(`deferred gate ${JSON.stringify(gate.id)} is missing status or detail`);
}
if (JSON.stringify(report.acceptanceManifest) !== JSON.stringify(acceptanceScenarioManifest)) {
  failures.push("embedded acceptance manifest does not match the current release contract");
}
if (report.source?.dirty !== false || report.source?.finalDirty !== false || report.source?.identityStable !== true) {
  failures.push("source identity is dirty or changed during acceptance");
}
if (report.source?.buildContext?.strategy !== "git-tree-objects"
    || report.source?.buildContext?.commitSha !== report.source?.headSha
    || report.source?.buildContext?.treeSha !== report.source?.treeSha
    || report.source?.buildContextStable !== true
    || report.source?.finalBuildContextDigest !== report.source?.buildContext?.contextDigest
    || report.source?.finalBuildContextFileCount !== report.source?.buildContext?.fileCount) {
  failures.push("Docker build context is not a stable exact archive of the recorded Git commit/tree");
}
for (const flag of ["skipBuild", "skipUpgrade", "allowNonqualifying"]) {
  if (report.environment?.[flag] !== false) failures.push(`environment.${flag} is not false`);
}

for (const expected of acceptanceScenarioManifest) {
  const items = (report.scenarios ?? []).filter((item) => item.id === expected.id);
  if (items.length !== 1) {
    failures.push(`${expected.id} has ${items.length} report entries`);
    continue;
  }
  if (items[0].status !== "passed") {
    failures.push(`${expected.id} status is ${items[0].status}`);
    continue;
  }
  for (const evidencePath of expected.requiredEvidence) {
    if (!hasEvidence(evidenceValue(items[0].detail, evidencePath))) {
      failures.push(`${expected.id} is missing ${evidencePath}`);
    }
  }
}
const candidateScenario = (report.scenarios ?? []).find((item) => item.id === "candidate-images");
if (candidateScenario?.detail?.exactGitContext !== true
    || candidateScenario?.detail?.treeSha !== report.source?.treeSha
    || candidateScenario?.detail?.contextDigest !== report.source?.buildContext?.contextDigest) {
  failures.push("candidate images were not built from the recorded exact Git context");
}
const sourceScenario = (report.scenarios ?? []).find((item) => item.id === "source-production-install");
if (sourceScenario?.detail?.exactGitContext !== true
    || sourceScenario?.detail?.treeSha !== report.source?.treeSha) {
  failures.push("source-production installation did not use the recorded exact Git context");
}
if ((report.scenarios ?? []).length !== acceptanceScenarioManifest.length) {
  failures.push("report contains an unexpected number of scenarios");
}

if (failures.length > 0) {
  console.error(`Acceptance report is not release-qualifying:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Acceptance report is release-qualifying: ${reportPath}`);
}
