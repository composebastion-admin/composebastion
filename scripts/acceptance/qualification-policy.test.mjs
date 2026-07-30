import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceNonqualifyingReasons,
  acceptanceOwnsDockerResource,
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

test("cleanup owns recovery-labeled resources in the isolated workload namespace", () => {
  const input = {
    projectNames: [
      "composebastion-acceptance-46000-fresh"
    ],
    workloadPrefix: "cbacceptance46000"
  };
  assert.equal(acceptanceOwnsDockerResource({
    ...input,
    project: "composebastion-acceptance-46000-fresh",
    name: "postgres"
  }), true);
  assert.equal(acceptanceOwnsDockerResource({
    ...input,
    project: "",
    name: "cbacceptance46000clone_database-data"
  }), true);
  assert.equal(acceptanceOwnsDockerResource({
    ...input,
    project: "cbacceptance46000clone-restore-abcd",
    name: "acceptance-net"
  }), true);
  assert.equal(acceptanceOwnsDockerResource({
    ...input,
    project: "",
    name: "customer-production-data"
  }), false);
  assert.equal(acceptanceOwnsDockerResource({
    ...input,
    project: "",
    name: "customer-cbacceptance46000-data"
  }), false);
});
