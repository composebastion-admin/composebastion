import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = spawnSync("git", ["ls-files", "-z"], {
  encoding: "buffer",
  maxBuffer: 32 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"]
});
if (tracked.error) throw tracked.error;
if (tracked.status !== 0) throw new Error(`git ls-files failed: ${String(tracked.stderr).trim()}`);

const allowedGhcrOwners = new Set([
  "composebastion-admin",
  "composebastion-tests",
  "example",
  // Reviewed upstream images used by the built-in application catalog.
  "home-assistant",
  "open-webui"
]);
const failures = [];
for (const file of tracked.stdout.toString("utf8").split("\0").filter(Boolean)) {
  // These files are preserved verbatim from third-party modules. Their owner
  // names, contacts, paths, and registry references are legal evidence rather
  // than ComposeBastion fixtures or project metadata.
  if (file.startsWith("LICENSES/go-modules/texts/")) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  const contents = bytes.toString("utf8");

  for (const match of contents.matchAll(/ghcr\.io\/([a-z0-9_.-]+)/gi)) {
    const owner = match[1].toLowerCase();
    if (!allowedGhcrOwners.has(owner)) failures.push(`${file}: unapproved GHCR fixture or image owner ${match[1]}`);
  }

  if (/\/Users\/(?!<)[^/\s]+\//.test(contents) || /[A-Za-z]:\\Users\\(?!<)[^\\\s]+\\/.test(contents)) {
    failures.push(`${file}: committed absolute developer home path`);
  }

  for (const match of contents.matchAll(/\bsupport@[a-z0-9.-]+\.[a-z]{2,}\b/gi)) {
    if (match[0].toLowerCase() !== "support@composebastion.com") {
      failures.push(`${file}: project support contact must use support@composebastion.com`);
    }
  }
}

const labelContract = new Map([
  [".github/ISSUE_TEMPLATE/bug_report.yml", ['labels: ["type: bug", "status: needs info"]']],
  [".github/ISSUE_TEMPLATE/feature_request.yml", ['labels: ["type: feature", "status: needs info"]']],
  [".github/ISSUE_TEMPLATE/deployment_help.yml", ['labels: ["type: support", "area: docker", "status: needs info"]']],
  [".github/ISSUE_TEMPLATE/security_report.yml", ['labels: ["type: security", "area: security", "status: needs info"]']],
  [".github/dependabot.yml", ['"type: dependencies"', '"area: security"', '"area: ci"', '"area: docker"']]
]);
const documentedLabels = readFileSync(".github/labels.md", "utf8");
for (const [file, expectedLabels] of labelContract) {
  const contents = readFileSync(file, "utf8");
  for (const expected of expectedLabels) {
    if (!contents.includes(expected)) failures.push(`${file}: missing intended label contract ${expected}`);
    for (const label of expected.matchAll(/"([^"]+)"/g)) {
      if (!documentedLabels.includes(`\`${label[1]}\``)) failures.push(`.github/labels.md: missing referenced label ${label[1]}`);
    }
  }
}

if (failures.length > 0) throw new Error(`Public repository hygiene failed:\n${failures.join("\n")}`);
console.log("Public repository fixtures, paths, image namespaces, and support contacts are clean.");
