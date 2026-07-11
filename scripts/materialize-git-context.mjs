#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(command, args, cwd, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: capture ? "utf8" : undefined,
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${String(result.stderr || result.stdout).trim()}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return capture ? String(result.stdout).trim() : "";
}

export function assertSafeTestResultsPath({ repositoryRoot, destination, label = "test-results path" }) {
  const requestedRoot = path.resolve(repositoryRoot);
  const canonicalRoot = realpathSync(requestedRoot);
  const requested = path.resolve(destination);
  const relative = path.relative(requestedRoot, requested);
  const segments = relative.split(path.sep);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative) || segments[0] !== "test-results" || segments.length < 2) {
    throw new Error(`${label} must be a child of the repository's test-results directory: ${requested}`);
  }

  let current = canonicalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} contains a symlink or non-directory component: ${current}`);
    }
    const resolved = realpathSync(current);
    if (resolved !== current) {
      throw new Error(`${label} resolves outside its canonical repository path: ${current} -> ${resolved}`);
    }
  }
  return path.join(canonicalRoot, ...segments);
}

function captureBuffer(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}\n${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function decodeGitPath(value) {
  const decoded = value.toString("utf8");
  if (decoded.includes("\uFFFD") || !Buffer.from(decoded).equals(value)) {
    throw new Error("Git build context contains a path that is not valid UTF-8");
  }
  const normalized = decoded.split("/");
  if (!decoded || decoded.startsWith("/") || normalized.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Git build context contains unsafe path ${JSON.stringify(decoded)}`);
  }
  return decoded;
}

function gitTreeEntries(repositoryRoot, commitSha) {
  const listing = captureBuffer("git", ["ls-tree", "-r", "-z", "--full-tree", commitSha], repositoryRoot);
  const entries = [];
  let offset = 0;
  while (offset < listing.length) {
    const end = listing.indexOf(0, offset);
    if (end < 0) throw new Error("Git tree listing is missing a NUL terminator");
    const record = listing.subarray(offset, end);
    offset = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("Git tree listing entry is missing its path separator");
    const [mode, type, objectId] = record.subarray(0, tab).toString("ascii").split(" ");
    const relative = decodeGitPath(record.subarray(tab + 1));
    if (!/^[a-f0-9]{40}$/.test(objectId ?? "")) throw new Error(`Invalid Git object ID for ${relative}`);
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new Error(`Unsupported Git tree entry ${mode} ${type} ${relative}; submodules and special files are not valid Docker source inputs`);
    }
    entries.push({ mode, objectId, relative });
  }
  return entries;
}

function verifiedBlob(repositoryRoot, objectId, relative) {
  const contents = captureBuffer("git", ["cat-file", "blob", objectId], repositoryRoot);
  const actual = createHash("sha1")
    .update(`blob ${contents.length}\0`)
    .update(contents)
    .digest("hex");
  if (actual !== objectId) throw new Error(`Git blob ${relative} does not match object ${objectId}`);
  return contents;
}

function assertSafeDestination(repositoryRoot, destination) {
  const requestedRoot = path.resolve(repositoryRoot);
  const root = realpathSync(requestedRoot);
  const requested = path.resolve(destination);
  const requestedRelative = path.relative(requestedRoot, requested);
  const requestedInsideRepository = requestedRelative !== ""
    && requestedRelative !== ".."
    && !requestedRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(requestedRelative);
  if (requestedInsideRepository
      && !requestedRelative.startsWith(`test-results${path.sep}`)) {
    throw new Error(`Exact Git contexts inside the repository are restricted to ignored test-results/: ${requested}`);
  }
  mkdirSync(path.dirname(requested), { recursive: true });
  const resolved = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  const relativeRoot = path.relative(resolved, root);
  if (resolved === root || resolved === path.parse(resolved).root
      || (relativeRoot !== "" && !relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== "..")) {
    throw new Error(`Refusing to replace unsafe Git context destination ${resolved}`);
  }
  const resolvedRelative = path.relative(root, resolved);
  const resolvedInsideRepository = resolvedRelative !== ""
    && resolvedRelative !== ".."
    && !resolvedRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(resolvedRelative);
  if (requestedInsideRepository !== resolvedInsideRepository) {
    throw new Error(`Refusing Git context destination redirected across the repository boundary: ${requested} -> ${resolved}`);
  }
  if (resolvedInsideRepository) {
    if (!resolvedRelative.startsWith(`test-results${path.sep}`)) {
      throw new Error(`Resolved Git context is outside ignored test-results/: ${resolved}`);
    }
    if (requestedRelative !== resolvedRelative) {
      throw new Error(`Refusing Git context destination redirected within the repository: ${requested} -> ${resolved}`);
    }
  }
  return resolved;
}

function contextEntries(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current).sort()) {
    const absolute = path.join(current, name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      entries.push({ relative, type: "directory", mode: stat.mode & 0o777 });
      entries.push(...contextEntries(root, absolute));
    } else if (stat.isSymbolicLink()) {
      entries.push({ relative, type: "symlink", mode: stat.mode & 0o777, target: readlinkSync(absolute) });
    } else if (stat.isFile()) {
      entries.push({ relative, type: "file", mode: stat.mode & 0o777, contents: readFileSync(absolute) });
    } else {
      throw new Error(`Unsupported entry in Git build context: ${relative}`);
    }
  }
  return entries;
}

export function digestGitBuildContext(destination) {
  const root = path.resolve(destination);
  if (!existsSync(root)) throw new Error(`Git build context does not exist: ${root}`);
  const hash = createHash("sha256");
  const hashField = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  hashField("ComposeBastion exact Git context digest v1");
  let fileCount = 0;
  for (const entry of contextEntries(root)) {
    const logicalMode = entry.type === "file"
      ? ((entry.mode & 0o111) !== 0 ? "100755" : "100644")
      : (entry.type === "symlink" ? "120000" : "040000");
    hashField(entry.type);
    hashField(entry.relative);
    hashField(logicalMode);
    if (entry.type === "file") {
      hashField(entry.contents);
      fileCount += 1;
    } else if (entry.type === "symlink") {
      hashField(entry.target);
    } else {
      hashField("");
    }
  }
  return { digest: `sha256:${hash.digest("hex")}`, fileCount };
}

export function materializeGitBuildContext({ repositoryRoot, revision, destination }) {
  const root = path.resolve(repositoryRoot);
  const resolvedDestination = assertSafeDestination(root, destination);
  const commitSha = run("git", ["rev-parse", "--verify", `${revision}^{commit}`], root, { capture: true });
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error(`Git context revision did not resolve to a full commit SHA: ${commitSha}`);
  const treeSha = run("git", ["rev-parse", "--verify", `${commitSha}^{tree}`], root, { capture: true });
  if (!/^[a-f0-9]{40}$/.test(treeSha)) throw new Error(`Git context revision did not resolve to a full tree SHA: ${treeSha}`);

  rmSync(resolvedDestination, { recursive: true, force: true });
  mkdirSync(path.dirname(resolvedDestination), { recursive: true });
  const sourceEntries = gitTreeEntries(root, commitSha);
  const materializedEntries = [];
  try {
    mkdirSync(resolvedDestination, { recursive: true });
    for (const entry of sourceEntries) {
      const destinationPath = path.join(resolvedDestination, ...entry.relative.split("/"));
      const relativeCheck = path.relative(resolvedDestination, destinationPath);
      if (relativeCheck.startsWith(`..${path.sep}`) || relativeCheck === ".." || path.isAbsolute(relativeCheck)) {
        throw new Error(`Git tree entry escaped the build context: ${entry.relative}`);
      }
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      const contents = verifiedBlob(root, entry.objectId, entry.relative);
      materializedEntries.push({ ...entry, contents });
      if (entry.mode === "120000") {
        const target = contents.toString("utf8");
        if (target.includes("\uFFFD") || !Buffer.from(target).equals(contents)) {
          throw new Error(`Git symlink target is not valid UTF-8: ${entry.relative}`);
        }
        symlinkSync(target, destinationPath);
      } else {
        const fileMode = entry.mode === "100755" ? 0o755 : 0o644;
        writeFileSync(destinationPath, contents, { mode: fileMode });
        chmodSync(destinationPath, fileMode);
      }
    }

    const actualLeafPaths = contextEntries(resolvedDestination)
      .filter((entry) => entry.type !== "directory")
      .map((entry) => entry.relative)
      .sort();
    const expectedLeafPaths = sourceEntries.map((entry) => entry.relative).sort();
    if (JSON.stringify(actualLeafPaths) !== JSON.stringify(expectedLeafPaths)) {
      throw new Error("Materialized Git context paths do not exactly match the commit tree");
    }
    for (const entry of materializedEntries) {
      const destinationPath = path.join(resolvedDestination, ...entry.relative.split("/"));
      const stat = lstatSync(destinationPath);
      if (entry.mode === "120000") {
        if (!stat.isSymbolicLink() || Buffer.from(readlinkSync(destinationPath)).compare(entry.contents) !== 0) {
          throw new Error(`Materialized symlink does not match Git blob ${entry.relative}`);
        }
      } else {
        const expectedExecutable = entry.mode === "100755";
        const actualExecutable = (stat.mode & 0o111) !== 0;
        if (!stat.isFile() || actualExecutable !== expectedExecutable || readFileSync(destinationPath).compare(entry.contents) !== 0) {
          throw new Error(`Materialized file does not match Git blob or mode ${entry.relative}`);
        }
      }
    }
    chmodSync(resolvedDestination, 0o755);
    for (const entry of contextEntries(resolvedDestination)) {
      if (entry.type === "directory") {
        chmodSync(path.join(resolvedDestination, ...entry.relative.split("/")), 0o755);
      }
    }

    for (const required of [".dockerignore", "Dockerfile", "Dockerfile.agent", "package.json", "package-lock.json"]) {
      if (!existsSync(path.join(resolvedDestination, required))) {
        throw new Error(`Exact Git build context is missing tracked file ${required}`);
      }
    }
  } catch (error) {
    rmSync(resolvedDestination, { recursive: true, force: true });
    throw error;
  }

  const context = digestGitBuildContext(resolvedDestination);
  return {
    strategy: "git-tree-objects",
    commitSha,
    treeSha,
    contextDigest: context.digest,
    fileCount: context.fileCount
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [destination, revision = "HEAD"] = process.argv.slice(2);
  if (!destination || process.argv.length > 4) {
    console.error("Usage: node scripts/materialize-git-context.mjs <destination> [revision]");
    process.exit(2);
  }
  const evidence = materializeGitBuildContext({
    repositoryRoot: process.cwd(),
    revision,
    destination
  });
  console.log(JSON.stringify(evidence));
}
