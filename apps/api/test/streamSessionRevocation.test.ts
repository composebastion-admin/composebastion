import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const readSession = vi.hoisted(() => vi.fn());
const streamContainerLogs = vi.hoisted(() => vi.fn());
const streamContainerUsage = vi.hoisted(() => vi.fn());
const streamHostStats = vi.hoisted(() => vi.fn());

vi.mock("../src/services/auth.js", () => ({
  readSession,
  requireRole: vi.fn(() => async () => undefined)
}));

vi.mock("../src/services/docker.js", () => ({
  execInContainer: vi.fn(),
  getContainerInspect: vi.fn(),
  getContainerLogs: vi.fn(),
  getContainerStats: vi.fn(),
  getContainerUsage: vi.fn(),
  getContainerVolumeMounts: vi.fn(),
  redactInspectEnv: vi.fn(),
  streamContainerLogs,
  streamContainerUsage
}));

vi.mock("../src/services/backups.js", () => ({
  createVolumeBackupsWithJobs: vi.fn(),
  createVolumeCloneWithJob: vi.fn()
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/services/audit.js", () => ({
  auditContextFromRequest: vi.fn(() => ({})),
  writeAuditEvent: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  withTransaction: vi.fn()
}));

vi.mock("../src/services/hostMetrics.js", () => ({
  getFleetHostSnapshot: vi.fn(),
  getHostMetricsSnapshot: vi.fn(),
  streamHostStats
}));

vi.mock("../src/services/hosts.js", () => ({
  listHosts: vi.fn()
}));

const {
  handleContainerLogsStream,
  handleContainerUsageStream
} = await import("../src/routes/containers.js");
const { handleHostMetricsStream } = await import("../src/routes/hostMetrics.js");
const {
  SESSION_REAUTHORIZATION_INTERVAL_MS,
  startSessionReauthorization
} = await import("../src/services/sessionReauthorization.js");

const hostId = "00000000-0000-4000-8000-000000000002";

function fakeRequest(
  params: Record<string, string>,
  query: Record<string, unknown> = {}
) {
  return {
    params,
    query,
    cookies: { cb_session: "session-token" },
    raw: new EventEmitter(),
    log: { error: vi.fn() }
  };
}

function fakeReply() {
  const writes: string[] = [];
  const raw = {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn((value: string) => {
      writes.push(value);
      return true;
    }),
    end: vi.fn(() => {
      raw.writableEnded = true;
    })
  };
  return {
    reply: { hijack: vi.fn(), raw },
    raw,
    writes
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stream session reauthorization", () => {
  it.each([
    {
      label: "container logs",
      handle: handleContainerLogsStream,
      request: () => fakeRequest(
        { hostId, containerId: "container-1" },
        { tail: 500 }
      ),
      connect: streamContainerLogs
    },
    {
      label: "container usage",
      handle: handleContainerUsageStream,
      request: () => fakeRequest({ hostId }),
      connect: streamContainerUsage
    },
    {
      label: "host metrics",
      handle: handleHostMetricsStream,
      request: () => fakeRequest({ hostId }),
      connect: streamHostStats
    }
  ])("terminates $label after session revocation or account disable", async ({
    handle,
    request,
    connect
  }) => {
    const stopRemoteStream = vi.fn();
    connect.mockResolvedValueOnce(stopRemoteStream);
    readSession.mockResolvedValueOnce(null);
    const currentRequest = request();
    const { reply, raw, writes } = fakeReply();

    await handle(currentRequest, reply);
    expect(stopRemoteStream).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      SESSION_REAUTHORIZATION_INTERVAL_MS
    );

    expect(readSession).toHaveBeenCalledWith(
      currentRequest,
      { touch: false }
    );
    expect(stopRemoteStream).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain("Stream authorization expired");
  });

  it("fails a stream closed when session revalidation cannot reach the database", async () => {
    const stopRemoteStream = vi.fn();
    streamContainerUsage.mockResolvedValueOnce(stopRemoteStream);
    readSession.mockRejectedValueOnce(new Error("database unavailable"));
    const request = fakeRequest({ hostId });
    const { reply, raw, writes } = fakeReply();

    await handleContainerUsageStream(request, reply);
    await vi.advanceTimersByTimeAsync(
      SESSION_REAUTHORIZATION_INTERVAL_MS
    );

    expect(stopRemoteStream).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toContain(
      "Stream authorization could not be verified"
    );
    expect(request.log.error).toHaveBeenCalledTimes(1);
  });

  it("does not overlap periodic database checks for a slow session lookup", async () => {
    let resolveLookup: ((value: {
      role: "viewer";
    }) => void) | undefined;
    readSession.mockReturnValueOnce(new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    const request = fakeRequest({ hostId });
    const onFailure = vi.fn();
    const stop = startSessionReauthorization(
      request as never,
      ["viewer"],
      onFailure,
      1_000
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(readSession).toHaveBeenCalledTimes(1);

    resolveLookup?.({ role: "viewer" });
    await Promise.resolve();
    stop();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
