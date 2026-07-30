import { describe, expect, it } from "vitest";
import {
  extractImagesFromCompose,
  inspectImagesFromCompose
} from "../src/services/composeImages.js";

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
    image: \${APP_IMAGE}
`;
    expect(extractImagesFromCompose(yaml)).toEqual([]);
  });

  it("uses Compose variable defaults when finding registry image references", () => {
    const yaml = `services:
  dashboard:
    image: 10.0.21.40:3000/kobuslabs/homelabdashboard:\${IMAGE_TAG:-latest}
`;
    expect(extractImagesFromCompose(yaml)).toEqual(["10.0.21.40:3000/kobuslabs/homelabdashboard:latest"]);
  });

  it("ignores image references that still require host environment interpolation", () => {
    const yaml = `services:
  dashboard:
    image: registry.example.com/dashboard:\${IMAGE_TAG}
`;
    expect(extractImagesFromCompose(yaml)).toEqual([]);
  });

  it("resolves merged private-registry images from the bound environment", () => {
    const yaml = `x-service: &service
  image: \${REGISTRY}/team/app:\${TAG:-latest}
services:
  app:
    <<: *service
`;
    expect(extractImagesFromCompose(
      yaml,
      "REGISTRY='registry.internal:5000'\nTAG='qualified'"
    )).toEqual(["registry.internal:5000/team/app:qualified"]);
  });

  it("reports image authorities that cannot be resolved without the bound environment", () => {
    const yaml = `services:
  app:
    image: \${REGISTRY}/team/app:\${TAG}
`;
    expect(inspectImagesFromCompose(yaml)).toEqual({
      images: [],
      unresolved: true
    });
    expect(inspectImagesFromCompose(
      yaml,
      "REGISTRY='registry.internal:5000'\nTAG='qualified'"
    )).toEqual({
      images: ["registry.internal:5000/team/app:qualified"],
      unresolved: false
    });
  });
});
