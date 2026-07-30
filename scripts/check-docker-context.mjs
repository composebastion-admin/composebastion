import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeTestResultsPath, digestGitBuildContext, materializeGitBuildContext, readStableRegularFile } from "./materialize-git-context.mjs";

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

  const sameNameReplacement = path.join(root, "same-name-package-replacement.json");
  writeFileSync(sameNameReplacement, "{\"replaced\":true}\n");
  let sameNameReplacementRejected = false;
  try {
    materializeGitBuildContext({
      repositoryRoot: attributeRepository,
      revision: "HEAD",
      destination: path.join(root, "same-name-replacement-context"),
      testHooks: {
        beforeStagedDigest: ({ stagingDestination }) => {
          const parentStat = statSync(stagingDestination);
          renameSync(
            sameNameReplacement,
            path.join(stagingDestination, "package.json")
          );
          utimesSync(
            stagingDestination,
            parentStat.atime,
            parentStat.mtime
          );
        }
      }
    });
  } catch (error) {
    sameNameReplacementRejected = String(error).includes(
      "does not exactly match the commit tree"
    );
  }
  if (!sameNameReplacementRejected) {
    failures.push(
      "a same-name inode/content replacement bypassed exact Git provenance"
    );
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

  const stableReadDirectory = path.join(root, "stable-read");
  mkdirSync(stableReadDirectory);
  const stableReadPath = path.join(stableReadDirectory, "payload.txt");
  writeFileSync(stableReadPath, "original\n");
  const stableReadReplacement = path.join(stableReadDirectory, "replacement.txt");
  writeFileSync(stableReadReplacement, "replacement\n");
  let changedInodeRejected = false;
  try {
    readStableRegularFile(stableReadPath, {
      afterOpen: () => renameSync(stableReadReplacement, stableReadPath)
    });
  } catch {
    changedInodeRejected = true;
  }
  if (!changedInodeRejected) failures.push("a file inode replacement was accepted as a stable context read");

  const linkTarget = path.join(stableReadDirectory, "target.txt");
  writeFileSync(linkTarget, "target\n");
  const fileToLinkPath = path.join(stableReadDirectory, "file-to-link.txt");
  writeFileSync(fileToLinkPath, "original\n");
  let fileToLinkRejected = false;
  try {
    readStableRegularFile(fileToLinkPath, {
      afterOpen: () => {
        rmSync(fileToLinkPath);
        symlinkSync("target.txt", fileToLinkPath);
      }
    });
  } catch {
    fileToLinkRejected = true;
  }
  if (!fileToLinkRejected) failures.push("a file-to-symlink replacement was accepted as a stable context read");

  const inPlaceMutationPath = path.join(stableReadDirectory, "in-place-mutation.txt");
  writeFileSync(inPlaceMutationPath, "before\n");
  let inPlaceMutationRejected = false;
  try {
    readStableRegularFile(inPlaceMutationPath, {
      afterRead: () => writeFileSync(inPlaceMutationPath, "after!\n")
    });
  } catch {
    inPlaceMutationRejected = true;
  }
  if (!inPlaceMutationRejected) failures.push("an in-place content mutation was accepted as a stable context read");

  const fileMetadataMutationPath = path.join(stableReadDirectory, "file-metadata-mutation.txt");
  writeFileSync(fileMetadataMutationPath, "stable contents\n");
  let fileMetadataMutationRejected = false;
  let fileMetadataCtimeAdvanced = false;
  try {
    readStableRegularFile(fileMetadataMutationPath, {
      afterRead: () => {
        const before = statSync(fileMetadataMutationPath);
        const originalMode = before.mode & 0o777;
        chmodSync(fileMetadataMutationPath, originalMode);
        let after = statSync(fileMetadataMutationPath);
        if (after.ctimeMs === before.ctimeMs) {
          chmodSync(fileMetadataMutationPath, originalMode ^ 0o100);
          chmodSync(fileMetadataMutationPath, originalMode);
          after = statSync(fileMetadataMutationPath);
        }
        fileMetadataCtimeAdvanced = after.ctimeMs !== before.ctimeMs;
      }
    });
  } catch {
    fileMetadataMutationRejected = true;
  }
  if (!fileMetadataCtimeAdvanced || !fileMetadataMutationRejected) {
    failures.push("a file ctime-only metadata mutation was accepted as a stable file read");
  }

  const directoryMetadataContext = path.join(root, "directory-metadata-context");
  mkdirSync(directoryMetadataContext);
  writeFileSync(path.join(directoryMetadataContext, "payload.txt"), "stable contents\n");
  const directoryMetadataBaseline = digestGitBuildContext(directoryMetadataContext);
  let directoryMetadataChurnApplied = false;
  let directoryMetadataCtimeAdvanced = false;
  let directoryMetadataSemanticsStable = false;
  let directoryMetadataRetryObserved = false;
  const directoryMetadataAfterChurn = digestGitBuildContext(
    directoryMetadataContext,
    {
      afterDirectorySnapshot: ({ current }) => {
        if (current !== directoryMetadataContext || directoryMetadataChurnApplied) return;
        const before = statSync(current);
        const originalMode = before.mode & 0o777;
        chmodSync(current, originalMode);
        let after = statSync(current);
        if (after.ctimeMs === before.ctimeMs) {
          chmodSync(current, originalMode ^ 0o100);
          chmodSync(current, originalMode);
          after = statSync(current);
        }
        directoryMetadataCtimeAdvanced = after.ctimeMs !== before.ctimeMs;
        directoryMetadataSemanticsStable = after.dev === before.dev
          && after.ino === before.ino
          && after.mode === before.mode
          && after.size === before.size
          && after.mtimeMs === before.mtimeMs;
        directoryMetadataChurnApplied = true;
      },
      beforeDirectoryMetadataRetry: () => {
        directoryMetadataRetryObserved = true;
      }
    }
  );
  if (!directoryMetadataChurnApplied
      || !directoryMetadataCtimeAdvanced
      || !directoryMetadataSemanticsStable
      || !directoryMetadataRetryObserved
      || directoryMetadataAfterChurn.digest !== directoryMetadataBaseline.digest
      || directoryMetadataAfterChurn.fileCount !== directoryMetadataBaseline.fileCount) {
    failures.push("directory ctime-only metadata churn changed or blocked the exact Git context digest");
  }

  const directoryEntryMutationContext = path.join(root, "directory-entry-mutation-context");
  mkdirSync(directoryEntryMutationContext);
  writeFileSync(path.join(directoryEntryMutationContext, "payload.txt"), "stable contents\n");
  let directoryEntryMutationRejected = false;
  try {
    digestGitBuildContext(directoryEntryMutationContext, {
      afterDirectorySnapshot: ({ current }) => {
        if (current === directoryEntryMutationContext) {
          writeFileSync(path.join(current, "injected.txt"), "mutation\n");
        }
      }
    });
  } catch (error) {
    directoryEntryMutationRejected = String(error).includes(
      "directory entries changed during traversal"
    );
  }
  if (!directoryEntryMutationRejected) {
    failures.push("a directory entry mutation was accepted during exact Git context traversal");
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
  mkdirSync(incompleteContext);
  const existingContextSentinel = path.join(incompleteContext, "preserved.txt");
  writeFileSync(existingContextSentinel, "preserve existing context\n");
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
  if (!missingRequiredRejected || readFileSync(existingContextSentinel, "utf8") !== "preserve existing context\n") {
    failures.push("a failed required-file check replaced or damaged the previous exact Git context");
  }

  execFileSync("git", [
    "-C", attributeRepository,
    "-c", "user.name=ComposeBastion Context Test",
    "-c", "user.email=context-test@composebastion.invalid",
    "revert", "--no-edit", "HEAD"
  ], { stdio: "pipe" });
  const rollbackContext = path.join(root, "rollback-context");
  mkdirSync(rollbackContext);
  const rollbackSentinel = path.join(rollbackContext, "preserved.txt");
  writeFileSync(rollbackSentinel, "preserve verified destination\n");
  let promotedMutationRejected = false;
  try {
    materializeGitBuildContext({
      repositoryRoot: attributeRepository,
      revision: "HEAD",
      destination: rollbackContext,
      testHooks: {
        beforePromotedDigest: ({ resolvedDestination }) => {
          writeFileSync(path.join(resolvedDestination, "package.json"), "mutated after promotion\n");
        }
      }
    });
  } catch (error) {
    promotedMutationRejected = String(error).includes("does not match its verified staging context");
  }
  if (!promotedMutationRejected
      || !existsSync(rollbackSentinel)
      || readFileSync(rollbackSentinel, "utf8") !== "preserve verified destination\n") {
    failures.push("a post-promotion verification failure did not restore the previous exact Git context");
  }

  const parentRaceContainer = path.join(root, "parent-race");
  const parentRaceOriginal = path.join(parentRaceContainer, "original-parent");
  const parentRaceMoved = path.join(parentRaceContainer, "moved-parent");
  mkdirSync(parentRaceOriginal, { recursive: true });
  const parentRaceDestination = path.join(parentRaceOriginal, "context");
  const redirectedParentSentinel = path.join(parentRaceContainer, "redirected-parent-sentinel.txt");
  writeFileSync(redirectedParentSentinel, "preserve redirected parent\n");
  let parentRaceRejected = false;
  try {
    materializeGitBuildContext({
      repositoryRoot: attributeRepository,
      revision: "HEAD",
      destination: parentRaceDestination,
      testHooks: {
        afterStagingVerified: () => {
          renameSync(parentRaceOriginal, parentRaceMoved);
          mkdirSync(parentRaceOriginal);
          symlinkSync(redirectedParentSentinel, path.join(parentRaceOriginal, "must-not-follow"));
        }
      }
    });
  } catch (error) {
    parentRaceRejected = String(error).includes("changed or was redirected");
  }
  if (!parentRaceRejected || readFileSync(redirectedParentSentinel, "utf8") !== "preserve redirected parent\n") {
    failures.push("a destination-parent replacement was not rejected without following redirected cleanup paths");
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
