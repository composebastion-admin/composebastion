import { useEffect, useState } from "react";
import type { HostStats } from "@dockermender/shared";

export type HostStatsStreamState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export function useHostStatsStream(hostId: string | null | undefined) {
  const [stats, setStats] = useState<HostStats | null>(null);
  const [state, setState] = useState<HostStatsStreamState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hostId || !("EventSource" in window)) {
      setState("idle");
      return undefined;
    }

    setState("connecting");
    setError(null);
    const source = new EventSource(`/api/hosts/${hostId}/metrics-stream`);
    source.onopen = () => {
      setState("open");
      setError(null);
    };
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { stats?: HostStats };
        if (payload.stats) setStats(payload.stats);
      } catch {
        setError("Could not parse host metrics stream event.");
      }
    };
    source.addEventListener("error", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { error?: string };
        if (payload.error) setError(payload.error);
      } catch {
        setError("Host metrics stream is reconnecting.");
      }
      setState("reconnecting");
    });
    source.onerror = () => {
      setState("reconnecting");
      setError("Host metrics stream is reconnecting.");
    };

    return () => {
      source.close();
      setState("closed");
    };
  }, [hostId]);

  return { stats, state, error };
}
