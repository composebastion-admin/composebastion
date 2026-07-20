import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { validateGoAttributionReview } from "./go-attribution-review.mjs";

const require = createRequire(import.meta.url);
let parseSpdxExpression;

function fail(message) {
  throw new Error(`Go attribution: ${message}`);
}

function values(flag) {
  const result = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag) result.push(process.argv[index + 1]);
  }
  return result;
}

function value(flag) {
  const found = values(flag);
  if (found.length !== 1 || !found[0]) fail(`${flag} must be provided exactly once`);
  return found[0];
}

function assignments(flag) {
  return new Map(values(flag).map((item) => {
    const separator = item.indexOf("=");
    if (separator <= 0 || separator === item.length - 1) fail(`${flag} must use name=value`);
    return [item.slice(0, separator), item.slice(separator + 1)];
  }));
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validateReview(review) {
  try {
    validateGoAttributionReview(review);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function validateSpdxExpression(key, expression) {
  if (expression === "NOASSERTION") return;
  try {
    parseSpdxExpression ??= require("spdx-expression-parse");
    parseSpdxExpression(expression);
  } catch (error) {
    fail(`${key} has invalid SPDX expression ${JSON.stringify(expression)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseInventory(binary, file) {
  const modules = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const [kind, module, version, sum = ""] = line.split("\t");
    if (kind === "=>") fail(`${file} contains an unattached replacement; emit normalized one-row module evidence`);
    if (!new Set(["mod", "dep"]).has(kind) || !module || !version) fail(`${file} contains an invalid row: ${line}`);
    modules.push({ binary, kind, module, version, sum });
  }
  return modules;
}

function inventorySet(inventories) {
  const result = new Map();
  for (const [binary, file] of inventories) {
    for (const row of parseInventory(binary, file)) {
      const key = `${row.module}@${row.version}`;
      const existing = result.get(key) ?? { ...row, consumingBinaries: [] };
      if (existing.sum && row.sum && existing.sum !== row.sum) fail(`${key} has conflicting Go checksums`);
      existing.sum ||= row.sum;
      if (!existing.consumingBinaries.includes(binary)) existing.consumingBinaries.push(binary);
      result.set(key, existing);
    }
  }
  return result;
}

function moduleDownload(module, version) {
  let output;
  try {
    output = execFileSync("go", ["mod", "download", "-json", `${module}@${version}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    fail(`cannot download ${module}@${version}: ${String(error.stderr ?? error.message).trim()}`);
  }
  const metadata = JSON.parse(output);
  if (metadata.Error || !metadata.Dir) fail(`cannot resolve source for ${module}@${version}: ${metadata.Error ?? "missing module directory"}`);
  return metadata.Dir;
}

function licenseFiles(sourceDirectory) {
  return readdirSync(sourceDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(license|licence|copying|notice|patents)([._-].*)?$/i.test(entry.name))
    .map((entry) => path.join(sourceDirectory, entry.name))
    .sort();
}

function detectSpdx(files) {
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n").toLowerCase();
  const detected = [];
  if (text.includes("apache license") && text.includes("version 2.0")) detected.push("Apache-2.0");
  if (text.includes("permission is hereby granted, free of charge")) detected.push("MIT");
  if (text.includes("mozilla public license") && text.includes("version 2.0")) detected.push("MPL-2.0");
  if (text.includes("isc license") || text.includes("permission to use, copy, modify, and/or distribute")) detected.push("ISC");
  if (text.includes("redistribution and use in source and binary forms") && text.includes("neither the name")) detected.push("BSD-3-Clause");
  else if (text.includes("redistribution and use in source and binary forms")) detected.push("BSD-2-Clause");
  const unique = [...new Set(detected)];
  return unique.length === 1 ? unique[0] : "NOASSERTION";
}

function sourceUrl(module, version) {
  return `https://pkg.go.dev/${module}@${version}`;
}

function writeManifest() {
  const outputDirectory = path.resolve(value("--out"));
  const inventories = assignments("--inventory");
  const sources = assignments("--source");
  const modules = inventorySet(inventories);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(path.join(outputDirectory, "texts"), { recursive: true, mode: 0o755 });

  const downloads = [...modules.values()]
    .filter((item) => !sources.has(item.module))
    .map((item) => `${item.module}@${item.version}`);
  if (downloads.length > 0) {
    try {
      execFileSync("go", ["mod", "download", ...downloads], { stdio: "inherit" });
    } catch {
      fail("one or more linked module sources could not be downloaded");
    }
  }

  const entries = [];
  for (const [key, item] of [...modules.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const directory = sources.get(item.module) ?? moduleDownload(item.module, item.version);
    if (!statSync(directory).isDirectory()) fail(`source for ${key} is not a directory: ${directory}`);
    const files = licenseFiles(directory);
    if (files.length === 0) fail(`${key} has no top-level license, copying, notice, or patents file`);
    const textDirectory = `texts/${sha256(key).slice(0, 24)}`;
    mkdirSync(path.join(outputDirectory, textDirectory), { recursive: true, mode: 0o755 });
    const recordedFiles = files.map((file) => {
      const destination = path.join(textDirectory, path.basename(file));
      const contents = readFileSync(file);
      writeFileSync(path.join(outputDirectory, destination), contents, { mode: 0o644 });
      return { path: destination, sha256: sha256(contents) };
    });
    entries.push({
      module: item.module,
      version: item.version,
      replacement: null,
      consumingBinaries: item.consumingBinaries.sort(),
      sourceUrl: sourceUrl(item.module, item.version),
      spdxExpression: detectSpdx(files),
      goChecksum: item.sum || null,
      requiredFiles: recordedFiles
    });
  }

  const manifest = {
    schemaVersion: 1,
    review: {
      status: "pending",
      approvedBy: null,
      approvedAt: null,
      note: "Generated license classification is evidence for qualified review and is not legal approval."
    },
    inventories: [...inventories].sort(([left], [right]) => left.localeCompare(right)).map(([binary, file]) => ({
      binary,
      sha256: sha256(readFileSync(file))
    })),
    modules: entries
  };
  writeFileSync(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(path.join(outputDirectory, "README.md"), `# Go Module Attribution Bundle

This directory contains the exact module/version union linked into the Trivy,
rclone, Docker CLI, and Docker Compose binaries shipped by ComposeBastion. The
manifest maps every entry to its consuming binary, upstream source record, SPDX
classification candidate, required license/notice texts, and SHA-256 checksums.

The current legal-review status and any qualified approval evidence are recorded
only in \`manifest.json\`, which is the source of truth. Automated classification
and checksum verification are release evidence, not qualified legal approval.
`, { mode: 0o644 });
  console.log(`Generated pending Go attribution manifest with ${entries.length} module/version entries.`);
}

function validateBundle(manifestFile, { validateSpdxExpressions = false } = {}) {
  const root = path.dirname(manifestFile);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.schemaVersion !== 1) fail("manifest schema version is invalid");
  validateReview(manifest.review);
  const entries = new Map();
  for (const entry of manifest.modules ?? []) {
    const key = `${entry.module}@${entry.version}`;
    if (entries.has(key)) fail(`duplicate manifest entry ${key}`);
    if (!entry.sourceUrl || !entry.spdxExpression || !Array.isArray(entry.consumingBinaries) || entry.consumingBinaries.length === 0 || !Array.isArray(entry.requiredFiles) || entry.requiredFiles.length === 0) {
      fail(`${key} has incomplete attribution metadata`);
    }
    if (manifest.review.status === "approved" && entry.spdxExpression === "NOASSERTION") {
      fail(`${key} still has NOASSERTION in an approved manifest`);
    }
    if (validateSpdxExpressions) validateSpdxExpression(key, entry.spdxExpression);
    for (const file of entry.requiredFiles) {
      const resolved = path.resolve(root, file.path);
      if (!resolved.startsWith(`${root}${path.sep}`)) fail(`${key} contains an unsafe attribution path`);
      const contents = readFileSync(resolved);
      if (sha256(contents) !== file.sha256) fail(`${key} attribution checksum mismatch for ${file.path}`);
    }
    entries.set(key, entry);
  }
  if (entries.size === 0) fail("manifest contains no Go module attribution entries");
  const inventoryRecords = new Map();
  for (const inventory of manifest.inventories ?? []) {
    if (!inventory.binary || !/^[a-f0-9]{64}$/.test(inventory.sha256) || inventoryRecords.has(inventory.binary)) {
      fail("manifest inventory checksum records are invalid or duplicated");
    }
    inventoryRecords.set(inventory.binary, inventory.sha256);
  }
  if (inventoryRecords.size === 0) fail("manifest contains no inventory checksum records");
  return { manifest, entries, inventoryRecords };
}

function checkManifest() {
  const manifestFile = path.resolve(value("--manifest"));
  const { manifest, entries } = validateBundle(manifestFile, { validateSpdxExpressions: true });
  if (process.argv.includes("--require-approved") && manifest.review.status !== "approved") {
    fail("stable release requires qualified approval in the attribution manifest");
  }
  console.log(`Verified ${entries.size} checked-in Go attribution entries (${manifest.review.status} legal review).`);
}

function csvCell(value) {
  const rendered = String(value ?? "");
  return /[",\r\n]/.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered;
}

function writeReviewWorksheet() {
  const manifestFile = path.resolve(value("--manifest"));
  const outputFile = path.resolve(value("--output"));
  const { entries } = validateBundle(manifestFile);
  const pending = [...entries.values()].filter((entry) => entry.spdxExpression === "NOASSERTION");
  const headers = [
    "module",
    "version",
    "consumers",
    "sourceUrl",
    "bundledLicenseFiles",
    "reviewedSpdxExpression",
    "reviewerOrOrganization",
    "reviewedAtUtc",
    "notes"
  ];
  const rows = pending.map((entry) => [
    entry.module,
    entry.version,
    entry.consumingBinaries.join(";"),
    entry.sourceUrl,
    entry.requiredFiles.map((file) => file.path).join(";"),
    "",
    "",
    "",
    ""
  ]);
  mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o755 });
  writeFileSync(outputFile, `${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`, { mode: 0o644 });
  console.log(`Exported ${pending.length} NOASSERTION entries to ${outputFile}.`);
}

function verifyManifest() {
  const manifestFile = path.resolve(value("--manifest"));
  const inventories = assignments("--inventory");
  if (inventories.size === 0) fail("verify requires at least one --inventory");
  const expected = inventorySet(inventories);
  const { manifest, entries, inventoryRecords } = validateBundle(manifestFile);
  for (const [binary, file] of inventories) {
    if (inventoryRecords.get(binary) !== sha256(readFileSync(file))) {
      fail(`${binary} linked-module inventory checksum differs from the reviewed manifest`);
    }
  }

  const actual = new Map();
  for (const entry of entries.values()) {
    const selectedConsumers = entry.consumingBinaries.filter((binary) => inventories.has(binary)).sort();
    if (selectedConsumers.length === 0) continue;
    const key = `${entry.module}@${entry.version}`;
    actual.set(key, { ...entry, consumingBinaries: selectedConsumers });
  }

  const missing = [...expected.keys()].filter((key) => !actual.has(key));
  const extra = [...actual.keys()].filter((key) => !expected.has(key));
  if (missing.length || extra.length) fail(`inventory differs from manifest; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`);
  for (const [key, expectedEntry] of expected) {
    const actualEntry = actual.get(key);
    if (JSON.stringify(actualEntry.consumingBinaries) !== JSON.stringify(expectedEntry.consumingBinaries.sort())) {
      fail(`${key} consuming-binary attribution differs from the linked inventory`);
    }
  }
  console.log(`Verified ${actual.size} Go attribution entries for ${[...inventories.keys()].join(", ")} (${manifest.review.status} legal review).`);
}

const command = process.argv[2];
if (command === "generate") writeManifest();
else if (command === "check") checkManifest();
else if (command === "verify") verifyManifest();
else if (command === "review") writeReviewWorksheet();
else fail("usage: node scripts/go-attribution.mjs <generate|check|verify|review> ...");
