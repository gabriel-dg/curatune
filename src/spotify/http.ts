// Thin HTTP client for the Spotify Web API: auth header, retries, error mapping, pagination.
// Follows spotikit commit b3531aa, src/spotikit/http.py. Differences, all deliberate:
// - fetch is called with `redirect: "error"`, so a redirect can never carry the bearer token elsewhere.
// - Errors carry only the status, method, path, and Spotify's message; never headers or tokens.
// - No write log yet (phase 4).

import { SpotikitError } from "./errors";
import type { FetchLike } from "./auth";

export const API_HOST = "api.spotify.com";
export const API_BASE = `https://${API_HOST}/v1`;
const MAX_RETRY_AFTER_SECONDS = 60;

export interface TokenProvider {
  accessToken(forceRefresh?: boolean): Promise<string>;
}

export type Params = Record<string, string | number | boolean | null | undefined>;

export interface ClientOptions {
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface CurrentUser {
  id: string;
  display_name: string | null;
}

export interface Page<T> {
  items?: T[];
  next?: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Absolute URLs (e.g. `next` links taken from responses) must point to the Web API over HTTPS.
 * The bearer token is attached to every request, so it must never be sent to another host.
 */
export function resolveUrl(path: string): URL {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(path);
  if (!absolute && !path.startsWith("/")) {
    throw new SpotikitError("INVALID_ARGUMENT", "API paths must start with '/'.", { path });
  }
  let url: URL;
  try {
    url = new URL(absolute ? path : `${API_BASE}${path}`);
  } catch {
    throw new SpotikitError("UNTRUSTED_URL", "Refusing to send credentials to an unparseable URL.");
  }
  if (url.protocol !== "https:" || url.host !== API_HOST || url.username || url.password) {
    throw new SpotikitError("UNTRUSTED_URL", "Refusing to send credentials to a URL outside the Spotify Web API.", {
      scheme: url.protocol.replace(/:$/, ""),
      host: url.host,
    });
  }
  return url;
}

export class SpotifyClient {
  private readonly tokens: TokenProvider;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private user: Promise<CurrentUser> | null = null;

  constructor(tokens: TokenProvider, options: ClientOptions) {
    this.tokens = tokens;
    this.fetch = options.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  // --- Core request --------------------------------------------------------------------------------

  async request<T = unknown>(method: string, path: string, options: { params?: Params; json?: unknown } = {}): Promise<T> {
    const url = resolveUrl(path);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const body = options.json === undefined ? undefined : JSON.stringify(options.json);
    const logPath = url.pathname;
    let refreshed = false;
    let forceRefresh = false;
    let attempt = 0;

    while (true) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.tokens.accessToken(forceRefresh)}`,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      forceRefresh = false;

      let resp: Response;
      try {
        resp = await this.fetch(url.toString(), {
          method,
          headers,
          body,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (exc) {
        if (attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(2 ** attempt * 1000);
          continue;
        }
        throw new SpotikitError("NETWORK_ERROR", "Network error contacting Spotify.", {
          error: exc instanceof Error ? exc.name : "unknown",
          method,
          path: logPath,
        });
      }

      const status = resp.status;
      if (status >= 200 && status < 300) {
        const text = await resp.text();
        return (text ? JSON.parse(text) : null) as T;
      }

      if (status === 401 && !refreshed) {
        // Access token rejected: force one refresh and retry.
        refreshed = true;
        forceRefresh = true;
        continue;
      }

      if (status === 429) {
        const retryAfter = Number.parseInt(resp.headers.get("Retry-After") ?? "1", 10) || 1;
        if (attempt < this.maxRetries && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
          attempt += 1;
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw new SpotikitError("RATE_LIMITED", "Spotify rate limit reached.", {
          retry_after_seconds: retryAfter,
          method,
          path: logPath,
        });
      }

      if (status >= 500 && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(2 ** attempt * 1000);
        continue;
      }

      throw await mapError(resp, method, logPath);
    }
  }

  get<T = unknown>(path: string, params?: Params): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  /** Yield every element of a paging object, following `next` links (checked by `resolveUrl`). */
  async *paginate<T>(path: string, params?: Params): AsyncGenerator<T> {
    let page: Page<T> | null = await this.get<Page<T>>(path, params);
    while (page) {
      yield* page.items ?? [];
      page = page.next ? await this.get<Page<T>>(page.next) : null;
    }
  }

  // --- Current user --------------------------------------------------------------------------------

  currentUser(): Promise<CurrentUser> {
    this.user ??= this.get<{ id: string; display_name?: string | null }>("/me").then(
      (me) => ({ id: me.id, display_name: me.display_name ?? null }),
      (exc: unknown) => {
        this.user = null;
        throw exc;
      },
    );
    return this.user;
  }

  async currentUserId(): Promise<string> {
    return (await this.currentUser()).id;
  }
}

async function mapError(resp: Response, method: string, path: string): Promise<SpotikitError> {
  let body: unknown = {};
  try {
    body = await resp.json();
  } catch {
    // Non-JSON error body.
  }
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const raw = error && typeof error === "object" ? (error as { message?: unknown }).message : error;
  const spotifyMessage = typeof raw === "string" ? raw : null;
  const details = { status: resp.status, method, path, spotify_message: spotifyMessage };
  const message = `Spotify API error ${resp.status}` + (spotifyMessage ? `: ${spotifyMessage}` : "");
  if (resp.status === 400) return new SpotikitError("API_BAD_REQUEST", message, details);
  if (resp.status === 403) return new SpotikitError("FORBIDDEN", message, details);
  if (resp.status === 404) return new SpotikitError("NOT_FOUND", message, details);
  return new SpotikitError("API_ERROR", message, details);
}
