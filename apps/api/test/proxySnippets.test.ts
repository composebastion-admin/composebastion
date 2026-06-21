import { describe, expect, it } from "vitest";
import { buildProxySnippets, mergeTraefikLabelsIntoCompose } from "../src/services/proxySnippets.js";

describe("buildProxySnippets", () => {
  it("generates traefik and caddy snippets with warnings when domain missing", () => {
    const result = buildProxySnippets({
      domains: [],
      exposedService: null,
      exposedPort: null,
      tlsDesired: true,
      projectName: "demo"
    });
    expect(result.traefikLabels.length).toBeGreaterThan(0);
    expect(result.caddySnippet).toContain("reverse_proxy");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("merges traefik labels into a compose service", () => {
    const yaml = `services:
  app:
    image: nginx:latest
`;
    const merged = mergeTraefikLabelsIntoCompose(yaml, "app", ["traefik.enable=true", "traefik.http.routers.app.rule=Host(`demo.local`)"]);
    expect(merged).toContain("labels:");
    expect(merged).toContain('traefik.enable=true');
    expect(merged).toContain("Host(`demo.local`)");
  });
});
