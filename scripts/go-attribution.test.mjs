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

function fixture(name, { review, spdxExpression = "MIT", inventorySha256 = "a".repeat(64) }) {
  const directory = path.join(temporaryRoot, name);
  const textDirectory = path.join(directory, "texts");
  const licenseContents = "Permission is hereby granted, free of charge, to use this fixture.\n";
  mkdirSync(textDirectory, { recursive: true });
  writeFileSync(path.join(textDirectory, "LICENSE"), licenseContents);
  const manifest = {
    schemaVersion: 1,
    review,
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

test("pending review passes normal checks and fails the stable-release check", () => {
  const manifest = fixture("pending", {
    review: { status: "pending", approvedBy: null, approvedAt: null, note: "review pending" },
    spdxExpression: "NOASSERTION"
  });
  expectSuccess(run(attributionScript, ["check", "--manifest", manifest]));
  expectFailure(
    run(attributionScript, ["check", "--manifest", manifest, "--require-approved"]),
    /stable release requires qualified approval/
  );
});

test("normal and stable-release checks reject invalid SPDX expressions", () => {
  for (const [index, spdxExpression] of ["banana", "Apache 2", "MIT AND", "(MIT OR Apache-2.0"].entries()) {
    const manifest = fixture(`invalid-spdx-${index}`, {
      review: { status: "pending", approvedBy: null, approvedAt: null },
      spdxExpression
    });
    expectFailure(run(attributionScript, ["check", "--manifest", manifest]), /has invalid SPDX expression/);
  }

  const approved = fixture("invalid-spdx-approved", {
    review: { status: "approved", approvedBy: "@qualified-reviewer", approvedAt: "2026-07-20T00:00:00Z" },
    spdxExpression: "banana"
  });
  expectFailure(
    run(attributionScript, ["check", "--manifest", approved, "--require-approved"]),
    /has invalid SPDX expression/
  );
});

test("stable-release checks accept valid compound SPDX expressions", () => {
  const manifest = fixture("compound-spdx", {
    review: { status: "approved", approvedBy: "@qualified-reviewer", approvedAt: "2026-07-20T00:00:00Z" },
    spdxExpression: "(MIT OR Apache-2.0)"
  });
  expectSuccess(run(attributionScript, ["check", "--manifest", manifest, "--require-approved"]));
});

test("inventory verification remains self-contained after development dependencies are pruned", () => {
  const isolatedDirectory = path.join(temporaryRoot, "isolated-verifier");
  mkdirSync(isolatedDirectory, { recursive: true });
  const isolatedScript = path.join(isolatedDirectory, "go-attribution.mjs");
  copyFileSync(attributionScript, isolatedScript);
  copyFileSync(path.join(root, "scripts", "go-attribution-review.mjs"), path.join(isolatedDirectory, "go-attribution-review.mjs"));
  const inventory = path.join(isolatedDirectory, "fixture.modules.tsv");
  const inventoryContents = "dep\texample.com/review-fixture\tv1.0.0\t\n";
  writeFileSync(inventory, inventoryContents);
  const manifest = fixture("isolated-verifier-manifest", {
    review: { status: "pending", approvedBy: null, approvedAt: null },
    spdxExpression: "NOASSERTION",
    inventorySha256: sha256(inventoryContents)
  });

  expectSuccess(run(isolatedScript, [
    "verify",
    "--manifest", manifest,
    "--inventory", `fixture=${inventory}`
  ]));
});

test("approved review requires both a public identity and RFC3339 UTC date", () => {
  const missingIdentity = fixture("missing-identity", {
    review: { status: "approved", approvedBy: "", approvedAt: "2026-07-20T00:00:00Z" }
  });
  const missingDate = fixture("missing-date", {
    review: { status: "approved", approvedBy: "@qualified-reviewer", approvedAt: null }
  });
  const nonUtcDate = fixture("non-utc-date", {
    review: { status: "approved", approvedBy: "@qualified-reviewer", approvedAt: "2026-07-20T02:00:00+02:00" }
  });
  const invalidCalendarDate = fixture("invalid-calendar-date", {
    review: { status: "approved", approvedBy: "@qualified-reviewer", approvedAt: "2026-02-30T00:00:00Z" }
  });
  expectFailure(run(attributionScript, ["check", "--manifest", missingIdentity]), /identify the qualified reviewer/);
  expectFailure(run(attributionScript, ["check", "--manifest", missingDate]), /RFC3339 UTC approval timestamp/);
  expectFailure(run(attributionScript, ["check", "--manifest", nonUtcDate]), /RFC3339 UTC approval timestamp/);
  expectFailure(run(attributionScript, ["check", "--manifest", invalidCalendarDate]), /RFC3339 UTC approval timestamp/);
});

test("approved review rejects every remaining NOASSERTION", () => {
  const manifest = fixture("noassertion", {
    review: { status: "approved", approvedBy: "@qualified-reviewer", approvedAt: "2026-07-20T00:00:00Z" },
    spdxExpression: "NOASSERTION"
  });
  expectFailure(run(attributionScript, ["check", "--manifest", manifest, "--require-approved"]), /still has NOASSERTION/);
});

test("approved review passes strict checks and produces matching notices", () => {
  const approved = fixture("approved", {
    review: { status: "approved", approvedBy: "@qualified-reviewer", approvedAt: "2026-07-20T00:00:00Z" }
  });
  const pending = fixture("pending-notice-mismatch", {
    review: { status: "pending", approvedBy: null, approvedAt: null }
  });
  const notices = path.join(temporaryRoot, "THIRD-PARTY-NOTICES.md");
  expectSuccess(run(attributionScript, ["check", "--manifest", approved, "--require-approved"]));
  expectSuccess(run(noticesScript, ["--go-manifest", approved, "--target", notices]));
  expectSuccess(run(noticesScript, ["--check", "--go-manifest", approved, "--target", notices]));
  const contents = readFileSync(notices, "utf8");
  assert.match(contents, /Legal review status: approved\./);
  assert.match(contents, /recorded by @qualified-reviewer at 2026-07-20T00:00:00Z\./);
  expectFailure(run(noticesScript, ["--check", "--go-manifest", pending, "--target", notices]), /is stale/);
});
