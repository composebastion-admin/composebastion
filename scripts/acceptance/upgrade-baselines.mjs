export const acceptanceUpgradeBaselines = Object.freeze([
  Object.freeze({
    key: "current-stable",
    scenarioId: "current-stable-upgrade",
    name: "Upgrade from public 1.1.2 with rollback and state preservation",
    version: "1.1.2",
    releaseTag: "ghcr.io/composebastion-admin/composebastion-app:1.1.2",
    pinnedImage:
      "ghcr.io/composebastion-admin/composebastion-app@sha256:53cceea331c04260ef30aba495ef912dc923e3636f0b5b70e66bfad02f284674",
    portOffset: 380,
    rollbackRehearsal: true
  }),
  Object.freeze({
    key: "legacy",
    scenarioId: "legacy-upgrade",
    name: "Long-hop upgrade from public 1.0.6 with credential rollback and re-upgrade",
    version: "1.0.6",
    releaseTag: "ghcr.io/composebastion-admin/composebastion-app:1.0.6",
    pinnedImage:
      "ghcr.io/composebastion-admin/composebastion-app@sha256:8bbff7cac90e0e6ec77b872f112dd52185c9033e5124e42c3e63a74f9ec42770",
    portOffset: 680,
    rollbackRehearsal: true
  })
]);
