import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupEvidenceFailures } from "./qualification-policy.mjs";
import { acceptanceScenarioManifest } from "./scenario-manifest.mjs";
import { acceptanceUpgradeBaselines, acceptanceUpgradeBridge } from "./upgrade-baselines.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const acceptanceResultsDir = path.join(root, "test-results", "acceptance");
const reportPath = process.argv[2] ?? path.join(root, "test-results", "acceptance", "report.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const goAttributionManifest = JSON.parse(await readFile(path.join(root, "LICENSES/go-modules/manifest.json"), "utf8"));
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
const expectedDeferredGates = ["real-nas", "real-cloud", "go-module-legal-review"];
const actualDeferredGates = (report.releaseQualification?.deferredGates ?? []).map((gate) => gate.id);
if (JSON.stringify(actualDeferredGates) !== JSON.stringify(expectedDeferredGates)) {
  failures.push(`deferred gate IDs are ${JSON.stringify(actualDeferredGates)}, expected ${JSON.stringify(expectedDeferredGates)}`);
}
for (const gate of report.releaseQualification?.deferredGates ?? []) {
  if (!gate.status || !gate.detail) failures.push(`deferred gate ${JSON.stringify(gate.id)} is missing status or detail`);
}
const goLegalGate = (report.releaseQualification?.deferredGates ?? []).find((gate) => gate.id === "go-module-legal-review");
if (goAttributionManifest.review?.status === "pending" && goLegalGate?.status !== "manual-required") {
  failures.push("pending Go attribution review is not rendered as manual-required");
}
if (goAttributionManifest.review?.status === "approved"
    && (goLegalGate?.status !== "approved"
      || !String(goLegalGate.detail).includes(goAttributionManifest.review.approvedBy)
      || !String(goLegalGate.detail).includes(goAttributionManifest.review.approvedAt))) {
  failures.push("approved Go attribution review evidence is not rendered in the acceptance report");
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
for (const flag of ["skipBuild", "skipUpgrade", "allowNonqualifying", "keep"]) {
  if (report.environment?.[flag] !== false) failures.push(`environment.${flag} is not false`);
}
failures.push(...cleanupEvidenceFailures(report.cleanup));

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
for (const baseline of acceptanceUpgradeBaselines) {
  const scenario = (report.scenarios ?? []).find(
    (item) => item.id === baseline.scenarioId
  );
  if (scenario?.detail?.from !== baseline.version
      || scenario?.detail?.to !== report.candidateVersion
      || scenario?.detail?.publicImage?.version !== baseline.version
      || scenario?.detail?.publicImage?.releaseTag !== baseline.releaseTag
      || scenario?.detail?.publicImage?.repoDigest !== baseline.pinnedImage
      || scenario?.detail?.bridge?.version !== acceptanceUpgradeBridge.version
      || scenario?.detail?.bridge?.releaseTag !== acceptanceUpgradeBridge.releaseTag
      || scenario?.detail?.bridge?.reference !== acceptanceUpgradeBridge.pinnedImage
      || scenario?.detail?.bridge?.repoDigest !== acceptanceUpgradeBridge.pinnedImage) {
    failures.push(
      `${baseline.scenarioId} is not bound to exact public ${baseline.version} and ${acceptanceUpgradeBridge.version} bridge image evidence`
    );
  }
  for (const outcome of ["failed", "successful"]) {
    const jobId = scenario?.detail?.hardenedUpdaterJobs?.[outcome]?.jobId;
    const outcomeFile = scenario?.detail?.hardenedUpdaterJobs?.[outcome]?.outcomeFile;
    if (typeof jobId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)
        || outcomeFile !== `.composebastion-self-update-${jobId}.outcome`) {
      failures.push(`${baseline.scenarioId} ${outcome} updater outcome is not bound to its durable job ID`);
    }
  }
  if (baseline.rollbackRehearsal
      && (scenario?.detail?.rollbackVersion !== acceptanceUpgradeBridge.version
        || scenario?.detail?.reupgradeVersion !== report.candidateVersion
        || scenario?.detail?.volumesRetained !== true
        || scenario?.detail?.rollbackReupgradeHealthy !== true)) {
    failures.push(
      `${baseline.scenarioId} does not prove rollback and re-upgrade on retained volumes`
    );
  }
  if (scenario?.detail?.credentialPreparation?.credentialTransition !== baseline.expectedCredentialTransition
      || scenario?.detail?.credentialPreparation?.environmentAction !== baseline.expectedEnvironmentAction
      || scenario?.detail?.credentialPreparation?.rawEnvironmentCanonicalized !== true) {
    failures.push(
      `${baseline.scenarioId} does not prove its raw-environment and credential preparation results separately`
    );
  }
  if (baseline.expectedCredentialTransition === "changed"
      && (scenario?.detail?.credentialPreparation?.actualRotationVerified !== true
        || scenario?.detail?.credentialPreparation?.restorationVerified !== true)) {
    failures.push(`${baseline.scenarioId} does not prove actual managed credential rotation and restoration`);
  }
  if (baseline.expectedCredentialTransition === "unchanged"
      && scenario?.detail?.credentialPreparation?.unchangedCredentialVerified !== true) {
    failures.push(`${baseline.scenarioId} does not prove that the managed credential remained unchanged`);
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
const freshScenario = (report.scenarios ?? []).find((item) => item.id === "fresh-image-install");
const liveBrowser = freshScenario?.detail?.liveBrowser;
const expectedBrowserProjects = {
  chromiumDesktop: "chromium-live",
  chromiumMobile: "chromium-live-mobile",
  firefoxDesktop: "firefox-live-critical",
  firefoxMobile: "firefox-live-mobile-critical",
  webkitDesktop: "webkit-live-critical",
  webkitMobile: "webkit-live-mobile-critical"
};
if (liveBrowser?.realBrowser !== true
    || liveBrowser?.database !== true
    || liveBrowser?.redis !== true
    || liveBrowser?.worker !== true
    || liveBrowser?.readOnlyQualificationSmoke !== true
    || liveBrowser?.projectCount !== Object.keys(expectedBrowserProjects).length
    || liveBrowser?.rawSecretBearingArtifactsExcluded !== true) {
  failures.push("live browser evidence does not attest the complete real six-project stack");
}
if (Object.keys(liveBrowser?.matrix ?? {}).length !== Object.keys(expectedBrowserProjects).length) {
  failures.push("live browser evidence matrix does not contain exactly six projects");
}
for (const [key, project] of Object.entries(expectedBrowserProjects)) {
  const entry = liveBrowser?.matrix?.[key];
  if (entry?.project !== project
      || !Number.isInteger(entry?.tests)
      || entry.tests < 1
      || entry.passed !== true) {
    failures.push(`live browser evidence matrix entry ${key} is not a passing ${project} execution`);
  }
}
const expectedBrowserEvidenceFile = `live-browser-${report.source?.headSha}-${report.environment?.portBase}.json`;
if (typeof liveBrowser?.evidenceFile !== "string"
    || liveBrowser.evidenceFile !== expectedBrowserEvidenceFile
    || path.basename(liveBrowser.evidenceFile) !== liveBrowser.evidenceFile) {
  failures.push("live browser evidence filename is not bound to the candidate commit and port");
} else {
  const evidencePath = path.resolve(acceptanceResultsDir, liveBrowser.evidenceFile);
  if (path.dirname(evidencePath) !== acceptanceResultsDir) {
    failures.push("live browser evidence path escapes test-results/acceptance");
  } else {
    let handle;
    try {
      const resultsStat = await lstat(acceptanceResultsDir);
      if (!resultsStat.isDirectory() || resultsStat.isSymbolicLink()) {
        throw new Error("test-results/acceptance is not a real directory");
      }
      handle = await open(evidencePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new Error("evidence is not a mode-0600 regular file");
      }
      const contents = await handle.readFile();
      const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
      if (liveBrowser.evidenceSha256 !== digest) throw new Error("evidence SHA-256 does not match");
      const evidence = JSON.parse(contents.toString("utf8"));
      const expectedEvidence = {
        realBrowser: liveBrowser.realBrowser,
        database: liveBrowser.database,
        redis: liveBrowser.redis,
        worker: liveBrowser.worker,
        readOnlyQualificationSmoke: liveBrowser.readOnlyQualificationSmoke,
        projectCount: liveBrowser.projectCount,
        matrix: liveBrowser.matrix,
        rawSecretBearingArtifactsExcluded: liveBrowser.rawSecretBearingArtifactsExcluded
      };
      if (JSON.stringify(evidence) !== JSON.stringify(expectedEvidence)) {
        throw new Error("evidence matrix does not match the acceptance report");
      }
    } catch (error) {
      failures.push(`live browser evidence is invalid: ${error instanceof Error ? error.message : error}`);
    } finally {
      await handle?.close();
    }
  }
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
