import { describe, expect, it } from "vitest";
import {
  dockerStatsIdentityKeys,
  dockerStatsRecordsMatch,
  isDockerStatsLifecycleTombstone,
  isDockerStatsRecord
} from "./dockerStats.js";

const fullId = "5fb479d76eb43580fcd59f1739151aa4922d80b8292d25fecc76af9a149b7398";
const tombstone = {
  Container: fullId,
  ID: "",
  Name: "--",
  CPUPerc: "0.00%",
  MemUsage: "0B / 0B"
};

describe("Docker stats identity validation", () => {
  it.each([
    [{ ID: "5fb479d76eb4" }, "a nonblank ID"],
    [{ ID: "container-1" }, "an opaque nonblank ID"],
    [{ Name: "web" }, "a usable Name"],
    [{ Names: "worker" }, "a usable Names value"],
    [{ Container: fullId, Name: "web" }, "a usable Name plus full Container ID"],
    [{ ID: "  container-1  " }, "a trimmed nonblank ID"],
    [{ Name: "  web  " }, "a trimmed usable Name"]
  ])("accepts %s with %s", (record) => {
    expect(isDockerStatsRecord(record)).toBe(true);
  });

  it.each([
    [null, "null"],
    [[], "an array"],
    ["stats", "a scalar"],
    [42, "a number"],
    [{}, "an empty object"],
    [{ CPUPerc: "1.00%", MemPerc: "2.00%" }, "metrics without identity"],
    [{ ID: "   " }, "a blank ID"],
    [{ Name: "--" }, "the lifecycle placeholder Name"],
    [{ Names: "--" }, "the lifecycle placeholder Names value"],
    [{ Container: "5fb479d76eb4" }, "a short Container-only ID"],
    [{ Container: fullId }, "a full Container-only ID"],
    [{ Container: fullId.toUpperCase().slice(0, 63) }, "a 63-character Container-only ID"],
    [{ Container: `${fullId}0` }, "a 65-character Container-only ID"],
    [{ Container: `${fullId.slice(0, 63)}z` }, "a non-hex Container-only ID"],
    [tombstone, "a lifecycle tombstone"]
  ])("rejects %s (%s)", (record) => {
    expect(isDockerStatsRecord(record)).toBe(false);
  });

  it("recognizes the lifecycle tombstone by its stable identity rather than metric formatting", () => {
    expect(isDockerStatsLifecycleTombstone(tombstone)).toBe(true);
    expect(isDockerStatsLifecycleTombstone({
      ...tombstone,
      CPUPerc: "0%",
      MemUsage: "0 bytes / 0 bytes",
      PIDs: 0
    })).toBe(true);
    expect(isDockerStatsLifecycleTombstone({ ...tombstone, ID: fullId.slice(0, 12) })).toBe(false);
    expect(isDockerStatsLifecycleTombstone({ ...tombstone, Name: "web" })).toBe(false);
    expect(isDockerStatsLifecycleTombstone({ ...tombstone, Names: "ignored-extra-field" })).toBe(true);
    expect(isDockerStatsLifecycleTombstone({ ...tombstone, Container: fullId.slice(0, 12) })).toBe(false);
    expect(isDockerStatsLifecycleTombstone(null)).toBe(false);
    expect(isDockerStatsLifecycleTombstone([])).toBe(false);
  });

  it("builds stable, deduplicated identity keys and omits invalid rows", () => {
    expect(dockerStatsIdentityKeys({
      Container: fullId.toUpperCase(),
      Name: " web ",
      Names: "web"
    })).toEqual([`id:${fullId}`, "name:web"]);
    expect(dockerStatsIdentityKeys({ CPUPerc: "1.00%" })).toEqual([]);
    expect(dockerStatsIdentityKeys(tombstone)).toEqual([]);
  });

  it("matches equivalent ID, Container, Name, and Names variants", () => {
    expect(dockerStatsRecordsMatch({ ID: fullId.slice(0, 12) }, { Container: fullId, Name: "web" })).toBe(true);
    expect(dockerStatsRecordsMatch({ ID: fullId }, { ID: fullId.slice(0, 12) })).toBe(true);
    expect(dockerStatsRecordsMatch({ Name: "web" }, { Names: "web" })).toBe(true);
    expect(dockerStatsRecordsMatch({ ID: "container-1", Name: "old" }, { ID: "container-1", Name: "new" })).toBe(true);
  });

  it("does not match unrelated, ambiguous, or invalid identities", () => {
    expect(dockerStatsRecordsMatch({ ID: "container-1" }, { ID: "container-2" })).toBe(false);
    expect(dockerStatsRecordsMatch({ Name: "web" }, { Name: "worker" })).toBe(false);
    expect(dockerStatsRecordsMatch({ ID: "abc" }, { ID: "abcdef" })).toBe(false);
    expect(dockerStatsRecordsMatch({ CPUPerc: "1.00%" }, { CPUPerc: "1.00%" })).toBe(false);
    expect(dockerStatsRecordsMatch(tombstone, { Container: fullId, Name: "web" })).toBe(false);
  });
});
