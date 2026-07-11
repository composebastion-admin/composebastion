#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isStrictSemVer } from "./release-semver.mjs";
import { assertSafeTestResultsPath, digestGitBuildContext, materializeGitBuildContext } from "./materialize-git-context.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const safeResultPath = (name, label) => assertSafeTestResultsPath({
  repositoryRoot,
  destination: path.join(repositoryRoot, "test-results", name),
  label
});
const reportDirectory = safeResultPath("release-images", "Release-image report directory");
const trivyCacheDirectory = safeResultPath("release-image-trivy-cache", "Release-image Trivy cache directory");
const buildContextDirectory = safeResultPath("release-image-git-context", "Release-image Git context directory");
const trivyImage = "aquasec/trivy:0.72.0@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f";
const expectedTrivyVersion = "0.72.0";
const builds = [
  { component: "app", architecture: "amd64", platform: "linux/amd64", dockerfile: "Dockerfile" },
  { component: "app", architecture: "arm64", platform: "linux/arm64", dockerfile: "Dockerfile" },
  { component: "agent", architecture: "amd64", platform: "linux/amd64", dockerfile: "Dockerfile.agent" },
  { component: "agent", architecture: "arm64", platform: "linux/arm64", dockerfile: "Dockerfile.agent" }
];

if (process.argv.includes("--help")) {
  console.log(`Usage: npm run release:verify-images

Requires a clean Git checkout, Docker with Buildx, and registry/network access.
Builds and scans four single-platform OCI archives without loading or publishing them.
Reports are written below test-results/release-images/.`);
  process.exit(0);
}

if (process.argv.length > 2) {
  throw new Error(`Unknown argument: ${process.argv.slice(2).join(" ")}`);
}

process.chdir(repositoryRoot);

function commandText(command, args) {
  return [command, ...args].map((value) => (/^[A-Za-z0-9_./:@=,+-]+$/.test(value) ? value : JSON.stringify(value))).join(" ");
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  console.log(`$ ${commandText(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: command === "git" ? { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } : process.env,
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 128 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = capture ? `\n${String(result.stderr || result.stdout).trim()}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return result;
}

function capture(command, args) {
  return String(run(command, args, { capture: true }).stdout).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Buffer(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

function tarEntry(archive, entry) {
  const result = spawnSync("tar", ["-xOf", archive, entry], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not read ${entry} from ${path.basename(archive)}: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

async function sha256TarEntry(archive, entry) {
  const hash = createHash("sha256");
  let stderr = "";
  const child = spawn("tar", ["-xOf", archive, entry], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => hash.update(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8192) stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`Could not hash ${entry} from ${path.basename(archive)}: ${stderr.trim()}`);
  return `sha256:${hash.digest("hex")}`;
}

function parseJsonBuffer(value, description) {
  try {
    return JSON.parse(value.toString("utf8"));
  } catch (error) {
    throw new Error(`${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireSha256Digest(value, description) {
  assert(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value), `${description} is not a SHA-256 digest`);
  return value;
}

function assertSafeArchivePaths(archive) {
  const listing = capture("tar", ["-tf", archive]);
  for (const entry of listing.split(/\r?\n/)) {
    const normalized = entry.replaceAll("\\", "/");
    const segments = normalized.split("/");
    assert(!normalized.startsWith("/") && !segments.includes(".."), `${path.basename(archive)} contains unsafe archive path ${JSON.stringify(entry)}`);
  }
}

async function inspectArchive(build, archive, metadata) {
  const index = parseJsonBuffer(tarEntry(archive, "index.json"), `${path.basename(archive)} index.json`);
  assert(index.schemaVersion === 2, `${path.basename(archive)} has OCI index schema ${index.schemaVersion ?? "missing"}`);
  assert(Array.isArray(index.manifests) && index.manifests.length === 1, `${path.basename(archive)} must contain exactly one image manifest`);

  const descriptor = index.manifests[0];
  const manifestDigest = requireSha256Digest(descriptor.digest, `${path.basename(archive)} manifest digest`);
  if (descriptor.platform) {
    assert(descriptor.platform.os === "linux", `${path.basename(archive)} index descriptor is not linux`);
    assert(descriptor.platform.architecture === build.architecture, `${path.basename(archive)} index descriptor architecture is not ${build.architecture}`);
  }
  const manifestBytes = tarEntry(archive, `blobs/sha256/${manifestDigest.slice("sha256:".length)}`);
  assert(sha256Buffer(manifestBytes) === manifestDigest, `${path.basename(archive)} manifest blob does not match ${manifestDigest}`);
  const manifest = parseJsonBuffer(manifestBytes, `${path.basename(archive)} manifest`);
  assert(manifest.schemaVersion === 2, `${path.basename(archive)} image manifest schema is not 2`);

  const configDigest = requireSha256Digest(manifest.config?.digest, `${path.basename(archive)} config digest`);
  const configBytes = tarEntry(archive, `blobs/sha256/${configDigest.slice("sha256:".length)}`);
  assert(sha256Buffer(configBytes) === configDigest, `${path.basename(archive)} config blob does not match ${configDigest}`);
  const config = parseJsonBuffer(configBytes, `${path.basename(archive)} config`);
  assert(config.os === "linux", `${path.basename(archive)} config is not linux`);
  assert(config.architecture === build.architecture, `${path.basename(archive)} config architecture is not ${build.architecture}`);

  const labels = config.config?.Labels ?? {};
  for (const [label, expected] of [
    ["org.opencontainers.image.version", metadata.version],
    ["org.opencontainers.image.revision", metadata.revision],
    ["org.opencontainers.image.created", metadata.created]
  ]) {
    assert(labels[label] === expected, `${path.basename(archive)} ${label} is ${JSON.stringify(labels[label])}, expected ${JSON.stringify(expected)}`);
  }

  const layerDigests = [];
  for (const [index, layer] of (manifest.layers ?? []).entries()) {
    const digest = requireSha256Digest(layer?.digest, `${path.basename(archive)} layer ${index} digest`);
    const actualDigest = await sha256TarEntry(archive, `blobs/sha256/${digest.slice("sha256:".length)}`);
    assert(actualDigest === digest, `${path.basename(archive)} layer ${index} blob does not match ${digest}`);
    layerDigests.push(digest);
  }
  assert(layerDigests.length > 0, `${path.basename(archive)} contains no image layers`);

  return {
    component: build.component,
    architecture: build.architecture,
    platform: build.platform,
    archive: path.relative(repositoryRoot, archive),
    archiveDigest: await sha256File(archive),
    manifestDigest,
    configDigest,
    layerDigests,
    version: metadata.version,
    revision: metadata.revision,
    created: metadata.created
  };
}

function vulnerabilityCounts(report) {
  const counts = { HIGH: 0, CRITICAL: 0 };
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (vulnerability.Severity in counts) counts[vulnerability.Severity] += 1;
    }
  }
  return counts;
}

function markdownReport(report) {
  const lines = [
    "# Local release image verification",
    "",
    `- Status: **${report.status.toUpperCase()}**`,
    `- Candidate: \`${report.version}\``,
    `- Revision: \`${report.revision}\``,
    `- Commit timestamp: \`${report.created}\``,
    `- Build context: \`${report.sourceContext.strategy}\` tree \`${report.sourceContext.treeSha}\` (\`${report.sourceContext.contextDigest}\`)`,
    `- Scanner: \`${report.scanner.version}\` via \`${report.scanner.image}\``,
    "",
    "| Component | Platform | Archive SHA-256 | Manifest digest | Config digest | High | Critical | Scan |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- |"
  ];
  for (const image of report.images) {
    lines.push(`| ${image.component} | ${image.platform} | \`${image.archiveDigest ?? "not-built"}\` | \`${image.manifestDigest ?? "not-verified"}\` | \`${image.configDigest ?? "not-verified"}\` | ${image.vulnerabilities?.HIGH ?? "-"} | ${image.vulnerabilities?.CRITICAL ?? "-"} | ${image.scanStatus ?? "not-run"} |`);
  }
  if (report.failures.length > 0) {
    lines.push("", "## Failures", "", ...report.failures.map((failure) => `- ${failure}`));
  }
  lines.push("", "The OCI archives and per-image Trivy JSON reports are local, ignored release artifacts. No image was loaded, pushed, tagged, or published.", "");
  return lines.join("\n");
}

function writeReports(report) {
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(path.join(reportDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(reportDirectory, "report.md"), markdownReport(report));
}

const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const metadata = {
  version: packageJson.version,
  revision: capture("git", ["rev-parse", "--verify", "HEAD^{commit}"]),
  tree: capture("git", ["rev-parse", "--verify", "HEAD^{tree}"]),
  created: capture("git", ["show", "-s", "--format=%cI", "HEAD"])
};
assert(isStrictSemVer(metadata.version), `package.json version ${JSON.stringify(metadata.version)} is not strict SemVer`);
assert(/^[a-f0-9]{40}$/.test(metadata.revision), `HEAD did not resolve to a full 40-character commit SHA: ${metadata.revision}`);
assert(/^[a-f0-9]{40}$/.test(metadata.tree), `HEAD did not resolve to a full 40-character tree SHA: ${metadata.tree}`);
assert(!Number.isNaN(Date.parse(metadata.created)), `HEAD commit timestamp is invalid: ${metadata.created}`);

const dirty = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
assert(dirty === "", `Release image verification requires a clean checkout. Commit or remove these changes first:\n${dirty}`);
run("docker", ["version"]);
run("docker", ["buildx", "version"]);
const builderInformation = capture("docker", ["buildx", "inspect", "--bootstrap"]);
for (const platform of new Set(builds.map((build) => build.platform))) {
  assert(builderInformation.includes(platform), `The active Buildx builder does not advertise ${platform} support`);
}
console.log(builderInformation);

rmSync(reportDirectory, { recursive: true, force: true });
mkdirSync(reportDirectory, { recursive: true });
mkdirSync(trivyCacheDirectory, { recursive: true });
const sourceContext = materializeGitBuildContext({
  repositoryRoot,
  revision: metadata.revision,
  destination: buildContextDirectory
});
assert(sourceContext.commitSha === metadata.revision && sourceContext.treeSha === metadata.tree, "Exact Git build context does not match the recorded commit/tree");

const report = {
  schemaVersion: 1,
  status: "running",
  version: metadata.version,
  revision: metadata.revision,
  tree: metadata.tree,
  created: metadata.created,
  sourceContext,
  scanner: { image: trivyImage, version: expectedTrivyVersion, versionOutput: null },
  images: [],
  failures: []
};

try {
  for (const build of builds) {
    const archive = path.join(reportDirectory, `release-${build.component}-${build.architecture}.tar`);
    console.log(`\nBuilding ${build.component} for ${build.platform} exactly once...`);
    run("docker", [
      "buildx", "build",
      "--file", path.join(buildContextDirectory, build.dockerfile),
      "--target", "runtime",
      "--platform", build.platform,
      "--provenance=false",
      "--sbom=false",
      "--build-arg", `APP_VERSION=${metadata.version}`,
      "--build-arg", `VCS_REF=${metadata.revision}`,
      "--build-arg", `BUILD_DATE=${metadata.created}`,
      "--output", `type=oci,dest=${archive}`,
      buildContextDirectory
    ]);
    const inspected = await inspectArchive(build, archive, metadata);
    report.images.push(inspected);
    writeFileSync(path.join(reportDirectory, `release-${build.component}-${build.architecture}.json`), `${JSON.stringify(inspected, null, 2)}\n`);
  }

  console.log(`\nVerifying scanner ${trivyImage}...`);
  const scanner = run("docker", ["run", "--rm", "--pull=always", trivyImage, "--version"], { capture: true });
  const scannerOutput = `${scanner.stdout}\n${scanner.stderr}`.trim();
  assert(new RegExp(`(?:^|\\s)Version:\\s*${expectedTrivyVersion.replaceAll(".", "\\.")}(?:\\s|$)`).test(scannerOutput), `Pinned scanner did not report Trivy ${expectedTrivyVersion}: ${scannerOutput}`);
  report.scanner.versionOutput = scannerOutput;
  console.log(scannerOutput);

  for (const image of report.images) {
    const scanFilename = `trivy-${image.component}-${image.architecture}.json`;
    const scanPath = path.join(reportDirectory, scanFilename);
    const scanInput = path.join(reportDirectory, `scan-input-${image.component}-${image.architecture}`);
    rmSync(scanInput, { recursive: true, force: true });
    mkdirSync(scanInput, { recursive: true });
    // Trivy 0.72 accepts an OCI layout directory, not a tarred OCI archive.
    // The archive and every referenced blob were verified immediately above;
    // extract that exact archive into a fresh, read-only scan input directory.
    assertSafeArchivePaths(path.join(repositoryRoot, image.archive));
    run("tar", ["-xf", path.join(repositoryRoot, image.archive), "-C", scanInput]);
    console.log(`\nScanning the exact verified OCI layout from ${image.archive}...`);
    let scan;
    try {
      scan = run("docker", [
        "run", "--rm",
        "--volume", `${repositoryRoot}:/workspace:ro`,
        "--volume", `${reportDirectory}:/reports`,
        "--volume", `${trivyCacheDirectory}:/trivy-cache`,
        trivyImage,
        "image",
        "--input", `/workspace/${path.relative(repositoryRoot, scanInput)}`,
        "--cache-dir", "/trivy-cache",
        "--ignorefile", "/workspace/.trivyignore.yaml",
        "--format", "json",
        "--output", `/reports/${scanFilename}`,
        "--exit-code", "1",
        "--ignore-unfixed=false",
        "--scanners", "vuln",
        "--pkg-types", "os,library",
        "--severity", "HIGH,CRITICAL"
      ], { allowFailure: true });
    } finally {
      rmSync(scanInput, { recursive: true, force: true });
    }

    if (!existsSync(scanPath)) {
      image.scanStatus = "failed";
      report.failures.push(`${image.component} ${image.platform}: Trivy exited ${scan.status} without writing ${scanFilename}`);
      continue;
    }
    try {
      const scanReport = JSON.parse(readFileSync(scanPath, "utf8"));
      image.vulnerabilities = vulnerabilityCounts(scanReport);
      image.scanReport = path.relative(repositoryRoot, scanPath);
      image.scanReportDigest = await sha256File(scanPath);
      image.scanExitCode = scan.status;
      const releasePolicyFindings = image.vulnerabilities.HIGH + image.vulnerabilities.CRITICAL;
      image.scanStatus = scan.status === 0 && releasePolicyFindings === 0 ? "passed" : "failed";
      if (image.scanStatus === "failed") {
        report.failures.push(`${image.component} ${image.platform}: Trivy found ${image.vulnerabilities.HIGH} high and ${image.vulnerabilities.CRITICAL} critical vulnerabilities (exit ${scan.status})`);
      }
    } catch (error) {
      image.scanStatus = "failed";
      report.failures.push(`${image.component} ${image.platform}: invalid Trivy JSON report (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  assert(report.images.length === builds.length, `Expected ${builds.length} verified archives, found ${report.images.length}`);
  assert(capture("git", ["rev-parse", "--verify", "HEAD^{commit}"]) === metadata.revision, "HEAD changed during release image verification");
  assert(capture("git", ["rev-parse", "--verify", "HEAD^{tree}"]) === metadata.tree, "HEAD tree changed during release image verification");
  const finalContext = digestGitBuildContext(buildContextDirectory);
  assert(finalContext.digest === sourceContext.contextDigest && finalContext.fileCount === sourceContext.fileCount,
    "Exact Git-derived Docker build context changed during release image verification");
  const finalDirty = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert(finalDirty === "", `Checkout changed during release image verification:\n${finalDirty}`);
  if (report.failures.length > 0) throw new Error(report.failures.join("\n"));
  report.status = "passed";
  writeReports(report);
  console.log(`\nAll four exact OCI archives passed Trivy ${expectedTrivyVersion}.`);
  console.log(`Reports: ${path.relative(repositoryRoot, reportDirectory)}/report.{json,md}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const accumulatedFailures = report.failures.join("\n");
  if (!report.failures.includes(message) && (accumulatedFailures === "" || !message.includes(accumulatedFailures))) {
    report.failures.push(message);
  }
  report.status = "failed";
  writeReports(report);
  throw error;
} finally {
  rmSync(buildContextDirectory, { recursive: true, force: true });
}
