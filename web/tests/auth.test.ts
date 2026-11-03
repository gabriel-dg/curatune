import { describe, expect, it } from "vitest";
import {
  addMonths,
  AUTHORIZE_URL,
  buildAuthorizeUrl,
  codeChallengeFor,
  constantTimeEqual,
  generateCodeVerifier,
  SCOPES,
  SpotifyAuth,
  takeCallbackParams,
  TOKEN_URL,
} from "../src/spotify/auth";
import { CuratuneError } from "../src/spotify/errors";
import { fakeFetch, json, MemoryStorage, rejection } from "./helpers";

const CLIENT_ID = "client123";
const REDIRECT = "http://127.0.0.1:5173/callback";
const CODE = "AUTH-CODE-SECRET";
const ACCESS = "ACCESS-TOKEN-SECRET";
const REFRESH = "REFRESH-TOKEN-SECRET";

type Handler = (url: URL, init: RequestInit) => Response;

const loginResponse: Handler = () =>
  json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: SCOPES.join(" ") });

function setup(handler: Handler = loginResponse) {
  const storage = new MemoryStorage();
  const { fetch, requests } = fakeFetch(handler);
  let now = Date.UTC(2026, 8, 28, 12, 0, 0);
  const auth = new SpotifyAuth({ clientId: CLIENT_ID, redirectUri: REDIRECT, storage, fetch, now: () => now });
  return { auth, storage, requests, advance: (ms: number) => (now += ms) };
}

type Ctx = ReturnType<typeof setup>;

async function begin(ctx: Ctx): Promise<URL> {
  return new URL(await ctx.auth.beginLogin());
}

async function login(ctx: Ctx): Promise<void> {
  const url = await begin(ctx);
  await ctx.auth.completeLogin(new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! }));
}

const fail = (promise: Promise<unknown>) => rejection(promise, CuratuneError);

describe("PKCE helpers", () => {
  it("generates an 86-char base64url verifier", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(generateCodeVerifier()).not.toBe(verifier);
  });

  it("computes the S256 challenge (RFC 7636 appendix B)", async () => {
    expect(await codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("builds the authorize URL with S256, state, and the playlist scopes", () => {
    const url = new URL(buildAuthorizeUrl(CLIENT_ID, REDIRECT, "challenge", "state1"));
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      code_challenge: "challenge",
      state: "state1",
      scope: "playlist-read-private playlist-modify-public playlist-modify-private",
    });
  });

  it("compares strings of any length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("adds months clamping the day", () => {
    expect(addMonths(new Date("2026-08-31T10:00:00Z"), 6).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonths(new Date("2026-03-15T00:00:00Z"), 6).toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
});

describe("takeCallbackParams", () => {
  it("returns the params and replaces the history entry with /", () => {
    const calls: unknown[][] = [];
    const params = takeCallbackParams(
      { pathname: "/callback", search: `?code=${CODE}&state=s` },
      { replaceState: (...args: unknown[]) => void calls.push(args) },
    );
    expect(params?.get("code")).toBe(CODE);
    expect(calls).toEqual([[null, "", "/"]]);
  });

  it("does nothing outside the callback path", () => {
    const calls: unknown[] = [];
    const params = takeCallbackParams({ pathname: "/", search: "?code=x" }, { replaceState: () => void calls.push(1) });
    expect(params).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("login", () => {
  it("exchanges the code at the token endpoint and stores the tokens", async () => {
    const ctx = setup();
    await login(ctx);
    expect(ctx.requests).toHaveLength(1);
    const req = ctx.requests[0]!;
    expect(req.url).toBe(TOKEN_URL);
    expect(req.init.method).toBe("POST");
    expect(req.init.redirect).toBe("error");
    expect(req.init.credentials).toBe("omit");
    const body = new URLSearchParams(req.init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe(CODE);
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(ctx.auth.isLoggedIn()).toBe(true);
    expect(await ctx.auth.accessToken()).toBe(ACCESS);
    expect(ctx.auth.status()?.missingScopes).toEqual([]);
  });

  it("sends the verifier whose challenge was in the authorize URL", async () => {
    const ctx = setup();
    const url = await begin(ctx);
    await ctx.auth.completeLogin(new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! }));
    const verifier = new URLSearchParams(ctx.requests[0]!.init.body as string).get("code_verifier")!;
    expect(await codeChallengeFor(verifier)).toBe(url.searchParams.get("code_challenge"));
  });

  it("removes the pending verifier and state after the exchange", async () => {
    const ctx = setup();
    await login(ctx);
    expect([...ctx.storage.data.keys()]).toEqual(["curatune-web.token"]);
  });

  it("rejects a state mismatch without contacting Spotify, and consumes the pending login", async () => {
    const ctx = setup();
    await begin(ctx);
    const err = await fail(ctx.auth.completeLogin(new URLSearchParams({ code: CODE, state: "forged" })));
    expect(err.code).toBe("AUTH_STATE_MISMATCH");
    expect(ctx.requests).toHaveLength(0);
    expect(ctx.storage.data.size).toBe(0);
  });

  it("rejects a missing state", async () => {
    const ctx = setup();
    await begin(ctx);
    const err = await fail(ctx.auth.completeLogin(new URLSearchParams({ code: CODE })));
    expect(err.code).toBe("AUTH_STATE_MISMATCH");
  });

  it("rejects a callback with no login in progress", async () => {
    const ctx = setup();
    const err = await fail(ctx.auth.completeLogin(new URLSearchParams({ code: CODE, state: "s" })));
    expect(err.code).toBe("AUTH_ERROR");
    expect(ctx.requests).toHaveLength(0);
  });

  it("rejects a replayed callback", async () => {
    const ctx = setup();
    const url = await begin(ctx);
    const params = new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! });
    await ctx.auth.completeLogin(params);
    const err = await fail(ctx.auth.completeLogin(params));
    expect(err.code).toBe("AUTH_ERROR");
    expect(ctx.requests).toHaveLength(1);
  });

  it("rejects a stale pending login", async () => {
    const ctx = setup();
    const url = await begin(ctx);
    ctx.advance(11 * 60_000);
    const params = new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! });
    expect((await fail(ctx.auth.completeLogin(params))).code).toBe("AUTH_ERROR");
    expect(ctx.requests).toHaveLength(0);
  });

  it("reports a denied authorization", async () => {
    const ctx = setup();
    const url = await begin(ctx);
    const params = new URLSearchParams({ error: "access_denied", state: url.searchParams.get("state")! });
    const err = await fail(ctx.auth.completeLogin(params));
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.details).toEqual({ spotify_error: "access_denied" });
  });

  it("never puts the code or verifier in errors", async () => {
    const ctx = setup(() => json({ error: "invalid_request", error_description: "bad" }, 400));
    const url = await begin(ctx);
    const { verifier } = JSON.parse(ctx.storage.dump()) as { verifier: string };
    const err = await fail(
      ctx.auth.completeLogin(new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! })),
    );
    const serialized = JSON.stringify(err) + err.message + String(err.stack);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain(verifier);
    expect(ctx.auth.isLoggedIn()).toBe(false);
  });

  it("maps invalid_grant on the code exchange to AUTH_ERROR", async () => {
    const ctx = setup(() => json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400));
    const url = await begin(ctx);
    const params = new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! });
    expect((await fail(ctx.auth.completeLogin(params))).code).toBe("AUTH_ERROR");
  });

  it("requires a refresh token", async () => {
    const ctx = setup(() => json({ access_token: ACCESS, expires_in: 3600 }));
    const url = await begin(ctx);
    const params = new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! });
    expect((await fail(ctx.auth.completeLogin(params))).code).toBe("AUTH_ERROR");
    expect(ctx.auth.isLoggedIn()).toBe(false);
  });

  it("reports network errors without their message", async () => {
    const storage = new MemoryStorage();
    const auth = new SpotifyAuth({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
      storage,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const url = new URL(await auth.beginLogin());
    const err = await fail(auth.completeLogin(new URLSearchParams({ code: CODE, state: url.searchParams.get("state")! })));
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.details).toEqual({ error: "TypeError" });
  });
});

describe("tokens", () => {
  it("requires a login", async () => {
    expect((await fail(setup().auth.accessToken())).code).toBe("AUTH_REQUIRED");
  });

  it("reuses the access token until close to expiry", async () => {
    const ctx = setup();
    await login(ctx);
    ctx.advance(3600_000 - 61_000);
    expect(await ctx.auth.accessToken()).toBe(ACCESS);
    expect(ctx.requests).toHaveLength(1);
  });

  it("refreshes near expiry, keeping authorizedAt and the refresh token if not rotated", async () => {
    let refreshes = 0;
    const ctx = setup((url, init) => {
      const body = new URLSearchParams(init.body as string);
      if (body.get("grant_type") !== "refresh_token") return loginResponse(url, init);
      refreshes++;
      expect(body.get("refresh_token")).toBe(REFRESH);
      expect(body.get("client_id")).toBe(CLIENT_ID);
      return json({ access_token: "NEW-ACCESS", expires_in: 3600 });
    });
    await login(ctx);
    const authorizedAt = ctx.auth.status()!.authorizedAt;
    ctx.advance(3600_000 - 30_000);
    expect(await ctx.auth.accessToken()).toBe("NEW-ACCESS");
    expect(refreshes).toBe(1);
    expect(ctx.auth.status()!.authorizedAt).toBe(authorizedAt);
    expect(ctx.storage.dump()).toContain(REFRESH);
    // Every token request goes to the Spotify token endpoint.
    expect(ctx.requests.every((r) => r.url === TOKEN_URL)).toBe(true);
  });

  it("shares one refresh between concurrent callers", async () => {
    let refreshes = 0;
    const ctx = setup((url, init) => {
      if (new URLSearchParams(init.body as string).get("grant_type") !== "refresh_token") return loginResponse(url, init);
      refreshes++;
      return json({ access_token: "NEW-ACCESS", refresh_token: "ROTATED", expires_in: 3600 });
    });
    await login(ctx);
    const tokens = await Promise.all([ctx.auth.accessToken(true), ctx.auth.accessToken(true)]);
    expect(tokens).toEqual(["NEW-ACCESS", "NEW-ACCESS"]);
    expect(refreshes).toBe(1);
    expect(ctx.storage.dump()).toContain("ROTATED");
  });

  it("discards the token on invalid_grant", async () => {
    const ctx = setup((url, init) => {
      if (new URLSearchParams(init.body as string).get("grant_type") !== "refresh_token") return loginResponse(url, init);
      return json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
    });
    await login(ctx);
    const err = await fail(ctx.auth.accessToken(true));
    expect(err.code).toBe("AUTH_EXPIRED");
    expect(err.details.refresh_expires_approx).toBe("2027-03-28T12:00:00Z");
    expect(JSON.stringify(err)).not.toContain(REFRESH);
    expect(ctx.auth.isLoggedIn()).toBe(false);
    expect(ctx.storage.data.size).toBe(0);
  });

  it("rejects a token stored for another client ID", async () => {
    const ctx = setup();
    await login(ctx);
    const other = new SpotifyAuth({ clientId: "other", redirectUri: REDIRECT, storage: ctx.storage, fetch: async () => json({}) });
    expect((await fail(other.accessToken())).code).toBe("AUTH_REQUIRED");
    expect(ctx.storage.data.size).toBe(0);
  });

  it("discards an unreadable stored token", async () => {
    const ctx = setup();
    ctx.storage.setItem("curatune-web.token", "{not json");
    expect((await fail(ctx.auth.accessToken())).code).toBe("AUTH_REQUIRED");
    expect(ctx.storage.data.size).toBe(0);
  });

  it("logout clears everything", async () => {
    const ctx = setup();
    await login(ctx);
    ctx.auth.logout();
    expect(ctx.storage.data.size).toBe(0);
  });

  it("requires a client ID", () => {
    const create = () =>
      new SpotifyAuth({ clientId: "", redirectUri: REDIRECT, storage: new MemoryStorage(), fetch: async () => json({}) });
    expect(create).toThrow(CuratuneError);
  });
});
