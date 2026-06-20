import { describe, expect, it } from "vitest";
import { decryptConfigPayload, decryptSecret, encryptConfigPayload, encryptSecret } from "../src/services/crypto.js";

describe("secret encryption", () => {
  it("round trips encrypted values", () => {
    const encrypted = encryptSecret("private-key-material");
    expect(encrypted).not.toContain("private-key-material");
    expect(decryptSecret(encrypted)).toBe("private-key-material");
  });

  it("round trips encrypted config backups with AES-256-GCM", () => {
    const encrypted = encryptConfigPayload({ sshPassword: "secret-password" }, "long-test-passphrase");
    expect(encrypted.algorithm).toBe("aes-256-gcm");
    expect(encrypted.ciphertext).not.toContain("secret-password");
    expect(decryptConfigPayload(encrypted, "long-test-passphrase")).toEqual({ sshPassword: "secret-password" });
  });
});
