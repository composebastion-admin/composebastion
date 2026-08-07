export const acceptanceUpgradeBridge = Object.freeze({
  version: "1.1.4",
  releaseTag: "ghcr.io/composebastion-admin/composebastion-app:1.1.4",
  pinnedImage:
    "ghcr.io/composebastion-admin/composebastion-app@sha256:26a5504bbd94dc2a31968f2cb8a827ad707eb79849fded70445af834cf1ea8a9"
});

export const acceptanceUpgradeBaselines = Object.freeze([
  Object.freeze({
    key: "current-stable",
    scenarioId: "current-stable-upgrade",
    name: "Public 1.1.2 through 1.1.4 bridge with rollback and state preservation",
    version: "1.1.2",
    releaseTag: "ghcr.io/composebastion-admin/composebastion-app:1.1.2",
    pinnedImage:
      "ghcr.io/composebastion-admin/composebastion-app@sha256:53cceea331c04260ef30aba495ef912dc923e3636f0b5b70e66bfad02f284674",
    portOffset: 380,
    rollbackRehearsal: true,
    expectedCredentialTransition: "changed",
    expectedEnvironmentAction: "canonicalize",
    initialManagedCredential: "legacy",
    rollbackManagedCredential: "legacy"
  }),
  Object.freeze({
    key: "legacy",
    scenarioId: "legacy-upgrade",
    name: "Public 1.0.6 through 1.1.4 bridge with stale-environment canonicalization and re-upgrade",
    version: "1.0.6",
    releaseTag: "ghcr.io/composebastion-admin/composebastion-app:1.0.6",
    pinnedImage:
      "ghcr.io/composebastion-admin/composebastion-app@sha256:8bbff7cac90e0e6ec77b872f112dd52185c9033e5124e42c3e63a74f9ec42770",
    portOffset: 680,
    rollbackRehearsal: true,
    expectedCredentialTransition: "unchanged",
    expectedEnvironmentAction: "canonicalize",
    initialManagedCredential: "canonical",
    rollbackManagedCredential: "canonical"
  })
]);
