import { describe, expect, it } from "vitest";
import { parseContainerInspectJson, redactInspectEnv, type ContainerInspectDetails } from "../src/services/docker.js";

describe("container inspect parser", () => {
  it("extracts detail drawer fields from docker inspect JSON", () => {
    const inspect = parseContainerInspectJson(JSON.stringify([
      {
        Config: {
          Image: "nginx:alpine",
          Env: ["FOO=bar", "SECRET=not-redacted-by-docker"],
          Labels: {
            "com.example.role": "web"
          }
        },
        State: {
          Status: "running",
          Running: true
        },
        HostConfig: {
          RestartPolicy: {
            Name: "on-failure",
            MaximumRetryCount: 3
          },
          PortBindings: {
            "80/tcp": [
              { HostIp: "0.0.0.0", HostPort: "8080" },
              { HostIp: "::", HostPort: "8080" }
            ],
            "443/tcp": null
          }
        },
        Mounts: [
          {
            Type: "volume",
            Name: "web_data",
            Source: "/var/lib/docker/volumes/web_data/_data",
            Destination: "/usr/share/nginx/html",
            RW: true
          },
          {
            Type: "bind",
            Source: "/srv/nginx.conf",
            Destination: "/etc/nginx/nginx.conf",
            RW: false
          }
        ],
        NetworkSettings: {
          Networks: {
            frontend: {
              IPAddress: "172.18.0.4",
              Aliases: ["web", "frontend-web"]
            }
          }
        }
      }
    ]));

    expect(inspect.image).toBe("nginx:alpine");
    expect(inspect.status).toBe("running");
    expect(inspect.restartPolicy).toBe("on-failure:3");
    expect(inspect.env).toEqual(["FOO=bar", "SECRET=not-redacted-by-docker"]);
    expect(inspect.labels).toEqual({ "com.example.role": "web" });
    expect(inspect.mounts).toEqual([
      {
        type: "volume",
        name: "web_data",
        source: "/var/lib/docker/volumes/web_data/_data",
        destination: "/usr/share/nginx/html",
        readOnly: false
      },
      {
        type: "bind",
        source: "/srv/nginx.conf",
        destination: "/etc/nginx/nginx.conf",
        readOnly: true
      }
    ]);
    expect(inspect.networks).toEqual([
      {
        name: "frontend",
        ipAddress: "172.18.0.4",
        aliases: ["web", "frontend-web"]
      }
    ]);
    expect(inspect.ports).toEqual([
      { containerPort: "80", protocol: "tcp", hostIp: "0.0.0.0", hostPort: "8080" },
      { containerPort: "80", protocol: "tcp", hostIp: "::", hostPort: "8080" },
      { containerPort: "443", protocol: "tcp" }
    ]);
  });
});

describe("container inspect redaction", () => {
  it("masks env values while preserving keys and non-env fields", () => {
    const details: ContainerInspectDetails = {
      image: "postgres:16",
      status: "running",
      restartPolicy: "unless-stopped",
      env: ["POSTGRES_PASSWORD=s3cret", "DATABASE_URL=postgres://user:pass@db/app", "EMPTY=", "FLAG_ONLY", "A=B=C"],
      mounts: [
        {
          type: "volume",
          name: "pgdata",
          destination: "/var/lib/postgresql/data",
          readOnly: false
        }
      ],
      networks: [{ name: "backend", ipAddress: "172.18.0.2", aliases: ["db"] }],
      ports: [{ containerPort: "5432", protocol: "tcp", hostIp: "127.0.0.1", hostPort: "5432" }],
      labels: { "com.example.role": "database" }
    };
    const originalEnv = [...details.env];

    const redacted = redactInspectEnv(details);

    expect(redacted).not.toBe(details);
    expect(redacted.env).toEqual([
      "POSTGRES_PASSWORD=<redacted>",
      "DATABASE_URL=<redacted>",
      "EMPTY=<redacted>",
      "FLAG_ONLY",
      "A=<redacted>"
    ]);
    expect(details.env).toEqual(originalEnv);
    expect(redacted.mounts).toEqual(details.mounts);
    expect(redacted.networks).toEqual(details.networks);
    expect(redacted.ports).toEqual(details.ports);
    expect(redacted.labels).toEqual(details.labels);
  });
});
