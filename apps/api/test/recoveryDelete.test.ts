import { describe, expect, it } from "vitest";
import { deleteRecoveryPointLocalFiles, recoveryPointDir } from "../src/services/recoveryStorage.js";

describe("recovery point local delete safety", () => {
  it("rejects invalid recovery point ids", async () => {
    await expect(deleteRecoveryPointLocalFiles("../escape")).rejects.toThrow("Invalid recovery point id");
  });

  it("targets only the recovery point directory under BACKUP_DIR", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(recoveryPointDir(id)).toContain(id);
    expect(recoveryPointDir(id)).not.toContain("..");
  });
});
