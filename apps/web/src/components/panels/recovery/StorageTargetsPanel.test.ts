import { describe, expect, it } from "vitest";
import { rcloneProviderOptions } from "./StorageTargetsPanel.js";

describe("rclone provider labels", () => {
  it("keeps SMB stable and marks imported rclone providers experimental", () => {
    const smb = rcloneProviderOptions.find((option) => option.value === "smb");
    const experimental = rcloneProviderOptions.filter((option) => option.value !== "smb");

    expect(smb).toMatchObject({ label: "SMB / CIFS", experimental: false });
    expect(experimental).not.toHaveLength(0);
    expect(experimental.every((option) => option.experimental)).toBe(true);
    expect(experimental.every((option) => option.label.includes("experimental"))).toBe(true);
  });
});
