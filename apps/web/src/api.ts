export function parseApiJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiErrorMessage(status: number, data: unknown) {
  if (data && typeof data === "object") {
    const payload = data as { issues?: Array<{ path?: unknown[]; message?: string }>; error?: string };
    const issue = Array.isArray(payload.issues) ? payload.issues[0] : null;
    if (issue?.message) {
      const issuePath = Array.isArray(issue.path) && issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `${issuePath}${issue.message}`;
    }
    if (typeof payload.error === "string" && payload.error) return payload.error;
  }
  return `Request failed with ${status}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers
  });

  const text = await response.text();
  const data = parseApiJson(text);
  if (!response.ok) {
    throw new Error(apiErrorMessage(response.status, data));
  }
  return data as T;
}

export function postJson<T>(path: string, body: unknown) {
  return api<T>(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function putJson<T>(path: string, body: unknown) {
  return api<T>(path, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

export function deleteJson<T>(path: string) {
  return api<T>(path, { method: "DELETE" });
}

export function patchJson<T>(path: string, body: unknown) {
  return api<T>(path, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}
