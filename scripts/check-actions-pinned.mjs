import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// This allowlist is the local review record: the SHA must be the peeled commit
// for the version named beside it, rather than a mutable tag or an annotated
// tag object. Updating an Action therefore requires changing both this record
// and the workflow reference in the same reviewed change.
const reviewedReferences = new Map([
  ["actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0", "v7.0.0"],
  ["actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294", "v5.0.0"],
  ["actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "v8.0.1"],
  ["actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", "v6.4.0"],
  ["actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "v7.0.1"],
  ["aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25", "v0.36.0"],
  ["docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a", "v7.3.0"],
  ["docker/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0", "v4.4.0"],
  ["docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302", "v6.2.0"],
  ["docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c", "v4.2.0"],
  ["docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8", "v4.2.0"],
  ["github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", "v4.37.0"],
  ["github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", "v4.37.0"]
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
