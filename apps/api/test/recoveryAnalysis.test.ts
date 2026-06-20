import { beforeEach, describe, expect, it, vi } from "vitest";

const getContainerInspect = vi.fn();
const resolveAppContext = vi.fn();
const getRecoveryProfile = vi.fn();
const getRecoveryProfileForApp = vi.fn();

vi.mock("../src/services/docker.js", () => ({
  getContainerInspect: (...args: unknown[]) => getContainerInspect(...args)
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
}));

vi.mock("../src/services/recoveryProfiles.js", () => ({
  getRecoveryProfile: (...args: unknown[]) => getRecoveryProfile(...args),
  getRecoveryProfileForApp: (...args: unknown[]) => getRecoveryProfileForApp(...args)
}));

describe("recovery analysis", () => {
  const hostId = "00000000-0000-4000-8000-000000000001";
  const appIdentity = { kind: "standalone", containerIds: ["postgres-1"] } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveAppContext.mockResolvedValue({
      label: "postgres",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: "/srv/postgres",
      composePath: null,
      containerIds: ["postgres-1"],
      volumeNames: ["pgdata"]
    });
    getRecoveryProfile.mockResolvedValue(null);
    getRecoveryProfileForApp.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002",
      hostId,
      appIdentity,
      name: "Postgres profile",
      includePaths: ["/srv/postgres/uploads"],
      excludePatterns: ["cache/**"],
      restorePaths: {},
      preCaptureCommand: null,
      postCaptureCommand: null,
      captureMode: "hot",
      createdAt: "2026-06-15T12:00:00.000Z",
      updatedAt: "2026-06-15T12:00:00.000Z"
    });
  });

  it("summarizes persistent data and recommends stop-first for database containers", async () => {
    getContainerInspect.mockResolvedValue({
      labels: { "com.docker.compose.service": "db" },
      image: "postgres:16",
      mounts: [
        {
          type: "volume",
          name: "pgdata",
          source: "/var/lib/docker/volumes/pgdata/_data",
          destination: "/var/lib/postgresql/data",
          readOnly: false
        },
        {
          type: "bind",
          source: "/srv/postgres/conf",
          destination: "/etc/postgresql/conf.d",
          readOnly: true
        },
        {
          type: "tmpfs",
          source: null,
          destination: "/tmp",
          readOnly: false
        }
      ]
    });

    const { analyzeRecovery } = await import("../src/services/recoveryAnalysis.js");
    const analysis = await analyzeRecovery({ hostId, appIdentity });

    expect(analysis.recommendedCaptureMode).toBe("stop_first");
    expect(analysis.status).toBe("warning");
    expect(analysis.volumes).toEqual(["pgdata"]);
    expect(analysis.bindMounts).toEqual(expect.arrayContaining([
      "/srv/postgres/conf",
      "/srv/postgres",
      "/srv/postgres/uploads"
    ]));
    expect(analysis.dataMounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "volume", name: "pgdata", included: true }),
      expect.objectContaining({ type: "tmpfs", destination: "/tmp", included: false }),
      expect.objectContaining({ type: "manual", source: "/srv/postgres/uploads", included: true })
    ]));
    expect(analysis.warnings.some((warning) => warning.includes("tmpfs"))).toBe(true);
  });
});
