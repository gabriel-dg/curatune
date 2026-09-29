// Client for an OpenAI-compatible chat completions endpoint (LM Studio, Ollama; for evaluations also hosted
// APIs such as Gemini's). It only ever sends the conversation and tool definitions: no Spotify token, no
// cookies. The only Authorization header it can send is the LLM provider's own API key, when one is given.

import type { ToolDefinition } from "../tools/types";
import type { FetchLike } from "../spotify/auth";

export type AgentErrorCode =
  | "LLM_NOT_CONFIGURED"
  | "LLM_UNREACHABLE"
  | "LLM_TIMEOUT"
  | "LLM_ERROR"
  | "LLM_CONTEXT_EXCEEDED"
  | "LLM_QUOTA_EXCEEDED"
  | "LLM_BAD_RESPONSE"
  | "CANCELLED";

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AgentErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.details = details;
  }
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Provider data attached to the call, sent back unchanged in the history (Gemini 3 models put their
   * "thought signature" here, and later requests with tool calls fail without it).
   */
  extra_content?: unknown;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** What the agent loop needs from a model; the eval and the tests provide their own. */
export interface ChatModel {
  complete(messages: ChatMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<Completion>;
}

export interface LlmOptions {
  baseUrl: string;
  model: string;
  fetch: FetchLike;
  timeoutMs?: number;
  /** The LLM provider's API key (hosted APIs). Never a Spotify credential. */
  apiKey?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after 429 (rate limit) or 503 (overloaded). */
  maxRetries?: number;
}

const MAX_RETRY_WAIT_MS = 60_000;

/** Remove reasoning blocks some models put in `content` (<think>…</think>, or a lone closing tag). */
export function stripReasoning(content: string): string {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const close = text.indexOf("</think>");
  if (close !== -1) text = text.slice(close + "</think>".length);
  return text.replace(/<think>[\s\S]*$/, "").trim();
}

export function chatCompletionsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.replace(/\/+$/, "") + "/chat/completions");
  } catch {
    throw new AgentError("LLM_NOT_CONFIGURED", "VITE_LLM_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentError("LLM_NOT_CONFIGURED", "VITE_LLM_BASE_URL must use http or https.");
  }
  return url.toString();
}

export class LlmClient implements ChatModel {
  private readonly url: string;
  private readonly model: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly apiKey: string | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private callCounter = 0;

  constructor(options: LlmOptions) {
    if (!options.baseUrl || !options.model) {
      throw new AgentError("LLM_NOT_CONFIGURED", "Set VITE_LLM_BASE_URL and VITE_LLM_MODEL in .env.local.");
    }
    this.url = chatCompletionsUrl(options.baseUrl);
    this.model = options.model;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.apiKey = options.apiKey?.trim() || null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
  }

  get modelName(): string {
    return this.model;
  }

  async complete(messages: ChatMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<Completion> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.completeOnce(messages, tools, signal);
      } catch (exc) {
        const status = exc instanceof AgentError && exc.code === "LLM_ERROR" ? exc.details.status : undefined;
        if (!(status === 429 || status === 503) || attempt >= this.maxRetries || signal?.aborted) throw exc;
        const retryAfter = Number((exc as AgentError).details.retry_after_seconds);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        if (wait > MAX_RETRY_WAIT_MS) throw exc;
        await this.sleep(wait);
        if (signal?.aborted) throw new AgentError("CANCELLED", "Stopped.");
      }
    }
  }

  private async completeOnce(messages: ChatMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<Completion> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    // Some providers reject an empty tools list together with tool_choice.
    const payload: Record<string, unknown> = { model: this.model, messages, stream: false };
    if (tools.length) Object.assign(payload, { tools, tool_choice: "auto" });
    let resp: Response;
    try {
      resp = await this.fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: combined,
      });
    } catch (exc) {
      if (signal?.aborted) throw new AgentError("CANCELLED", "Stopped.");
      if (timeout.aborted) {
        throw new AgentError("LLM_TIMEOUT", `The model did not answer within ${Math.round(this.timeoutMs / 1000)} s.`);
      }
      throw new AgentError("LLM_UNREACHABLE", "Cannot reach the LLM server. Is LM Studio running and reachable?", {
        error: exc instanceof Error ? exc.name : "unknown",
      });
    }

    let body: Record<string, unknown> | null = null;
    try {
      const parsed = (await resp.json()) as unknown;
      // Gemini's OpenAI-compatible endpoint wraps error bodies in an array.
      body = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
    } catch {
      // Handled below.
    }
    if (!resp.ok) {
      const error = body?.error;
      const raw = error && typeof error === "object" ? (error as { message?: unknown }).message : error;
      const message = typeof raw === "string" ? raw.slice(0, 500) : null;
      if (resp.status === 429 && /per ?day|daily/i.test(JSON.stringify(error ?? ""))) {
        // A daily quota: retrying within this request cannot help.
        throw new AgentError("LLM_QUOTA_EXCEEDED", "The LLM provider's daily quota is used up. Try again tomorrow or use another model.", {
          status: resp.status,
          daily: true,
        });
      }
      if (message && /context (length|window|size)|too many tokens|n_ctx|context.*(exceed|overflow)/i.test(message)) {
        throw new AgentError(
          "LLM_CONTEXT_EXCEEDED",
          "The conversation no longer fits in the model's context. Start a new chat, or load the model with a " +
            "larger context length in LM Studio.",
          { status: resp.status, server_message: message },
        );
      }
      throw new AgentError("LLM_ERROR", `The LLM server returned an error (${resp.status})${message ? `: ${message}` : ""}.`, {
        status: resp.status,
        retry_after_seconds: Number(resp.headers.get("Retry-After")) || undefined,
      });
    }

    const choice = (body?.choices as unknown[] | undefined)?.[0] as
      | { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
      | undefined;
    if (!choice?.message) throw new AgentError("LLM_BAD_RESPONSE", "The LLM response has no message.");
    const rawCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    const toolCalls: ToolCall[] = rawCalls.map((call: { id?: unknown; function?: { name?: unknown; arguments?: unknown }; extra_content?: unknown }) => ({
      // Some servers omit ids; the loop needs one per call to pair results with calls.
      id: typeof call.id === "string" && call.id ? call.id : `call_${++this.callCounter}`,
      type: "function",
      function: {
        name: typeof call.function?.name === "string" ? call.function.name : "",
        arguments:
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {}),
      },
      ...(call.extra_content !== undefined ? { extra_content: call.extra_content } : {}),
    }));
    return {
      content: typeof choice.message.content === "string" ? stripReasoning(choice.message.content) : "",
      toolCalls,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      usage: (body?.usage as Completion["usage"]) ?? null,
    };
  }
}
