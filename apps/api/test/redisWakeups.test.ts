import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRedisWakeupSubscription } from "../src/services/redisWakeups.js";

class FakeRedisSubscriber extends EventEmitter {
  status = "wait";
  connectAttempts = 0;
  readonly subscribe = vi.fn(async () => 1);
  readonly disconnect = vi.fn(() => {
    this.status = "end";
  });

  async connect() {
    this.connectAttempts += 1;
    if (this.connectAttempts === 1) {
      this.status = "end";
      const error = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      this.emit("error", error);
      this.emit("end");
      throw error;
    }
    this.status = "ready";
    this.emit("ready");
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Redis worker wake-up subscription", () => {
  it("starts without Redis, reconnects, subscribes, and resumes wake-ups", async () => {
    vi.useFakeTimers();
    const client = new FakeRedisSubscriber();
    const onWakeup = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn() };

    const subscription = startRedisWakeupSubscription({
      createClient: () => client as any,
      logger,
      onWakeup,
      reconnectDelayMs: 100
    });

    await vi.waitFor(() => expect(client.connectAttempts).toBe(1));
    expect(logger.warn).toHaveBeenCalledWith(
      "Redis subscription unavailable; database polling remains active",
      { errorType: "ECONNREFUSED" }
    );

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledWith("jobs:queued"));
    expect(client.connectAttempts).toBe(2);
    expect(logger.info).toHaveBeenCalledWith("Redis job wake-up subscription restored");

    client.emit("message", "other:channel", "ignored");
    client.emit("message", "jobs:queued", "job-id");
    expect(onWakeup).toHaveBeenCalledOnce();

    subscription?.close();
    client.emit("end");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.connectAttempts).toBe(2);
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it("does nothing when Redis is not configured", () => {
    expect(startRedisWakeupSubscription({
      createClient: () => null,
      onWakeup: vi.fn()
    })).toBeNull();
  });

  it("retries a failed subscribe command without stopping database polling", async () => {
    vi.useFakeTimers();
    const client = new FakeRedisSubscriber();
    client.connectAttempts = 1;
    client.subscribe
      .mockRejectedValueOnce(Object.assign(new Error("subscribe failed"), { code: "READONLY" }))
      .mockResolvedValueOnce(1);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const subscription = startRedisWakeupSubscription({
      createClient: () => client as any,
      logger,
      onWakeup: vi.fn(),
      reconnectDelayMs: 100
    });

    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        "Redis subscription unavailable; database polling remains active",
        { errorType: "READONLY" }
      );
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(client.subscribe).toHaveBeenCalledTimes(2));
    expect(logger.info).toHaveBeenCalledWith("Redis job wake-up subscription restored");
    subscription?.close();
  });
});
