import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const attributionScript = path.join(root, "scripts", "go-attribution.mjs");
const noticesScript = path.join(root, "scripts", "generate-third-party-notices.mjs");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "composebastion-go-attribution-"));

after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function fixture(name, { spdxExpression = "MIT", inventorySha256 = "a".repeat(64) } = {}) {
  const directory = path.join(temporaryRoot, name);
  const textDirectory = path.join(directory, "texts");
  const licenseContents = "Permission is hereby granted, free of charge, to use this fixture.\n";
  mkdirSync(textDirectory, { recursive: true });
  writeFileSync(path.join(textDirectory, "LICENSE"), licenseContents);
  const manifest = {
    schemaVersion: 1,
    inventories: [{ binary: "fixture", sha256: inventorySha256 }],
    modules: [{
      module: "example.com/review-fixture",
      version: "v1.0.0",
      replacement: null,
      consumingBinaries: ["fixture"],
      sourceUrl: "https://pkg.go.dev/example.com/review-fixture@v1.0.0",
      spdxExpression,
      goChecksum: null,
      requiredFiles: [{ path: "texts/LICENSE", sha256: sha256(licenseContents) }]
    }]
  };
  const manifestFile = path.join(directory, "manifest.json");
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestFile;
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function expectSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function expectFailure(result, pattern) {
  assert.notEqual(result.status, 0, "command unexpectedly succeeded");
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

test("complete attribution passes without a manual approval gate", () => {
  const manifest = fixture("complete", { spdxExpression: "NOASSERTION" });
  expectSuccess(run(attributionScript, ["check", "--manifest", manifest]));
});

test("checks reject invalid SPDX expressions", () => {
  for (const [index, spdxExpression] of ["banana", "Apache 2", "MIT AND", "(MIT OR Apache-2.0"].entries()) {
    const manifest = fixture(`invalid-spdx-${index}`, { spdxExpression });
    expectFailure(run(attributionScript, ["check", "--manifest", manifest]), /has invalid SPDX expression/);
  }
});

test("checks accept valid compound SPDX expressions", () => {
  const manifest = fixture("compound-spdx", { spdxExpression: "(MIT OR Apache-2.0)" });
  expectSuccess(run(attributionScript, ["check", "--manifest", manifest]));
});

test("inventory verification remains self-contained after development dependencies are pruned", () => {
  const isolatedDirectory = path.join(temporaryRoot, "isolated-verifier");
  mkdirSync(isolatedDirectory, { recursive: true });
  const isolatedScript = path.join(isolatedDirectory, "go-attribution.mjs");
  copyFileSync(attributionScript, isolatedScript);
  const inventory = path.join(isolatedDirectory, "fixture.modules.tsv");
  const inventoryContents = "dep\texample.com/review-fixture\tv1.0.0\t\n";
  writeFileSync(inventory, inventoryContents);
  const manifest = fixture("isolated-verifier-manifest", {
    spdxExpression: "NOASSERTION",
    inventorySha256: sha256(inventoryContents)
  });

  expectSuccess(run(isolatedScript, [
    "verify",
    "--manifest", manifest,
    "--inventory", `fixture=${inventory}`
  ]));
});

test("notices describe the automated attribution evidence", () => {
  const notices = path.join(temporaryRoot, "THIRD-PARTY-NOTICES.md");
  expectSuccess(run(noticesScript, ["--target", notices]));
  expectSuccess(run(noticesScript, ["--check", "--target", notices]));
  const contents = readFileSync(notices, "utf8");
  assert.match(contents, /checked-in Go attribution manifest, required upstream texts, and checksums/);
});
