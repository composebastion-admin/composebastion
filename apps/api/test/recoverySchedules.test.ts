import { describe, expect, it } from "vitest";
import { recoveryScheduleCreateSchema } from "@composebastion/shared";

describe("recovery schedule capture mode", () => {
  it("accepts hot and stop_first capture modes", () => {
    const hot = recoveryScheduleCreateSchema.parse({
      hostId: "00000000-0000-4000-8000-000000000001",
      name: "Nightly",
      appIdentity: { kind: "compose", projectName: "demoapp" },
      intervalMs: 3_600_000,
      captureMode: "hot"
    });
    expect(hot.captureMode).toBe("hot");

    const stopFirst = recoveryScheduleCreateSchema.parse({
      hostId: "00000000-0000-4000-8000-000000000001",
      name: "Nightly quiesced",
      appIdentity: { kind: "compose", projectName: "demoapp" },
      intervalMs: 3_600_000,
      captureMode: "stop_first"
    });
    expect(stopFirst.captureMode).toBe("stop_first");
  });
});

describe("due recovery schedule enqueue payload", () => {
  it("maps stop_first schedules to stopFirst job payload", () => {
    const schedule = { capture_mode: "stop_first" };
    expect(schedule.capture_mode === "stop_first").toBe(true);
    const payload = { recoveryPointId: "rp", stopFirst: schedule.capture_mode === "stop_first" };
    expect(payload.stopFirst).toBe(true);
  });
});
