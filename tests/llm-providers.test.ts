import { describe, expect, it } from "vitest";
import { buildCsp } from "../config/csp";
import { runTurn } from "../src/agent/loop";
import { SYSTEM_PROMPT } from "../src/agent/prompt";
import { SpotifyAuth } from "../src/spotify/auth";
import { SpotifyClient } from "../src/spotify/http";
import { READ_TOOLS } from "../src/tools";
import { buildProviders, LlmSettings } from "../src/ui/llm-providers";
import { buildFixture, FakeSpotify } from "./fake-spotify";
import { fakeFetch, json, MemoryStorage, noSleep } from "./helpers";

const HOSTED = "https://generativelanguage.googleapis.com/v1beta/openai";
const config = {
  llmBaseUrl: "http://llm.test:1234/v1",
  llmModel: "local-model",
  hostedLlm: { baseUrl: HOSTED, model: "gemini-3.8-flash", name: "Gemini" },
};

describe("providers", () => {
  it("offers the local model, and the hosted one only when configured", () => {
    const fetch = async () => json({});
    expect(buildProviders({ ...config, hostedLlm: null }, fetch).map((p) => p.id)).toEqual(["local"]);
    const providers = buildProviders(config, fetch);
    expect(providers.map((p) => [p.id, p.label, p.requiresKey, p.host])).toEqual([
      ["local", "Local · local-model", false, "llm.test:1234"],
      ["hosted", "Gemini · gemini-3.8-flash", true, "generativelanguage.googleapis.com"],
    ]);
  });

  it("sends the hosted key only to the hosted endpoint, and no key to the local one", async () => {
    const { fetch, requests } = fakeFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
    const [local, hosted] = buildProviders(config, fetch);
    await local!.create(null).complete([], []);
    await hosted!.create("GEMINI-KEY").complete([], []);
    expect(requests[0]!.url).toBe("http://llm.test:1234/v1/chat/completions");
    expect(requests[0]!.headers.Authorization).toBeUndefined();
    expect(requests[1]!.url).toBe(`${HOSTED}/chat/completions`);
    expect(requests[1]!.headers.Authorization).toBe("Bearer GEMINI-KEY");
  });

  it("keeps keys and the selection per provider in the given storage, and forgets them", () => {
    const storage = new MemoryStorage();
    const settings = new LlmSettings(storage);
    const [, hosted] = buildProviders(config, async () => json({}));
    expect(settings.apiKey(hosted!)).toBeNull();
    settings.setApiKey(hosted!, "  GEMINI-KEY ");
    settings.select(hosted!);
    expect(settings.apiKey(hosted!)).toBe("GEMINI-KEY");
    expect(settings.selected()).toBe("hosted");
    settings.forgetApiKey(hosted!);
    expect(settings.apiKey(hosted!)).toBeNull();
    expect([...storage.data.keys()]).toEqual(["spotikit-web.llm-provider"]);
  });
});

describe("CSP with a hosted provider", () => {
  it("adds the hosted origin to connect-src only", () => {
    const csp = buildCsp({ llmBaseUrl: config.llmBaseUrl, hostedLlmBaseUrl: HOSTED });
    expect(csp).toContain("connect-src 'self' https://accounts.spotify.com https://api.spotify.com http://llm.test:1234 https://generativelanguage.googleapis.com;");
    expect(csp).toContain("script-src 'self';");
  });

  it("does not repeat an origin and names the bad variable", () => {
    expect(buildCsp({ llmBaseUrl: HOSTED, hostedLlmBaseUrl: HOSTED }).match(/generativelanguage/g)).toHaveLength(1);
    expect(() => buildCsp({ hostedLlmBaseUrl: "nope" })).toThrow(/VITE_HOSTED_LLM_BASE_URL/);
  });
});

describe("security invariant with a hosted provider", () => {
  it("the Spotify token never reaches the hosted model, and its key never reaches Spotify", async () => {
    const ACCESS = "SPOTIFY-ACCESS-SECRET";
    const KEY = "GEMINI-KEY-SECRET";
    const storage = new MemoryStorage();
    storage.setItem(
      "spotikit-web.token",
      JSON.stringify({ clientId: "cid", accessToken: ACCESS, refreshToken: "R", expiresAt: Date.now() + 3600_000, scope: "", authorizedAt: "2026-09-28T00:00:00Z" }),
    );
    const spotify = new FakeSpotify(buildFixture());
    const spotifyRequests: RequestInit[] = [];
    const auth = new SpotifyAuth({ clientId: "cid", redirectUri: "http://127.0.0.1:5173/callback", storage, fetch: spotify.fetch });
    const client = new SpotifyClient(auth, {
      fetch: async (input, init) => {
        spotifyRequests.push(init ?? {});
        return spotify.fetch(input, init);
      },
      sleep: noSleep,
    });
    let step = 0;
    const llm = fakeFetch(() =>
      ++step === 1
        ? json({ choices: [{ message: { content: "", tool_calls: [{ id: "a", function: { name: "playlists_list", arguments: "{}" } }] } }] })
        : json({ choices: [{ message: { content: "Done." } }] }),
    );
    const [, hosted] = buildProviders(config, llm.fetch);
    await runTurn([{ role: "system", content: SYSTEM_PROMPT }], "list", { model: hosted!.create(KEY), tools: READ_TOOLS, ctx: { client } });

    expect(spotifyRequests.length).toBeGreaterThan(0);
    for (const init of spotifyRequests) expect(JSON.stringify(init)).not.toContain(KEY);
    expect(llm.requests).toHaveLength(2);
    for (const req of llm.requests) {
      expect(req.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(req.init.body) + JSON.stringify(req.headers)).not.toContain(ACCESS);
    }
  });
});
