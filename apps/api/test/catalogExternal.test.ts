import { afterEach, describe, expect, it, vi } from "vitest";
import { listExternalCatalogCandidates } from "../src/services/catalog.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function textResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/yaml" }
  });
}

describe("external catalog discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads Awesome-Selfhosted candidates sorted by stars with review templates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/master")) {
        return jsonResponse({
          tree: [
            { path: "software/archivebox.yml", type: "blob" },
            { path: "software/small.yml", type: "blob" },
            { path: "software/archived.yml", type: "blob" }
          ]
        });
      }
      if (url.endsWith("software%2Farchivebox.yml") || url.endsWith("software/archivebox.yml")) {
        return textResponse(`name: ArchiveBox
website_url: https://archivebox.io/
description: Self-hosted web archive.
licenses:
  - MIT
platforms:
  - Docker
tags:
  - Archiving and Digital Preservation (DP)
source_code_url: https://github.com/ArchiveBox/ArchiveBox
stargazers_count: 27000
updated_at: '2026-06-01'
archived: false
current_release:
  tag: v1.0.0
  published_at: '2026-05-01'
`);
      }
      if (url.endsWith("software%2Fsmall.yml") || url.endsWith("software/small.yml")) {
        return textResponse(`name: Small App
website_url: https://example.com/small
description: Smaller useful app.
licenses:
  - Apache-2.0
platforms:
  - Docker
tags:
  - Automation
stargazers_count: 10
updated_at: '2026-01-01'
archived: false
`);
      }
      if (url.endsWith("software%2Farchived.yml") || url.endsWith("software/archived.yml")) {
        return textResponse(`name: Old App
website_url: https://example.com/old
description: Archived app.
licenses:
  - MIT
platforms:
  - Docker
tags:
  - Miscellaneous
stargazers_count: 99999
updated_at: '2020-01-01'
archived: true
`);
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const result = await listExternalCatalogCandidates({ limit: 5 });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.total).toBe(2);
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(["ArchiveBox", "Small App"]);
    expect(result.candidates[0]?.importTemplate.id).toBe("awesome-archivebox");
    expect(result.candidates[0]?.importTemplate.composeYaml).toContain("replace-with-official-image:latest");
    expect(result.candidates[1]?.category).toBe("automation");
  });
});
