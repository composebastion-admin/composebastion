import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const NPM_VERSION = "11.19.0";
const NPM_INTEGRITY =
  "sha512-SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function npmVersion() {
  return execFileSync(npmCommand, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}

const currentVersion = npmVersion();
if (process.argv.includes("--check")) {
  assert.equal(
    currentVersion,
    NPM_VERSION,
    `Expected npm ${NPM_VERSION}; received ${currentVersion}`
  );
  console.log(`Pinned npm ${currentVersion} is active.`);
  process.exit(0);
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "composebastion-npm-bootstrap-")
);
const tarball = path.join(temporaryDirectory, `npm-${NPM_VERSION}.tgz`);
try {
  execFileSync(
    npmCommand,
    [
      "--silent",
      "pack",
      "--ignore-scripts",
      "--dangerously-allow-all-scripts=false",
      `npm@${NPM_VERSION}`,
      "--pack-destination",
      temporaryDirectory
    ],
    {
      cwd: temporaryDirectory,
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  const actualIntegrity =
    `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  assert.equal(
    actualIntegrity,
    NPM_INTEGRITY,
    "Downloaded npm tarball failed the reviewed SHA-512 integrity check"
  );
  execFileSync(
    npmCommand,
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--dangerously-allow-all-scripts=false",
      tarball
    ],
    {
      cwd: temporaryDirectory,
      stdio: "inherit"
    }
  );
  assert.equal(
    npmVersion(),
    NPM_VERSION,
    `npm ${NPM_VERSION} did not become active after installation`
  );
  console.log(`Installed integrity-verified npm ${NPM_VERSION}.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
