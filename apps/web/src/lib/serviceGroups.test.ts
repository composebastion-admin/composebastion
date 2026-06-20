import { describe, expect, it } from "vitest";
import type { ComposeStack, DockerApp, DockerHost, ResourceSnapshot } from "@dockermender/shared";
import { filterServiceGroups, findAppForServiceGroup, groupServices, isSelfManagementServiceGroup, parseContainerLabels, summarizeServiceGroups } from "./serviceGroups.js";

function container(partial: {
  id: string;
  hostId?: string;
  externalId: string;
  name: string;
  data: Record<string, unknown>;
}): ResourceSnapshot {
  return {
    id: partial.id,
    hostId: partial.hostId ?? "h1",
    kind: "container",
    externalId: partial.externalId,
    name: partial.name,
    data: partial.data,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

const hosts: DockerHost[] = [
  { id: "h1", name: "Host One", hostname: "host-one" } as unknown as DockerHost,
  { id: "h2", name: "Host Two", hostname: "host-two" } as unknown as DockerHost
];

const containers = [
  container({
    id: "1",
    externalId: "web-1",
    name: "shop-web-1",
    data: {
      Names: "shop-web-1",
      State: "running",
      Image: "nginx:alpine",
      Ports: "0.0.0.0:8080->80/tcp",
      Labels: "com.docker.compose.project=shop,com.docker.compose.service=web,com.docker.compose.project.working_dir=/srv/shop"
    }
  }),
  container({
    id: "2",
    externalId: "db-1",
    name: "shop-db-1",
    data: {
      Names: "shop-db-1",
      State: "exited",
      Image: "postgres:16",
      Labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": "db" }
    }
  }),
  container({
    id: "3",
    externalId: "lonely-1",
    name: "pihole",
    data: { Names: "pihole", State: "running", Image: "pihole/pihole" }
  })
];

const stacks: ComposeStack[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    hostId: "h1",
    name: "Shop",
    projectName: "shop"
  } as unknown as ComposeStack
];

describe("parseContainerLabels", () => {
  it("parses comma-joined label strings", () => {
    expect(parseContainerLabels("a=1,b=2,c=x=y")).toEqual({ a: "1", b: "2", c: "x=y" });
  });

  it("parses label objects", () => {
    expect(parseContainerLabels({ a: 1, b: "two" })).toEqual({ a: "1", b: "two" });
  });

  it("returns empty for missing labels", () => {
    expect(parseContainerLabels(undefined)).toEqual({});
    expect(parseContainerLabels("")).toEqual({});
  });
});

describe("groupServices", () => {
  it("groups compose containers by project and keeps standalone containers separate", () => {
    const groups = groupServices(containers, stacks, hosts);
    expect(groups).toHaveLength(2);

    const shop = groups.find((group) => group.projectName === "shop");
    expect(shop).toBeDefined();
    expect(shop?.kind).toBe("compose");
    expect(shop?.name).toBe("Shop");
    expect(shop?.stack?.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(shop?.members.map((member) => member.serviceName)).toEqual(["db", "web"]);
    expect(shop?.workingDir).toBe("/srv/shop");
    expect(shop?.totalCount).toBe(2);
    expect(shop?.runningCount).toBe(1);
    expect(shop?.status).toBe("partial");

    const pihole = groups.find((group) => group.projectName === null);
    expect(pihole?.kind).toBe("standalone");
    expect(pihole?.name).toBe("pihole");
    expect(pihole?.status).toBe("running");
  });

  it("orders compose groups before standalone groups", () => {
    const groups = groupServices(containers, stacks, hosts);
    expect(groups.map((group) => group.kind)).toEqual(["compose", "standalone"]);
  });

  it("includes managed stacks that have no live containers", () => {
    const groups = groupServices([], stacks, hosts);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projectName).toBe("shop");
    expect(groups[0]?.totalCount).toBe(0);
    expect(groups[0]?.status).toBe("stopped");
  });

  it("summarizes data mounts and database persistence warnings", () => {
    const groups = groupServices(
      [
        container({
          id: "web",
          externalId: "web-1",
          name: "shop-web-1",
          data: {
            Names: "shop-web-1",
            State: "running",
            Image: "nginx:alpine",
            Labels: "com.docker.compose.project=shop,com.docker.compose.service=web,com.docker.compose.project.working_dir=/srv/shop",
            Mounts: [
              { Type: "volume", Name: "shop_data", Destination: "/data", RW: true },
              { Type: "bind", Source: "/srv/shop/config", Destination: "/config", RW: false }
            ]
          }
        }),
        container({
          id: "db",
          externalId: "db-1",
          name: "shop-db-1",
          data: {
            Names: "shop-db-1",
            State: "running",
            Image: "postgres:16",
            Labels: "com.docker.compose.project=shop,com.docker.compose.service=db"
          }
        })
      ],
      stacks,
      hosts
    );

    const shop = groups.find((group) => group.projectName === "shop")!;
    expect(shop.dataMounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "volume", name: "shop_data", destination: "/data" }),
      expect.objectContaining({ type: "bind", source: "/srv/shop/config", destination: "/config", readOnly: true }),
      expect.objectContaining({ type: "compose_working_dir", source: "/srv/shop" })
    ]));
    expect(shop.dataWarnings).toEqual([
      "db looks database-like but has no detected persistent data mount."
    ]);
  });
});

describe("filterServiceGroups", () => {
  const groups = groupServices(containers, stacks, hosts);

  it("filters by member service name", () => {
    const filtered = filterServiceGroups(groups, "postgres", "all");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.projectName).toBe("shop");
  });

  it("filters to running services only", () => {
    const filtered = filterServiceGroups(groups, "", "running");
    expect(filtered.map((group) => group.projectName)).toEqual(["shop", null]);
  });

  it("filters to fully stopped services", () => {
    const stopped = groupServices(
      [container({ id: "x", externalId: "x1", name: "idle", data: { Names: "idle", State: "exited", Image: "busybox" } })],
      [],
      hosts
    );
    expect(filterServiceGroups(stopped, "", "stopped")).toHaveLength(1);
    expect(filterServiceGroups(stopped, "", "running")).toHaveLength(0);
  });
});

describe("summarizeServiceGroups", () => {
  it("totals services and containers", () => {
    const summary = summarizeServiceGroups(groupServices(containers, stacks, hosts));
    expect(summary.totalServices).toBe(2);
    expect(summary.totalContainers).toBe(3);
    expect(summary.runningContainers).toBe(2);
    expect(summary.runningServices).toBe(1);
    expect(summary.partialServices).toBe(1);
  });
});

describe("findAppForServiceGroup", () => {
  it("matches a compose service to app metadata by stack id", () => {
    const group = groupServices(containers, stacks, hosts).find((item) => item.projectName === "shop")!;
    const app = {
      id: "stack:00000000-0000-0000-0000-000000000001",
      hostId: "h1",
      name: "Shop",
      stackId: "00000000-0000-0000-0000-000000000001",
      projectName: "shop",
      containerIds: ["web-1", "db-1"],
      update: { status: "update_available", kind: "git" }
    } as unknown as DockerApp;

    expect(findAppForServiceGroup(group, [app])?.id).toBe(app.id);
  });

  it("matches standalone services by primary container id", () => {
    const group = groupServices(containers, stacks, hosts).find((item) => item.kind === "standalone")!;
    const app = {
      id: "container:3",
      hostId: "h1",
      name: "pihole",
      stackId: null,
      projectName: null,
      primaryContainerId: "lonely-1",
      containerIds: ["lonely-1"],
      update: { status: "up_to_date", kind: "image" }
    } as unknown as DockerApp;

    expect(findAppForServiceGroup(group, [app])?.id).toBe(app.id);
  });
});

describe("isSelfManagementServiceGroup", () => {
  it("detects the self-managed compose project", () => {
    const groups = groupServices(
      [
        container({
          id: "dm-app",
          externalId: "dockermender-app-1",
          name: "dockermender-app-1",
          data: {
            Names: "dockermender-app-1",
            State: "running",
            Image: "dockermender-app",
            Labels: "com.docker.compose.project=dockermender,com.docker.compose.service=app"
          }
        })
      ],
      [],
      hosts
    );

    expect(isSelfManagementServiceGroup(groups[0]!)).toBe(true);
  });

  it("does not block ordinary compose projects", () => {
    const groups = groupServices(containers, stacks, hosts);
    expect(groups.every((group) => !isSelfManagementServiceGroup(group))).toBe(true);
  });
});
