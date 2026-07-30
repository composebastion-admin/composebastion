import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceNonqualifyingReasons,
  cleanupEmptyFields,
  cleanupEvidenceFailures,
  cleanupTrueFields,
  composeProjectImageListArguments,
  ownedCandidateImageTags,
  requireImageComposeProject
} from "./qualification-policy.mjs";

function passingCleanup() {
  return {
    ...Object.fromEntries(cleanupTrueFields.map((field) => [field, true])),
    ...Object.fromEntries(cleanupEmptyFields.map((field) => [field, []]))
  };
}

test("keep is always a release-nonqualifying acceptance option", () => {
  const reasons = acceptanceNonqualifyingReasons({
    worktreeDirty: false,
    skipBuild: false,
    skipUpgrade: false,
    allowNonqualifying: false,
    keep: true
  });
  assert.deepEqual(reasons, [
    "Disposable acceptance infrastructure was retained with --keep; this report cannot qualify a release"
  ]);
});

test("cleanup evidence fails closed for residual state and omitted checks", () => {
  const cleanup = passingCleanup();
  cleanup.verified = false;
  cleanup.volumes = ["composebastion-acceptance-19000-fresh_postgres-data"];
  assert.deepEqual(cleanupEvidenceFailures(cleanup), [
    "cleanup.verified is not true",
    "cleanup.volumes is not empty"
  ]);
});

test("complete empty cleanup evidence passes", () => {
  assert.deepEqual(cleanupEvidenceFailures(passingCleanup()), []);
});

test("candidate tags bind both commit and isolated port", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(ownedCandidateImageTags({ revision, portBase: 19000 }), {
    app: `composebastion-pq-app:${revision}-19000`,
    agent: `composebastion-pq-agent:${revision}-19000`
  });
});

test("image ownership uses supported list fields and inspected Compose labels", () => {
  assert.deepEqual(composeProjectImageListArguments, [
    "image",
    "ls",
    "--no-trunc",
    "--filter",
    "label=com.docker.compose.project",
    "--format",
    "{{.ID}}\t{{.Repository}}:{{.Tag}}"
  ]);
  assert.equal(
    requireImageComposeProject({
      Config: { Labels: { "com.docker.compose.project": "composebastion-acceptance-41700-fresh" } }
    }),
    "composebastion-acceptance-41700-fresh"
  );
  assert.throws(
    () => requireImageComposeProject({ Config: { Labels: {} } }),
    /inspected project label is missing/
  );
  assert.throws(() => requireImageComposeProject(null), /inspected project label is missing/);
});
