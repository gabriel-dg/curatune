// The agent loop: send the conversation to the model, run the tools it asks for, feed the results back,
// until it answers in text or a limit is reached. Tools run in the browser; the model only sees their
// trimmed JSON results.

import { executeTool, toolDefinitions, type Tool, type ToolContext, type ToolExecution } from "../tools";
import { AgentError, type ChatMessage, type ChatModel, type ToolCall } from "./llm";

export const DEFAULT_MAX_STEPS = 12;
export const MAX_TOOL_CALLS_PER_STEP = 8;

export type AgentEvent =
  | { type: "model_start"; step: number }
  | { type: "model_end"; step: number; ms: number; promptTokens: number | null }
  | { type: "note"; content: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; execution: ToolExecution }
  /** The conversation after a step's tool results, a valid point to resume from if the turn fails later. */
  | { type: "checkpoint"; messages: ChatMessage[] }
  | { type: "answer"; content: string };

export interface TurnOptions {
  model: ChatModel;
  tools: Tool[];
  ctx: ToolContext;
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  now?: () => number;
}

export interface TurnResult {
  /** The whole conversation after this turn (input history + new messages). */
  messages: ChatMessage[];
  answer: string;
  stoppedAtLimit: boolean;
  executions: ToolExecution[];
}

/** Identity of a call: tool name plus arguments with keys sorted, so formatting differences do not matter. */
function callKey(call: ToolCall): string {
  try {
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    const sorted = Object.fromEntries(Object.keys(args).sort().map((k) => [k, args[k]]));
    return `${call.function.name} ${JSON.stringify(sorted)}`;
  } catch {
    return `${call.function.name} ${call.function.arguments}`;
  }
}

function skipped(call: ToolCall, code: string, message: string): ToolExecution {
  const outcome = { ok: false as const, error: { code, message } };
  return { name: call.function.name, args: null, outcome, content: JSON.stringify(outcome), summary: code, ms: 0, write: null };
}

const ID_RE = /[A-Za-z0-9]{22}/g;

/** IDs the conversation has seen from a trustworthy source: the user's messages and tool results. */
function knownIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if ((m.role === "user" || m.role === "tool") && m.content) {
      for (const id of m.content.match(ID_RE) ?? []) ids.add(id);
    }
  }
  return ids;
}

export async function runTurn(history: ChatMessage[], userText: string, options: TurnOptions): Promise<TurnResult> {
  const { model, tools, ctx, signal, onEvent = () => {} } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const now = options.now ?? (() => performance.now());
  const definitions = toolDefinitions(tools);
  const messages: ChatMessage[] = [...history, { role: "user", content: userText }];
  const executions: ToolExecution[] = [];
  const seenCalls = new Set<string>();
  let lastPromptTokens: number | null = null;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) throw new AgentError("CANCELLED", "Stopped.");
    onEvent({ type: "model_start", step });
    const started = now();
    const completion = await model.complete(messages, definitions, signal);
    const promptTokens = completion.usage?.prompt_tokens ?? null;
    onEvent({ type: "model_end", step, ms: now() - started, promptTokens });
    // Within a turn the conversation only grows. Fewer prompt tokens than the previous step means the
    // server silently dropped part of it (LM Studio does this when the context length is too small),
    // so the model no longer sees earlier tool results and its answer cannot be trusted.
    if (promptTokens !== null && lastPromptTokens !== null && promptTokens < lastPromptTokens) {
      throw new AgentError(
        "LLM_CONTEXT_EXCEEDED",
        "The LLM server truncated the conversation because it does not fit in the model's context. Load the " +
          "model with a larger context length in LM Studio (for example 32768), or start a new chat.",
        { prompt_tokens: promptTokens, previous_prompt_tokens: lastPromptTokens },
      );
    }
    lastPromptTokens = promptTokens ?? lastPromptTokens;

    if (completion.toolCalls.length === 0) {
      const answer = completion.content || "(The model returned an empty answer.)";
      messages.push({ role: "assistant", content: answer });
      onEvent({ type: "answer", content: answer });
      return { messages, answer, stoppedAtLimit: false, executions };
    }

    messages.push({ role: "assistant", content: completion.content || null, tool_calls: completion.toolCalls });
    if (completion.content) onEvent({ type: "note", content: completion.content });

    // Every tool call gets exactly one tool message, in order, as the API requires.
    for (const [index, call] of completion.toolCalls.entries()) {
      if (signal?.aborted) throw new AgentError("CANCELLED", "Stopped.");
      onEvent({ type: "tool_start", call });
      const key = callKey(call);
      let execution: ToolExecution;
      if (index >= MAX_TOOL_CALLS_PER_STEP) {
        execution = skipped(call, "TOO_MANY_TOOL_CALLS", `At most ${MAX_TOOL_CALLS_PER_STEP} tool calls per step; this one was skipped.`);
      } else if (seenCalls.has(key)) {
        execution = skipped(call, "REPEATED_CALL", "You already made this exact call in this turn. Use its earlier result.");
      } else {
        seenCalls.add(key);
        const known = knownIds(messages);
        execution = await executeTool(tools, call.function.name, call.function.arguments, { ...ctx, isKnownId: (id) => known.has(id) }, now);
      }
      executions.push(execution);
      messages.push({ role: "tool", tool_call_id: call.id, content: execution.content });
      onEvent({ type: "tool_end", call, execution });
    }
    onEvent({ type: "checkpoint", messages: [...messages] });
  }

  // Step limit reached: one last call without tools, so the user gets what was done and found so far
  // instead of nothing (earlier writes and plans already happened and are shown in the UI).
  messages.push({ role: "user", content: STEP_LIMIT_NOTICE });
  if (signal?.aborted) throw new AgentError("CANCELLED", "Stopped.");
  onEvent({ type: "model_start", step: maxSteps + 1 });
  const started = now();
  let answer: string;
  try {
    const completion = await model.complete(messages, [], signal);
    onEvent({ type: "model_end", step: maxSteps + 1, ms: now() - started, promptTokens: completion.usage?.prompt_tokens ?? null });
    answer = completion.toolCalls.length === 0 && completion.content ? completion.content : FALLBACK_LIMIT_ANSWER(maxSteps);
  } catch (exc) {
    if (exc instanceof AgentError && exc.code === "CANCELLED") throw exc;
    answer = FALLBACK_LIMIT_ANSWER(maxSteps);
  }
  messages.push({ role: "assistant", content: answer });
  onEvent({ type: "answer", content: answer });
  return { messages, answer, stoppedAtLimit: true, executions };
}

const STEP_LIMIT_NOTICE =
  "[App notice: the step limit for this request was reached, so no more tools can be called now. Tell the " +
  "user briefly what you did and found so far, what is still missing, and suggest a narrower next request.]";

const FALLBACK_LIMIT_ANSWER = (steps: number) =>
  `Stopped after ${steps} model steps without a final answer. Try a more specific request.`;
