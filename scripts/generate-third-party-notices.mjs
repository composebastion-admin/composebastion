import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "THIRD-PARTY-NOTICES.md");
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const check = process.argv.includes("--check");

const bundledRuntimeTools = [
  ["Trivy", "0.72.0 (8a32853686209a428179bb3a1688802b25691564)", "Apache-2.0", "app"],
  ["ORAS Go v2", "2.6.2", "Apache-2.0", "app (linked into Trivy)"],
  ["rclone", "1.74.4 (5bc93a2a7ab0ebd0a11352bc4968eabeffb18027)", "MIT", "app"],
  ["Docker CLI", "29.6.1 (8900f1d330cb39e93e16d780a26bff1d7e07ba03)", "Apache-2.0", "agent"],
  ["Docker Compose", "5.3.1 (f32009d4a2c687dd405398cc7975d12dccaf8dff)", "Apache-2.0", "agent"],
  ["Go standard library", "1.26.5", "BSD-3-Clause", "app and agent tool binaries"]
];

// These packages publish an MIT LICENSE file but omit the package.json license
// field consumed by npm's lockfile. Keep overrides explicit and narrowly pinned.
const licenseOverrides = new Map([
  ["buildcheck@0.0.7", "MIT"],
  ["cpu-features@0.0.10", "MIT"],
  ["ssh2@1.17.0", "MIT"]
]);

function packageName(lockPath) {
  const parts = lockPath.split("/");
  const nodeModules = parts.lastIndexOf("node_modules");
  const first = parts[nodeModules + 1];
  return first.startsWith("@") ? `${first}/${parts[nodeModules + 2]}` : first;
}

function cell(value) {
  return String(value).replaceAll("|", "\\|");
}

const rows = Object.entries(lock.packages ?? {})
  .filter(([lockPath, metadata]) => lockPath.includes("node_modules/") && metadata.version)
  .map(([lockPath, metadata]) => {
    const name = packageName(lockPath);
    return {
      name,
      version: metadata.version,
      license: metadata.license ?? licenseOverrides.get(`${name}@${metadata.version}`) ?? "UNKNOWN",
      lockPath
    };
  })
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version) || left.lockPath.localeCompare(right.lockPath));

const counts = new Map();
for (const row of rows) counts.set(row.license, (counts.get(row.license) ?? 0) + 1);
const summary = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
const reviewLicenses = rows.filter((row) => /GPL|AGPL|SSPL|UNKNOWN|UNLICENSED/i.test(row.license));

const output = `# Third-Party Notices

ComposeBastion may include or depend on third-party software components.
Third-party components are governed by their own license terms and are not relicensed by LICENSE.md.

This inventory was generated from package-lock.json for ComposeBastion ${packageJson.version}. It is a best-effort dependency notice for the npm workspace.

## Bundled Runtime Tools

These non-npm tools are distributed in the app or agent image. Their applicable
upstream license and notice files are copied into \`/licenses/third-party/\` in
the corresponding image.

Each image records deterministic linked Go module inventories under
\`/licenses/third-party/go-buildinfo/\` and carries the checked-in manifest,
upstream license/notice texts, SPDX classification candidates, and SHA-256
checksums under \`/licenses/third-party/go-modules/\`. Image builds fail if the
linked inventory differs from that bundle or a required text is missing.
**Legal review status: pending.** Automated collection and classification are
review evidence, not qualified legal approval; that dated approval remains a
release gate.

| Component | Reviewed version/source | License | Image |
|-----------|-------------------------|---------|-------|
${bundledRuntimeTools.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n")}

## License Summary

| License | Package entries |
|---------|-----------------|
${summary.map(([license, count]) => `| ${cell(license)} | ${count} |`).join("\n")}

## Manual Review Items

${reviewLicenses.length === 0
    ? "No missing, GPL, AGPL, SSPL, UNKNOWN, or UNLICENSED package entries were found in the npm lockfile inventory."
    : reviewLicenses.map((row) => `- ${row.name}@${row.version}: ${row.license}`).join("\n")}

## Dependency Inventory

| Package | Version | License | Lockfile path |
|---------|---------|---------|---------------|
${rows.map((row) => `| ${cell(row.name)} | ${cell(row.version)} | ${cell(row.license)} | ${cell(row.lockPath)} |`).join("\n")}

## Notes

- Local ComposeBastion workspace packages are covered by LICENSE.md and are excluded from this third-party inventory.
- Dependency license metadata can change between package versions. Regenerate and review this file whenever dependencies change.
- This file is not legal advice and does not replace review of dependency license texts, package repositories, or distributed artifacts.
`;

if (check) {
  const current = await readFile(target, "utf8");
  if (current !== output) {
    console.error("THIRD-PARTY-NOTICES.md is stale. Run npm run notices:write.");
    process.exit(1);
  }
  console.log("Third-party dependency notices are current.");
} else {
  await writeFile(target, output);
  console.log(`Updated ${path.relative(root, target)} with ${rows.length} dependency entries.`);
}
