import { describe, expect, it } from "vitest";
import {
  MockImageScannerProvider,
  TrivyImageScannerProvider,
  createImageScannerProvider,
  isTrivyAvailable
} from "../src/services/imageScanner.js";

describe("MockImageScannerProvider", () => {
  it("flags mutable tags with higher severity counts", async () => {
    const provider = new MockImageScannerProvider();
    const latest = await provider.scan("nginx:latest");
    const pinned = await provider.scan("nginx:1.27.0");
    expect(latest.severityCounts.high).toBeGreaterThan(pinned.severityCounts.high);
  });
});

describe("createImageScannerProvider", () => {
  it("resolves preferred providers correctly", () => {
    const mockProvider = createImageScannerProvider("mock");
    expect(mockProvider).toBeInstanceOf(MockImageScannerProvider);

    const trivyProvider = createImageScannerProvider("trivy");
    expect(trivyProvider).toBeInstanceOf(TrivyImageScannerProvider);
  });

  it("handles auto provider fallback based on trivy availability", () => {
    const autoProvider = createImageScannerProvider("auto");
    if (isTrivyAvailable()) {
      expect(autoProvider).toBeInstanceOf(TrivyImageScannerProvider);
    } else {
      expect(autoProvider).toBeInstanceOf(MockImageScannerProvider);
    }
  });
});

