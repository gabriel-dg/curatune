// OAuth 2.0 Authorization Code flow with PKCE, entirely in the browser (no client secret, no backend).
// Follows curatune commit b3531aa, src/curatune/auth.py. Differences, all deliberate:
// - The callback is a page of this app instead of a local HTTP server; `takeCallbackParams` strips `code`
//   and `state` from the address bar and the session history before anything else runs.
// - Tokens and the pending login (verifier, state) live in the injected storage (sessionStorage in the
//   app, never localStorage), so they are per tab. Closing the tab does not reliably remove them: reopening
//   a closed tab, session restore, and duplicating a tab bring sessionStorage back. Log out removes them.
// - The current user is not fetched here; the API client reads /me when it needs it.
// Tokens, codes, and verifiers never appear in errors, logs, or the URL. Refresh tokens expire 6 months
// after the original authorization; on invalid_grant the token is discarded and AUTH_EXPIRED is raised.

import { CuratuneError } from "./errors";

export const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SCOPES = ["playlist-read-private", "playlist-modify-public", "playlist-modify-private"] as const;
export const CALLBACK_PATH = "/callback";

const TOKEN_KEY = "curatune-web.token";
const PENDING_KEY = "curatune-web.pending-login";
const ACCESS_TOKEN_SKEW_MS = 60_000;
const PENDING_LOGIN_MAX_AGE_MS = 10 * 60_000;
const REFRESH_TOKEN_LIFETIME_MONTHS = 6;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** The subset of the Web Storage API used here (sessionStorage in the app, a fake in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// --- PKCE helpers ------------------------------------------------------------------------------

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 64 random bytes encoded as base64url: 86 chars from [A-Za-z0-9_-], within the 43-128 range allowed. */
export function generateCodeVerifier(randomBytes = defaultRandomBytes): string {
  return base64Url(randomBytes(64));
}

export function generateState(randomBytes = defaultRandomBytes): string {
  return base64Url(randomBytes(32));
}

export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES.join(" "),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Comparison whose duration does not depend on where the strings differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// --- Callback URL --------------------------------------------------------------------------------

/**
 * On the OAuth callback page, return its query parameters and immediately replace the history entry
 * with "/", so `code` and `state` leave the address bar and the session history. Elsewhere, null.
 */
export function takeCallbackParams(
  location: Pick<Location, "pathname" | "search">,
  history: Pick<History, "replaceState">,
): URLSearchParams | null {
  if (location.pathname !== CALLBACK_PATH) return null;
  const params = new URLSearchParams(location.search);
  history.replaceState(null, "", "/");
  return params;
}

// --- Dates -----------------------------------------------------------------------------------------

export function addMonths(date: Date, months: number): Date {
  const monthIndex = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
  return result;
}

function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

// --- Token manager ---------------------------------------------------------------------------------

interface StoredToken {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  authorizedAt: string;
  lastRefreshedAt?: string;
}

interface PendingLogin {
  state: string;
  verifier: string;
  createdAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface AuthStatus {
  scopes: string[];
  missingScopes: string[];
  authorizedAt: string;
  refreshExpiresApprox: string;
  refreshLikelyExpired: boolean;
  accessTokenExpiresAt: string;
}

export interface AuthOptions {
  clientId: string;
  redirectUri: string;
  storage: KeyValueStorage;
  fetch: FetchLike;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

class InvalidGrant extends Error {}

function loggedOut(): CuratuneError {
  return new CuratuneError("AUTH_REQUIRED", "Logged out while the token was being refreshed. Log in again.");
}

export class SpotifyAuth {
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly storage: KeyValueStorage;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  // Concurrent requests that need a refresh share one token request.
  private refreshing: Promise<StoredToken> | null = null;
  // Incremented by logout(): a refresh that started before it must not save (or discard) a token after it.
  private epoch = 0;

  constructor(options: AuthOptions) {
    if (!options.clientId) {
      throw new CuratuneError("CONFIG_ERROR", "VITE_SPOTIFY_CLIENT_ID is not set. Add it to .env.local.");
    }
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.storage = options.storage;
    this.fetch = options.fetch;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
  }

  /** Store a fresh verifier and state, and return the Spotify authorization URL to navigate to. */
  async beginLogin(): Promise<string> {
    const verifier = generateCodeVerifier(this.randomBytes);
    const state = generateState(this.randomBytes);
    const pending: PendingLogin = { state, verifier, createdAt: this.now() };
    this.storage.setItem(PENDING_KEY, JSON.stringify(pending));
    return buildAuthorizeUrl(this.clientId, this.redirectUri, await codeChallengeFor(verifier), state);
  }

  /** Validate the callback parameters and exchange the code for tokens. */
  async completeLogin(params: URLSearchParams): Promise<void> {
    // The pending login is single-use: the verifier is removed whatever the outcome.
    const pending = this.takePendingLogin();
    if (!pending) {
      throw new CuratuneError(
        "AUTH_ERROR",
        "No login is in progress in this tab. Start the login again from this page (same tab and address).",
      );
    }
    // State is validated first, before trusting any other callback parameter.
    if (!constantTimeEqual(params.get("state") ?? "", pending.state)) {
      throw new CuratuneError("AUTH_STATE_MISMATCH", "OAuth state mismatch; the callback was rejected.");
    }
    if (this.now() - pending.createdAt > PENDING_LOGIN_MAX_AGE_MS) {
      throw new CuratuneError("AUTH_ERROR", "The login took too long. Start it again.");
    }
    const error = params.get("error");
    if (error) {
      throw new CuratuneError("AUTH_ERROR", "Authorization was denied.", { spotify_error: error });
    }
    const code = params.get("code");
    if (!code) {
      throw new CuratuneError("AUTH_ERROR", "The callback did not include an authorization code.");
    }

    let payload: TokenResponse;
    try {
      payload = await this.tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: pending.verifier,
      });
    } catch (exc) {
      if (exc instanceof InvalidGrant) {
        throw new CuratuneError("AUTH_ERROR", "Spotify rejected the authorization code. Log in again.", {
          spotify_error_description: exc.message || null,
        });
      }
      throw exc;
    }
    if (!payload.refresh_token) {
      throw new CuratuneError("AUTH_ERROR", "The token response did not include a refresh token.");
    }
    const now = this.now();
    this.save({
      clientId: this.clientId,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: now + (payload.expires_in ?? 3600) * 1000,
      scope: payload.scope ?? "",
      authorizedAt: isoSeconds(now),
    });
  }

  isLoggedIn(): boolean {
    try {
      return this.loadRequired() !== null;
    } catch {
      return false;
    }
  }

  status(): AuthStatus | null {
    let token: StoredToken;
    try {
      token = this.loadRequired();
    } catch {
      return null;
    }
    const granted = token.scope.split(/\s+/).filter(Boolean);
    const refreshExpires = addMonths(new Date(token.authorizedAt), REFRESH_TOKEN_LIFETIME_MONTHS);
    return {
      scopes: granted,
      missingScopes: SCOPES.filter((s) => !granted.includes(s)),
      authorizedAt: token.authorizedAt,
      refreshExpiresApprox: isoSeconds(refreshExpires.getTime()),
      refreshLikelyExpired: this.now() >= refreshExpires.getTime(),
      accessTokenExpiresAt: isoSeconds(token.expiresAt),
    };
  }

  logout(): void {
    this.epoch++;
    this.refreshing = null;
    this.storage.removeItem(TOKEN_KEY);
    this.storage.removeItem(PENDING_KEY);
  }

  async accessToken(forceRefresh = false): Promise<string> {
    const token = this.loadRequired();
    if (!forceRefresh && token.expiresAt - ACCESS_TOKEN_SKEW_MS > this.now()) {
      return token.accessToken;
    }
    if (!this.refreshing) {
      const refreshing = this.refresh(token).finally(() => {
        if (this.refreshing === refreshing) this.refreshing = null;
      });
      this.refreshing = refreshing;
    }
    return (await this.refreshing).accessToken;
  }

  // Internals

  private takePendingLogin(): PendingLogin | null {
    const raw = this.storage.getItem(PENDING_KEY);
    this.storage.removeItem(PENDING_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<PendingLogin>;
      if (typeof value.state === "string" && typeof value.verifier === "string" && typeof value.createdAt === "number") {
        return value as PendingLogin;
      }
    } catch {
      // Fall through: treated as no login in progress.
    }
    return null;
  }

  private loadRequired(): StoredToken {
    const raw = this.storage.getItem(TOKEN_KEY);
    if (!raw) throw new CuratuneError("AUTH_REQUIRED", "Not logged in.");
    let token: StoredToken;
    try {
      token = JSON.parse(raw) as StoredToken;
    } catch {
      this.storage.removeItem(TOKEN_KEY);
      throw new CuratuneError("AUTH_REQUIRED", "The stored token was unreadable and was discarded. Log in again.");
    }
    if (token.clientId !== this.clientId) {
      this.storage.removeItem(TOKEN_KEY);
      throw new CuratuneError("AUTH_REQUIRED", "The stored token belongs to a different client ID. Log in again.");
    }
    return token;
  }

  private save(token: StoredToken): void {
    this.storage.setItem(TOKEN_KEY, JSON.stringify(token));
  }

  private async refresh(token: StoredToken): Promise<StoredToken> {
    const epoch = this.epoch;
    let payload: TokenResponse;
    try {
      payload = await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: token.clientId,
      });
    } catch (exc) {
      if (!(exc instanceof InvalidGrant)) throw exc;
      if (epoch !== this.epoch) throw loggedOut();
      this.storage.removeItem(TOKEN_KEY);
      throw new CuratuneError(
        "AUTH_EXPIRED",
        "The refresh token is expired or revoked (Spotify refresh tokens last 6 months from the original " +
          "authorization). The stored token was discarded; log in again.",
        {
          authorized_at: token.authorizedAt,
          refresh_expires_approx: isoSeconds(
            addMonths(new Date(token.authorizedAt), REFRESH_TOKEN_LIFETIME_MONTHS).getTime(),
          ),
          spotify_error_description: exc.message || null,
        },
      );
    }
    const updated: StoredToken = {
      ...token,
      accessToken: payload.access_token,
      expiresAt: this.now() + (payload.expires_in ?? 3600) * 1000,
      scope: payload.scope || token.scope,
      // The response may or may not rotate the refresh token; keep the old one if absent.
      // authorizedAt is intentionally preserved: refreshing does not extend the 6-month limit.
      refreshToken: payload.refresh_token || token.refreshToken,
      lastRefreshedAt: isoSeconds(this.now()),
    };
    if (epoch !== this.epoch) throw loggedOut();
    this.save(updated);
    return updated;
  }

  private async tokenRequest(data: Record<string, string>): Promise<TokenResponse> {
    let resp: Response;
    try {
      resp = await this.fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(data).toString(),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (exc) {
      throw new CuratuneError("AUTH_ERROR", "Network error contacting the Spotify token endpoint.", {
        error: exc instanceof Error ? exc.name : "unknown",
      });
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body: handled below with an empty body.
    }
    if (resp.status === 200 && typeof body.access_token === "string") {
      return body as unknown as TokenResponse;
    }
    const error = typeof body.error === "string" ? body.error : null;
    const description = typeof body.error_description === "string" ? body.error_description : null;
    if (error === "invalid_grant") throw new InvalidGrant(description ?? "");
    throw new CuratuneError("AUTH_ERROR", "The Spotify token endpoint returned an error.", {
      status: resp.status,
      error,
      error_description: description,
    });
  }
}
