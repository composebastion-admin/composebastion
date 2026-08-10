import path from "node:path";
import { shQuote } from "./commands.js";

export const RESTORE_OWNER_MARKER_SUFFIX =
  ".composebastion-restore-owner";
export const RESTORE_OWNER_FILE = "owner";
export const RESTORE_TARGET_IDENTITY_FILE = "target-identity";
export const RESTORE_PARENT_IDENTITY_FILE = "parent-identity";
export const RESTORE_MARKER_IDENTITY_FILE = "marker-identity";
export const RESTORE_TRUSTED_ROOT_FILE = "trusted-root";

const SAFETY_REFUSAL_EXIT_CODES = new Set([
  73,
  74,
  75,
  76,
  77,
  78,
  79
]);

export function isOwnedRemoteDirectorySafetyRefusal(code: number) {
  return SAFETY_REFUSAL_EXIT_CODES.has(code);
}

export function assertSafeOwnedRemoteDirectoryPath(value: string) {
  const raw = value.trim().replace(/\/+$/, "");
  const normalized = path.posix.normalize(raw);
  if (
    !raw.startsWith("/")
    || raw === "/"
    || raw.split("/").some((part) => part === "..")
    || normalized !== raw
  ) {
    throw new Error(
      "Attempt-owned remote directory must be a canonical absolute non-root path"
    );
  }
  return normalized;
}

function assertSafeAttemptToken(value: string) {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) {
    throw new Error("Restore attempt token is unsafe for a quarantine path");
  }
  return value;
}

export function ownedRemoteDirectoryMarkerPaths(targetPath: string) {
  const target = assertSafeOwnedRemoteDirectoryPath(targetPath);
  const markerPath = `${target}${RESTORE_OWNER_MARKER_SUFFIX}`;
  return {
    target,
    parentPath: path.posix.dirname(target),
    markerPath,
    ownerPath: path.posix.join(markerPath, RESTORE_OWNER_FILE),
    targetIdentityPath: path.posix.join(
      markerPath,
      RESTORE_TARGET_IDENTITY_FILE
    ),
    parentIdentityPath: path.posix.join(
      markerPath,
      RESTORE_PARENT_IDENTITY_FILE
    ),
    markerIdentityPath: path.posix.join(
      markerPath,
      RESTORE_MARKER_IDENTITY_FILE
    ),
    trustedRootPath: path.posix.join(
      markerPath,
      RESTORE_TRUSTED_ROOT_FILE
    )
  };
}

function trustedAncestorCheck(
  startPath: string,
  failureMessage: string,
  shellExpression = false
) {
  return [
    `restore_probe=${shellExpression ? startPath : shQuote(startPath)};`,
    "while :; do",
    `if [ ! -d "$restore_probe" ] || [ -L "$restore_probe" ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 76; fi;`,
    "restore_real=\"$(readlink -f -- \"$restore_probe\")\" || exit 76;",
    `if [ "$restore_real" != "$restore_probe" ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 76; fi;`,
    "restore_permissions=\"$(stat -c '%A' -- \"$restore_probe\")\" || exit 76;",
    "restore_untrusted_write=\"$(printf '%s' \"$restore_permissions\" | cut -c 6,9)\";",
    `case "$restore_untrusted_write" in *w*) printf '%s\\n' ${shQuote(
      `${failureMessage}; group/other-writable ancestry is not trusted`
    )} >&2; exit 78 ;; esac;`,
    `if [ "$restore_probe" = "/" ]; then break; fi;`,
    "restore_probe=\"$(dirname -- \"$restore_probe\")\";",
    "done"
  ].join(" ");
}

function markerValidation(
  markerPath: string,
  expectedOwner: string,
  expectedTarget: string,
  failureMessage: string
) {
  const ownerPath = path.posix.join(
    markerPath,
    RESTORE_OWNER_FILE
  );
  const targetIdentityPath = path.posix.join(
    markerPath,
    RESTORE_TARGET_IDENTITY_FILE
  );
  const parentIdentityPath = path.posix.join(
    markerPath,
    RESTORE_PARENT_IDENTITY_FILE
  );
  const markerIdentityPath = path.posix.join(
    markerPath,
    RESTORE_MARKER_IDENTITY_FILE
  );
  const trustedRootPath = path.posix.join(
    markerPath,
    RESTORE_TRUSTED_ROOT_FILE
  );
  const requiredFiles = [
    ownerPath,
    targetIdentityPath,
    parentIdentityPath,
    markerIdentityPath,
    trustedRootPath
  ];
  return [
    `if [ ! -d ${shQuote(markerPath)} ] || [ -L ${shQuote(markerPath)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 73; fi;`,
    ...requiredFiles.map((file) =>
      `if [ ! -f ${shQuote(file)} ] || [ -L ${shQuote(file)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 73; fi;`
    ),
    `restore_owner="$(cat -- ${shQuote(ownerPath)})" || exit 73;`,
    `restore_target_identity="$(cat -- ${shQuote(targetIdentityPath)})" || exit 73;`,
    `restore_parent_identity="$(cat -- ${shQuote(parentIdentityPath)})" || exit 73;`,
    `restore_marker_identity="$(cat -- ${shQuote(markerIdentityPath)})" || exit 73;`,
    `restore_trusted_root="$(cat -- ${shQuote(trustedRootPath)})" || exit 73;`,
    `if [ "$restore_owner" != ${shQuote(expectedOwner)} ] || [ "$restore_trusted_root" != ${shQuote(expectedTarget)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 73; fi;`,
    `restore_current_marker_identity="$(stat -c '%d:%i' -- ${shQuote(markerPath)})" || exit 73;`,
    `if [ "$restore_current_marker_identity" != "$restore_marker_identity" ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 77; fi`
  ].join(" ");
}

function markerBaseValidation(
  markerPath: string,
  expectedOwner: string,
  expectedTarget: string,
  failureMessage: string
) {
  const ownerPath = path.posix.join(markerPath, RESTORE_OWNER_FILE);
  const parentIdentityPath = path.posix.join(
    markerPath,
    RESTORE_PARENT_IDENTITY_FILE
  );
  const markerIdentityPath = path.posix.join(
    markerPath,
    RESTORE_MARKER_IDENTITY_FILE
  );
  const trustedRootPath = path.posix.join(
    markerPath,
    RESTORE_TRUSTED_ROOT_FILE
  );
  return [
    `if [ ! -d ${shQuote(markerPath)} ] || [ -L ${shQuote(markerPath)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 73; fi;`,
    ...[
      ownerPath,
      parentIdentityPath,
      markerIdentityPath,
      trustedRootPath
    ].map((file) =>
      `if [ ! -f ${shQuote(file)} ] || [ -L ${shQuote(file)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 73; fi;`
    ),
    `restore_owner="$(cat -- ${shQuote(ownerPath)})" || exit 73;`,
    `restore_parent_identity="$(cat -- ${shQuote(parentIdentityPath)})" || exit 73;`,
    `restore_marker_identity="$(cat -- ${shQuote(markerIdentityPath)})" || exit 73;`,
    `restore_trusted_root="$(cat -- ${shQuote(trustedRootPath)})" || exit 73;`,
    `if [ "$restore_owner" != ${shQuote(expectedOwner)} ] || [ "$restore_trusted_root" != ${shQuote(expectedTarget)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 73; fi;`,
    `restore_current_marker_identity="$(stat -c '%d:%i' -- ${shQuote(markerPath)})" || exit 73;`,
    `if [ "$restore_current_marker_identity" != "$restore_marker_identity" ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 77; fi`
  ].join(" ");
}

function attemptOwnedDirectoryPaths(
  targetPath: string,
  attemptTokenInput: string
) {
  const paths = ownedRemoteDirectoryMarkerPaths(targetPath);
  const attemptToken = assertSafeAttemptToken(attemptTokenInput);
  const acquisitionMarker =
    `${paths.markerPath}.acquire-${attemptToken}`;
  return {
    ...paths,
    attemptToken,
    acquisitionMarker,
    acquisitionBuild: `${acquisitionMarker}.building`,
    stagingTarget: `${paths.target}.acquire-${attemptToken}`,
    targetQuarantine:
      `${paths.target}.composebastion-delete-${attemptToken}`,
    markerQuarantine:
      `${paths.markerPath}.composebastion-delete-${attemptToken}`,
    acquisitionQuarantine:
      `${acquisitionMarker}.composebastion-delete`,
    acquisitionBuildQuarantine:
      `${acquisitionMarker}.building.composebastion-delete`,
    stagingQuarantine:
      `${paths.target}.acquire-${attemptToken}.composebastion-delete`
  };
}

function boundDirectoryValidation(
  directoryPath: string,
  identityExpression: string,
  failureMessage: string
) {
  return [
    `if [ ! -d ${shQuote(directoryPath)} ] || [ -L ${shQuote(directoryPath)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 77; fi;`,
    `restore_current_directory_identity="$(stat -c '%d:%i' -- ${shQuote(directoryPath)})" || exit 77;`,
    `if [ "$restore_current_directory_identity" != ${identityExpression} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 77; fi`
  ].join(" ");
}

function removeDirectoryWithoutCrossingFilesystems(directoryPath: string) {
  // GNU rm has --one-file-system, but supported lightweight SSH hosts often
  // expose BusyBox rm without it. Both GNU and BusyBox find support this
  // non-following, depth-first equivalent. A nested mount makes deletion fail
  // closed at the mountpoint instead of traversing into another filesystem.
  return `find ${shQuote(directoryPath)} -xdev -depth -delete || exit $?;`;
}

function removeBoundDirectory(
  originalPath: string,
  quarantinePath: string,
  identityExpression: string,
  failureMessage: string
) {
  return [
    `if { [ -e ${shQuote(originalPath)} ] || [ -L ${shQuote(originalPath)} ]; } && { [ -e ${shQuote(quarantinePath)} ] || [ -L ${shQuote(quarantinePath)} ]; }; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 79; fi;`,
    `if [ -e ${shQuote(originalPath)} ] || [ -L ${shQuote(originalPath)} ]; then`,
    `${boundDirectoryValidation(
      originalPath,
      identityExpression,
      failureMessage
    )};`,
    `mv -T -n -- ${shQuote(originalPath)} ${shQuote(quarantinePath)} || exit $?;`,
    `if [ -e ${shQuote(originalPath)} ] || [ -L ${shQuote(originalPath)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 79; fi;`,
    "fi;",
    `if [ -e ${shQuote(quarantinePath)} ] || [ -L ${shQuote(quarantinePath)} ]; then`,
    `${boundDirectoryValidation(
      quarantinePath,
      identityExpression,
      failureMessage
    )};`,
    removeDirectoryWithoutCrossingFilesystems(quarantinePath),
    `if [ -e ${shQuote(quarantinePath)} ] || [ -L ${shQuote(quarantinePath)} ]; then printf '%s\\n' ${shQuote(failureMessage)} >&2; exit 79; fi;`,
    "fi;"
  ].join(" ");
}

export function buildAcquireOwnedRemoteDirectoryCommand(input: {
  targetPath: string;
  ownerValue: string;
  attemptToken: string;
  label: string;
}) {
  const paths = attemptOwnedDirectoryPaths(
    input.targetPath,
    input.attemptToken
  );
  const failureMessage =
    `${input.label} has untrusted, symlinked, or writable ancestry`;
  const ownershipFailure =
    `${input.label} durable ownership identity could not be verified`;
  const cleanupInProgress =
    `${input.label} has an interrupted cleanup that must reconcile before acquisition`;
  const existingAncestorCheck = [
    `restore_probe=${shQuote(paths.parentPath)};`,
    `while [ ! -e "$restore_probe" ] && [ ! -L "$restore_probe" ] && [ "$restore_probe" != "/" ]; do restore_probe="$(dirname -- "$restore_probe")"; done;`,
    trustedAncestorCheck("\"$restore_probe\"", failureMessage, true)
  ].join(" ");
  const acquisitionTargetIdentityPath = path.posix.join(
    paths.acquisitionMarker,
    RESTORE_TARGET_IDENTITY_FILE
  );
  const buildOwnerPath = path.posix.join(
    paths.acquisitionBuild,
    RESTORE_OWNER_FILE
  );
  const buildParentIdentityPath = path.posix.join(
    paths.acquisitionBuild,
    RESTORE_PARENT_IDENTITY_FILE
  );
  const buildMarkerIdentityPath = path.posix.join(
    paths.acquisitionBuild,
    RESTORE_MARKER_IDENTITY_FILE
  );
  const buildTrustedRootPath = path.posix.join(
    paths.acquisitionBuild,
    RESTORE_TRUSTED_ROOT_FILE
  );
  const pendingTargetIdentityPath =
    `${acquisitionTargetIdentityPath}.pending-${paths.attemptToken}`;
  const cleanupPaths = [
    paths.targetQuarantine,
    paths.markerQuarantine,
    paths.acquisitionQuarantine,
    paths.acquisitionBuildQuarantine,
    paths.stagingQuarantine
  ];
  return [
    `${existingAncestorCheck};`,
    `(umask 077; mkdir -p -- ${shQuote(paths.parentPath)}) || exit $?;`,
    `${trustedAncestorCheck(paths.parentPath, failureMessage)};`,
    [
      `if [ -e ${shQuote(paths.markerPath)} ] || [ -L ${shQuote(paths.markerPath)} ]; then`,
      `${markerValidation(
        paths.markerPath,
        input.ownerValue,
        paths.target,
        ownershipFailure
      )};`,
      `if [ ! -d ${shQuote(paths.target)} ] || [ -L ${shQuote(paths.target)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `restore_target_real="$(readlink -f -- ${shQuote(paths.target)})" || exit 77;`,
      `if [ "$restore_target_real" != ${shQuote(paths.target)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `restore_current_target_identity="$(stat -c '%d:%i' -- ${shQuote(paths.target)})" || exit 77;`,
      `if [ "$restore_current_target_identity" != "$restore_target_identity" ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `if [ -e ${shQuote(paths.acquisitionMarker)} ] || [ -L ${shQuote(paths.acquisitionMarker)} ] || [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ] || [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 79; fi;`,
      "exit 0;",
      "fi;"
    ].join(" "),
    ...cleanupPaths.map((cleanupPath) =>
      `if [ -e ${shQuote(cleanupPath)} ] || [ -L ${shQuote(cleanupPath)} ]; then printf '%s\\n' ${shQuote(cleanupInProgress)} >&2; exit 79; fi;`
    ),
    [
      `if [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; then`,
      `if [ ! -d ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 73; fi;`,
      `if [ -f ${shQuote(buildOwnerPath)} ] && [ ! -L ${shQuote(buildOwnerPath)} ]; then`,
      `restore_build_owner="$(cat -- ${shQuote(buildOwnerPath)})" || exit 73;`,
      `if [ "$restore_build_owner" != ${shQuote(input.ownerValue)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 73; fi;`,
      "else",
      `if find ${shQuote(paths.acquisitionBuild)} -mindepth 1 -print -quit | grep -q .; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 73; fi;`,
      "fi;",
      `if [ -e ${shQuote(paths.target)} ] || [ -L ${shQuote(paths.target)} ] || [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `restore_build_identity="$(stat -c '%d:%i' -- ${shQuote(paths.acquisitionBuild)})" || exit 77;`,
      `mv -T -n -- ${shQuote(paths.acquisitionBuild)} ${shQuote(paths.acquisitionBuildQuarantine)} || exit $?;`,
      `if [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 79; fi;`,
      `restore_current_build_identity="$(stat -c '%d:%i' -- ${shQuote(paths.acquisitionBuildQuarantine)})" || exit 77;`,
      `if [ "$restore_current_build_identity" != "$restore_build_identity" ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      removeDirectoryWithoutCrossingFilesystems(
        paths.acquisitionBuildQuarantine
      ),
      "fi;"
    ].join(" "),
    [
      `if [ ! -e ${shQuote(paths.acquisitionMarker)} ] && [ ! -L ${shQuote(paths.acquisitionMarker)} ]; then`,
      `if [ -e ${shQuote(paths.target)} ] || [ -L ${shQuote(paths.target)} ] || [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(
        `${input.label} already exists or is reserved by another restore attempt`
      )} >&2; exit 73; fi;`,
      `mkdir -m 700 -- ${shQuote(paths.acquisitionBuild)} || exit $?;`,
      `restore_parent_identity="$(stat -c '%d:%i' -- ${shQuote(paths.parentPath)})" || exit 75;`,
      `restore_marker_identity="$(stat -c '%d:%i' -- ${shQuote(paths.acquisitionBuild)})" || exit 75;`,
      [
        "(umask 077",
        `printf '%s\\n' ${shQuote(input.ownerValue)} > ${shQuote(buildOwnerPath)}`,
        `printf '%s\\n' "$restore_parent_identity" > ${shQuote(buildParentIdentityPath)}`,
        `printf '%s\\n' "$restore_marker_identity" > ${shQuote(buildMarkerIdentityPath)}`,
        `printf '%s\\n' ${shQuote(paths.target)} > ${shQuote(buildTrustedRootPath)}`,
        ") || { printf '%s\\n' 'Failed to persist restore directory reservation; refusing destructive cleanup' >&2; exit 75; };"
      ].join("; "),
      `${markerBaseValidation(
        paths.acquisitionBuild,
        input.ownerValue,
        paths.target,
        ownershipFailure
      )};`,
      `mv -T -n -- ${shQuote(paths.acquisitionBuild)} ${shQuote(paths.acquisitionMarker)} || exit $?;`,
      `if [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 74; fi;`,
      "fi;"
    ].join(" "),
    `${markerBaseValidation(
      paths.acquisitionMarker,
      input.ownerValue,
      paths.target,
      ownershipFailure
    )};`,
    `${trustedAncestorCheck(paths.parentPath, failureMessage)};`,
    `restore_current_parent_identity="$(stat -c '%d:%i' -- ${shQuote(paths.parentPath)})" || exit 77;`,
    `if [ "$restore_current_parent_identity" != "$restore_parent_identity" ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
    [
      `if [ ! -f ${shQuote(acquisitionTargetIdentityPath)} ] || [ -L ${shQuote(acquisitionTargetIdentityPath)} ]; then`,
      `if [ -e ${shQuote(paths.target)} ] || [ -L ${shQuote(paths.target)} ]; then printf '%s\\n' ${shQuote(
        `${input.label} already exists or was created outside this attempt`
      )} >&2; exit 73; fi;`,
      `if [ ! -e ${shQuote(paths.stagingTarget)} ] && [ ! -L ${shQuote(paths.stagingTarget)} ]; then mkdir -m 700 -- ${shQuote(paths.stagingTarget)} || exit $?; fi;`,
      `if [ ! -d ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `if find ${shQuote(paths.stagingTarget)} -mindepth 1 -print -quit | grep -q .; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `restore_target_real="$(readlink -f -- ${shQuote(paths.stagingTarget)})" || exit 75;`,
      `if [ "$restore_target_real" != ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 76; fi;`,
      `restore_target_identity="$(stat -c '%d:%i' -- ${shQuote(paths.stagingTarget)})" || exit 75;`,
      `if [ -e ${shQuote(pendingTargetIdentityPath)} ] || [ -L ${shQuote(pendingTargetIdentityPath)} ]; then`,
      `if [ ! -f ${shQuote(pendingTargetIdentityPath)} ] || [ -L ${shQuote(pendingTargetIdentityPath)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `rm -f -- ${shQuote(pendingTargetIdentityPath)} || exit $?;`,
      "fi;",
      `(umask 077; printf '%s\\n' "$restore_target_identity" > ${shQuote(pendingTargetIdentityPath)}) || exit 75;`,
      `mv -T -n -- ${shQuote(pendingTargetIdentityPath)} ${shQuote(acquisitionTargetIdentityPath)} || exit $?;`,
      `if [ -e ${shQuote(pendingTargetIdentityPath)} ] || [ -L ${shQuote(pendingTargetIdentityPath)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      "else",
      `restore_target_identity="$(cat -- ${shQuote(acquisitionTargetIdentityPath)})" || exit 73;`,
      "fi;"
    ].join(" "),
    [
      `if [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then`,
      `if [ ! -d ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `restore_current_target_identity="$(stat -c '%d:%i' -- ${shQuote(paths.stagingTarget)})" || exit 77;`,
      `if [ "$restore_current_target_identity" != "$restore_target_identity" ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
      `mv -T -n -- ${shQuote(paths.stagingTarget)} ${shQuote(paths.target)} || exit $?;`,
      `if [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(
        `${input.label} appeared concurrently; refusing to overwrite it`
      )} >&2; exit 73; fi;`,
      "fi;"
    ].join(" "),
    `if [ ! -d ${shQuote(paths.target)} ] || [ -L ${shQuote(paths.target)} ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
    `restore_current_target_identity="$(stat -c '%d:%i' -- ${shQuote(paths.target)})" || exit 77;`,
    `if [ "$restore_current_target_identity" != "$restore_target_identity" ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi;`,
    `${markerValidation(
      paths.acquisitionMarker,
      input.ownerValue,
      paths.target,
      ownershipFailure
    )};`,
    `mv -T -n -- ${shQuote(paths.acquisitionMarker)} ${shQuote(paths.markerPath)} || exit $?;`,
    `if [ -e ${shQuote(paths.acquisitionMarker)} ] || [ -L ${shQuote(paths.acquisitionMarker)} ]; then printf '%s\\n' ${shQuote(
      `${input.label} durable marker appeared concurrently`
    )} >&2; exit 74; fi;`,
    `${markerValidation(
      paths.markerPath,
      input.ownerValue,
      paths.target,
      ownershipFailure
    )};`,
    `restore_current_target_identity="$(stat -c '%d:%i' -- ${shQuote(paths.target)})" || exit 77;`,
    `if [ "$restore_current_target_identity" != "$restore_target_identity" ]; then printf '%s\\n' ${shQuote(ownershipFailure)} >&2; exit 77; fi`
  ].join(" ");
}

export function buildCleanupOwnedRemoteDirectoryCommand(input: {
  targetPath: string;
  ownerValue: string;
  attemptToken: string;
  label: string;
}) {
  const paths = attemptOwnedDirectoryPaths(
    input.targetPath,
    input.attemptToken
  );
  const mismatchMessage =
    `${input.label} durable path identity changed; refusing cleanup`;
  const ancestryCheck = trustedAncestorCheck(
    paths.parentPath,
    `${input.label} parent is symlinked, non-canonical, or writable by an untrusted principal`
  );
  const validateMarker = markerValidation(
    paths.markerPath,
    input.ownerValue,
    paths.target,
    mismatchMessage
  );
  const validateQuarantinedMarker = markerValidation(
    paths.markerQuarantine,
    input.ownerValue,
    paths.target,
    mismatchMessage
  );
  const validateAcquisitionMarker = markerBaseValidation(
    paths.acquisitionMarker,
    input.ownerValue,
    paths.target,
    mismatchMessage
  );
  const validateQuarantinedAcquisitionMarker =
    markerBaseValidation(
      paths.acquisitionQuarantine,
      input.ownerValue,
      paths.target,
      mismatchMessage
    );
  const acquisitionTargetIdentityPath = path.posix.join(
    paths.acquisitionMarker,
    RESTORE_TARGET_IDENTITY_FILE
  );
  const quarantinedAcquisitionTargetIdentityPath = path.posix.join(
    paths.acquisitionQuarantine,
    RESTORE_TARGET_IDENTITY_FILE
  );
  const buildOwnerPath = path.posix.join(
    paths.acquisitionBuild,
    RESTORE_OWNER_FILE
  );
  const quarantinedBuildOwnerPath = path.posix.join(
    paths.acquisitionBuildQuarantine,
    RESTORE_OWNER_FILE
  );
  const allAttemptPaths = [
    paths.target,
    paths.markerPath,
    paths.targetQuarantine,
    paths.markerQuarantine,
    paths.acquisitionMarker,
    paths.acquisitionQuarantine,
    paths.acquisitionBuild,
    paths.acquisitionBuildQuarantine,
    paths.stagingTarget,
    paths.stagingQuarantine
  ];
  return [
    `${ancestryCheck};`,
    [
      `if { [ -e ${shQuote(paths.markerPath)} ] || [ -L ${shQuote(paths.markerPath)} ]; } && { [ -e ${shQuote(paths.markerQuarantine)} ] || [ -L ${shQuote(paths.markerQuarantine)} ]; }; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      `if [ -e ${shQuote(paths.markerPath)} ] || [ -L ${shQuote(paths.markerPath)} ]; then`,
      `${validateMarker};`,
      "restore_final_marker=original;",
      `elif [ -e ${shQuote(paths.markerQuarantine)} ] || [ -L ${shQuote(paths.markerQuarantine)} ]; then`,
      `${validateQuarantinedMarker};`,
      "restore_final_marker=quarantine;",
      "else",
      "restore_final_marker=;",
      "fi;"
    ].join(" "),
    [
      `if [ -n "$restore_final_marker" ]; then`,
      `if [ -e ${shQuote(paths.acquisitionMarker)} ] || [ -L ${shQuote(paths.acquisitionMarker)} ] || [ -e ${shQuote(paths.acquisitionQuarantine)} ] || [ -L ${shQuote(paths.acquisitionQuarantine)} ] || [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ] || [ -e ${shQuote(paths.acquisitionBuildQuarantine)} ] || [ -L ${shQuote(paths.acquisitionBuildQuarantine)} ] || [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ] || [ -e ${shQuote(paths.stagingQuarantine)} ] || [ -L ${shQuote(paths.stagingQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      `${ancestryCheck};`,
      `restore_current_parent_identity="$(stat -c '%d:%i' -- ${shQuote(paths.parentPath)})" || exit 77;`,
      `if [ "$restore_current_parent_identity" != "$restore_parent_identity" ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`,
      `${removeBoundDirectory(
        paths.target,
        paths.targetQuarantine,
        "\"$restore_target_identity\"",
        mismatchMessage
      )}`,
      `if [ -e ${shQuote(paths.markerPath)} ] || [ -L ${shQuote(paths.markerPath)} ]; then`,
      `${validateMarker};`,
      `mv -T -n -- ${shQuote(paths.markerPath)} ${shQuote(paths.markerQuarantine)} || exit $?;`,
      `if [ -e ${shQuote(paths.markerPath)} ] || [ -L ${shQuote(paths.markerPath)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      "fi;",
      `${validateQuarantinedMarker};`,
      removeDirectoryWithoutCrossingFilesystems(paths.markerQuarantine),
      `if [ -e ${shQuote(paths.markerQuarantine)} ] || [ -L ${shQuote(paths.markerQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      "fi;"
    ].join(" "),
    [
      `if { [ -e ${shQuote(paths.acquisitionMarker)} ] || [ -L ${shQuote(paths.acquisitionMarker)} ]; } && { [ -e ${shQuote(paths.acquisitionQuarantine)} ] || [ -L ${shQuote(paths.acquisitionQuarantine)} ]; }; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      `if [ -e ${shQuote(paths.acquisitionMarker)} ] || [ -L ${shQuote(paths.acquisitionMarker)} ]; then`,
      `${validateAcquisitionMarker};`,
      `restore_acquisition_target_identity_path=${shQuote(acquisitionTargetIdentityPath)};`,
      "restore_acquisition_marker=original;",
      `elif [ -e ${shQuote(paths.acquisitionQuarantine)} ] || [ -L ${shQuote(paths.acquisitionQuarantine)} ]; then`,
      `${validateQuarantinedAcquisitionMarker};`,
      `restore_acquisition_target_identity_path=${shQuote(quarantinedAcquisitionTargetIdentityPath)};`,
      "restore_acquisition_marker=quarantine;",
      "else",
      "restore_acquisition_marker=;",
      "fi;"
    ].join(" "),
    [
      `if [ -n "$restore_acquisition_marker" ]; then`,
      `${ancestryCheck};`,
      `restore_current_parent_identity="$(stat -c '%d:%i' -- ${shQuote(paths.parentPath)})" || exit 77;`,
      `if [ "$restore_current_parent_identity" != "$restore_parent_identity" ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`,
      `if [ -f "$restore_acquisition_target_identity_path" ] && [ ! -L "$restore_acquisition_target_identity_path" ]; then`,
      `restore_target_identity="$(cat -- "$restore_acquisition_target_identity_path")" || exit 73;`,
      `${removeBoundDirectory(
        paths.stagingTarget,
        paths.stagingQuarantine,
        "\"$restore_target_identity\"",
        mismatchMessage
      )}`,
      `${removeBoundDirectory(
        paths.target,
        paths.targetQuarantine,
        "\"$restore_target_identity\"",
        mismatchMessage
      )}`,
      "else",
      `if [ -e ${shQuote(paths.stagingQuarantine)} ] || [ -L ${shQuote(paths.stagingQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`,
      `if [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then`,
      `if [ ! -d ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`,
      `rmdir -- ${shQuote(paths.stagingTarget)} || { printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; };`,
      "fi;",
      `if [ -e ${shQuote(paths.target)} ] || [ -L ${shQuote(paths.target)} ] || [ -e ${shQuote(paths.targetQuarantine)} ] || [ -L ${shQuote(paths.targetQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`,
      "fi;",
      `if [ -e ${shQuote(paths.acquisitionMarker)} ] || [ -L ${shQuote(paths.acquisitionMarker)} ]; then`,
      `${validateAcquisitionMarker};`,
      `mv -T -n -- ${shQuote(paths.acquisitionMarker)} ${shQuote(paths.acquisitionQuarantine)} || exit $?;`,
      `if [ -e ${shQuote(paths.acquisitionMarker)} ] || [ -L ${shQuote(paths.acquisitionMarker)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      "fi;",
      `${validateQuarantinedAcquisitionMarker};`,
      removeDirectoryWithoutCrossingFilesystems(
        paths.acquisitionQuarantine
      ),
      `if [ -e ${shQuote(paths.acquisitionQuarantine)} ] || [ -L ${shQuote(paths.acquisitionQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      "fi;"
    ].join(" "),
    [
      `if { [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; } && { [ -e ${shQuote(paths.acquisitionBuildQuarantine)} ] || [ -L ${shQuote(paths.acquisitionBuildQuarantine)} ]; }; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      `if [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; then`,
      `if [ ! -d ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 73; fi;`,
      `if [ -f ${shQuote(buildOwnerPath)} ] && [ ! -L ${shQuote(buildOwnerPath)} ]; then`,
      `restore_build_owner="$(cat -- ${shQuote(buildOwnerPath)})" || exit 73;`,
      `if [ "$restore_build_owner" != ${shQuote(input.ownerValue)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 73; fi;`,
      "else",
      `if find ${shQuote(paths.acquisitionBuild)} -mindepth 1 -print -quit | grep -q .; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 73; fi;`,
      "fi;",
      `restore_build_identity="$(stat -c '%d:%i' -- ${shQuote(paths.acquisitionBuild)})" || exit 77;`,
      `mv -T -n -- ${shQuote(paths.acquisitionBuild)} ${shQuote(paths.acquisitionBuildQuarantine)} || exit $?;`,
      `if [ -e ${shQuote(paths.acquisitionBuild)} ] || [ -L ${shQuote(paths.acquisitionBuild)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      "else",
      `if [ -e ${shQuote(paths.acquisitionBuildQuarantine)} ] || [ -L ${shQuote(paths.acquisitionBuildQuarantine)} ]; then`,
      `if [ ! -d ${shQuote(paths.acquisitionBuildQuarantine)} ] || [ -L ${shQuote(paths.acquisitionBuildQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 73; fi;`,
      `restore_build_identity="$(stat -c '%d:%i' -- ${shQuote(paths.acquisitionBuildQuarantine)})" || exit 77;`,
      "fi;",
      "fi;",
      `if [ -e ${shQuote(paths.acquisitionBuildQuarantine)} ] || [ -L ${shQuote(paths.acquisitionBuildQuarantine)} ]; then`,
      `restore_current_build_identity="$(stat -c '%d:%i' -- ${shQuote(paths.acquisitionBuildQuarantine)})" || exit 77;`,
      `if [ "$restore_current_build_identity" != "$restore_build_identity" ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`,
      `if [ -f ${shQuote(quarantinedBuildOwnerPath)} ] && [ ! -L ${shQuote(quarantinedBuildOwnerPath)} ]; then`,
      `restore_build_owner="$(cat -- ${shQuote(quarantinedBuildOwnerPath)})" || exit 73;`,
      `if [ "$restore_build_owner" != ${shQuote(input.ownerValue)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 73; fi;`,
      "else",
      `if find ${shQuote(paths.acquisitionBuildQuarantine)} -mindepth 1 -print -quit | grep -q .; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 73; fi;`,
      "fi;",
      removeDirectoryWithoutCrossingFilesystems(
        paths.acquisitionBuildQuarantine
      ),
      `if [ -e ${shQuote(paths.acquisitionBuildQuarantine)} ] || [ -L ${shQuote(paths.acquisitionBuildQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 79; fi;`,
      "fi;"
    ].join(" "),
    `if [ -e ${shQuote(paths.stagingTarget)} ] || [ -L ${shQuote(paths.stagingTarget)} ] || [ -e ${shQuote(paths.stagingQuarantine)} ] || [ -L ${shQuote(paths.stagingQuarantine)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`,
    ...allAttemptPaths.map((candidate) =>
      `if [ -e ${shQuote(candidate)} ] || [ -L ${shQuote(candidate)} ]; then printf '%s\\n' ${shQuote(mismatchMessage)} >&2; exit 77; fi;`
    )
  ].join(" ");
}
