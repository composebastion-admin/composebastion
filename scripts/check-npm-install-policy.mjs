import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) =>
  JSON.parse(readFileSync(path.join(root, file), "utf8"));
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");

const expectedAllowScripts = {
  "cpu-features@0.0.10": true,
  "esbuild@0.25.12": true,
  "esbuild@0.28.1": true,
  fsevents: false,
  "ssh2@1.17.0": true
};
const expectedPackageManager = "npm@11.19.0";
const expectedNpmIntegrity =
  "sha512-SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==";

assert.deepEqual(
  packageJson.allowScripts,
  expectedAllowScripts,
  "package.json must retain the reviewed, version-pinned install-script policy"
);
assert.equal(
  packageJson.packageManager,
  expectedPackageManager,
  "packageManager must remain a Corepack-compatible exact npm version"
);
assert.match(packageJson.packageManager, /^npm@\d+\.\d+\.\d+$/);
assert.doesNotMatch(
  packageJson.packageManager,
  /\+/,
  "npm tarball integrity belongs in bootstrap-npm.mjs, not packageManager"
);
assert.deepEqual(packageJson.engines, {
  node: ">=24.0.0 <25",
  npm: ">=11.19.0 <12"
});
assert.deepEqual(
  packageLock.packages?.[""]?.engines,
  packageJson.engines,
  "package-lock.json root engines must match package.json"
);

const npmrc = new Map(
  readFileSync(path.join(root, ".npmrc"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 1
        ? [line, ""]
        : [line.slice(0, separator), line.slice(separator + 1)];
    })
);
assert.equal(npmrc.get("dangerously-allow-all-scripts"), "false");
assert.equal(npmrc.get("engine-strict"), "true");
assert.equal(npmrc.get("ignore-scripts"), "false");
assert.equal(npmrc.get("strict-allow-scripts"), "true");

const npmExecPath = process.env.npm_execpath;
assert.ok(
  npmExecPath,
  "Run this policy through npm so the exact active npm CLI can be verified"
);
const runNpm = (...args) =>
  execFileSync(process.execPath, [npmExecPath, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
const npmVersion = runNpm("--version");
const match = /^11\.(\d+)\.(\d+)$/.exec(npmVersion);
assert.ok(
  match && Number(match[1]) >= 19,
  `npm 11.19 or newer within major 11 is required; received ${npmVersion}`
);
assert.equal(runNpm("config", "get", "engine-strict"), "true");
assert.equal(runNpm("config", "get", "strict-allow-scripts"), "true");
assert.equal(
  runNpm("config", "get", "dangerously-allow-all-scripts"),
  "false",
  "The emergency allow-all override must never be active"
);
assert.equal(
  runNpm("config", "get", "ignore-scripts"),
  "false",
  "Reviewed install scripts must execute in the qualified manager build"
);
assert.deepEqual(
  JSON.parse(runNpm("install-scripts", "ls", "--json")).allowScripts,
  [],
  "Every dependency install script must be explicitly approved or denied"
);
const bootstrapSource = readFileSync(
  path.join(root, "scripts/bootstrap-npm.mjs"),
  "utf8"
);
for (const invariant of [
  'const NPM_VERSION = "11.19.0";',
  `"${expectedNpmIntegrity}"`,
  "mkdtemp(",
  'path.join(os.tmpdir(), "composebastion-npm-bootstrap-")',
  '"pack",',
  '"--ignore-scripts",',
  '"--dangerously-allow-all-scripts=false",',
  'createHash("sha512")',
  "assert.equal(",
  "rmSync(temporaryDirectory, { recursive: true, force: true });"
]) {
  assert.ok(
    bootstrapSource.includes(invariant),
    `npm bootstrap is missing required invariant: ${invariant}`
  );
}
assert.doesNotMatch(
  bootstrapSource,
  /currentVersion === NPM_VERSION/,
  "normal bootstrap mode must always hash and install the reviewed tarball"
);

for (const dockerfile of ["Dockerfile", "Dockerfile.agent"]) {
  const source = readFileSync(path.join(root, dockerfile), "utf8");
  assert.match(
    source,
    /^COPY scripts\/bootstrap-npm\.mjs scripts\/bootstrap-npm\.mjs$/m
  );
  assert.match(
    source,
    /^RUN node scripts\/bootstrap-npm\.mjs$/m
  );
}
assert.match(
  readFileSync(path.join(root, "Dockerfile"), "utf8"),
  /^RUN npm ci --engine-strict --strict-allow-scripts --dangerously-allow-all-scripts=false --ignore-scripts=false$/m
);
assert.match(
  readFileSync(path.join(root, "Dockerfile.agent"), "utf8"),
  /^RUN npm ci --workspace @composebastion\/agent --include-workspace-root=false --engine-strict --dangerously-allow-all-scripts=false --ignore-scripts$/m
);
const dockerIgnoreLines = readFileSync(path.join(root, ".dockerignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim());
assert.ok(
  dockerIgnoreLines.includes(".npmrc") && dockerIgnoreLines.includes("**/.npmrc"),
  "developer npm configuration and possible registry credentials must remain outside Docker build contexts"
);

console.log(
  `npm ${npmVersion} install-script policy is strict, complete, and pinned.`
);
