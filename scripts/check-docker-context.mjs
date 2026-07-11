import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeTestResultsPath, digestGitBuildContext, materializeGitBuildContext } from "./materialize-git-context.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "composebastion-context-"));
const context = path.join(root, "context");
const output = path.join(root, "output");
mkdirSync(context);
cpSync(".dockerignore", path.join(context, ".dockerignore"));
writeFileSync(path.join(context, "Dockerfile"), "FROM scratch\nCOPY . /context\n");

function writeFixture(relativePath, contents) {
  const destination = path.join(context, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

const forbidden = [
  ".env",
  ".env.production",
  ".npmrc",
  ".ssh/id_ed25519",
  "private.pem",
  "server.crt",
  "id_ed25519.pub",
  "test-results/runtime.json",
  "nested/config/.env",
  "nested/config/.env.production",
  "nested/project/.npmrc",
  "nested/home/.ssh/id_ed25519",
  "nested/certs/server.pem",
  "nested/certs/server.key",
  "nested/certs/client.p12",
  "nested/certs/client.pfx",
  "nested/certs/server.crt",
  "nested/certs/server.cer",
  "nested/certs/server.cert",
  "nested/certs/server.der",
  "nested/certs/trust.jks",
  "nested/certs/trust.keystore",
  "nested/certs/signing.p8",
  "nested/certs/signing.pkcs8",
  "nested/certs/putty.ppk",
  "nested/ssh/id_rsa",
  "nested/ssh/id_dsa",
  "nested/ssh/id_ecdsa",
  "nested/ssh/id_ed25519.pub",
  "nested/ssh/custom.pub",
  "nested/ssh/authorized_keys",
  "nested/ssh/known_hosts",
  "nested/dependencies/node_modules/package/index.js",
  "nested/build/dist/bundle.js",
  "nested/runtime/coverage/lcov.info",
  "nested/runtime/data/state.sqlite",
  "nested/runtime/playwright-report/index.html",
  "nested/runtime/test-results/runtime.json",
  "nested/runtime/acceptance-runtime/state.json",
  "nested/runtime/state.sqlite",
  "nested/runtime/state.sqlite3",
  "nested/runtime/state.db",
  "nested/runtime/state.db-wal",
  "nested/runtime/app.log",
  "nested/runtime/npm-debug.log",
  "nested/repository/.git/config",
  ".claude/settings.local.json",
  ".codex/config.toml",
  ".DS_Store",
  "nested/tools/.claude/settings.local.json",
  "nested/tools/.codex/config.toml",
  "nested/tools/.DS_Store"
];

for (const relativePath of forbidden) writeFixture(relativePath, "credential or runtime sentinel\n");
for (const relativePath of [".env.example", "safe.txt", "nested/source/safe.txt"]) writeFixture(relativePath, "safe\n");

try {
  execFileSync("docker", ["buildx", "build", "--progress=plain", "--output", `type=local,dest=${output}`, context], { stdio: "pipe" });
  const copied = path.join(output, "context");
  const failures = [];
  for (const required of [".env.example", "safe.txt", "nested/source/safe.txt"]) {
    if (!existsSync(path.join(copied, required))) failures.push(`${required} should be present`);
  }
  for (const relativePath of forbidden) {
    if (existsSync(path.join(copied, relativePath))) failures.push(`${relativePath} leaked into the Docker context`);
  }
  const exactContext = path.join(root, "exact-git-context");
  const exactEvidence = materializeGitBuildContext({
    repositoryRoot: process.cwd(),
    revision: "HEAD",
    destination: exactContext
  });
  if (existsSync(path.join(exactContext, ".claude", "settings.local.json"))) {
    failures.push("ignored local Claude settings leaked into the exact Git context");
  }
  if (digestGitBuildContext(exactContext).digest !== exactEvidence.contextDigest) {
    failures.push("exact Git context digest was not deterministic after materialization");
  }
  writeFileSync(path.join(exactContext, "context-mutation-proof.txt"), "mutation\n");
  if (digestGitBuildContext(exactContext).digest === exactEvidence.contextDigest) {
    failures.push("exact Git context digest did not detect a post-materialization mutation");
  }

  const attributeRepository = path.join(root, "attribute-repository");
  mkdirSync(attributeRepository);
  execFileSync("git", ["-C", attributeRepository, "init", "--quiet"], { stdio: "pipe" });
  for (const [relativePath, contents] of [
    [".dockerignore", "node_modules\n"],
    ["Dockerfile", "FROM scratch\n"],
    ["Dockerfile.agent", "FROM scratch\n"],
    ["package.json", "{}\n"],
    ["package-lock.json", "{}\n"],
    ["omitted.txt", "must remain present\n"],
    ["executable.sh", "#!/bin/sh\nexit 0\n"]
  ]) {
    writeFileSync(path.join(attributeRepository, relativePath), contents);
  }
  chmodSync(path.join(attributeRepository, "executable.sh"), 0o755);
  symlinkSync("omitted.txt", path.join(attributeRepository, "linked.txt"));
  execFileSync("git", ["-C", attributeRepository, "add", "."], { stdio: "pipe" });
  execFileSync("git", [
    "-C", attributeRepository,
    "-c", "user.name=ComposeBastion Context Test",
    "-c", "user.email=context-test@composebastion.invalid",
    "commit", "--quiet", "-m", "context fixture"
  ], { stdio: "pipe" });
  const originalContextCommit = execFileSync("git", ["-C", attributeRepository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(attributeRepository, ".git", "info", "attributes"), "omitted.txt export-ignore\n");
  const attributeContext = path.join(root, "attribute-context");
  materializeGitBuildContext({
    repositoryRoot: attributeRepository,
    revision: "HEAD",
    destination: attributeContext
  });
  if (readFileSync(path.join(attributeContext, "omitted.txt"), "utf8") !== "must remain present\n") {
    failures.push("local Git export-ignore attributes changed the exact tree-object context");
  }
  if ((statSync(path.join(attributeContext, "executable.sh")).mode & 0o111) === 0) {
    failures.push("exact Git context did not preserve executable mode");
  }
  if (readlinkSync(path.join(attributeContext, "linked.txt")) !== "omitted.txt") {
    failures.push("exact Git context did not preserve a tracked symlink");
  }
  writeFileSync(path.join(attributeRepository, "omitted.txt"), "replacement content\n");
  execFileSync("git", ["-C", attributeRepository, "add", "omitted.txt"], { stdio: "pipe" });
  execFileSync("git", [
    "-C", attributeRepository,
    "-c", "user.name=ComposeBastion Context Test",
    "-c", "user.email=context-test@composebastion.invalid",
    "commit", "--quiet", "-m", "replacement fixture"
  ], { stdio: "pipe" });
  const replacementCommit = execFileSync("git", ["-C", attributeRepository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", attributeRepository, "replace", originalContextCommit, replacementCommit], { stdio: "pipe" });
  const replaceContext = path.join(root, "replace-context");
  materializeGitBuildContext({
    repositoryRoot: attributeRepository,
    revision: originalContextCommit,
    destination: replaceContext
  });
  if (readFileSync(path.join(replaceContext, "omitted.txt"), "utf8") !== "must remain present\n") {
    failures.push("a local Git replace ref changed the exact tree-object context");
  }

  const originalUmask = process.umask();
  let restrictiveEvidence;
  let standardEvidence;
  try {
    process.umask(0o077);
    restrictiveEvidence = materializeGitBuildContext({
      repositoryRoot: attributeRepository,
      revision: "HEAD",
      destination: path.join(root, "umask-077-context")
    });
    process.umask(0o022);
    standardEvidence = materializeGitBuildContext({
      repositoryRoot: attributeRepository,
      revision: "HEAD",
      destination: path.join(root, "umask-022-context")
    });
  } finally {
    process.umask(originalUmask);
  }
  if (restrictiveEvidence.contextDigest !== standardEvidence.contextDigest) {
    failures.push("exact Git context digest changed with the process umask");
  }

  const redirectedStorage = path.join(root, "redirected-storage");
  const redirectedContext = path.join(redirectedStorage, "context");
  mkdirSync(redirectedContext, { recursive: true });
  const redirectSentinel = path.join(redirectedContext, "must-not-be-deleted.txt");
  writeFileSync(redirectSentinel, "preserve\n");
  symlinkSync(redirectedStorage, path.join(attributeRepository, "test-results"));
  let redirectedDestinationRejected = false;
  try {
    assertSafeTestResultsPath({
      repositoryRoot: attributeRepository,
      destination: path.join(attributeRepository, "test-results", "context"),
      label: "Synthetic redirected results"
    });
    materializeGitBuildContext({
      repositoryRoot: attributeRepository,
      revision: "HEAD",
      destination: path.join(attributeRepository, "test-results", "context")
    });
  } catch {
    redirectedDestinationRejected = true;
  }
  if (!redirectedDestinationRejected || !existsSync(redirectSentinel)) {
    failures.push("a symlinked test-results directory redirected destructive context cleanup outside the repository");
  }

  rmSync(path.join(attributeRepository, "Dockerfile.agent"));
  execFileSync("git", ["-C", attributeRepository, "add", "Dockerfile.agent"], { stdio: "pipe" });
  execFileSync("git", [
    "-C", attributeRepository,
    "-c", "user.name=ComposeBastion Context Test",
    "-c", "user.email=context-test@composebastion.invalid",
    "commit", "--quiet", "-m", "missing required file fixture"
  ], { stdio: "pipe" });
  const incompleteContext = path.join(root, "incomplete-context");
  let missingRequiredRejected = false;
  try {
    materializeGitBuildContext({
      repositoryRoot: attributeRepository,
      revision: "HEAD",
      destination: incompleteContext
    });
  } catch (error) {
    missingRequiredRejected = String(error).includes("missing tracked file Dockerfile.agent");
  }
  if (!missingRequiredRejected || existsSync(incompleteContext)) {
    failures.push("a failed required-file check left a partial exact Git context behind");
  }

  const collisionContextA = path.join(root, "digest-collision-a");
  const collisionContextB = path.join(root, "digest-collision-b");
  mkdirSync(collisionContextA);
  mkdirSync(collisionContextB);
  writeFileSync(
    path.join(collisionContextA, "a"),
    Buffer.concat([Buffer.from("X\0file\0b\0"), Buffer.from("100644"), Buffer.from("\0Y")])
  );
  writeFileSync(path.join(collisionContextB, "a"), "X");
  writeFileSync(path.join(collisionContextB, "b"), "Y");
  if (digestGitBuildContext(collisionContextA).digest === digestGitBuildContext(collisionContextB).digest) {
    failures.push("exact Git context digest has an ambiguous entry/payload encoding");
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log("Docker build context excludes credential/runtime sentinels and exact Git contexts are mutation-detecting.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
