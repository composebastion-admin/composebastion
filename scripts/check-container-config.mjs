import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  evaluateContainerConfigReport,
  expectedTrivyVersion
} from "./container-config-policy.mjs";

const pinnedTrivyImage =
  "aquasec/trivy:0.72.0@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f";
const targets = [
  "Dockerfile",
  "Dockerfile.agent",
  "infra/dev/sshhost.Dockerfile"
];
const failures = [];
const admitted = [];
const cliOptions = new Set(process.argv.slice(2));
for (const option of cliOptions) {
  if (option !== "--docker" && option !== "--local") {
    failures.push(`Unknown option ${option}; use --docker or --local`);
  }
}
if (cliOptions.has("--docker") && cliOptions.has("--local")) {
  failures.push("--docker and --local are mutually exclusive");
}
const useDocker = !cliOptions.has("--local");

function runTrivy(args, mountWorkspace = false) {
  if (!useDocker) {
    return execFileSync(process.env.TRIVY_BIN || "trivy", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
  }
  const dockerArgs = ["run", "--rm", "--pull=always"];
  if (mountWorkspace) {
    dockerArgs.push(
      "--mount", `type=bind,src=${process.cwd()},dst=/workspace,readonly`,
      "--workdir", "/workspace"
    );
  }
  dockerArgs.push(pinnedTrivyImage, ...args);
  return execFileSync("docker", dockerArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
}

function requireText(file, pattern, message) {
  const source = readFileSync(file, "utf8");
  if (!pattern.test(source)) failures.push(`${file}: ${message}`);
}

requireText(
  "Dockerfile",
  /^USER\s+(?:node|1000(?::1000)?)\s*$/m,
  "the release manager runtime must declare a non-root USER"
);
requireText(
  "Dockerfile.agent",
  /^USER\s+root\s*$/m,
  "the reviewed Docker-socket trust boundary must be explicit"
);
requireText(
  "agent-compose.image.example.yml",
  /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/,
  "the root exception is valid only while the default agent mounts the Docker socket"
);
requireText(
  "infra/dev/sshhost.Dockerfile",
  /^# Development-only "remote Docker host"/,
  "the root SSH image must remain explicitly development-only"
);
requireText(
  "infra/dev/sshhost.Dockerfile",
  /PermitRootLogin yes/,
  "the fixture exception is valid only while it intentionally tests root SSH"
);

const releaseIgnore = readFileSync(".trivyignore.yaml", "utf8");
if (/DS-0002|misconfigurations\s*:/i.test(releaseIgnore)) {
  failures.push(
    ".trivyignore.yaml: container-user exceptions must not enter the release vulnerability ignore file"
  );
}

try {
  const versionOutput = runTrivy(["--version"]);
  const actualVersion = /^Version:\s*(\S+)\s*$/m.exec(versionOutput)?.[1];
  if (actualVersion !== expectedTrivyVersion) {
    failures.push(
      `Container configuration scans require Trivy ${expectedTrivyVersion}, got ${actualVersion ?? "unknown"}`
    );
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  failures.push(`Unable to validate Trivy ${expectedTrivyVersion} (${detail})`);
}

for (const target of targets) {
  let report;
  try {
    const output = runTrivy([
      "fs",
      "--quiet",
      "--scanners", "misconfig",
      "--misconfig-scanners", "dockerfile",
      "--include-non-failures",
      "--format", "json",
      "--exit-code", "0",
      "--ignorefile", "/dev/null",
      target
    ], true);
    report = JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(`${target}: unable to run Trivy ${expectedTrivyVersion} container-config scan (${detail})`);
    continue;
  }

  const evaluated = evaluateContainerConfigReport(target, report);
  failures.push(...evaluated.failures);
  admitted.push(...evaluated.admitted);
}

if (failures.length > 0) {
  throw new Error(`Container configuration policy failed:\n${failures.join("\n")}`);
}

console.log(
  `Manager Dockerfile passes the Trivy ${expectedTrivyVersion} DS-0002 non-root requirement.`
);
for (const exception of admitted) {
  console.log(`Reviewed exception: ${exception}`);
}
console.log("Release vulnerability ignores remain separate and unchanged by this policy.");
