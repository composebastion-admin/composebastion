import { describe, expect, it } from "vitest";
import { alertSilenceMatches } from "../src/services/alerts.js";

const now = new Date("2026-06-16T12:00:00.000Z");
const rule = {
  rule_id: "11111111-1111-4111-8111-111111111111",
  host_id: "22222222-2222-4222-8222-222222222222"
};

describe("alert silence matching", () => {
  it("matches active silences by rule or host", () => {
    const window = {
      starts_at: "2026-06-16T11:00:00.000Z",
      ends_at: "2026-06-16T13:00:00.000Z"
    };

    expect(alertSilenceMatches({ ...window, rule_id: rule.rule_id }, rule, now)).toBe(true);
    expect(alertSilenceMatches({ ...window, host_id: rule.host_id }, rule, now)).toBe(true);
    expect(alertSilenceMatches({ ...window, rule_id: "33333333-3333-4333-8333-333333333333" }, rule, now)).toBe(false);
  });

  it("ignores silences outside their time window", () => {
    expect(alertSilenceMatches({
      rule_id: rule.rule_id,
      starts_at: "2026-06-16T13:00:00.000Z",
      ends_at: "2026-06-16T14:00:00.000Z"
    }, rule, now)).toBe(false);
  });
});
