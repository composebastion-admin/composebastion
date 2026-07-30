import { describe, expect, it } from "vitest";
import { auditActions } from "./auditActions.js";

describe("audit action catalog", () => {
  it("includes every privileged action emitted by the API", () => {
    expect(auditActions).toEqual(expect.arrayContaining([
      "alert.channel.delete",
      "alert.rule.delete",
      "compose.forget",
      "compose.proxy.update",
      "container.clone",
      "recovery.verify",
      "volume.clone"
    ]));
  });
});
