import { rename, rm, writeFile } from "node:fs/promises";

export const WORKER_READINESS_MARKER_PATH = "/tmp/composebastion-worker-ready.json";

type WorkerReadinessMarker = {
  schema: 1;
  workerId: string;
  version: string;
  registeredAt: string;
};

export async function clearWorkerReadinessMarker(
  markerPath = WORKER_READINESS_MARKER_PATH
) {
  await rm(markerPath, { force: true });
}

export async function publishWorkerReadinessMarker(
  input: { workerId: string; version: string; registeredAt?: string },
  markerPath = WORKER_READINESS_MARKER_PATH
) {
  const marker: WorkerReadinessMarker = {
    schema: 1,
    workerId: input.workerId,
    version: input.version,
    registeredAt: input.registeredAt ?? new Date().toISOString()
  };
  const temporaryPath = `${markerPath}.tmp.${process.pid}.${input.workerId}`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, markerPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return marker;
}
