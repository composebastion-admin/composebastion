import { describe, expect, it } from "vitest";
import { extractImagesFromCompose } from "../src/services/composeImages.js";

describe("extractImagesFromCompose", () => {
  it("collects image references from compose yaml", () => {
    const yaml = `services:
  web:
    image: nginx:1.27
  cache:
    image: "redis:7-alpine"
`;
    expect(extractImagesFromCompose(yaml)).toEqual(["nginx:1.27", "redis:7-alpine"]);
  });

  it("ignores variable placeholders", () => {
    const yaml = `services:
  app:
    image: \${APP_IMAGE:-nginx:alpine}
`;
    expect(extractImagesFromCompose(yaml)).toEqual([]);
  });
});
