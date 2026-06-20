import { describe, expect, it } from "vitest";
import { formatRestorePathMappings, parseProfileLines, parseRestorePathMappings } from "./recoveryProfile.js";

describe("recovery profile helpers", () => {
  it("parses line-based include and exclude entries", () => {
    expect(parseProfileLines(" /srv/app \n\n cache/** \r\n")).toEqual(["/srv/app", "cache/**"]);
  });

  it("parses restore path mappings", () => {
    expect(parseRestorePathMappings([
      "/srv/app => /restore/app",
      "/data=/restore/data",
      "ignored"
    ].join("\n"))).toEqual({
      "/srv/app": "/restore/app",
      "/data": "/restore/data"
    });
  });

  it("formats restore path mappings for editing", () => {
    expect(formatRestorePathMappings({
      "/srv/app": "/restore/app",
      "/data": "/restore/data"
    })).toBe("/srv/app => /restore/app\n/data => /restore/data");
  });
});
