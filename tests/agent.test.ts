import { describe, expect, it } from "vitest";
import { SpotifyAuth } from "../src/spotify/auth";
import { SpotifyClient } from "../src/spotify/http";
import { AgentError, chatCompletionsUrl, LlmClient, stripReasoning, type ChatMessage, type ChatModel, type Completion } from "../src/agent/llm";
import { runTurn, type AgentEvent } from "../src/agent/loop";
import { SYSTEM_PROMPT } from "../src/agent/prompt";
import { READ_TOOLS } from "../src/tools";
import { buildFixture, FakeSpotify } from "./fake-spotify";
import { fakeFetch, json, MemoryStorage, noSleep, rejection } from "./helpers";

const LLM_BASE = "http://llm.test:1234/v1";

function completion(content: string, calls: [string, unknown][] = []): Completion {
  return {
    content,
    toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
    finishReason: calls.length ? "tool_calls" : "stop",
    usage: null,
  };
}

/** A model that replays scripted completions and records what it was sent. */
class ScriptedModel implements ChatModel {
  seen: ChatMessage[][] = [];
  constructor(private readonly script: ((messages: ChatMessage[]) => Completion)[]) {}
  async complete(messages: ChatMessage[]): Promise<Completion> {
    this.seen.push(structuredClone(messages));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next(messages);
  }
}

function spotifyClient() {
  const fixture = buildFixture();
  const spotify = new FakeSpotify(fixture);
  return { client: new SpotifyClient({ accessToken: async () => "token" }, { fetch: spotify.fetch, sleep: noSleep }), ids: fixture.ids };
}

const system: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

describe("runTurn", () => {
  it("answers directly when the model calls no tools", async () => {
    const { client } = spotifyClient();
    const model = new ScriptedModel([() => completion("Thelonious Monk.")]);
    const result = await runTurn(system, "Who wrote 'Round Midnight?", { model, tools: READ_TOOLS, ctx: { client } });
    expect(result.answer).toBe("Thelonious Monk.");
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("runs tools, feeds their results back, and pairs every call with a tool message", async () => {
    const { client, ids } = spotifyClient();
    const model = new ScriptedModel([
      () => completion("", [["playlists_list", {}]]),
      (messages) => {
        const listed = JSON.parse((messages.at(-1) as { content: string }).content);
        expect(listed.ok).toBe(true);
        return completion("Looking.", [["playlist_show", { playlist_id: listed.result.playlists[0].id }], ["track_show", { track_id: ids.koko }]]);
      },
      () => completion("12 tracks."),
    ]);
    const events: AgentEvent[] = [];
    const result = await runTurn(system, "Show Bebop test", { model, tools: READ_TOOLS, ctx: { client }, onEvent: (e) => events.push(e) });
    expect(result.answer).toBe("12 tracks.");
    expect(result.executions.map((e) => [e.name, e.outcome.ok])).toEqual([
      ["playlists_list", true],
      ["playlist_show", true],
      ["track_show", true],
    ]);
    const roles = result.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "tool", "tool", "assistant"]);
    const toolMessages = result.messages.filter((m) => m.role === "tool") as { tool_call_id: string }[];
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["c0", "c0", "c1"]);
    expect(events.map((e) => e.type)).toEqual([
      "model_start", "model_end", "tool_start", "tool_end",
      "model_start", "model_end", "note", "tool_start", "tool_end", "tool_start", "tool_end",
      "model_start", "model_end", "answer",
    ]);
  });

  it("returns tool errors to the model instead of failing the turn", async () => {
    const { client } = spotifyClient();
    const model = new ScriptedModel([
      () => completion("", [["playlist_show", { playlist_id: "Bebop test" }]]),
      (messages) => {
        const outcome = JSON.parse((messages.at(-1) as { content: string }).content);
        expect(outcome).toMatchObject({ ok: false, error: { code: "INVALID_REFERENCE" } });
        return completion("I need the id first.");
      },
    ]);
    const result = await runTurn(system, "Show Bebop test", { model, tools: READ_TOOLS, ctx: { client } });
    expect(result.answer).toBe("I need the id first.");
  });

  it("stops at the step limit", async () => {
    const { client } = spotifyClient();
    const model = new ScriptedModel(Array.from({ length: 3 }, (_, i) => () => completion("", [["search_tracks", { query: `q${i}` }]])));
    const result = await runTurn(system, "loop", { model, tools: READ_TOOLS, ctx: { client }, maxSteps: 3 });
    expect(result.stoppedAtLimit).toBe(true);
    expect(result.executions).toHaveLength(3);
  });

  it("does not repeat an identical call within a turn", async () => {
    const { client } = spotifyClient();
    const model = new ScriptedModel([
      () => completion("", [["search_tracks", { query: "salt", limit: 5 }]]),
      () => completion("", [["search_tracks", { limit: 5, query: "salt" }]]),
      () => completion("done"),
    ]);
    const result = await runTurn(system, "x", { model, tools: READ_TOOLS, ctx: { client } });
    expect(result.executions.map((e) => e.summary)).toEqual(["3 results", "REPEATED_CALL"]);
  });

  it("stops when the server truncates the conversation", async () => {
    const { client } = spotifyClient();
    const withTokens = (c: Completion, prompt_tokens: number): Completion => ({ ...c, usage: { prompt_tokens } });
    const model = new ScriptedModel([
      () => withTokens(completion("", [["playlists_list", {}]]), 3000),
      () => withTokens(completion("", [["search_tracks", { query: "x" }]]), 1700),
    ]);
    const err = await rejection(runTurn(system, "x", { model, tools: READ_TOOLS, ctx: { client } }), AgentError);
    expect(err.code).toBe("LLM_CONTEXT_EXCEEDED");
    expect(err.details).toEqual({ prompt_tokens: 1700, previous_prompt_tokens: 3000 });
  });

  it("skips tool calls beyond the per-step limit but still answers each one", async () => {
    const { client } = spotifyClient();
    const calls = Array.from({ length: 10 }, (_, i) => ["search_tracks", { query: `q${i}` }] as [string, unknown]);
    const model = new ScriptedModel([() => completion("", calls), () => completion("done")]);
    const result = await runTurn(system, "many", { model, tools: READ_TOOLS, ctx: { client } });
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(10);
    expect(result.executions.slice(8).map((e) => e.summary)).toEqual(["TOO_MANY_TOOL_CALLS", "TOO_MANY_TOOL_CALLS"]);
  });

  it("can be cancelled", async () => {
    const { client } = spotifyClient();
    const controller = new AbortController();
    const model = new ScriptedModel([
      () => {
        controller.abort();
        return completion("", [["playlists_list", {}]]);
      },
    ]);
    const err = await rejection(runTurn(system, "x", { model, tools: READ_TOOLS, ctx: { client }, signal: controller.signal }), AgentError);
    expect(err.code).toBe("CANCELLED");
  });
});

describe("LlmClient", () => {
  it("posts the conversation and tools to the chat completions endpoint", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({ choices: [{ message: { content: "<think>hmm</think>Hi!", tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 42 } }),
    );
    const llm = new LlmClient({ baseUrl: LLM_BASE, model: "m1", fetch });
    const result = await llm.complete([{ role: "user", content: "hello" }], []);
    expect(result).toEqual({ content: "Hi!", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 42 } });
    const req = requests[0]!;
    expect(req.url).toBe(`${LLM_BASE}/chat/completions`);
    expect(req.headers).toEqual({ "Content-Type": "application/json" });
    expect(req.init.credentials).toBe("omit");
    expect(req.init.redirect).toBe("error");
    expect(JSON.parse(req.init.body as string)).toEqual({
      model: "m1",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      tool_choice: "auto",
      stream: false,
    });
  });

  it("normalizes tool calls, filling in missing ids and object arguments", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        choices: [{
          message: { content: null, tool_calls: [{ function: { name: "playlists_list", arguments: { owned_only: true } } }, { id: "x", function: { name: "track_show", arguments: "{}" } }] },
          finish_reason: "tool_calls",
        }],
      }),
    );
    const result = await new LlmClient({ baseUrl: LLM_BASE, model: "m", fetch }).complete([], []);
    expect(result.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "playlists_list", arguments: '{"owned_only":true}' } },
      { id: "x", type: "function", function: { name: "track_show", arguments: "{}" } },
    ]);
  });

  it("maps server errors, context overflow, and network failures", async () => {
    const complete = (fetch: Parameters<typeof fakeFetch>[0]) => new LlmClient({ baseUrl: LLM_BASE, model: "m", fetch: fakeFetch(fetch).fetch }).complete([], []);
    expect((await rejection(complete(() => json({ error: "Model not loaded" }, 404)), AgentError)).code).toBe("LLM_ERROR");
    const overflow = await rejection(
      complete(() => json({ error: { message: "The number of tokens to keep from the initial prompt is greater than the context length" } }, 400)),
      AgentError,
    );
    expect(overflow.code).toBe("LLM_CONTEXT_EXCEEDED");
    expect((await rejection(complete(() => json({ choices: [] })), AgentError)).code).toBe("LLM_BAD_RESPONSE");
    const unreachable = new LlmClient({ baseUrl: LLM_BASE, model: "m", fetch: async () => { throw new TypeError("Failed to fetch"); } });
    expect((await rejection(unreachable.complete([], []), AgentError)).code).toBe("LLM_UNREACHABLE");
  });

  it("requires configuration", () => {
    expect(() => new LlmClient({ baseUrl: "", model: "m", fetch: async () => json({}) })).toThrowError(expect.objectContaining({ code: "LLM_NOT_CONFIGURED" }));
    expect(() => chatCompletionsUrl("ftp://x")).toThrowError(expect.objectContaining({ code: "LLM_NOT_CONFIGURED" }));
    expect(chatCompletionsUrl("http://h:1/v1/")).toBe("http://h:1/v1/chat/completions");
  });
});

describe("stripReasoning", () => {
  it.each([
    ["<think>a</think>b", "b"],
    ["a</think>\nb", "b"],
    ["b<think>unfinished", "b"],
    ["plain", "plain"],
  ])("%j -> %j", (input, output) => {
    expect(stripReasoning(input)).toBe(output);
  });
});

describe("security invariant: the Spotify token never reaches the LLM", () => {
  it("sends no token or authorization to the LLM endpoint across a full tool-using turn", async () => {
    const ACCESS = "SPOTIFY-ACCESS-SECRET";
    const REFRESH = "SPOTIFY-REFRESH-SECRET";
    const storage = new MemoryStorage();
    storage.setItem(
      "spotikit-web.token",
      JSON.stringify({ clientId: "cid", accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 3600_000, scope: "", authorizedAt: "2026-09-28T00:00:00Z" }),
    );
    const fixture = buildFixture();
    const spotify = new FakeSpotify(fixture);
    const spotifyRequests: { url: string; auth: string | undefined }[] = [];
    const auth = new SpotifyAuth({ clientId: "cid", redirectUri: "http://127.0.0.1:5173/callback", storage, fetch: spotify.fetch });
    const client = new SpotifyClient(auth, {
      fetch: async (input, init) => {
        spotifyRequests.push({ url: input, auth: (init?.headers as Record<string, string>).Authorization });
        return spotify.fetch(input, init);
      },
      sleep: noSleep,
    });

    let step = 0;
    const llmFetch = fakeFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as { messages: ChatMessage[] };
      step++;
      if (step === 1) return json({ choices: [{ message: { content: "", tool_calls: [{ id: "a", function: { name: "playlists_list", arguments: "{}" } }] } }] });
      if (step === 2) {
        const listed = JSON.parse((body.messages.at(-1) as { content: string }).content);
        const id = listed.result.playlists[0].id;
        return json({ choices: [{ message: { content: "", tool_calls: [{ id: "b", function: { name: "playlist_show", arguments: JSON.stringify({ playlist_id: id }) } }] } }] });
      }
      return json({ choices: [{ message: { content: "Done." } }] });
    });
    const model = new LlmClient({ baseUrl: LLM_BASE, model: "m", fetch: llmFetch.fetch });

    const result = await runTurn(system, "Show my first playlist", { model, tools: READ_TOOLS, ctx: { client } });
    expect(result.answer).toBe("Done.");

    // Spotify got the bearer token, and only Spotify did.
    expect(spotifyRequests.length).toBeGreaterThan(0);
    expect(spotifyRequests.every((r) => r.url.startsWith("https://api.spotify.com/") && r.auth === `Bearer ${ACCESS}`)).toBe(true);
    // The LLM got the conversation, never the token, a refresh token, or an Authorization header.
    expect(llmFetch.requests).toHaveLength(3);
    for (const req of llmFetch.requests) {
      expect(req.url.startsWith(LLM_BASE)).toBe(true);
      expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
      const sent = JSON.stringify(req.init.body) + JSON.stringify(req.headers);
      expect(sent).not.toContain(ACCESS);
      expect(sent).not.toContain(REFRESH);
      expect(sent).not.toMatch(/snapshot_id|Bearer/);
    }
  });
});
