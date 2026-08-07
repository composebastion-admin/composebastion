import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AdminUser, DockerHost, ResourceSnapshot } from "@composebastion/shared";
import type { Jobish } from "../lib/dashboardTypes.js";
import { AuthorizationProvider } from "./AuthorizationContext.js";
import { ConfirmProvider } from "./ConfirmProvider.js";
import { ToastProvider } from "./ToastProvider.js";
import { SideNavigation } from "./dashboard/SideNavigation.js";
import { BackupsPanel } from "./panels/BackupsPanel.js";
import { ServicesPanel } from "./panels/ServicesPanel.js";

const host = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Primary",
  hostname: "docker.example.test",
  port: 22,
  username: "docker",
  connectionMode: "ssh",
  sshAuthType: "key",
  agentUrl: null,
  dockerSocketPath: "/var/run/docker.sock",
  tags: [],
  lastStatus: "online",
  lastSeenAt: "2026-07-10T12:00:00.000Z",
  lastError: null,
  dockerVersion: "28.0.0",
  composeVersion: "2.39.0",
  agentVersion: null,
  createdAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-10T12:00:00.000Z"
} satisfies DockerHost;

const container = {
  id: "00000000-0000-4000-8000-000000000002",
  hostId: host.id,
  kind: "container",
  externalId: "container-1",
  name: "demo-web-1",
  data: {
    Names: "demo-web-1",
    Image: "nginx:1.29",
    State: "running",
    Ports: "0.0.0.0:8080->80/tcp",
    Labels: {
      "com.docker.compose.project": "demo",
      "com.docker.compose.service": "web"
    }
  },
  updatedAt: "2026-07-10T12:00:00.000Z"
} satisfies ResourceSnapshot;

const runJob = async <T extends Jobish>(request: () => Promise<T>) => request();
const refresh = async () => undefined;

function renderAuthorized(role: AdminUser["role"], child: React.ReactNode) {
  return renderToStaticMarkup(
    <AuthorizationProvider role={role}>
      <ConfirmProvider>
        <ToastProvider>{child}</ToastProvider>
      </ConfirmProvider>
    </AuthorizationProvider>
  );
}

describe("role-aware rendering", () => {
  it("removes restricted navigation destinations for viewers", () => {
    const viewerMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <AuthorizationProvider role="viewer">
          <SideNavigation currentTab="overview" hasHost onTabChange={() => undefined} />
        </AuthorizationProvider>
      </MemoryRouter>
    );

    expect(viewerMarkup).toContain('href="/containers"');
    expect(viewerMarkup).toContain('href="/recovery"');
    expect(viewerMarkup).not.toContain('href="/ssh"');
    expect(viewerMarkup).not.toContain('href="/deploy"');

    const operatorMarkup = renderToStaticMarkup(
      <MemoryRouter>
        <AuthorizationProvider role="operator">
          <SideNavigation currentTab="overview" hasHost onTabChange={() => undefined} />
        </AuthorizationProvider>
      </MemoryRouter>
    );
    expect(operatorMarkup).toContain('href="/ssh"');
    expect(operatorMarkup).toContain('href="/deploy"');
  });

  it("keeps service inventory visible while removing viewer mutations", () => {
    const panel = (
      <ServicesPanel
        hosts={[host]}
        apps={[]}
        containers={[container]}
        images={[]}
        stacks={[]}
        refresh={refresh}
        runJob={runJob}
        onOpenContainers={() => undefined}
      />
    );

    const viewerMarkup = renderAuthorized("viewer", panel);
    expect(viewerMarkup).toContain("demo");
    expect(viewerMarkup).toContain('title="Open in Containers"');
    expect(viewerMarkup).not.toContain('title="Start service"');
    expect(viewerMarkup).not.toContain("Scan updates");

    const operatorMarkup = renderAuthorized("operator", panel);
    expect(operatorMarkup).toContain('title="Start service"');
    expect(operatorMarkup).toContain("Scan updates");
  });

  it("renders backup inventory read-only for viewers", () => {
    const panel = (
      <BackupsPanel hosts={[host]} backups={[]} jobs={[]} refresh={refresh} runJob={runJob} />
    );

    const viewerMarkup = renderAuthorized("viewer", panel);
    expect(viewerMarkup).toContain("Backup inventory");
    expect(viewerMarkup).not.toContain("Create backup");
    expect(viewerMarkup).not.toContain("Schedule backup");

    const operatorMarkup = renderAuthorized("operator", panel);
    expect(operatorMarkup).toContain("Create backup");
    expect(operatorMarkup).toContain("Schedule backup");
  });
});
