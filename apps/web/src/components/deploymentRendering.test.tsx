import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DockerHost } from "@composebastion/shared";
import type { Jobish } from "../lib/dashboardTypes.js";
import { ConfirmProvider } from "./ConfirmProvider.js";
import { GithubDeployPanel } from "./panels/GithubDeployPanel.js";

const sshHost = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Docker Prod 1",
  hostname: "10.0.21.50",
  port: 22,
  username: "docker",
  connectionMode: "ssh",
  sshAuthType: "key",
  agentUrl: null,
  dockerSocketPath: "/var/run/docker.sock",
  tags: [],
  lastStatus: "online",
  lastSeenAt: null,
  lastError: null,
  dockerVersion: "28.0.0",
  composeVersion: "2.39.0",
  agentVersion: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z"
} satisfies DockerHost;

const refresh = async () => undefined;
const runJob = async <T extends Jobish>(request: () => Promise<T>) => request();

function render(host: DockerHost) {
  return renderToStaticMarkup(
    <ConfirmProvider>
      <GithubDeployPanel
        hosts={[host]}
        scopeHosts={[host]}
        repositories={[]}
        refresh={refresh}
        runJob={runJob}
      />
    </ConfirmProvider>
  );
}

describe("universal deployment rendering", () => {
  it("shows one accessible source flow and My Library instead of manual image forms", () => {
    const markup = render(sshHost);
    expect(markup).toContain("Paste it. We&#x27;ll work out the rest.");
    expect(markup).toContain('aria-label="Deployment source"');
    expect(markup).toContain("Upload Compose");
    expect(markup).toContain("Analyze");
    expect(markup).toContain("My Library");
    expect(markup).not.toContain("Restart policy");
    expect(markup).not.toContain("Ports, one per line");
    expect(markup).not.toContain("Clone &amp; Deploy");
  });

  it("explains the SSH-first Git capability on agent hosts", () => {
    const markup = render({ ...sshHost, connectionMode: "agent", agentUrl: "https://agent.example.test" });
    expect(markup).toContain("Git analysis currently requires an SSH-connected host");
    expect(markup).toContain("Compose and image inputs work");
  });
});
