const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RegistryTrustArtifactIdentity = {
  jobId: string;
  attemptCount: number;
};

export function registryTrustArtifactPaths(
  identity: RegistryTrustArtifactIdentity
) {
  if (!UUID.test(identity.jobId)) {
    throw new Error("Registry trust artifact ownership requires a valid job id.");
  }
  if (
    !Number.isInteger(identity.attemptCount)
    || identity.attemptCount < 1
    || identity.attemptCount > 1_000
  ) {
    throw new Error(
      "Registry trust artifact ownership requires a valid job attempt."
    );
  }
  const owner = `${identity.jobId}-${identity.attemptCount}`;
  return {
    candidatePath: `/tmp/composebastion-daemon-${owner}.json`,
    // This root-owned backup is deliberate rollback evidence. Unlike the
    // temporary candidate it is retained after a successful mutation.
    backupPath: `/etc/docker/daemon.json.composebastion-${owner}.bak`
  };
}
