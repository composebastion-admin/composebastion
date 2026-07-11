import { describe, expect, it, vi } from "vitest";
import { createNonOverlappingTask } from "../src/services/nonOverlappingTask.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createNonOverlappingTask", () => {
  it("skips overlapping invocations and permits the next run after completion", async () => {
    const first = deferred<boolean>();
    const task = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(false);
    const runner = createNonOverlappingTask(task);

    const firstRun = runner.run();
    await expect(runner.run()).resolves.toEqual({ started: false });
    expect(task).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await expect(firstRun).resolves.toEqual({ started: true, value: true });
    await expect(runner.run()).resolves.toEqual({ started: true, value: false });
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("releases its in-flight guard after a rejection", async () => {
    const task = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(true);
    const runner = createNonOverlappingTask(task);

    await expect(runner.run()).rejects.toThrow("database unavailable");
    await expect(runner.run()).resolves.toEqual({ started: true, value: true });
  });

  it("does not start new work after it is stopped", async () => {
    const task = vi.fn().mockResolvedValue(true);
    const runner = createNonOverlappingTask(task);

    runner.stop();

    expect(runner.isStopped()).toBe(true);
    await expect(runner.run()).resolves.toEqual({ started: false });
    expect(task).not.toHaveBeenCalled();
  });
});
