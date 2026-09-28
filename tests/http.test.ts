import { describe, expect, it } from "vitest";
import { SpotikitError } from "../src/spotify/errors";
import { API_BASE, resolveUrl, SpotifyClient, type TokenProvider } from "../src/spotify/http";
import { fakeFetch, json, noSleep, rejection } from "./helpers";

const TOKEN = "BEARER-SECRET";

class FakeTokens implements TokenProvider {
  calls: boolean[] = [];
  async accessToken(forceRefresh = false): Promise<string> {
    this.calls.push(forceRefresh);
    return forceRefresh ? `${TOKEN}-2` : TOKEN;
  }
}

function setup(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const tokens = new FakeTokens();
  const { fetch, requests } = fakeFetch(handler);
  const sleeps: number[] = [];
  const client = new SpotifyClient(tokens, {
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { client, tokens, requests, sleeps };
}

const fail = (promise: Promise<unknown>) => rejection(promise, SpotikitError);

describe("resolveUrl", () => {
  it("prefixes relative paths with the API base", () => {
    expect(resolveUrl("/me").toString()).toBe(`${API_BASE}/me`);
  });

  it("accepts absolute Web API URLs", () => {
    const next = "https://api.spotify.com/v1/me/playlists?offset=50&limit=50";
    expect(resolveUrl(next).toString()).toBe(next);
    expect(resolveUrl("https://api.spotify.com:443/v1/me").host).toBe("api.spotify.com");
  });

  it.each([
    "http://api.spotify.com/v1/me",
    "https://evil.example/v1/me",
    "https://api.spotify.com.evil.example/v1/me",
    "https://api.spotify.com@evil.example/v1/me",
    "https://user:pass@api.spotify.com/v1/me",
    "https://api.spotify.com:8443/v1/me",
    "https://accounts.spotify.com/api/token",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "HTTPS://EVIL.EXAMPLE/v1",
  ])("rejects %s", (url) => {
    expect(() => resolveUrl(url)).toThrowError(expect.objectContaining({ code: "UNTRUSTED_URL" }));
  });

  it("keeps protocol-relative-looking paths on the API host", () => {
    expect(resolveUrl("//evil.example/x").host).toBe("api.spotify.com");
  });

  it("rejects relative paths without a leading slash", () => {
    expect(() => resolveUrl("me")).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("SpotifyClient.request", () => {
  it("sends the bearer token only to the Web API, with safe fetch options", async () => {
    const ctx = setup(() => json({ id: "u1" }));
    expect(await ctx.client.get("/me", { market: undefined, limit: 5, flag: null })).toEqual({ id: "u1" });
    const req = ctx.requests[0]!;
    expect(req.url).toBe(`${API_BASE}/me?limit=5`);
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.init.redirect).toBe("error");
    expect(req.init.credentials).toBe("omit");
    expect(req.init.referrerPolicy).toBe("no-referrer");
  });

  it("never calls fetch for an untrusted URL", async () => {
    const ctx = setup(() => json({}));
    const err = await fail(ctx.client.get("https://evil.example/steal"));
    expect(err.code).toBe("UNTRUSTED_URL");
    expect(ctx.requests).toHaveLength(0);
    expect(ctx.tokens.calls).toHaveLength(0);
  });

  it("sends JSON bodies", async () => {
    const ctx = setup(() => json({ snapshot_id: "s" }, 201));
    await ctx.client.request("POST", "/playlists/x/items", { json: { uris: ["spotify:track:a"] } });
    expect(ctx.requests[0]!.init.body).toBe('{"uris":["spotify:track:a"]}');
    expect(ctx.requests[0]!.headers["Content-Type"]).toBe("application/json");
  });

  it("returns null for empty bodies", async () => {
    const ctx = setup(() => new Response(null, { status: 204 }));
    expect(await ctx.client.get("/x")).toBeNull();
  });

  it("forces one token refresh on 401, then gives up", async () => {
    const ctx = setup(() => json({ error: { status: 401, message: "The access token expired" } }, 401));
    const err = await fail(ctx.client.get("/me"));
    expect(ctx.tokens.calls).toEqual([false, true]);
    expect(ctx.requests[1]!.headers.Authorization).toBe(`Bearer ${TOKEN}-2`);
    expect(err.code).toBe("API_ERROR");
    expect(err.details.status).toBe(401);
  });

  it("retries after a 401 with the refreshed token", async () => {
    const ctx = setup((_url, init) =>
      (init.headers as Record<string, string>).Authorization === `Bearer ${TOKEN}` ? json({}, 401) : json({ ok: 1 }),
    );
    expect(await ctx.client.get("/me")).toEqual({ ok: 1 });
  });

  it("honours Retry-After on 429", async () => {
    let calls = 0;
    const ctx = setup(() => (++calls === 1 ? json({}, 429, { "Retry-After": "2" }) : json({ ok: 1 })));
    expect(await ctx.client.get("/me")).toEqual({ ok: 1 });
    expect(ctx.sleeps).toEqual([2000]);
  });

  it("does not wait for a Retry-After over 60 s", async () => {
    const ctx = setup(() => json({}, 429, { "Retry-After": "120" }));
    const err = await fail(ctx.client.get("/me"));
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.details.retry_after_seconds).toBe(120);
    expect(ctx.sleeps).toEqual([]);
  });

  it("retries 5xx with backoff, then maps the error", async () => {
    const ctx = setup(() => json({ error: { status: 502, message: "Bad gateway" } }, 502));
    const err = await fail(ctx.client.get("/me"));
    expect(ctx.requests).toHaveLength(4);
    expect(ctx.sleeps).toEqual([2000, 4000, 8000]);
    expect(err.code).toBe("API_ERROR");
    expect(err.message).toBe("Spotify API error 502: Bad gateway");
  });

  it("retries network errors, then reports NETWORK_ERROR", async () => {
    const tokens = new FakeTokens();
    const client = new SpotifyClient(tokens, {
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      sleep: noSleep,
    });
    const err = await fail(client.get("/me"));
    expect(err.code).toBe("NETWORK_ERROR");
    expect(tokens.calls).toHaveLength(4);
  });

  it.each([
    [400, "API_BAD_REQUEST"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [418, "API_ERROR"],
  ])("maps %i to %s without leaking the token", async (status, code) => {
    const ctx = setup(() => json({ error: { status, message: "nope" } }, status));
    const err = await fail(ctx.client.get("/playlists/abc", { fields: "id" }));
    expect(err.code).toBe(code);
    expect(err.details).toEqual({ status, method: "GET", path: "/v1/playlists/abc", spotify_message: "nope" });
    expect(JSON.stringify(err) + err.message).not.toContain(TOKEN);
  });
});

describe("SpotifyClient.paginate", () => {
  it("follows next links", async () => {
    const ctx = setup((url) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const next = offset < 4 ? `https://api.spotify.com/v1/me/playlists?offset=${offset + 2}&limit=2` : null;
      return json({ items: [offset, offset + 1], next });
    });
    const items: number[] = [];
    for await (const item of ctx.client.paginate<number>("/me/playlists", { limit: 2 })) items.push(item);
    expect(items).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ctx.requests).toHaveLength(3);
  });

  it("refuses a next link to another host", async () => {
    const ctx = setup(() => json({ items: [1], next: "https://evil.example/v1/me/playlists?offset=1" }));
    const iterate = async () => {
      for await (const _ of ctx.client.paginate("/me/playlists")) void _;
    };
    expect((await fail(iterate())).code).toBe("UNTRUSTED_URL");
    expect(ctx.requests).toHaveLength(1);
  });
});

describe("SpotifyClient.currentUser", () => {
  it("reads /me once", async () => {
    const ctx = setup(() => json({ id: "u1", display_name: "User" }));
    expect(await ctx.client.currentUserId()).toBe("u1");
    expect(await ctx.client.currentUser()).toEqual({ id: "u1", display_name: "User" });
    expect(ctx.requests).toHaveLength(1);
  });

  it("does not cache failures", async () => {
    let calls = 0;
    const ctx = setup(() => (++calls === 1 ? json({}, 404) : json({ id: "u1" })));
    await fail(ctx.client.currentUserId());
    expect(await ctx.client.currentUserId()).toBe("u1");
  });
});
