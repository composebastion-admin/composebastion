export const cleanupEmptyFields = Object.freeze([
  "containers",
  "images",
  "networks",
  "volumes",
  "files",
  "runtimeInputFiles",
  "backupArtifacts",
  "storageObjects",
  "candidateTags",
  "errors"
]);

export const cleanupTrueFields = Object.freeze([
  "attempted",
  "verified",
  "projectResourcesChecked",
  "workloadResourcesChecked",
  "candidateImagesChecked",
  "externalImagesChecked",
  "runtimeInputsChecked",
  "storageChecked",
  "runtimeRemoved",
  "bindRemoved"
]);

export function acceptanceNonqualifyingReasons({
  worktreeDirty,
  skipBuild,
  skipUpgrade,
  allowNonqualifying,
  keep
}) {
  const reasons = [];
  if (worktreeDirty) reasons.push("The working tree was dirty, so the built context is not identical to the recorded commit");
  if (skipBuild) reasons.push("Candidate image builds were skipped and existing local images were reused");
  if (skipUpgrade) reasons.push("The public 1.0.6 upgrade scenario was explicitly skipped");
  if (allowNonqualifying) reasons.push("Developer --allow-nonqualifying opt-out requested; this report cannot qualify a release");
  if (keep) reasons.push("Disposable acceptance infrastructure was retained with --keep; this report cannot qualify a release");
  return reasons;
}

export function cleanupEvidenceFailures(cleanup) {
  if (!cleanup || typeof cleanup !== "object" || Array.isArray(cleanup)) {
    return ["cleanup evidence is missing"];
  }
  const failures = [];
  for (const field of cleanupTrueFields) {
    if (cleanup[field] !== true) failures.push(`cleanup.${field} is not true`);
  }
  for (const field of cleanupEmptyFields) {
    if (!Array.isArray(cleanup[field])) {
      failures.push(`cleanup.${field} is not an array`);
    } else if (cleanup[field].length !== 0) {
      failures.push(`cleanup.${field} is not empty`);
    }
  }
  return failures;
}

export function ownedCandidateImageTags({ revision, portBase }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Candidate revision must be a full lowercase SHA-1");
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 64535) {
    throw new Error("Acceptance port base is outside the supported range");
  }
  return Object.freeze({
    app: `composebastion-pq-app:${revision}-${portBase}`,
    agent: `composebastion-pq-agent:${revision}-${portBase}`
  });
}
