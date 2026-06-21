import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import type { LookupFunction } from "node:net";
import { resolveAgentHostname, selectAgentAddress, shouldAllowPrivateOutboundUrls, type LookupAll } from "./ssrf.js";

type WebhookOptions = {
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  resolve?: LookupAll;
};

export function shouldAllowPrivateWebhookUrls(nodeEnv: string, allowPrivateWebhookUrls: boolean) {
  return shouldAllowPrivateOutboundUrls(nodeEnv, allowPrivateWebhookUrls);
}

function parseWebhookUrl(urlStr: string) {
  const parsed = new URL(urlStr);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use http or https");
  }
  return parsed;
}

async function createPinnedLookup(parsed: URL, allowPrivateNetwork: boolean, resolve?: LookupAll): Promise<LookupFunction> {
  const addresses = await resolveAgentHostname(parsed.hostname, resolve);
  const selected = selectAgentAddress(addresses, allowPrivateNetwork);
  return ((_hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (typeof callback !== "function") return;
    if (typeof optionsOrCallback === "object" && optionsOrCallback && "all" in optionsOrCallback && optionsOrCallback.all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

export async function validateWebhookUrl(urlStr: string, options: WebhookOptions = {}) {
  try {
    const parsed = parseWebhookUrl(urlStr);
    await createPinnedLookup(parsed, Boolean(options.allowPrivateNetwork), options.resolve);
    return true;
  } catch {
    return false;
  }
}

export async function postJsonWebhook(urlStr: string, payload: unknown, options: WebhookOptions = {}) {
  const parsed = parseWebhookUrl(urlStr);
  const lookup = await createPinnedLookup(parsed, Boolean(options.allowPrivateNetwork), options.resolve);
  const body = JSON.stringify(payload);
  const transport = parsed.protocol === "https:" ? https : http;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<{ ok: boolean; statusCode: number }>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        lookup,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          finish(() => resolve({ ok: statusCode >= 200 && statusCode < 300, statusCode }));
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Webhook request timed out"));
    });
    request.on("error", (error) => finish(() => reject(error)));
    request.write(body);
    request.end();
  });
}
