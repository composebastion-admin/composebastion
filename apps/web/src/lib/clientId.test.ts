import { describe, expect, it, vi } from "vitest";
import { createClientId } from "./clientId.js";

describe("createClientId", () => {
  it("uses native randomUUID when available", () => {
    expect(createClientId({ randomUUID: () => "native-id" })).toBe("native-id");
  });

  it("builds a uuid from getRandomValues when randomUUID is unavailable", () => {
    const id = createClientId({
      getRandomValues: (array) => {
        const bytes = array as unknown as Uint8Array;
        bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return array;
      }
    });

    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("falls back without browser crypto support", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T00:00:00.000Z"));
    const random = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    expect(createClientId(null)).toMatch(/^id-/);

    random.mockRestore();
    vi.useRealTimers();
  });
});
