let accessToken: string | null = null;
const listeners = new Set<(t: string | null) => void>();

export function setAccessToken(token: string | null) {
  accessToken = token;
  listeners.forEach((l) => l(token));
}
export function getAccessToken() {
  return accessToken;
}
export function onTokenChange(fn: (t: string | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * A UI layer (the toast provider) registers here so every successful mutating
 * request — POST / PUT / PATCH / DELETE — can raise a "saved" notification
 * without each call site wiring it up. Pass `notify: false` to opt a call out,
 * or `notify: "…"` to override the headline.
 */
export interface MutationNotice {
  method: string;
  path: string;
  message?: string;
}
let mutationNotifier: ((n: MutationNotice) => void) | null = null;
export function setMutationNotifier(fn: ((n: MutationNotice) => void) | null) {
  mutationNotifier = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
      .then(async (r) => {
        if (!r.ok) return false;
        const data = await r.json();
        setAccessToken(data.accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/**
 * A request whose answer isn't JSON (audio, files): the raw Response, with the same sign-in as
 * `api()` — the access token, and one silent refresh when it has expired (401).
 */
export async function apiResponse(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (res.status === 401 && retry) {
    if (await tryRefresh()) return apiResponse(path, init, false);
    setAccessToken(null);
  }
  return res;
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit & { json?: unknown; retry?: boolean; notify?: boolean | string } = {},
): Promise<T> {
  const { json, retry = true, notify, ...init } = opts;
  const headers = new Headers(init.headers);
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(json);
  }
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(path, { ...init, headers, credentials: "include" });

  if (res.status === 401 && retry && !path.includes("/auth/")) {
    if (await tryRefresh()) return api<T>(path, { ...opts, retry: false });
    setAccessToken(null);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? res.statusText, body.details);
  }

  const method = (init.method ?? "GET").toUpperCase();
  if (
    notify !== false &&
    method !== "GET" &&
    method !== "HEAD" &&
    !path.includes("/auth/")
  ) {
    mutationNotifier?.({
      method,
      path,
      message: typeof notify === "string" ? notify : undefined,
    });
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}
