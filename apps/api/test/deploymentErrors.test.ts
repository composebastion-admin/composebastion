import { describe, expect, it } from "vitest";
import { dockerCommandFailureMessage } from "../src/services/commands.js";

describe("deployment error translation", () => {
  it("explains Docker HTTP registry trust failures", () => {
    expect(dockerCommandFailureMessage(
      'failed to do request: Head "https://10.0.21.40:3000/v2/kobuslabs/linuxclitogui/manifests/latest": http: server gave HTTP response to HTTPS client',
      "failed"
    )).toBe(
      "Docker does not trust HTTP registry '10.0.21.40:3000'. Configure it as an insecure registry on this host, then retry the deployment."
    );
  });
});
