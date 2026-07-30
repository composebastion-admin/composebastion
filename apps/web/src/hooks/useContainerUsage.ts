import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dockerStatsRecordsMatch,
  isDockerStatsLifecycleTombstone,
  isDockerStatsRecord,
  type DockerHost,
  type DockerStatsRecord
} from "@composebastion/shared";
import { api } from "../api.js";

export type ContainerUsageRows = Record<string, DockerStatsRecord[]>;
export const CONTAINER_USAGE_STREAM_STALE_MS = 15_000;
export const CONTAINER_USAGE_STREAM_RETRY_MS = 60_000;
export const CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS = 60_000;

export function containerUsageStreamDecision(
  now: number,
  startedAt: number | undefined,
  lastMessageAt: number | undefined,
  lastSuccessfulSnapshotAt: number | undefined
) {
  const freshnessReference = lastMessageAt ?? startedAt;
  return {
    poll: lastMessageAt === undefined
      || now - lastMessageAt >= CONTAINER_USAGE_STREAM_STALE_MS
      || lastSuccessfulSnapshotAt === undefined
      || now - lastSuccessfulSnapshotAt >= CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS,
    reconnect: freshnessReference !== undefined && now - freshnessReference >= CONTAINER_USAGE_STREAM_RETRY_MS
  };
}

export function containerUsageSnapshotRequestGeneration(
  activeGeneration: number | undefined,
  inFlightGeneration: number | undefined
) {
  return activeGeneration !== undefined && activeGeneration !== inFlightGeneration
    ? activeGeneration
    : null;
}

export function isContainerUsageSnapshotRequestCurrent(
  activeGeneration: number | undefined,
  requestGeneration: number
) {
  return activeGeneration === requestGeneration;
}

export function reduceContainerUsageRows(rows: DockerStatsRecord[], stats: unknown) {
  if (!isDockerStatsRecord(stats)) return rows;
  return [...rows.filter((row) => !dockerStatsRecordsMatch(row, stats)), stats];
}

export function parseContainerUsageSnapshot(value: unknown) {
  if (!Array.isArray(value)) return null;
  let rows: DockerStatsRecord[] = [];
  for (const stats of value) {
    if (isDockerStatsLifecycleTombstone(stats)) continue;
    if (!isDockerStatsRecord(stats)) return null;
    rows = reduceContainerUsageRows(rows, stats);
  }
  return rows;
}

export function useContainerUsage(hosts: DockerHost[]) {
  const [usage, setUsage] = useState<ContainerUsageRows>({});
  const lifecycleGeneration = useRef(0);
  const activeHostGenerations = useRef(new Map<string, number>());
  const inFlightGenerations = useRef(new Map<string, number>());
  const streams = useRef(new Map<string, EventSource>());
  const streamStartedAt = useRef(new Map<string, number>());
  const streamLastMessageAt = useRef(new Map<string, number>());
  const lastSuccessfulSnapshotAt = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, number>());
  const onlineHostIds = useMemo(
    () => hosts.filter((host) => host.lastStatus === "online").map((host) => host.id).sort(),
    [hosts]
  );
  const onlineHostKey = onlineHostIds.join(",");

  const loadSnapshot = useCallback(async (hostId: string) => {
    if (document.visibilityState === "hidden") return;
    const requestGeneration = containerUsageSnapshotRequestGeneration(
      activeHostGenerations.current.get(hostId),
      inFlightGenerations.current.get(hostId)
    );
    if (requestGeneration === null) return;
    inFlightGenerations.current.set(hostId, requestGeneration);
    const requestIsCurrent = () => isContainerUsageSnapshotRequestCurrent(
      activeHostGenerations.current.get(hostId),
      requestGeneration
    );
    try {
      const result = await api<{ usage: unknown }>(`/api/hosts/${hostId}/containers/usage`);
      const snapshot = parseContainerUsageSnapshot(result.usage);
      if (!snapshot) throw new Error("Container usage snapshot is malformed");
      if (!requestIsCurrent()) return;
      lastSuccessfulSnapshotAt.current.set(hostId, Date.now());
      setUsage((current) => requestIsCurrent()
        ? { ...current, [hostId]: snapshot }
        : current);
    } catch {
      if (!requestIsCurrent()) return;
      setUsage((current) => requestIsCurrent()
        ? { ...current, [hostId]: current[hostId] ?? [] }
        : current);
    } finally {
      if (inFlightGenerations.current.get(hostId) === requestGeneration) {
        inFlightGenerations.current.delete(hostId);
      }
    }
  }, []);

  useEffect(() => {
    const hostIds = onlineHostKey.split(",").filter(Boolean);
    const currentHostIds = new Set(hostIds);
    const generation = lifecycleGeneration.current + 1;
    lifecycleGeneration.current = generation;
    for (const hostId of hostIds) activeHostGenerations.current.set(hostId, generation);
    setUsage((current) => Object.fromEntries(Object.entries(current).filter(([hostId]) => currentHostIds.has(hostId))));

    const clearHost = (hostId: string) => {
      streams.current.get(hostId)?.close();
      streams.current.delete(hostId);
      streamStartedAt.current.delete(hostId);
      streamLastMessageAt.current.delete(hostId);
      lastSuccessfulSnapshotAt.current.delete(hostId);
      const timer = retryTimers.current.get(hostId);
      if (timer !== undefined) window.clearTimeout(timer);
      retryTimers.current.delete(hostId);
    };

    const connect = (hostId: string) => {
      if (!isContainerUsageSnapshotRequestCurrent(activeHostGenerations.current.get(hostId), generation)) return;
      clearHost(hostId);
      if (document.visibilityState === "hidden" || !("EventSource" in window)) return;
      const source = new EventSource(`/api/hosts/${hostId}/containers/usage-stream`);
      streams.current.set(hostId, source);
      streamStartedAt.current.set(hostId, Date.now());
      source.onmessage = (event) => {
        if (
          !isContainerUsageSnapshotRequestCurrent(activeHostGenerations.current.get(hostId), generation)
          || streams.current.get(hostId) !== source
        ) return;
        try {
          const payload = JSON.parse(event.data) as { stats?: unknown };
          if (!isDockerStatsRecord(payload.stats)) return;
          streamLastMessageAt.current.set(hostId, Date.now());
          setUsage((current) => (
            isContainerUsageSnapshotRequestCurrent(activeHostGenerations.current.get(hostId), generation)
              ? {
                  ...current,
                  [hostId]: reduceContainerUsageRows(current[hostId] ?? [], payload.stats)
                }
              : current
          ));
        } catch {
          // A malformed frame does not invalidate the last good snapshot.
        }
      };
      source.onerror = () => {
        if (
          !isContainerUsageSnapshotRequestCurrent(activeHostGenerations.current.get(hostId), generation)
          || streams.current.get(hostId) !== source
        ) return;
        clearHost(hostId);
        void loadSnapshot(hostId);
        retryTimers.current.set(hostId, window.setTimeout(() => connect(hostId), 60_000));
      };
    };

    const start = () => {
      if (document.visibilityState === "hidden") return;
      for (const hostId of hostIds) {
        void loadSnapshot(hostId);
        connect(hostId);
      }
    };
    const stop = () => hostIds.forEach(clearHost);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };

    start();
    const fallback = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      for (const hostId of hostIds) {
        const decision = containerUsageStreamDecision(
          Date.now(),
          streamStartedAt.current.get(hostId),
          streamLastMessageAt.current.get(hostId),
          lastSuccessfulSnapshotAt.current.get(hostId)
        );
        if (decision.poll) void loadSnapshot(hostId);
        if (decision.reconnect) connect(hostId);
      }
    }, 10_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const hostId of hostIds) {
        if (activeHostGenerations.current.get(hostId) === generation) {
          activeHostGenerations.current.delete(hostId);
        }
        if (inFlightGenerations.current.get(hostId) === generation) {
          inFlightGenerations.current.delete(hostId);
        }
      }
      stop();
    };
  }, [loadSnapshot, onlineHostKey]);

  return usage;
}
