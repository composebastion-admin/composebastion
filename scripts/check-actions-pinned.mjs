import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// This allowlist is the local review record: the SHA must be the peeled commit
// for the version named beside it, rather than a mutable tag or an annotated
// tag object. Updating an Action therefore requires changing both this record
// and the workflow reference in the same reviewed change.
const reviewedReferences = new Map([
  ["actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10", "v6.0.3"],
  ["actions/dependency-review-action@2031cfc080254a8a887f58cffee85186f0e49e48", "v4.9.0"],
  ["actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "v4.3.0"],
  ["actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", "v6.4.0"],
  ["actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", "v4.6.2"],
  ["aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25", "v0.36.0"],
  ["docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a", "v7.3.0"],
  ["docker/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0", "v4.4.0"],
  ["docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302", "v6.2.0"],
  ["docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c", "v4.2.0"],
  ["docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8", "v4.2.0"],
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
