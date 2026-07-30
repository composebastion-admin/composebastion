import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import {
  currentRemoteMutationContext,
  normalizeRemoteMutationTimeoutMs,
  recordRemoteMutationDispatch,
  recordRemoteMutationTerminal,
  REMOTE_MUTATION_COMPLETION_GRACE_MS,
  RemoteMutationOutcomeUnknownError,
  type RemoteMutationRuntimeState,
  type RemoteMutationRuntimeStatus
} from "./remoteMutationProof.js";

export interface SshTarget {
  hostname: string;
  port: number;
  username: string;
  privateKey?: string;
  password?: string;
  passphrase?: string | null;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  code: number;
  signal?: string;
}

function validatedSshCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("SSH command cannot be empty");
  if (/[\0\r]/.test(trimmed)) throw new Error("SSH command contains invalid control characters");
  return trimmed;
}

function execValidatedSshCommand(
  client: Client,
  command: string,
  callback: (error: Error | undefined, stream: ClientChannel) => void
) {
  const safeCommand = validatedSshCommand(command);
  // Commands passed here are built by internal command builders that shell-quote untrusted arguments; this wrapper rejects control characters before invoking ssh2.
  // lgtm[js/command-line-injection]
  client.exec(safeCommand, callback);
}

function connect(target: SshTarget) {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    // ssh2 can emit more than one socket/protocol error while a failed
    // handshake is closing. Keep a sink attached for the client's full
    // lifetime; the phase-specific listener below still rejects the
    // connection with the first actionable failure.
    client.on("error", () => undefined);
    const config: ConnectConfig = {
      host: target.hostname,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey || undefined,
      password: target.password || undefined,
      passphrase: target.passphrase ?? undefined,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000
    };

    const onError = (error: Error) => {
      client.removeListener("ready", onReady);
      reject(error);
    };
    const onReady = () => {
      client.removeListener("error", onError);
      resolve(client);
    };
    client.once("ready", onReady);
    client.once("error", onError);
    client.connect(config);
  });
}

async function runSshCommandRaw(
  target: SshTarget,
  command: string,
  options: { input?: string | Buffer; timeoutMs?: number } = {}
) {
  const client = await connect(target);
  return new Promise<SshResult>((resolve, reject) => {
    let settled = false;
    let streamRef: ClientChannel | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      streamRef?.destroy();
      client.end();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timeout = setTimeout(
      () => fail(new Error(`SSH command timed out after ${options.timeoutMs ?? 120_000}ms`)),
      options.timeoutMs ?? 120_000
    );
    client.once("error", fail);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        fail(error);
        return;
      }
      if (settled) {
        stream.destroy();
        return;
      }
      streamRef = stream;

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.once("error", fail);
      stream.stderr.once("error", fail);
      stream.on("close", (code: number | null, signal?: string) => {
        if (settled) return;
        if (code === null) {
          fail(new Error(`SSH command closed without an exit status${signal ? ` (${signal})` : ""}`));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        client.removeListener("error", fail);
        client.end();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code,
          signal
        });
      });

      if (options.input) stream.end(options.input);
      else stream.end();
    });
  });
}

const REMOTE_OPERATION_HEADER = "__COMPOSEBASTION_REMOTE_OPERATION__";
const REMOTE_OPERATION_ID = /^[0-9a-f]{64}$/;

function remoteShellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function assertRemoteOperationId(operationId: string) {
  if (!REMOTE_OPERATION_ID.test(operationId)) {
    throw new Error("Remote operation id must be a 64-character lowercase hexadecimal digest");
  }
}

function remoteOperationBaseSetup(operationId: string) {
  const quotedOperationId = remoteShellQuote(operationId);
  return [
    "umask 077",
    'root="$HOME/.composebastion"',
    'base="$root/remote-operations"',
    'if [ -e "$root" ] || [ -L "$root" ]; then test -d "$root" && test ! -L "$root"; else mkdir "$root"; fi',
    'chmod 0700 "$root"',
    'if [ -e "$base" ] || [ -L "$base" ]; then test -d "$base" && test ! -L "$base"; else mkdir "$base"; fi',
    'chmod 0700 "$base"',
    `dir="$base"/${quotedOperationId}`,
    'if [ -e "$dir" ] || [ -L "$dir" ]; then test -d "$dir" && test ! -L "$dir"; else mkdir "$dir"; fi',
    'chmod 0700 "$dir"',
    `if [ -e "$dir/identity" ] || [ -L "$dir/identity" ]; then test -f "$dir/identity" && test ! -L "$dir/identity" && test "$(cat "$dir/identity")" = ${quotedOperationId}; else (umask 077; set -C; printf '%s\\n' ${quotedOperationId} > "$dir/identity"); fi`
  ];
}

function remoteOperationLivenessFunction() {
  return [
    "operation_is_live() {",
    '  test -f "$dir/pid" && test -f "$dir/pid_start" || return 1',
    '  pid=$(cat "$dir/pid")',
    '  start=$(cat "$dir/pid_start")',
    '  case "$pid:$start" in *[!0-9:]*|:|*:) return 1 ;; esac',
    '  test -r "/proc/$pid/stat" || return 1',
    '  kill -0 "$pid" 2>/dev/null || return 1',
    '  current=$(awk \'{print $22}\' "/proc/$pid/stat" 2>/dev/null || true)',
    '  test -n "$current" && test "$current" = "$start"',
    "}"
  ];
}

function remoteOperationRunnerScript() {
  return [
    "set +e",
    "dir=$1",
    "limit_seconds=$2",
    "remote_command=$3",
    "has_input=$4",
    'printf "%s\\n" "$$" > "$dir/pid.tmp" && mv "$dir/pid.tmp" "$dir/pid"',
    'if test -r "/proc/$$/stat"; then awk \'{print $22}\' "/proc/$$/stat" > "$dir/pid_start.tmp" && mv "$dir/pid_start.tmp" "$dir/pid_start"; else printf "%s\\n" unavailable > "$dir/pid_start"; fi',
    // Publish "running" only after both PID identity fields are durable. The
    // waiter must never observe a running state before it can prove liveness.
    'printf "%s\\n" running > "$dir/state.tmp" && mv "$dir/state.tmp" "$dir/state"',
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/started_at.tmp" && mv "$dir/started_at.tmp" "$dir/started_at"',
    'if test "$has_input" = 1; then',
    '  COMPOSEBASTION_REMOTE_INPUT="$dir/input" timeout -k 5s "${limit_seconds}s" sh -c "$remote_command" < "$dir/input" > "$dir/stdout" 2> "$dir/stderr"',
    "else",
    '  timeout -k 5s "${limit_seconds}s" sh -c "$remote_command" > "$dir/stdout" 2> "$dir/stderr"',
    "fi",
    "code=$?",
    'rm -f -- "$dir/input"',
    'case "$code" in 124|137) terminal_state=timed_out ;; 0) terminal_state=completed ;; *) terminal_state=failed ;; esac',
    'printf "%s\\n" "$code" > "$dir/code.tmp" && mv "$dir/code.tmp" "$dir/code"',
    'printf "%s\\n" "$terminal_state" > "$dir/state.tmp" && mv "$dir/state.tmp" "$dir/state"',
    'date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/completed_at.tmp" && mv "$dir/completed_at.tmp" "$dir/completed_at"',
    'printf "%s\\n" "$terminal_state" > "$dir/result.tmp" && mv "$dir/result.tmp" "$dir/result"'
  ].join("\n");
}

function buildDurableRemoteOperationCommand(
  operationId: string,
  command: string,
  timeoutMs: number,
  inputProof: {
    byteLength: number;
    sha256: string;
  } | null
) {
  assertRemoteOperationId(operationId);
  if (
    inputProof
    && (
      !Number.isSafeInteger(inputProof.byteLength)
      || inputProof.byteLength < 0
      || !REMOTE_OPERATION_ID.test(inputProof.sha256)
    )
  ) {
    throw new Error("Remote operation input proof is invalid");
  }
  const hasInput = inputProof !== null;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const runner = remoteOperationRunnerScript();
  return [
    "set -eu",
    ...remoteOperationBaseSetup(operationId),
    ...remoteOperationLivenessFunction(),
    'if test ! -f "$dir/result" && test ! -e "$dir/state" && test ! -e "$dir/pid" && test ! -e "$dir/input" && test ! -L "$dir/input"; then',
    "  command -v timeout >/dev/null 2>&1",
    "  command -v setsid >/dev/null 2>&1",
    "  command -v nohup >/dev/null 2>&1",
    hasInput
      ? [
          "  command -v sha256sum >/dev/null 2>&1",
          '  test ! -e "$dir/input" && test ! -L "$dir/input"',
          '  trap \'rm -f -- "$dir/input"\' 0 1 2 15',
          '  (umask 077; set -C; cat > "$dir/input")',
          '  test -f "$dir/input" && test ! -L "$dir/input"',
          '  chmod 0600 "$dir/input"',
          '  actual_bytes=$(wc -c < "$dir/input" | tr -d "[:space:]")',
          '  actual_sha256=$(sha256sum "$dir/input" | awk \'{print $1}\')',
          `  if test "$actual_bytes" != ${remoteShellQuote(String(inputProof?.byteLength))} || test "$actual_sha256" != ${remoteShellQuote(inputProof?.sha256 ?? "")}; then`,
          '    rm -f -- "$dir/input"',
          `    printf '${REMOTE_OPERATION_HEADER} %s %s\\n' proof_unavailable -1`,
          "    exit 0",
          "  fi"
        ].join("\n")
      : '  rm -f -- "$dir/input"',
    '  printf "%s\\n" dispatched > "$dir/state.tmp" && mv "$dir/state.tmp" "$dir/state"',
    // The background child is not the invoking shell's process-group leader,
    // so plain POSIX/BusyBox `setsid` can create the detached session. Avoid
    // GNU-only `setsid -f`; supported SSH Docker hosts commonly use BusyBox.
    `  setsid nohup sh -c ${remoteShellQuote(runner)} composebastion-remote-runner "$dir" ${remoteShellQuote(String(timeoutSeconds))} ${remoteShellQuote(command)} ${hasInput ? "1" : "0"} </dev/null >/dev/null 2>&1 &`,
    ...(hasInput ? ['  trap - 0 1 2 15'] : []),
    "fi",
    'if test ! -f "$dir/result" && test ! -e "$dir/state" && test ! -e "$dir/pid" && { test -e "$dir/input" || test -L "$dir/input"; }; then',
    `  printf '${REMOTE_OPERATION_HEADER} %s %s\\n' proof_unavailable -1`,
    "  exit 0",
    "fi",
    'if test ! -f "$dir/result" && test -e "$dir/state" && ! operation_is_live && test "$(cat "$dir/state")" != dispatched; then',
    '  rm -f -- "$dir/input"',
    `  printf '${REMOTE_OPERATION_HEADER} %s %s\\n' proof_unavailable -1`,
    "  exit 0",
    "fi",
    `deadline=$(( $(date +%s) + ${timeoutSeconds + Math.ceil(REMOTE_MUTATION_COMPLETION_GRACE_MS / 1_000)} ))`,
    'while test ! -f "$dir/result"; do',
    '  if test -f "$dir/state" && test "$(cat "$dir/state")" = running && ! operation_is_live; then',
    `    printf '${REMOTE_OPERATION_HEADER} %s %s\\n' proof_unavailable -1`,
    "    exit 0",
    "  fi",
    '  if test "$(date +%s)" -ge "$deadline"; then',
    `    printf '${REMOTE_OPERATION_HEADER} %s %s\\n' running -1`,
    "    exit 0",
    "  fi",
    "  sleep 1",
    "done",
    'state=$(cat "$dir/result")',
    'code=$(cat "$dir/code" 2>/dev/null || printf "%s" -1)',
    `printf '${REMOTE_OPERATION_HEADER} %s %s\\n' "$state" "$code"`,
    'cat -- "$dir/stdout" 2>/dev/null || true',
    'cat -- "$dir/stderr" >&2 2>/dev/null || true'
  ].join("\n");
}

function parseRemoteOperationResponse(
  operationId: string,
  result: SshResult
) {
  const newline = result.stdout.indexOf("\n");
  const header = (newline === -1 ? result.stdout : result.stdout.slice(0, newline)).trim();
  const match = new RegExp(
    `^${REMOTE_OPERATION_HEADER} (running|completed|failed|timed_out|missing|proof_unavailable) (-?\\d+)$`
  ).exec(header);
  if (!match) {
    throw new RemoteMutationOutcomeUnknownError(
      operationId,
      currentRemoteMutationContext()?.phase ?? "unknown",
      "ssh",
      "proof_unavailable"
    );
  }
  const state = match[1] as RemoteMutationRuntimeState;
  const code = Number(match[2]);
  return {
    state,
    result: {
      stdout: newline === -1 ? "" : result.stdout.slice(newline + 1),
      stderr: result.stderr,
      code: Number.isInteger(code) ? code : -1
    } satisfies SshResult
  };
}

function buildInspectRemoteOperationCommand(operationId: string) {
  assertRemoteOperationId(operationId);
  const quotedOperationId = remoteShellQuote(operationId);
  return [
    "set -eu",
    "umask 077",
    'root="$HOME/.composebastion"',
    'base="$root/remote-operations"',
    `if test ! -e "$root" && test ! -L "$root"; then printf '${REMOTE_OPERATION_HEADER} missing -1\\n'; exit 0; fi`,
    'test -d "$root" && test ! -L "$root"',
    `if test ! -e "$base" && test ! -L "$base"; then printf '${REMOTE_OPERATION_HEADER} missing -1\\n'; exit 0; fi`,
    'test -d "$base" && test ! -L "$base"',
    `dir="$base"/${quotedOperationId}`,
    `if test ! -e "$dir" && test ! -L "$dir"; then printf '${REMOTE_OPERATION_HEADER} missing -1\\n'; exit 0; fi`,
    'test -d "$dir" && test ! -L "$dir"',
    `if test ! -f "$dir/identity" || test -L "$dir/identity" || test "$(cat "$dir/identity")" != ${quotedOperationId}; then printf '${REMOTE_OPERATION_HEADER} proof_unavailable -1\\n'; exit 0; fi`,
    ...remoteOperationLivenessFunction(),
    'if test -f "$dir/result"; then',
    '  state=$(cat "$dir/result")',
    '  code=$(cat "$dir/code" 2>/dev/null || printf "%s" -1)',
    'elif operation_is_live; then',
    "  state=running",
    "  code=-1",
    'elif test -f "$dir/state" || test -f "$dir/pid" || test -e "$dir/input" || test -L "$dir/input"; then',
    '  rm -f -- "$dir/input"',
    "  state=proof_unavailable",
    "  code=-1",
    "else",
    "  state=missing",
    "  code=-1",
    "fi",
    `printf '${REMOTE_OPERATION_HEADER} %s %s\\n' "$state" "$code"`
  ].join("\n");
}

function buildCleanupRemoteOperationCommand(operationId: string) {
  assertRemoteOperationId(operationId);
  const quotedOperationId = remoteShellQuote(operationId);
  return [
    "set -eu",
    'root="$HOME/.composebastion"',
    'base="$root/remote-operations"',
    'if test ! -e "$root" && test ! -L "$root"; then exit 0; fi',
    'test -d "$root" && test ! -L "$root"',
    'if test ! -e "$base" && test ! -L "$base"; then exit 0; fi',
    'test -d "$base" && test ! -L "$base"',
    'dir="$base"/' + quotedOperationId,
    'if test ! -e "$dir" && test ! -L "$dir"; then exit 0; fi',
    'test -d "$dir" && test ! -L "$dir"',
    'test -f "$dir/identity" && test ! -L "$dir/identity"',
    `test "$(cat "$dir/identity")" = ${quotedOperationId}`,
    'test -f "$dir/result" && test ! -L "$dir/result"',
    'state=$(cat "$dir/result")',
    'case "$state" in completed|failed|timed_out) ;; *) exit 1 ;; esac',
    'rm -rf -- "$dir"'
  ].join("\n");
}

export async function cleanupSshRemoteOperation(
  target: SshTarget,
  operationId: string
) {
  const cleaned = await runSshCommandRaw(
    target,
    buildCleanupRemoteOperationCommand(operationId),
    { timeoutMs: 30_000 }
  );
  if (cleaned.code !== 0) {
    throw new Error(
      cleaned.stderr
      || cleaned.stdout
      || "Could not remove terminal SSH operation proof"
    );
  }
}

const SSH_REMOTE_OPERATION_SWEEP_HEADER =
  "__COMPOSEBASTION_REMOTE_OPERATION_SWEEP__";

function buildSweepTerminalRemoteOperationsCommand(
  protectedOperationIds: string[],
  options: {
    maxScanned?: number;
    maxRemoved?: number;
    graceSeconds?: number;
  } = {}
) {
  const protectedIds = [...new Set(protectedOperationIds)];
  for (const operationId of protectedIds) assertRemoteOperationId(operationId);
  const maxScanned = Math.max(1, Math.min(
    Math.floor(options.maxScanned ?? 200),
    1_000
  ));
  const maxRemoved = Math.max(1, Math.min(
    Math.floor(options.maxRemoved ?? 50),
    200
  ));
  const graceSeconds = Math.max(60, Math.min(
    Math.floor(options.graceSeconds ?? 15 * 60),
    24 * 60 * 60
  ));
  const protectedCase = protectedIds.length
    ? `    ${protectedIds.join("|")}) continue ;;`
    : "";
  const sweep = [
    "set -eu",
    'root="$HOME/.composebastion"',
    'base="$root/remote-operations"',
    'if test ! -e "$root" && test ! -L "$root"; then exit 0; fi',
    'test -d "$root" && test ! -L "$root"',
    'if test ! -e "$base" && test ! -L "$base"; then exit 0; fi',
    'test -d "$base" && test ! -L "$base"',
    "now=$(date +%s)",
    "scanned=0",
    "removed=0",
    'for dir in "$base"/*; do',
    '  if test ! -e "$dir" && test ! -L "$dir"; then continue; fi',
    '  name=${dir##*/}',
    '  case "$name" in',
    "    *[!0-9a-f]*|'') continue ;;",
    ...(protectedCase ? [protectedCase] : []),
    "  esac",
    '  test "${#name}" -eq 64 || continue',
    '  test -d "$dir" && test ! -L "$dir" || continue',
    '  test -f "$dir/identity" && test ! -L "$dir/identity" || continue',
    '  test "$(cat "$dir/identity" 2>/dev/null || true)" = "$name" || continue',
    '  test -f "$dir/result" && test ! -L "$dir/result" || continue',
    '  state=$(cat "$dir/result" 2>/dev/null || true)',
    '  case "$state" in completed|failed|timed_out) ;; *) continue ;; esac',
    // Count only structurally valid, unprotected terminal candidates. Large
    // protected or corrupt prefixes must not starve later orphan cleanup.
    "  scanned=$((scanned + 1))",
    `  if test "$scanned" -gt ${maxScanned}; then break; fi`,
    '  modified=$(stat -c %Y "$dir/result" 2>/dev/null || printf "%s" 0)',
    '  case "$modified" in *[!0-9]*|\'\') continue ;; esac',
    `  test "$((now - modified))" -ge ${graceSeconds} || continue`,
    // Revalidate identity and terminal state immediately before the exact
    // bounded deletion so a changing/corrupt marker fails closed.
    '  test -d "$dir" && test ! -L "$dir"',
    '  test -f "$dir/identity" && test ! -L "$dir/identity"',
    '  test "$(cat "$dir/identity")" = "$name"',
    '  test -f "$dir/result" && test ! -L "$dir/result"',
    '  state=$(cat "$dir/result")',
    '  case "$state" in completed|failed|timed_out) ;; *) continue ;; esac',
    '  rm -rf -- "$dir"',
    `  printf '${SSH_REMOTE_OPERATION_SWEEP_HEADER} %s\\n' "$name"`,
    "  removed=$((removed + 1))",
    `  if test "$removed" -ge ${maxRemoved}; then break; fi`,
    "done"
  ].join("\n");
  return [
    "command -v timeout >/dev/null 2>&1",
    "command -v stat >/dev/null 2>&1",
    `timeout -k 5s 30s sh -c ${remoteShellQuote(sweep)}`
  ].join("\n");
}

export async function sweepSshTerminalRemoteOperations(
  target: SshTarget,
  protectedOperationIds: string[],
  options: {
    maxScanned?: number;
    maxRemoved?: number;
    graceSeconds?: number;
  } = {}
) {
  if (protectedOperationIds.length > 1_000) {
    throw new Error(
      "Too many protected remote-operation ids to perform a bounded sweep"
    );
  }
  const result = await runSshCommandRaw(
    target,
    buildSweepTerminalRemoteOperationsCommand(
      protectedOperationIds,
      options
    ),
    { timeoutMs: 45_000 }
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr
      || result.stdout
      || "Could not sweep terminal SSH operation proofs"
    );
  }
  const removedOperationIds = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${SSH_REMOTE_OPERATION_SWEEP_HEADER} `))
    .map((line) => line.slice(SSH_REMOTE_OPERATION_SWEEP_HEADER.length + 1))
    .filter((operationId) => REMOTE_OPERATION_ID.test(operationId));
  return {
    removed: removedOperationIds.length,
    operationIds: removedOperationIds
  };
}

export async function inspectSshRemoteOperation(
  target: SshTarget,
  operationId: string
): Promise<RemoteMutationRuntimeStatus> {
  const result = await runSshCommandRaw(
    target,
    buildInspectRemoteOperationCommand(operationId),
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Could not inspect the remote SSH operation");
  }
  const parsed = parseRemoteOperationResponse(operationId, result);
  return {
    operationId,
    state: parsed.state,
    code: parsed.result.code
  };
}

export async function runSshCommand(
  target: SshTarget,
  command: string,
  options: { input?: string | Buffer; timeoutMs?: number } = {}
) {
  const context = currentRemoteMutationContext();
  if (!context) return runSshCommandRaw(target, command, options);

  const timeoutMs = await recordRemoteMutationDispatch(
    context,
    "ssh",
    normalizeRemoteMutationTimeoutMs(options.timeoutMs)
  );
  let result: SshResult;
  try {
    const inputProof = options.input === undefined
      ? null
      : {
          byteLength: Buffer.byteLength(options.input),
          sha256: createHash("sha256").update(options.input).digest("hex")
        };
    result = await runSshCommandRaw(
      target,
      buildDurableRemoteOperationCommand(
        context.operationId,
        command,
        timeoutMs,
        inputProof
      ),
      {
        input: options.input,
        timeoutMs: timeoutMs + REMOTE_MUTATION_COMPLETION_GRACE_MS
      }
    );
  } catch (error) {
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "ssh",
      "transport_lost",
      error
    );
  }
  if (result.code !== 0) {
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "ssh",
      "proof_unavailable",
      new Error(result.stderr || result.stdout || "Remote SSH operation supervisor failed")
    );
  }
  const parsed = parseRemoteOperationResponse(context.operationId, result);
  if (
    parsed.state === "running"
    || parsed.state === "missing"
    || parsed.state === "proof_unavailable"
  ) {
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "ssh",
      parsed.state
    );
  }
  await recordRemoteMutationTerminal(context, parsed.state);
  await cleanupSshRemoteOperation(
    target,
    context.operationId
  ).catch(() => undefined);
  if (parsed.state === "timed_out") {
    throw new RemoteMutationOutcomeUnknownError(
      context.operationId,
      context.phase,
      "ssh",
      parsed.state
    );
  }
  return parsed.result;
}

export const sshRemoteOperationInternals = {
  buildAtomicRemoteFileWriteCommand,
  buildDurableRemoteOperationCommand,
  buildCleanupRemoteOperationCommand,
  buildInspectRemoteOperationCommand,
  buildSweepTerminalRemoteOperationsCommand,
  parseRemoteOperationResponse
};

export async function streamSshCommandLines(
  target: SshTarget,
  command: string,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
  options: { preserveLineFormatting?: boolean } = {}
) {
  const client = await connect(target);
  return new Promise<() => void>((resolve, reject) => {
    let streamRef: ClientChannel | null = null;
    let buffer = "";
    let settled = false;
    let promiseResolved = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      client.removeListener("error", handleClientError);
      streamRef?.destroy();
      client.end();
    };
    const handleClientError = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      onError(failure);
      cleanup();
      if (!promiseResolved) reject(failure);
    };
    const handleStreamError = (error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
      cleanup();
    };
    client.once("error", handleClientError);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        cleanup();
        reject(error);
        return;
      }
      if (settled) {
        stream.destroy();
        return;
      }

      streamRef = stream;
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (options.preserveLineFormatting) {
            onLine(line);
            continue;
          }
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        const message = chunk.toString("utf8").trim();
        if (message) onError(new Error(message));
      });
      stream.once("error", handleStreamError);
      stream.stderr.once("error", handleStreamError);
      stream.once("close", cleanup);
      promiseResolved = true;
      resolve(cleanup);
    });
  });
}

function buildAtomicRemoteFileWriteCommand(remotePath: string) {
  if (/[\0\r]/.test(remotePath)) {
    throw new Error("Remote file path contains invalid control characters");
  }
  const parent = path.posix.dirname(remotePath);
  const basename = path.posix.basename(remotePath);
  if (!basename || basename === "." || basename === "..") {
    throw new Error("Remote file path must name a file");
  }
  const target = remoteShellQuote(remotePath);
  const parentPath = remoteShellQuote(parent);
  const temporaryTemplate = remoteShellQuote(
    path.posix.join(parent, `.${basename}.composebastion.XXXXXX`)
  );
  return [
    "set -eu",
    `target=${target}`,
    `parent=${parentPath}`,
    'test -d "$parent" && test ! -L "$parent"',
    'if test -e "$target" || test -L "$target"; then test -f "$target" && test ! -L "$target"; fi',
    `tmp=$(mktemp ${temporaryTemplate})`,
    'trap \'rm -f -- "$tmp"\' 0 1 2 15',
    'test -f "$tmp" && test ! -L "$tmp"',
    'cat > "$tmp"',
    'chmod 0600 "$tmp"',
    'test -f "$tmp" && test ! -L "$tmp"',
    // `-T` prevents a concurrent directory from turning this replacement
    // into a successful move *inside* the wrong target.
    'mv -fT -- "$tmp" "$target"',
    'trap - 0 1 2 15'
  ].join("\n");
}

export async function writeRemoteFile(target: SshTarget, remotePath: string, contents: string) {
  const context = currentRemoteMutationContext();
  if (context) {
    const result = await runSshCommand(
      target,
      buildAtomicRemoteFileWriteCommand(remotePath),
      {
        input: contents,
        timeoutMs: 120_000
      }
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr
        || result.stdout
        || "Could not atomically write the remote file"
      );
    }
    return;
  }
  const client = await connect(target);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error("SSH file write timed out after 120000ms"));
    }, 120_000);
    let sftpRef: { once: (event: "error", handler: (error: unknown) => void) => unknown; removeListener: (event: "error", handler: (error: unknown) => void) => unknown } | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.removeListener("error", fail);
      sftpRef?.removeListener("error", fail);
      client.end();
      const normalized = error instanceof Error ? error : new Error(String(error));
      reject(normalized);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.removeListener("error", fail);
      sftpRef?.removeListener("error", fail);
      client.end();
      if (error !== undefined) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve();
    };
    client.once("error", fail);
    client.sftp((sftpError, sftp) => {
      if (settled) return;
      if (sftpError) {
        fail(sftpError);
        return;
      }
      sftpRef = sftp;
      sftp.once("error", fail);

      sftp.writeFile(remotePath, contents, { mode: 0o600 }, (writeError) => {
        if (settled) return;
        if (writeError) {
          finish(writeError);
          return;
        }
        finish();
      });
    });
  });
}

export async function readRemoteFile(target: SshTarget, remotePath: string, maxBytes = 512 * 1024) {
  const client = await connect(target);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let sftpRef: { once: (event: "error", handler: (error: unknown) => void) => unknown; removeListener: (event: "error", handler: (error: unknown) => void) => unknown } | null = null;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      client.removeListener("error", fail);
      sftpRef?.removeListener("error", fail);
      client.end();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    client.once("error", fail);
    client.sftp((sftpError, sftp) => {
      if (settled) return;
      if (sftpError) {
        fail(sftpError);
        return;
      }
      sftpRef = sftp;
      sftp.once("error", fail);

      sftp.stat(remotePath, (statError, stats) => {
        if (settled) return;
        if (statError) {
          fail(statError);
          return;
        }
        if (stats.size > maxBytes) {
          fail(new Error(`File is too large to edit in-browser (${stats.size} bytes, limit ${maxBytes} bytes)`));
          return;
        }

        sftp.readFile(remotePath, (readError, data) => {
          if (settled) return;
          if (readError) {
            fail(readError);
            return;
          }
          settled = true;
          client.removeListener("error", fail);
          sftp.removeListener("error", fail);
          client.end();
          resolve(data.toString("utf8"));
        });
      });
    });
  });
}

export async function streamSshCommandToFile(
  target: SshTarget,
  command: string,
  localPath: string,
  timeoutMs = 10 * 60_000,
  outputTransform?: NodeJS.ReadWriteStream | null
) {
  await mkdir(path.dirname(localPath), { recursive: true });
  const client = await connect(target);

  return new Promise<{ stderr: string; sizeBytes: number }>((resolve, reject) => {
    let settled = false;
    const file = createWriteStream(localPath);
    const stderr: Buffer[] = [];
    let timeout: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      file.destroy();
      client.end();
      reject(error);
    };
    const fileFinished = new Promise<void>((finishResolve) => {
      file.once("finish", finishResolve);
    });
    timeout = setTimeout(() => {
      fail(new Error(`SSH stream timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    file.on("error", fail);
    client.once("error", fail);

    execValidatedSshCommand(client, command, (error, stream) => {
      if (error) {
        fail(error);
        return;
      }
      if (settled) {
        stream.destroy();
        return;
      }

      const output = outputTransform ? stream.pipe(outputTransform) : stream;
      output.pipe(file);
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("error", fail);
      stream.stderr.on("error", fail);
      outputTransform?.on("error", fail);
      stream.on("close", async (code: number | null) => {
        if (settled) return;
        if (code === null) {
          fail(new Error("SSH stream closed without an exit status"));
          return;
        }
        if (code !== 0) {
          fail(new Error(Buffer.concat(stderr).toString("utf8") || `SSH stream failed with code ${code}`));
          return;
        }
        try {
          await fileFinished;
          settled = true;
          clearTimeout(timeout);
          client.removeListener("error", fail);
          client.end();
          const stats = await stat(localPath);
          resolve({ stderr: Buffer.concat(stderr).toString("utf8"), sizeBytes: stats.size });
        } catch (finishError) {
          fail(finishError instanceof Error ? finishError : new Error(String(finishError)));
        }
      });
    });
  });
}

export interface SshShellSession {
  write: (data: Buffer | string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  onData: (handler: (chunk: Buffer) => void) => void;
  onClose: (handler: () => void) => void;
  onError: (handler: (error: Error) => void) => void;
}

export async function openSshShell(
  target: SshTarget,
  options: { cols?: number; rows?: number; term?: string } = {}
): Promise<SshShellSession> {
  const client = await connect(target);
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const term = options.term ?? "xterm-256color";

  return new Promise((resolve, reject) => {
    let streamRef: ClientChannel | null = null;
    let resolved = false;
    let closed = false;
    let terminalError: Error | null = null;
    const errorHandlers = new Set<(error: Error) => void>();
    const close = () => {
      if (closed) return;
      closed = true;
      client.removeListener("error", handleFailure);
      streamRef?.close();
      client.end();
    };
    const handleFailure = (error: unknown) => {
      if (closed) return;
      terminalError = error instanceof Error ? error : new Error(String(error));
      for (const handler of errorHandlers) handler(terminalError);
      if (!resolved) {
        closed = true;
        client.removeListener("error", handleFailure);
        client.end();
        reject(terminalError);
        return;
      }
      close();
    };
    client.once("error", handleFailure);
    client.shell({ cols, rows, term }, (error, stream) => {
      if (error) {
        handleFailure(error);
        return;
      }
      if (closed) {
        stream.destroy();
        return;
      }

      streamRef = stream;
      stream.once("error", handleFailure);

      resolved = true;
      resolve({
        write: (data) => stream.write(data),
        resize: (width, height) => stream.setWindow(height, width, 0, 0),
        close,
        onData: (handler) => stream.on("data", handler),
        onClose: (handler) => {
          stream.on("close", handler);
          client.on("close", handler);
        },
        onError: (handler) => {
          errorHandlers.add(handler);
          if (terminalError) queueMicrotask(() => handler(terminalError!));
        }
      });
    });
  });
}

export async function pipeReadableToSshCommand(
  target: SshTarget,
  input: NodeJS.ReadableStream,
  command: string,
  timeoutMs = 10 * 60_000
) {
  const client = await connect(target);
  return new Promise<SshResult>((resolve, reject) => {
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if ("destroy" in input && typeof input.destroy === "function") input.destroy();
      client.end();
      reject(new Error(`SSH restore stream timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if ("destroy" in input && typeof input.destroy === "function") input.destroy();
      client.end();
      reject(error);
    };

    input.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    client.once("error", fail);

    client.exec(command, (error, stream) => {
      if (error) {
        fail(error);
        return;
      }
      if (settled) {
        stream.destroy();
        return;
      }

      input.pipe(stream);
      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.on("error", fail);
      stream.stderr.on("error", fail);
      stream.on("close", (code: number | null, signal?: string) => {
        if (settled) return;
        if (code === null) {
          fail(new Error(`SSH restore stream closed without an exit status${signal ? ` (${signal})` : ""}`));
          return;
        }
        settled = true;
        clearTimeout(timeout);
        client.removeListener("error", fail);
        client.end();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code,
          signal
        });
      });
    });
  });
}

export async function pipeFileToSshCommand(target: SshTarget, localPath: string, command: string, timeoutMs = 10 * 60_000) {
  return pipeReadableToSshCommand(target, createReadStream(localPath), command, timeoutMs);
}
