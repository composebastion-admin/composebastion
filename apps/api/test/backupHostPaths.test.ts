import { describe, expect, it } from "vitest";
import {
  assertHostBackupPathAllowed,
  buildHostPathCaptureCommand,
  buildHostPathRestoreCommand,
  buildHostPathRestoreStateCommand,
  hostPathRestoreDecision,
  normalizeHostSourcePath,
  normalizeHostTargetPath,
  parseHostPathAllowedRoots
} from "../src/services/backupHostPaths.js";

describe("host-path backup helpers", () => {
  it("normalizes absolute host paths and rejects unsafe values", () => {
    expect(normalizeHostSourcePath("/srv/app/../data")).toBe("/srv/data");
    expect(normalizeHostTargetPath("/restore/app/")).toBe("/restore/app");

    for (const bad of ["/", "relative/path", "/srv/app\nnext", "/srv/app\0x", "/srv/app\tname"]) {
      expect(() => normalizeHostSourcePath(bad)).toThrow();
    }
  });

  it("builds quoted tar commands for capture and restore", () => {
    expect(buildHostPathCaptureCommand("/srv/app data")).toBe("tar czf - -C '/srv/app data' .");
    expect(buildHostPathRestoreCommand("/restore/app data")).toBe("mkdir -p '/restore/app data' && tar xzf - -C '/restore/app data'");
  });

  it("builds a quoted remote overwrite-state command", () => {
    const command = buildHostPathRestoreStateCommand("/restore/app's data");
    expect(command).toContain("'\\''");
    expect(command).not.toContain("/restore/app's data");
    expect(command).toContain("non_empty_directory");
  });

  it("decides when a host-path restore is allowed", () => {
    expect(hostPathRestoreDecision("missing", false, "/restore/app").allowed).toBe(true);
    expect(hostPathRestoreDecision("empty_directory", false, "/restore/app").allowed).toBe(true);
    expect(hostPathRestoreDecision("non_empty_directory", true, "/restore/app").allowed).toBe(true);
    expect(hostPathRestoreDecision("non_empty_directory", false, "/restore/app")).toMatchObject({
      allowed: false
    });
    expect(hostPathRestoreDecision("not_directory", true, "/restore/app")).toMatchObject({
      allowed: false
    });
  });

  it("parses and applies optional host-path allowlist roots", () => {
    const roots = parseHostPathAllowedRoots("/srv,/var/lib/dockermender/data/");
    expect(roots).toEqual(["/srv", "/var/lib/dockermender/data"]);
    expect(assertHostBackupPathAllowed("/srv", "Source path", roots)).toBe("/srv");
    expect(assertHostBackupPathAllowed("/srv/app/data", "Source path", roots)).toBe("/srv/app/data");
    expect(assertHostBackupPathAllowed("/var/lib/dockermender/data/app", "Target path", roots)).toBe("/var/lib/dockermender/data/app");
    expect(() => assertHostBackupPathAllowed("/srvish/app", "Source path", roots)).toThrow("outside configured");
    expect(() => assertHostBackupPathAllowed("/var/lib/dockermender/database", "Target path", roots)).toThrow("outside configured");
  });

  it("keeps the allowlist opt-in and rejects invalid roots", () => {
    expect(assertHostBackupPathAllowed("/etc/app", "Source path", [])).toBe("/etc/app");
    expect(() => parseHostPathAllowedRoots("/")).toThrow("cannot be /");
    expect(() => parseHostPathAllowedRoots("relative/path")).toThrow();
    expect(() => parseHostPathAllowedRoots("/srv/app\nnext")).toThrow("control");
  });
});
