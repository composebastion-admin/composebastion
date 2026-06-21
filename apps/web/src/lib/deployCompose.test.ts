import { describe, expect, it } from "vitest";
import { generateSingleImageCompose, imageWithDefaultLatest } from "./deployCompose.js";

describe("deploy compose helpers", () => {
  it("adds latest only when an image lacks a tag or digest", () => {
    expect(imageWithDefaultLatest("nginx")).toBe("nginx:latest");
    expect(imageWithDefaultLatest("localhost:5000/nginx")).toBe("localhost:5000/nginx:latest");
    expect(imageWithDefaultLatest("localhost:5000/nginx:1.27")).toBe("localhost:5000/nginx:1.27");
    expect(imageWithDefaultLatest("ghcr.io/example/app@sha256:abc")).toBe("ghcr.io/example/app@sha256:abc");
  });

  it("generates a single-service compose file with latest pull policy", () => {
    const yaml = generateSingleImageCompose({
      image: "ghcr.io/example/app",
      serviceName: "Example App",
      restartPolicy: "unless-stopped",
      ports: "8080:80\n8443:443",
      env: "APP_ENV=prod",
      volumes: "app_data:/data",
      command: "serve --http",
      alwaysPullLatest: true
    });

    expect(yaml).toContain("example-app:");
    expect(yaml).toContain('image: "ghcr.io/example/app:latest"');
    expect(yaml).toContain("pull_policy: always");
    expect(yaml).toContain('restart: "unless-stopped"');
    expect(yaml).toContain('- "8080:80"');
    expect(yaml).toContain('- "APP_ENV=prod"');
    expect(yaml).toContain('- "app_data:/data"');
    expect(yaml).toContain('command: "serve --http"');
  });
});
