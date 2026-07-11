import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// This allowlist is the local review record: the SHA must be the peeled commit
// for the version named beside it, rather than a mutable tag or an annotated
// tag object. Updating an Action therefore requires changing both this record
// and the workflow reference in the same reviewed change.
const reviewedReferences = new Map([
  ["actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", "v4.3.1"],
  ["actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10", "v6.0.3"],
  ["actions/dependency-review-action@2031cfc080254a8a887f58cffee85186f0e49e48", "v4.9.0"],
  ["actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "v4.3.0"],
  ["actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", "v4.4.0"],
  ["actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", "v4.6.2"],
  ["aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25", "v0.36.0"],
  ["docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8", "v6.19.2"],
  ["docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9", "v3.7.0"],
  ["docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f", "v3.12.0"],
  ["docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130", "v3.7.0"],
  ["github/codeql-action/analyze@cdefb33c0f6224e58673d9004f47f7cb3e328b89", "v4.31.10"],
  ["github/codeql-action/init@cdefb33c0f6224e58673d9004f47f7cb3e328b89", "v4.31.10"]
]);

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(location) : [location];
  });
}

const failures = [];
for (const file of filesBelow(".github/workflows").filter((name) => /\.ya?ml$/i.test(name))) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const reference = /^\s*(?:-\s*)?uses:\s*["']?([^"'\s#]+)["']?/.exec(line)?.[1];
    if (!reference || reference.startsWith("./")) return;
    if (reference.startsWith("docker://") && /@sha256:[a-f0-9]{64}$/i.test(reference)) return;
    if (!/^[^@\s]+@[a-f0-9]{40}$/i.test(reference)) {
      failures.push(`${file}:${index + 1}: ${reference}`);
      return;
    }
    const version = /\s+#\s+(v(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,2}(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(line)?.[1];
    if (!version) {
      failures.push(`${file}:${index + 1}: ${reference} is missing its reviewed version comment`);
      return;
    }
    const reviewedVersion = reviewedReferences.get(reference);
    if (!reviewedVersion) {
      failures.push(`${file}:${index + 1}: ${reference} is not in the reviewed Action allowlist`);
    } else if (version !== reviewedVersion) {
      failures.push(`${file}:${index + 1}: ${reference} is ${reviewedVersion}, not ${version}`);
    }
  });
}

if (failures.length > 0) {
  throw new Error(`GitHub Actions must use immutable full commit SHAs:\n${failures.join("\n")}`);
}

console.log("All remote GitHub Actions use reviewed peeled commit SHAs with matching version comments.");
