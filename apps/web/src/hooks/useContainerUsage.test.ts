import { describe, expect, it } from "vitest";
import {
  CONTAINER_USAGE_STREAM_RETRY_MS,
  CONTAINER_USAGE_STREAM_STALE_MS,
  containerUsageStreamDecision
} from "./useContainerUsage.js";

describe("container usage stream freshness", () => {
  it("keeps polling until a stream produces a valid usage frame", () => {
    expect(containerUsageStreamDecision(10_000, 0, undefined)).toEqual({ poll: true, reconnect: false });
  });

  it("polls stale streams and reconnects them after sixty seconds", () => {
    expect(containerUsageStreamDecision(CONTAINER_USAGE_STREAM_STALE_MS - 1, 0, 1)).toEqual({ poll: false, reconnect: false });
    expect(containerUsageStreamDecision(CONTAINER_USAGE_STREAM_STALE_MS + 1, 0, 1)).toEqual({ poll: true, reconnect: false });
    expect(containerUsageStreamDecision(CONTAINER_USAGE_STREAM_RETRY_MS + 1, 0, 1)).toEqual({ poll: true, reconnect: true });
  });
});
