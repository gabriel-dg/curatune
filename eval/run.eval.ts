// Runs the phase 2 scenarios against real models served by the configured LLM endpoint, with the fake
// Spotify (no token needed). Usage (Git Bash):
//   npm run eval                                      # VITE_LLM_MODEL, 1 run
//   EVAL_MODELS=model-a,model-b EVAL_RUNS=2 npm run eval
//   EVAL_ONLY=injection,pagination npm run eval
// Results are written to scratch/eval/ (gitignored) and summarized on stdout.

import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { LlmClient, type ChatMessage } from "../src/agent/llm";
import { runTurn } from "../src/agent/loop";
import { SYSTEM_PROMPT } from "../src/agent/prompt";
import { SpotifyClient } from "../src/spotify/http";
import { ALL_TOOLS } from "../src/tools";
import { buildFixture, FakeSpotify } from "../tests/fake-spotify";
import { grade, renderPrompt, SCENARIOS, type ScenarioResult } from "./scenarios";

const baseUrl = process.env.VITE_LLM_BASE_URL ?? "";
const models = (process.env.EVAL_MODELS || process.env.VITE_LLM_MODEL || "").split(",").map((m) => m.trim()).filter(Boolean);
const runs = Number(process.env.EVAL_RUNS || 1);
const only = (process.env.EVAL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const scenarios = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

async function loadedContext(model: string): Promise<number | null> {
  // LM Studio-specific; other servers simply do not answer this.
  try {
    const resp = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/api/v0/models/${encodeURIComponent(model)}`);
    const data = (await resp.json()) as { loaded_context_length?: number };
    return data.loaded_context_length ?? null;
  } catch {
    return null;
  }
}

async function runScenario(llm: LlmClient, scenarioIndex: number): Promise<ScenarioResult> {
  const scenario = scenarios[scenarioIndex]!;
  const fixture = buildFixture();
  const spotify = new FakeSpotify(fixture);
  const client = new SpotifyClient({ accessToken: async () => "fake-token" }, { fetch: spotify.fetch, sleep: async () => {} });
  const prompt = renderPrompt(scenario.prompt, fixture.ids);
  const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  let steps = 0;
  const started = performance.now();
  try {
    const result = await runTurn(history, prompt, {
      model: llm,
      tools: ALL_TOOLS,
      ctx: { client },
      onEvent: (e) => {
        if (e.type === "model_start") steps = e.step;
      },
    });
    const failures = grade(scenario, prompt, fixture.ids, result.executions, result.answer, result.stoppedAtLimit, spotify);
    return {
      id: scenario.id,
      passed: failures.length === 0,
      failures,
      steps,
      seconds: Math.round((performance.now() - started) / 100) / 10,
      calls: result.executions.map((e) => ({ name: e.name, args: e.args, ok: e.outcome.ok })),
      answer: result.answer,
    };
  } catch (exc) {
    const error = exc instanceof Error ? `${(exc as { code?: string }).code ?? exc.name}: ${exc.message}` : String(exc);
    return { id: scenario.id, passed: false, failures: [error], steps, seconds: Math.round((performance.now() - started) / 100) / 10, calls: [], answer: "", error };
  }
}

it(
  "evaluates models on the phase 2 scenarios",
  async () => {
    expect(baseUrl, "VITE_LLM_BASE_URL is not set").not.toBe("");
    expect(models.length, "set VITE_LLM_MODEL or EVAL_MODELS").toBeGreaterThan(0);
    mkdirSync("scratch/eval", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const summary: string[] = [];

    for (const model of models) {
      const llm = new LlmClient({ baseUrl, model, fetch: (input, init) => fetch(input, init), timeoutMs: 600_000 });
      const results: (ScenarioResult & { run: number })[] = [];
      const file = `scratch/eval/${stamp}-${model.replace(/[^\w.-]+/g, "_")}.json`;
      for (let run = 1; run <= runs; run++) {
        for (let i = 0; i < scenarios.length; i++) {
          const result = await runScenario(llm, i);
          results.push({ ...result, run });
          const context = await loadedContext(model);
          writeFileSync(file, JSON.stringify({ model, loaded_context_length: context, runs, results }, null, 2));
          console.log(`[${model} run ${run}] ${result.passed ? "PASS" : "FAIL"} ${result.id} (${result.steps} steps, ${result.seconds} s)${result.passed ? "" : ` - ${result.failures.join("; ")}`}`);
        }
      }
      const passed = results.filter((r) => r.passed).length;
      const seconds = results.reduce((sum, r) => sum + r.seconds, 0);
      summary.push(`${model}: ${passed}/${results.length} passed, ${Math.round(seconds)} s total, context ${await loadedContext(model)} (${file})`);
    }
    console.log(["", "Summary", ...summary].join("\n"));
  },
  6 * 60 * 60_000,
);
