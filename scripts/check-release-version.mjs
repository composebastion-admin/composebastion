import { readFileSync } from "node:fs";
import { isStrictSemVer } from "./release-semver.mjs";

const workspacePaths = ["apps/api", "apps/agent", "apps/web", "packages/shared"];
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const openapi = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
const releaseMetadata = JSON.parse(readFileSync("release-metadata.json", "utf8"));
const version = rootPackage.version;
const stableVersion = releaseMetadata.stableVersion;
const failures = [];

if (!isStrictSemVer(version)) {
  failures.push(`package.json version is not valid SemVer: ${version}`);
}
if (releaseMetadata.version !== version) {
  failures.push(`release-metadata.json version: ${releaseMetadata.version} != ${version}`);
}
if (!isStrictSemVer(stableVersion) || stableVersion.includes("-") || stableVersion.includes("+")) {
  failures.push(`release-metadata.json stableVersion is not a stable SemVer: ${stableVersion}`);
}
if (version.includes("-")) {
  const prereleaseChannel = version.split("-", 2)[1]?.split(".", 1)[0];
  if (releaseMetadata.channel !== prereleaseChannel) {
    failures.push(`release-metadata.json channel: ${releaseMetadata.channel} != ${prereleaseChannel}`);
  }
} else if (releaseMetadata.channel !== "stable" || stableVersion !== version) {
  failures.push(`stable release metadata must use channel stable and stableVersion ${version}`);
}

for (const workspace of workspacePaths) {
  const packageJson = JSON.parse(readFileSync(`${workspace}/package.json`, "utf8"));
  if (packageJson.version !== version) failures.push(`${workspace}/package.json: ${packageJson.version} != ${version}`);
}

if (lockfile.version !== version) failures.push(`package-lock.json top-level version: ${lockfile.version} != ${version}`);
for (const workspace of ["", ...workspacePaths]) {
  if (lockfile.packages?.[workspace]?.version !== version) {
    failures.push(`package-lock.json packages[${JSON.stringify(workspace)}].version: ${lockfile.packages?.[workspace]?.version} != ${version}`);
  }
}
if (openapi.info?.version !== version) failures.push(`docs/openapi.json: ${openapi.info?.version} != ${version}`);
const notices = readFileSync("THIRD-PARTY-NOTICES.md", "utf8");
if (!notices.includes(`for ComposeBastion ${version}.`)) failures.push(`THIRD-PARTY-NOTICES.md: generated version does not match ${version}`);

const documentedCandidateMarkers = [
  ["README.md", `Package and OpenAPI version: \`${version}\`.`],
  ["release-metadata.json", `"version": "${version}"`]
];
const documentedStableMarkers = [
  ["README.md", `Latest published stable release: \`v${stableVersion}\`.`],
  ["SECURITY.md", `public release (\`v${stableVersion}\`)`],
  ["docs/installation.md", `published stable release is \`v${stableVersion}\`.`],
  ["docs/upgrade-guide.md", `published release is \`v${stableVersion}\`.`],
  ["docs/operations-runbook.md", `tags are \`${stableVersion}\` and \`v${stableVersion}\`.`],
  ["docs/connect-hosts.md", `manager and agent release is \`${stableVersion}\`.`],
  ["docs/how-to.md", `Version covered: \`v${stableVersion}\`.`],
  ["docker-compose.image.yml", `# ${stableVersion}. For homelab/NAS auto-updates`],
  ["agent-compose.image.example.yml", `manager, for example ${stableVersion}.`]
];
for (const [file, marker] of [...documentedCandidateMarkers, ...documentedStableMarkers]) {
  if (!readFileSync(file, "utf8").includes(marker)) {
    failures.push(`${file}: candidate/stable release metadata is not aligned`);
  }
}
if (version.includes("-")) {
  const betaMarkers = [
    ["README.md", `Current beta candidate: \`v${version}\`.`],
    ["docs/beta-release.md", `Beta version: \`v${version}\`.`]
  ];
  for (const [file, marker] of betaMarkers) {
    if (!readFileSync(file, "utf8").includes(marker)) {
      failures.push(`${file}: beta release marker is not aligned at ${version}`);
    }
  }
}

for (const dockerfile of ["Dockerfile", "Dockerfile.agent"]) {
  const contents = readFileSync(dockerfile, "utf8");
  if (!/^ARG APP_VERSION=source$/m.test(contents)) failures.push(`${dockerfile}: APP_VERSION must use the non-release source fallback`);
  if (contents.includes(`ARG APP_VERSION=${version}`)) failures.push(`${dockerfile}: contains a hard-coded candidate version`);
}

const acceptanceRunner = readFileSync("scripts/acceptance/run.mjs", "utf8");
if (!/const candidateVersion = JSON\.parse\(await readFile\(path\.join\(root, "package\.json"\), "utf8"\)\)\.version;/.test(acceptanceRunner)) {
  failures.push("scripts/acceptance/run.mjs: candidate version must be read from package.json");
}

if (failures.length > 0) throw new Error(`Release version alignment failed:\n${failures.join("\n")}`);
console.log(`Release version artifacts are aligned at ${version}.`);
