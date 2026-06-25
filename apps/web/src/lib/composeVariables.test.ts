import { describe, expect, it } from "vitest";
import { composeVariableOverrides, upsertEnvValue } from "./composeVariables.js";

describe("composeVariableOverrides", () => {
  it("detects generic Compose variables and port mappings", () => {
    const composeYaml = `
services:
  app:
    image: "ghcr.io/example/app:\${IMAGE_TAG-latest}"
    ports:
      - "\${APP_PORT:-3000}:8080"
      - "$PLAIN_PORT:9000/udp"
    environment:
      API_KEY: "\${API_KEY}"
`;

    expect(composeVariableOverrides(composeYaml, "APP_PORT=3100\nAPI_KEY=secret")).toEqual([
      { key: "APP_PORT", defaultValue: "3000", containerPort: "8080", value: "3100" },
      { key: "PLAIN_PORT", defaultValue: "", containerPort: "9000", value: "" },
      { key: "API_KEY", defaultValue: "", value: "secret" },
      { key: "IMAGE_TAG", defaultValue: "latest", value: "latest" }
    ]);
  });

  it("keeps the port context when a variable appears more than once", () => {
    const composeYaml = `
services:
  app:
    environment:
      PUBLIC_PORT: "\${PUBLIC_PORT}"
    ports:
      - "\${PUBLIC_PORT-8080}:80"
`;

    expect(composeVariableOverrides(composeYaml, "")).toContainEqual({
      key: "PUBLIC_PORT",
      defaultValue: "8080",
      containerPort: "80",
      value: "8080"
    });
  });
});

describe("upsertEnvValue", () => {
  it("updates existing values and appends new ones", () => {
    expect(upsertEnvValue("APP_PORT=3000\nIMAGE_TAG=0.9.6", "APP_PORT", "3100")).toBe("APP_PORT=3100\nIMAGE_TAG=0.9.6");
    expect(upsertEnvValue("APP_PORT=3100", "IMAGE_TAG", "1.0.2")).toBe("APP_PORT=3100\nIMAGE_TAG=1.0.2");
  });
});
