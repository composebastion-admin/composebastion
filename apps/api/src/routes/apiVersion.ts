import type { FastifyInstance, HTTPMethods } from "fastify";
import type { InjectOptions, Response as InjectResponse } from "light-my-request";
import { sendApiError } from "../services/apiError.js";

type AliasMethod = NonNullable<InjectOptions["method"]>;

const aliasMethods: HTTPMethods[] = ["DELETE", "GET", "PATCH", "POST", "PUT"];
const unsupportedAliasPatterns = [
  /\/stream(?:\?|$)/,
  /\/download(?:\?|$)/,
  /\/terminal(?:\?|$)/
];

function targetUrl(rawUrl: string | undefined, wildcard: string) {
  const query = rawUrl?.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
  return `/api/${wildcard}${query}`;
}

function payloadForInject(body: unknown) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

function proxyHeaders(headers: Record<string, unknown>, requestId: string) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || Array.isArray(value)) continue;
    if (["connection", "content-length", "host"].includes(key.toLowerCase())) continue;
    next[key] = String(value);
  }
  next["x-request-id"] = requestId;
  return next;
}

export async function registerApiVersionAliasRoutes(app: FastifyInstance) {
  app.route({
    method: aliasMethods,
    url: "/api/v1/*",
    handler: async (request, reply) => {
      const wildcard = (request.params as { "*": string })["*"] ?? "";
      const url = targetUrl(request.raw.url, wildcard);

      if (unsupportedAliasPatterns.some((pattern) => pattern.test(url))) {
        return sendApiError(reply, 404, "NOT_FOUND", "This endpoint needs an explicit v1 streaming contract.");
      }

      const response = await new Promise<InjectResponse>((resolve, reject) => {
        app.inject({
          method: request.method as AliasMethod,
          url,
          headers: proxyHeaders(request.headers, request.id),
          payload: payloadForInject(request.body)
        }, (error, injectedResponse) => {
          if (error) {
            reject(error);
            return;
          }
          if (!injectedResponse) {
            reject(new Error("Missing injected response"));
            return;
          }
          resolve(injectedResponse);
        });
      });

      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined || ["connection", "content-length", "transfer-encoding"].includes(key.toLowerCase())) continue;
        reply.header(key, value);
      }

      return reply.code(response.statusCode).send(response.rawPayload);
    }
  });
}
