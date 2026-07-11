import { createRedis, redisErrorType } from "./redis.js";

const JOB_WAKEUP_CHANNEL = "jobs:queued";
const RECONNECT_DELAY_MS = 5_000;

type RedisSubscriber = NonNullable<ReturnType<typeof createRedis>>;

type WakeupLogger = Pick<Console, "info" | "warn">;

export type RedisWakeupSubscription = {
  close: () => void;
};

export type RedisWakeupSubscriptionOptions = {
  onWakeup: () => void;
  createClient?: () => RedisSubscriber | null;
  logger?: WakeupLogger;
  reconnectDelayMs?: number;
};

/**
 * Keep Redis as a latency optimization only. The worker always polls PostgreSQL,
 * while this subscription reconnects independently after cold-start or runtime
 * Redis outages.
 */
export function startRedisWakeupSubscription(options: RedisWakeupSubscriptionOptions): RedisWakeupSubscription | null {
  const client = options.createClient ? options.createClient() : createRedis({ reconnect: true });
  if (!client) return null;

  const logger = options.logger ?? console;
  const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  let closed = false;
  let unavailable = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let subscribeRetryTimer: NodeJS.Timeout | null = null;
  let connectInFlight: Promise<void> | null = null;
  let subscribeInFlight: Promise<unknown> | null = null;

  const warnUnavailable = (error: unknown) => {
    if (closed || unavailable) return;
    unavailable = true;
    logger.warn("Redis subscription unavailable; database polling remains active", {
      errorType: redisErrorType(error)
    });
  };

  const subscribe = () => {
    if (closed || subscribeInFlight || client.status !== "ready") return;
    subscribeInFlight = client.subscribe(JOB_WAKEUP_CHANNEL)
      .then(() => {
        if (unavailable) logger.info("Redis job wake-up subscription restored");
        unavailable = false;
      })
      .catch((error) => {
        warnUnavailable(error);
        if (!closed && !subscribeRetryTimer) {
          subscribeRetryTimer = setTimeout(() => {
            subscribeRetryTimer = null;
            subscribe();
          }, reconnectDelayMs);
        }
      })
      .finally(() => {
        subscribeInFlight = null;
      });
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer || client.status !== "end") return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  const connect = () => {
    if (closed || connectInFlight || client.status === "ready" || client.status === "connect" || client.status === "connecting" || client.status === "reconnecting") return;
    connectInFlight = client.connect()
      .catch(warnUnavailable)
      .finally(() => {
        connectInFlight = null;
        scheduleReconnect();
      });
  };

  client.on("ready", subscribe);
  client.on("message", (channel) => {
    if (!closed && channel === JOB_WAKEUP_CHANNEL) options.onWakeup();
  });
  client.on("error", warnUnavailable);
  client.on("end", scheduleReconnect);

  connect();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (subscribeRetryTimer) clearTimeout(subscribeRetryTimer);
      reconnectTimer = null;
      subscribeRetryTimer = null;
      client.disconnect();
    }
  };
}
