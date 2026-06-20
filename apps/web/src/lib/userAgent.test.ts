import { describe, expect, it } from "vitest";
import { describeUserAgent } from "./userAgent.js";

describe("describeUserAgent", () => {
  it("describes common desktop browsers", () => {
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe("Firefox on Windows");
    expect(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0")).toBe("Edge on Linux");
  });

  it("describes mobile Safari and Android Chrome", () => {
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(describeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36")).toBe("Chrome on Android");
  });

  it("falls back for missing or unfamiliar agents", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent("")).toBe("Unknown device");
    expect(describeUserAgent("curl/8.4.0")).toBe("curl/8.4.0");
    expect(describeUserAgent("x".repeat(80))).toBe(`${"x".repeat(47)}...`);
  });
});
