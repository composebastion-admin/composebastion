import { describe, expect, it } from "vitest";
import type { DockerApp, RecoveryPointListItem } from "@composebastion/shared";
import {
  dockerAppRecoveryKey,
  dockerAppToRecoveryIdentity,
  recoveryAppLabel,
  recoveryIdentityKey,
  recoveryLocalState,
  recoveryReadinessClass,
  recoveryReadinessLabel,
  recoveryRemoteState
} from "./recovery.js";

const composeApp: DockerApp = {
  id: "app-1",
  hostId: "00000000-0000-4000-8000-000000000001",
  hostName: "Host",
  hostHostname: "host",
  name: "Demo App",
  source: "compose",
  status: "running",
  imageReferences: ["nginx:alpine"],
  ports: "8080:80",
  containerIds: ["abc"],
  primaryContainerId: "abc",
  stackId: "00000000-0000-4000-8000-000000000002",
  repositoryId: null,
  repositoryUrl: null,
  branch: null,
  projectName: "demoapp",
  sourceLink: null,
  update: { status: "up_to_date", kind: "none" },
  updatedAt: new Date(0).toISOString()
};

describe("recovery helpers", () => {
  it("maps docker apps to recovery identities", () => {
    expect(dockerAppToRecoveryIdentity(composeApp)).toEqual({
      kind: "stack",
      stackId: composeApp.stackId,
      projectName: "demoapp",
      label: "Demo App"
    });
    expect(dockerAppRecoveryKey(composeApp)).toBe(`stack:${composeApp.stackId}`);
    expect(recoveryIdentityKey({ kind: "standalone", containerIds: ["b", "a"], label: "Pair" })).toBe("standalone:a,b");
  });

  it("formats recovery readiness labels and classes", () => {
    expect(recoveryReadinessLabel("ready")).toBe("Ready");
    expect(recoveryReadinessLabel("needs_profile")).toBe("Needs profile");
    expect(recoveryReadinessClass("needs_profile")).toBe("needsProfile");
    expect(recoveryReadinessClass("blocked")).toBe("blocked");
  });

  it("derives recovery point labels and artifact states", () => {
    const point: RecoveryPointListItem = {
      id: "00000000-0000-4000-8000-000000000003",
      hostId: composeApp.hostId,
      name: "Snapshot",
      appIdentity: dockerAppToRecoveryIdentity(composeApp),
      triggerKind: "manual",
      status: "partial",
      backupTargetId: "00000000-0000-4000-8000-000000000004",
      legacyVolumeBackupId: null,
      artifactCount: 3,
      completedArtifactCount: 3,
      totalBytes: 1024,
      error: null,
      metadata: {},
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      lastDrillAt: null,
      lastDrillStatus: null,
      lastDrillError: null,
      lastSuccessfulDrillAt: null
    };
    expect(recoveryAppLabel(point)).toBe("Demo App");
    expect(recoveryLocalState(point)).toBe("partial");
    expect(recoveryRemoteState(point)).toBe("partial");
  });
});
