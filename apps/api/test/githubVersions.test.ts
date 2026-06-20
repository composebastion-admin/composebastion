import { afterEach, describe, expect, it, vi } from "vitest";
import { listGithubVersionsForUrl, parseGithubUrl } from "../src/services/github.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("GitHub version discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses HTTPS and SSH GitHub repository URLs", () => {
    expect(parseGithubUrl("https://github.com/Owner/Repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubUrl("git@github.com:Owner/Repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGithubUrl("ssh://git@github.com/Owner/Repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(() => parseGithubUrl("https://gitlab.com/owner/repo")).toThrow("GitHub repository URL");
  });

  it("lists branches, tags, and releases with update state", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname.endsWith("/branches")) {
        return jsonResponse([
          { name: "main", commit: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
          { name: "dev", commit: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }
        ]);
      }
      if (url.pathname.endsWith("/tags")) {
        return jsonResponse([
          { name: "v1.0.0", commit: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
          { name: "v1.1.0", commit: { sha: "cccccccccccccccccccccccccccccccccccccccc" } }
        ]);
      }
      if (url.pathname.endsWith("/releases")) {
        return jsonResponse([
          { tag_name: "v1.1.0", name: "Version 1.1", draft: false, prerelease: false, published_at: "2026-06-17T10:00:00Z", html_url: "https://github.com/owner/repo/releases/tag/v1.1.0" },
          { tag_name: "v1.2.0-beta", name: "Version 1.2 beta", draft: false, prerelease: true, published_at: "2026-06-17T11:00:00Z", html_url: "https://github.com/owner/repo/releases/tag/v1.2.0-beta" },
          { tag_name: "draft", name: "Draft", draft: true, prerelease: false }
        ]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const versions = await listGithubVersionsForUrl("https://github.com/owner/repo", undefined, {
      selectedRef: "main",
      currentCommitSha: "aaaaaaaaaaaa"
    });

    expect(versions.options.map((option) => `${option.kind}:${option.ref}`)).toEqual([
      "branch:main",
      "branch:dev",
      "tag:v1.0.0",
      "tag:v1.1.0",
      "release:v1.1.0",
      "release:v1.2.0-beta"
    ]);
    expect(versions.options.find((option) => option.ref === "main")).toMatchObject({
      selected: true,
      deployed: true,
      updateAvailable: false
    });
    expect(versions.options.find((option) => option.ref === "dev")).toMatchObject({
      selected: false,
      deployed: false,
      updateAvailable: true
    });
    expect(versions.options.find((option) => option.kind === "release" && option.ref === "v1.1.0")).toMatchObject({
      label: "Version 1.1",
      updateAvailable: true
    });
    expect(versions.options.find((option) => option.ref === "v1.2.0-beta")?.label).toBe("Version 1.2 beta (pre-release)");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
