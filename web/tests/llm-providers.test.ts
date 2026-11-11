import { describe, expect, it } from "vitest";
import { buildCsp } from "../config/csp";
import { runTurn } from "../src/agent/loop";
import { SYSTEM_PROMPT } from "../src/agent/prompt";
import { SpotifyAuth } from "../src/spotify/auth";
import { SpotifyClient } from "../src/spotify/http";
import { READ_TOOLS } from "../src/tools";
import { loadConfig } from "../src/config";
import { buildProviders, hostedDataNotice, LlmSettings, pickProvider, SPOTIFY_AI_TERMS } from "../src/ui/llm-providers";
import { buildFixture, FakeSpotify } from "./fake-spotify";
import { fakeFetch, json, MemoryStorage, noSleep } from "./helpers";

const HOSTED = "https://generativelanguage.googleapis.com/v1beta/openai";
const config = {
  llmBaseUrl: "http://llm.test:1234/v1",
  llmModel: "local-model",
  hostedLlm: { baseUrl: HOSTED, models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], name: "Gemini" },
};

describe("providers", () => {
  it("offers the local model, and each hosted model only when configured", () => {
    const fetch = async () => json({});
    expect(buildProviders({ ...config, hostedLlm: null }, fetch).map((p) => p.id)).toEqual(["local"]);
    const providers = buildProviders(config, fetch);
    expect(providers.map((p) => [p.id, p.label, p.requiresKey, p.host])).toEqual([
      ["local", "Local · local-model", false, "llm.test:1234"],
      ["hosted:gemini-3.8-flash", "Gemini · gemini-3.8-flash", true, "generativelanguage.googleapis.com"],
      ["hosted:gemini-3.5-flash-lite", "Gemini · gemini-3.5-flash-lite", true, "generativelanguage.googleapis.com"],
    ]);
  });

  it("reads a comma-separated list of hosted models, and needs both a URL and a model", () => {
    const env = (vars: Record<string, string>) => loadConfig(vars as unknown as ImportMetaEnv, "http://127.0.0.1:5173");
    expect(env({ VITE_HOSTED_LLM_BASE_URL: HOSTED, VITE_HOSTED_LLM_MODEL: " gemini-3.8-flash, gemini-3.5-flash-lite,,gemini-3.8-flash " }).hostedLlm).toEqual({
      baseUrl: HOSTED,
      models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
      name: "Hosted",
    });
    expect(env({ VITE_HOSTED_LLM_BASE_URL: HOSTED, VITE_HOSTED_LLM_MODEL: " , " }).hostedLlm).toBeNull();
    expect(env({ VITE_HOSTED_LLM_MODEL: "gemini-3.8-flash" }).hostedLlm).toBeNull();
  });

  it("sends each hosted model's name in the request", async () => {
    const { fetch, requests } = fakeFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
    const [, flash, lite] = buildProviders(config, fetch);
    await flash!.create("K").complete([], []);
    await lite!.create("K").complete([], []);
    expect(requests.map((r) => JSON.parse(String(r.init.body)).model)).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
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

  it("keeps one key for all the hosted models and the selection in the given storage, and forgets them", () => {
    const storage = new MemoryStorage();
    const settings = new LlmSettings(storage);
    const [local, flash, lite] = buildProviders(config, async () => json({}));
    expect(settings.apiKey(flash!)).toBeNull();
    settings.setApiKey(flash!, "  GEMINI-KEY ");
    settings.select(lite!);
    expect(settings.apiKey(flash!)).toBe("GEMINI-KEY");
    expect(settings.apiKey(lite!)).toBe("GEMINI-KEY");
    expect(settings.apiKey(local!)).toBeNull();
    expect(settings.selected()).toBe("hosted:gemini-3.5-flash-lite");
    settings.forgetApiKey(lite!);
    expect(settings.apiKey(flash!)).toBeNull();
    expect([...storage.data.keys()]).toEqual(["curatune-web.llm-provider"]);
  });

  it("leaves out an unconfigured local model when a hosted one is configured, as on the public site", () => {
    const fetch = async () => json({});
    const site = buildProviders({ llmBaseUrl: "", llmModel: "", hostedLlm: config.hostedLlm }, fetch);
    expect(site.map((p) => p.id)).toEqual(["hosted:gemini-3.8-flash", "hosted:gemini-3.5-flash-lite"]);
    expect(pickProvider(site, null).id).toBe("hosted:gemini-3.8-flash");
    expect(pickProvider(site, "local").id).toBe("hosted:gemini-3.8-flash");
    expect(site.every((p) => p.requiresKey && hostedDataNotice(p) !== null)).toBe(true);
    // Half a local setup is no local model either.
    expect(buildProviders({ ...config, llmModel: "" }, fetch).map((p) => p.id)).not.toContain("local");
    // With nothing configured, the local entry stays, so the chat says what to set.
    expect(buildProviders({ llmBaseUrl: "", llmModel: "", hostedLlm: null }, fetch).map((p) => p.id)).toEqual(["local"]);
  });

  it("picks the saved provider; an old saved \"hosted\" means the first hosted model", () => {
    const providers = buildProviders(config, async () => json({}));
    expect(pickProvider(providers, "hosted:gemini-3.5-flash-lite").model).toBe("gemini-3.5-flash-lite");
    expect(pickProvider(providers, "hosted").model).toBe("gemini-3.8-flash");
    expect(pickProvider(providers, "hosted:gone-model").id).toBe("local");
    expect(pickProvider(providers, null).id).toBe("local");
  });

  it("defaults to the local model when there is one, and says what leaves the machine only for hosted ones", () => {
    const providers = buildProviders(config, async () => json({}));
    expect(providers[0]).toMatchObject({ id: "local", hosted: false });
    expect(providers.slice(1).every((p) => p.hosted)).toBe(true);
    expect(pickProvider(providers, "unknown").id).toBe("local");
    expect(hostedDataNotice(providers[0]!)).toBeNull();
    const notice = hostedDataNotice(providers[1]!)!;
    expect(notice).toContain("Gemini · gemini-3.8-flash is a hosted model");
    expect(notice).toContain("playlist names, track names, and artists");
    expect(notice).toContain("leave this computer and go to generativelanguage.googleapis.com");
    expect(SPOTIFY_AI_TERMS.map((t) => t.label)).toEqual(["Developer Terms, section IV.2.1", "Developer Policy, section III.14"]);
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
      "curatune-web.token",
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
