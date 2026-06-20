import { describe, expect, it } from "vitest";
import { dockerActionSchema } from "@dockermender/shared";
import { buildComposeCommand, buildDockerActionCommand, dockerCommandFailureMessage, shQuote, withDockerEnv } from "../src/services/commands.js";

describe("Docker command builders", () => {
  it("quotes shell values safely", () => {
    expect(shQuote("web'app")).toBe("'web'\\''app'");
  });

  it("builds typed container commands", () => {
    const action = dockerActionSchema.parse({
      type: "container.remove",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { containerId: "abc 123", force: true, removeVolumes: true }
    });
    expect(buildDockerActionCommand(action)).toBe("docker rm --force --volumes 'abc 123'");
    const rename = dockerActionSchema.parse({
      type: "container.rename",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { containerId: "abc 123", name: "web app" }
    });
    expect(buildDockerActionCommand(rename)).toBe("docker rename 'abc 123' 'web app'");
  });

  it("rejects creating built-in network drivers", () => {
    const action = dockerActionSchema.parse({
      type: "network.create",
      hostId: "00000000-0000-4000-8000-000000000001",
      payload: { name: "host-like", driver: "host", labels: {} }
    });
    expect(() => buildDockerActionCommand(action)).toThrow("built-in Docker network");
  });

  it("adds the configured Docker socket environment", () => {
    expect(withDockerEnv("docker ps", "/var/run/docker.sock")).toBe("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:$PATH DOCKER_HOST='unix:///var/run/docker.sock' docker ps");
  });

  it("explains missing Docker CLI failures from SSH hosts", () => {
    expect(dockerCommandFailureMessage("bash: line 1: docker: command not found", "failed")).toContain("Docker CLI was not found");
  });

  it("explains Docker socket permission failures from SSH hosts", () => {
    expect(dockerCommandFailureMessage(
      "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
      "failed"
    )).toContain("cannot access the Docker socket");
  });

  it("force recreates compose services on deploy so config changes apply", () => {
    expect(buildComposeCommand("sampleapp", "/tmp/compose.yml", "up")).toContain("up -d --remove-orphans --force-recreate");
  });
});
