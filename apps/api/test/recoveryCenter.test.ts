import { describe, expect, it } from "vitest";
import { buildMigrationPlan } from "../src/services/recoveryCenter.js";

describe("recovery center planning", () => {
  it("builds a migration plan with warnings and artifact estimates", () => {
    const plan = buildMigrationPlan(
      {
        sourceHostId: "00000000-0000-4000-8000-000000000001",
        targetHostId: "00000000-0000-4000-8000-000000000002",
        sourceAppIdentity: { kind: "compose", projectName: "demoapp" },
        createRecoveryPoint: true
      },
      {
        label: "Demo App",
        projectName: "demoapp",
        stackId: "00000000-0000-4000-8000-000000000003",
        composeYaml: "services:\n  web:\n    image: nginx:alpine\n",
        env: "FOO=bar\n",
        workingDir: "/srv/demoapp",
        composePath: "docker-compose.yml",
        containerIds: ["web"],
        volumeNames: ["demoapp_data"]
      }
    );

    expect(plan.steps.map((step) => step.id)).toEqual(["capture", "transfer", "deploy", "verify"]);
    expect(plan.estimatedArtifacts).toBe(5);
    expect(plan.estimatedHostFolders).toBe(1);
    expect(plan.warnings).toContain("Compose working directory /srv/demoapp will be captured and recreated on the target at the same path.");
  });
});
