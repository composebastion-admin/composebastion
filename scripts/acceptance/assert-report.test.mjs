import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acceptanceScenarioManifest } from "./scenario-manifest.mjs";
import { cleanupEmptyFields, cleanupTrueFields } from "./qualification-policy.mjs";
import { acceptanceUpgradeBaselines } from "./upgrade-baselines.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assertionScript = path.join(root, "scripts/acceptance/assert-report.mjs");
const acceptanceResultsDir = path.join(root, "test-results", "acceptance");
const goManifest = JSON.parse(await readFile(path.join(root, "LICENSES/go-modules/manifest.json"), "utf8"));
const headSha = "0123456789abcdef0123456789abcdef01234567";
const treeSha = "89abcdef0123456789abcdef0123456789abcdef";
const contextDigest = `sha256:${"ab".repeat(32)}`;
let reportCounter = 0;

function setEvidence(target, expression, value = true) {
  const fields = expression.split(".");
  let cursor = target;
  for (const field of fields.slice(0, -1)) cursor = cursor[field] ??= {};
  cursor[fields.at(-1)] = value;
}

function passingCleanup() {
  return {
    ...Object.fromEntries(cleanupTrueFields.map((field) => [field, true])),
    ...Object.fromEntries(cleanupEmptyFields.map((field) => [field, []]))
  };
}

function passingReport() {
  const portBase = 19000 + reportCounter++;
  const scenarios = acceptanceScenarioManifest.map((entry) => {
    const detail = {};
    for (const evidence of entry.requiredEvidence) setEvidence(detail, evidence);
    return { id: entry.id, name: entry.name, status: "passed", durationMs: 1, detail };
  });
  const candidate = scenarios.find((item) => item.id === "candidate-images");
  candidate.detail.treeSha = treeSha;
  candidate.detail.contextDigest = contextDigest;
  candidate.detail.exactGitContext = true;
  const source = scenarios.find((item) => item.id === "source-production-install");
  source.detail.treeSha = treeSha;
  source.detail.exactGitContext = true;
  const fresh = scenarios.find((item) => item.id === "fresh-image-install");
  fresh.detail.liveBrowser = {
    realBrowser: true,
    database: true,
    redis: true,
    worker: true,
    readOnlyQualificationSmoke: true,
    projectCount: 6,
    matrix: {
      chromiumDesktop: { project: "chromium-live", tests: 1, passed: true },
      chromiumMobile: { project: "chromium-live-mobile", tests: 1, passed: true },
      firefoxDesktop: { project: "firefox-live-critical", tests: 1, passed: true },
      firefoxMobile: { project: "firefox-live-mobile-critical", tests: 1, passed: true },
      webkitDesktop: { project: "webkit-live-critical", tests: 1, passed: true },
      webkitMobile: { project: "webkit-live-mobile-critical", tests: 1, passed: true }
    },
    rawSecretBearingArtifactsExcluded: true
  };
  for (const baseline of acceptanceUpgradeBaselines) {
    const upgrade = scenarios.find((item) => item.id === baseline.scenarioId);
    upgrade.detail.from = baseline.version;
    upgrade.detail.to = "1.2.0-beta.1";
    upgrade.detail.publicImage.version = baseline.version;
    upgrade.detail.publicImage.releaseTag = baseline.releaseTag;
    upgrade.detail.publicImage.repoDigest = baseline.pinnedImage;
    upgrade.detail.legacyManagedCredentialReconciled = baseline.key === "legacy";
    if (baseline.rollbackRehearsal) {
      upgrade.detail.rollbackVersion = baseline.version;
      upgrade.detail.reupgradeVersion = "1.2.0-beta.1";
      upgrade.detail.volumesRetained = true;
      upgrade.detail.rollbackReupgradeHealthy = true;
    }
  }
  const goGate = goManifest.review?.status === "approved"
    ? {
        id: "go-module-legal-review",
        status: "approved",
        detail: `Approved by ${goManifest.review.approvedBy} at ${goManifest.review.approvedAt}`
      }
    : {
        id: "go-module-legal-review",
        status: "manual-required",
        detail: "Review linked Go module inventories"
      };
  return {
    candidateVersion: "1.2.0-beta.1",
    status: "passed",
    releaseQualification: {
      automatedAcceptanceQualifying: true,
      manifestComplete: true,
      nonqualifyingReasons: [],
      deferredGates: [
        { id: "real-nas", status: "manual-required", detail: "external fixture" },
        { id: "real-cloud", status: "manual-required", detail: "external fixture" },
        goGate
      ]
    },
    acceptanceManifest: acceptanceScenarioManifest,
    source: {
      dirty: false,
      finalDirty: false,
      identityStable: true,
      headSha,
      treeSha,
      buildContext: {
        strategy: "git-tree-objects",
        commitSha: headSha,
        treeSha,
        contextDigest,
        fileCount: 100
      },
      buildContextStable: true,
      finalBuildContextDigest: contextDigest,
      finalBuildContextFileCount: 100
    },
    environment: {
      portBase,
      skipBuild: false,
      skipUpgrade: false,
      allowNonqualifying: false,
      keep: false
    },
    cleanup: passingCleanup(),
    scenarios
  };
}

function browserEvidence(report) {
  const liveBrowser = report.scenarios.find((item) => item.id === "fresh-image-install").detail.liveBrowser;
  return {
    realBrowser: liveBrowser.realBrowser,
    database: liveBrowser.database,
    redis: liveBrowser.redis,
    worker: liveBrowser.worker,
    readOnlyQualificationSmoke: liveBrowser.readOnlyQualificationSmoke,
    projectCount: liveBrowser.projectCount,
    matrix: liveBrowser.matrix,
    rawSecretBearingArtifactsExcluded: liveBrowser.rawSecretBearingArtifactsExcluded
  };
}

async function assertReport(report, evidenceState = "valid") {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "composebastion-assert-report-"));
  const reportPath = path.join(tempDirectory, "report.json");
  const evidence = browserEvidence(report);
  const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceFile = `live-browser-${report.source.headSha}-${report.environment.portBase}.json`;
  const evidencePath = path.join(acceptanceResultsDir, evidenceFile);
  const liveBrowser = report.scenarios.find((item) => item.id === "fresh-image-install").detail.liveBrowser;
  liveBrowser.evidenceFile = evidenceFile;
  liveBrowser.evidenceSha256 = `sha256:${createHash("sha256").update(evidenceJson).digest("hex")}`;
  try {
    await mkdir(acceptanceResultsDir, { recursive: true });
    await rm(evidencePath, { force: true });
    if (evidenceState === "symlink") {
      const targetPath = path.join(tempDirectory, "browser-evidence-target.json");
      await writeFile(targetPath, evidenceJson, { mode: 0o600, flag: "wx" });
      await symlink(targetPath, evidencePath);
    } else if (evidenceState !== "missing") {
      await writeFile(evidencePath, evidenceJson, { mode: 0o600, flag: "wx" });
      if (evidenceState === "tampered") {
        await writeFile(evidencePath, `${JSON.stringify({ ...evidence, projectCount: 5 }, null, 2)}\n`);
      } else if (evidenceState === "permissive-mode") {
        await chmod(evidencePath, 0o644);
      }
    }
    await writeFile(reportPath, `${JSON.stringify(report)}\n`);
    return spawnSync(process.execPath, [assertionScript, reportPath], {
      cwd: root,
      encoding: "utf8"
    });
  } finally {
    await rm(evidencePath, { force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test("release assertion accepts complete cleanup evidence", async () => {
  const result = await assertReport(passingReport());
  assert.equal(result.status, 0, result.stderr);
});

test("release assertion rejects --keep even when every scenario passed", async () => {
  const report = passingReport();
  report.environment.keep = true;
  const result = await assertReport(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /environment\.keep is not false/);
});

test("release assertion rejects residual cleanup state", async () => {
  const report = passingReport();
  report.cleanup.verified = false;
  report.cleanup.volumes = ["composebastion-acceptance-19000-fresh_postgres-data"];
  const result = await assertReport(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cleanup\.verified is not true/);
  assert.match(result.stderr, /cleanup\.volumes is not empty/);
});

test("release assertion rejects missing live browser evidence", async () => {
  const result = await assertReport(passingReport(), "missing");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live browser evidence is invalid/);
});

test("release assertion rejects tampered live browser evidence", async () => {
  const result = await assertReport(passingReport(), "tampered");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /evidence SHA-256 does not match/);
});

test("release assertion rejects permissive live browser evidence mode", async () => {
  const result = await assertReport(passingReport(), "permissive-mode");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mode-0600 regular file/);
});

test("release assertion rejects symlinked live browser evidence", async () => {
  const result = await assertReport(passingReport(), "symlink");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live browser evidence is invalid/);
});

test("release assertion rejects an upgrade scenario bound to the wrong public image", async () => {
  const report = passingReport();
  const scenario = report.scenarios.find((item) => item.id === "current-stable-upgrade");
  scenario.detail.publicImage.repoDigest = acceptanceUpgradeBaselines[1].pinnedImage;
  const result = await assertReport(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not bound to exact public 1\.1\.2 image evidence/);
});

test("release assertion rejects current-stable upgrade without retained-volume rollback proof", async () => {
  const report = passingReport();
  const scenario = report.scenarios.find((item) => item.id === "current-stable-upgrade");
  scenario.detail.volumesRetained = false;
  const result = await assertReport(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not prove rollback and re-upgrade on retained volumes/);
});

test("release assertion rejects an upgrade without legacy environment compatibility proof", async () => {
  const report = passingReport();
  const scenario = report.scenarios.find((item) => item.id === "current-stable-upgrade");
  scenario.detail.legacyEnvironmentPlaceholderHandled = false;
  const result = await assertReport(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is missing legacyEnvironmentPlaceholderHandled/);
});

test("release assertion rejects an upgrade without backup ownership migration proof", async () => {
  const report = passingReport();
  const scenario = report.scenarios.find((item) => item.id === "legacy-upgrade");
  scenario.detail.legacyBackupOwnershipMigrated = false;
  const result = await assertReport(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is missing legacyBackupOwnershipMigrated/);
});

test("release assertion rejects a long-hop upgrade without managed credential reconciliation", async () => {
  const report = passingReport();
  const scenario = report.scenarios.find((item) => item.id === "legacy-upgrade");
  scenario.detail.legacyManagedCredentialReconciled = false;
  const result = await assertReport(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not prove legacy managed database credential reconciliation/);
});
