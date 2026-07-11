import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DockerHost } from "@composebastion/shared";
import { api } from "../api.js";

export type ContainerUsageRows = Record<string, Record<string, unknown>[]>;
export const CONTAINER_USAGE_STREAM_STALE_MS = 15_000;
export const CONTAINER_USAGE_STREAM_RETRY_MS = 60_000;

export function containerUsageStreamDecision(now: number, startedAt: number | undefined, lastMessageAt: number | undefined) {
  const freshnessReference = lastMessageAt ?? startedAt;
  return {
    poll: lastMessageAt === undefined || now - lastMessageAt >= CONTAINER_USAGE_STREAM_STALE_MS,
    reconnect: freshnessReference !== undefined && now - freshnessReference >= CONTAINER_USAGE_STREAM_RETRY_MS
  };
}

function sameUsageRow(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftId = String(left.ID ?? "");
  const rightId = String(right.ID ?? "");
  if (leftId && rightId) return leftId === rightId;
  const leftName = String(left.Name ?? left.Names ?? "");
  const rightName = String(right.Name ?? right.Names ?? "");
  return Boolean(leftName && rightName && leftName === rightName);
}

function replaceUsageRow(rows: Record<string, unknown>[], stats: Record<string, unknown>) {
  return [...rows.filter((row) => !sameUsageRow(row, stats)), stats];
}

export function useContainerUsage(hosts: DockerHost[]) {
  const [usage, setUsage] = useState<ContainerUsageRows>({});
  const inFlight = useRef(new Set<string>());
  const streams = useRef(new Map<string, EventSource>());
  const streamStartedAt = useRef(new Map<string, number>());
  const streamLastMessageAt = useRef(new Map<string, number>());
  const retryTimers = useRef(new Map<string, number>());
  const onlineHostIds = useMemo(
    () => hosts.filter((host) => host.lastStatus === "online").map((host) => host.id).sort(),
    [hosts]
  );
  const onlineHostKey = onlineHostIds.join(",");

  const loadSnapshot = useCallback(async (hostId: string) => {
    if (document.visibilityState === "hidden" || inFlight.current.has(hostId)) return;
    inFlight.current.add(hostId);
    try {
      const result = await api<{ usage: Record<string, unknown>[] }>(`/api/hosts/${hostId}/containers/usage`);
      setUsage((current) => ({ ...current, [hostId]: result.usage }));
    } catch {
      setUsage((current) => ({ ...current, [hostId]: current[hostId] ?? [] }));
    } finally {
      inFlight.current.delete(hostId);
    }
  }, []);

  useEffect(() => {
    const hostIds = onlineHostKey.split(",").filter(Boolean);
    const currentHostIds = new Set(hostIds);
    setUsage((current) => Object.fromEntries(Object.entries(current).filter(([hostId]) => currentHostIds.has(hostId))));

    const clearHost = (hostId: string) => {
      streams.current.get(hostId)?.close();
      streams.current.delete(hostId);
      streamStartedAt.current.delete(hostId);
      streamLastMessageAt.current.delete(hostId);
      const timer = retryTimers.current.get(hostId);
      if (timer !== undefined) window.clearTimeout(timer);
      retryTimers.current.delete(hostId);
    };

    const connect = (hostId: string) => {
      clearHost(hostId);
      if (document.visibilityState === "hidden" || !("EventSource" in window)) return;
      const source = new EventSource(`/api/hosts/${hostId}/containers/usage-stream`);
      streams.current.set(hostId, source);
      streamStartedAt.current.set(hostId, Date.now());
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { stats?: unknown };
          if (!payload.stats || typeof payload.stats !== "object") return;
          streamLastMessageAt.current.set(hostId, Date.now());
          setUsage((current) => ({
            ...current,
            [hostId]: replaceUsageRow(current[hostId] ?? [], payload.stats as Record<string, unknown>)
          }));
        } catch {
          // A malformed frame does not invalidate the last good snapshot.
        }
      };
      source.onerror = () => {
        source.close();
        streams.current.delete(hostId);
        streamStartedAt.current.delete(hostId);
        streamLastMessageAt.current.delete(hostId);
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
          streamLastMessageAt.current.get(hostId)
        );
        if (decision.poll) void loadSnapshot(hostId);
        if (decision.reconnect) connect(hostId);
      }
    }, 10_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(fallback);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [loadSnapshot, onlineHostKey]);

  return usage;
}
