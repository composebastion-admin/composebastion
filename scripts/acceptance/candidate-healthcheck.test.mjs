import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderCandidateHealthcheckProgram } from "./candidate-healthcheck.mjs";

const healthyUrl = "data:application/json,%7B%22ok%22%3Atrue%7D";

function runHealthcheck(program) {
  return spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
}

test("candidate healthcheck retains the historical readiness probe with a forced-failure marker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "composebastion-candidate-health-"));
  try {
    const packagePath = path.join(directory, "package.json");
    const markerPath = path.join(directory, "force-candidate-unhealthy");
    await writeFile(packagePath, JSON.stringify({ version: "1.2.0-beta.1" }), { mode: 0o600 });
    const program = renderCandidateHealthcheckProgram("1.2.0-beta.1", {
      packagePath,
      markerPath,
      healthUrl: healthyUrl
    });

    assert.equal(runHealthcheck(program).status, 0);
    await writeFile(markerPath, "forced candidate failure\n", { mode: 0o600 });
    assert.equal(runHealthcheck(program).status, 1);
    assert.match(renderCandidateHealthcheckProgram("1.2.0-beta.1"), /\/api\/health\/ready/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("health marker affects only the candidate version", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "composebastion-candidate-health-"));
  try {
    const packagePath = path.join(directory, "package.json");
    const markerPath = path.join(directory, "force-candidate-unhealthy");
    await writeFile(packagePath, JSON.stringify({ version: "1.1.6" }), { mode: 0o600 });
    await writeFile(markerPath, "forced candidate failure\n", { mode: 0o600 });

    const program = renderCandidateHealthcheckProgram("1.2.0-beta.1", {
      packagePath,
      markerPath,
      healthUrl: healthyUrl
    });
    assert.equal(runHealthcheck(program).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate healthcheck fails when readiness HTTP is not successful", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "composebastion-candidate-health-"));
  try {
    const packagePath = path.join(directory, "package.json");
    await writeFile(packagePath, JSON.stringify({ version: "1.2.0-beta.1" }), { mode: 0o600 });
    const program = renderCandidateHealthcheckProgram("1.2.0-beta.1", {
      packagePath,
      markerPath: path.join(directory, "missing-marker"),
      healthUrl: "http://127.0.0.1:1/"
    });
    assert.equal(runHealthcheck(program).status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
