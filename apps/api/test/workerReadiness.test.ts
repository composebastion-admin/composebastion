import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearWorkerReadinessMarker,
  publishWorkerReadinessMarker
} from "../src/services/workerReadiness.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("worker readiness marker", () => {
  it("atomically replaces stale startup evidence with the registered worker identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-worker-ready-"));
    temporaryDirectories.push(directory);
    const markerPath = path.join(directory, "ready.json");
    await writeFile(markerPath, "stale\n");

    await clearWorkerReadinessMarker(markerPath);
    const published = await publishWorkerReadinessMarker({
      workerId: "worker-123",
      version: "1.2.0-beta.2",
      registeredAt: "2026-08-09T08:00:00.000Z"
    }, markerPath);

    expect(published).toEqual({
      schema: 1,
      workerId: "worker-123",
      version: "1.2.0-beta.2",
      registeredAt: "2026-08-09T08:00:00.000Z"
    });
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual(published);
  });
});
