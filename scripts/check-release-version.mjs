import { readFileSync } from "node:fs";
import { isStrictSemVer } from "./release-semver.mjs";

const workspacePaths = ["apps/api", "apps/agent", "apps/web", "packages/shared"];
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const openapi = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
const version = rootPackage.version;
const failures = [];

if (!isStrictSemVer(version)) {
  failures.push(`package.json version is not valid SemVer: ${version}`);
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
