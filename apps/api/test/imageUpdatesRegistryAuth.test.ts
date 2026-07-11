import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/crypto.js", () => ({
  decryptSecret: (value: string) => value
}));

const { findRegistryAuthForReference } = await import("../src/services/imageUpdates.js");

describe("saved registry credential matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["https://docker.io", "registry-1.docker.io/library/nginx:latest"],
    ["https://registry-1.docker.io", "docker.io/library/nginx:latest"],
    ["index.docker.io", "nginx:latest"]
  ])("matches Docker Hub aliases symmetrically: %s -> %s", async (url, image) => {
    query.mockResolvedValue({
      rows: [{
        id: "registry-id",
        url,
        username: "operator",
        password_encrypted: "secret",
        insecure: false
      }]
    });

    await expect(findRegistryAuthForReference(image)).resolves.toMatchObject({
      id: "registry-id",
      username: "operator",
      password: "secret",
      insecure: false,
      trustedOrigin: expect.stringMatching(/^https:\/\//)
    });
  });

  it("ignores malformed legacy saved URLs instead of treating them as trusted origins", async () => {
    query.mockResolvedValue({
      rows: [{
        id: "registry-id",
        url: "https://user:secret@docker.io",
        username: "operator",
        password_encrypted: "secret",
        insecure: false
      }]
    });

    await expect(findRegistryAuthForReference("nginx:latest")).resolves.toBeNull();
  });
});
