export const acceptanceScenarioManifest = Object.freeze([
  {
    id: "candidate-images",
    name: "Candidate runtime image build",
    requiredEvidence: [
      "contextIdentity",
      "treeSha",
      "contextDigest",
      "app.id",
      "app.version",
      "app.revision",
      "app.created",
      "agent.id",
      "agent.version",
      "agent.revision",
      "agent.created"
    ]
  },
  {
    id: "fresh-image-install",
    name: "Fresh production-image installation and recovery",
    requiredEvidence: [
      "productionImageCompose",
      "firstRunSetup",
      "loginSession",
      "operationsReadiness",
      "about.aboutBundle",
      "mail.testNotification",
      "mail.workerNotification",
      "roles.viewerForbidden",
      "registry.operatorSavedPrivateRegistry",
      "registry.unsavedPrivateRegistryBlocked",
      "agent.usageSnapshot",
      "agent.sustainedUsageStream",
      "workerReliability.absentWorkerFailedReadiness",
      "workerReliability.redisDatabasePollingCompleted",
      "workerReliability.redisDiagnosticRecovered",
      "leaseRecovery.recoveredAttempt",
      "workload.namedVolumes",
      "workload.allowedBindMount",
      "workload.database",
      "workload.customNetwork",
      "workload.staticAddresses",
      "workload.volumeMarker",
      "workload.volumeMarkerSeededAfterDeploy",
      "targets.s3Connection",
      "targets.smbConnection",
      "recovery.remoteOnlyVerified",
      "recovery.verificationStateVerified",
      "recovery.restoredDataVerified",
      "recovery.exactVolumeMarkerRestored",
      "recovery.restoredNetworkBehaviorVerified",
      "recovery.cleanupVerified"
    ]
  },
  {
    id: "source-production-install",
    name: "Fresh source-build production installation",
    requiredEvidence: [
      "productionSourceCompose",
      "exactGitContext",
      "treeSha",
      "runtimeVersion",
      "firstRunSetup",
      "loginSession",
      "configurationWrite",
      "backupWrite"
    ]
  },
  {
    id: "public-upgrade",
    name: "Upgrade from public 1.0.6 with state preservation",
    requiredEvidence: [
      "from",
      "to",
      "publicImage.id",
      "publicImage.repoDigest",
      "preservedConfiguration",
      "preservedEncryptedConfiguration",
      "preservedDatabase",
      "preservedCompletedJob",
      "preservedQueuedJob",
      "workerMigrationHealthy"
    ]
  }
]);
