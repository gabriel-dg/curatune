// Chat view: the conversation with the model, the tool calls it makes, and their results. Everything the
// model or Spotify wrote is rendered as text nodes (see ./dom.ts and renderText below).

import { AgentError, type ChatMessage, type ChatModel } from "../agent/llm";
import { runTurn, type AgentEvent } from "../agent/loop";
import { SYSTEM_PROMPT } from "../agent/prompt";
import type { Plan } from "../plans/plans";
import { SpotikitError } from "../spotify/errors";
import type { KeyValueStore } from "../storage/kv";
import { ALL_TOOLS, type ToolContext, type WriteReport } from "../tools";
import { h } from "./dom";
import type { LlmSettings, ProviderOption } from "./llm-providers";
import { planCard } from "./plan-card";

const SUGGESTIONS = [
  "Which playlists do I have?",
  "Are there duplicates in my test playlist?",
  "Find versions of Salt Peanuts by Dizzy Gillespie",
];

/** Link to a playlist in the Spotify app, only for well-formed IDs. */
function playlistLink(id: string | null): HTMLElement | null {
  if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
  return h("a", { text: "Open in Spotify", attrs: { href: `https://open.spotify.com/playlist/${id}`, target: "_blank", rel: "noopener noreferrer" } });
}

/** A write performed on Spotify: always expanded, never folded like reads. */
function writeCard(report: WriteReport, time: string): HTMLElement {
  return h("div", { class: "write-card", attrs: { role: "status" } }, [
    h("div", { class: "write-title" }, [h("strong", { text: report.title }), h("span", { class: "muted", text: ` · ${time}` })]),
    report.lines.length ? h("div", { class: "write-lines", text: report.lines.join("\n") }) : null,
    ...report.warnings.map((w) => h("div", { class: "warning", text: w })),
    playlistLink(report.playlistId),
  ]);
}

/** Plain text with two conveniences: **bold** and "# heading" lines (shown bold, without the hashes). */
export function renderText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  text.split("\n").forEach((line, index) => {
    if (index > 0) fragment.append("\n");
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      fragment.append(h("strong", { text: heading[1] }));
      return;
    }
    line.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) fragment.append(h("strong", { text: part.slice(2, -2) }));
      else if (part) fragment.append(part);
    });
  });
  return fragment;
}

function compactArgs(raw: string): string {
  try {
    const args = JSON.parse(raw || "{}") as Record<string, unknown>;
    return Object.entries(args)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
  } catch {
    return raw;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export class ChatView {
  readonly element: HTMLElement;
  /** Called when a turn fails because the Spotify session is gone. */
  onAuthError: (exc: SpotikitError) => void = () => {};

  private readonly providers: ProviderOption[];
  private readonly settings: LlmSettings;
  private provider: ProviderOption;
  private readonly providerSelect: HTMLSelectElement;
  private readonly forgetKeyButton: HTMLButtonElement;
  private readonly ctx: ToolContext;
  private readonly backups: KeyValueStore;
  /** What the user did with plans since the last message; prepended to the next one for the model. */
  private notices: string[] = [];
  private history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  private readonly transcript: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly newButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  // Writes of this session. Unlike the transcript, "New chat" does not clear them.
  private readonly writesLog: HTMLDetailsElement;
  private readonly writesList: HTMLElement;
  private writeCount = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { providers: ProviderOption[]; settings: LlmSettings; ctx: ToolContext; backups: KeyValueStore }) {
    this.providers = options.providers;
    this.settings = options.settings;
    this.provider = this.providers.find((p) => p.id === this.settings.selected()) ?? this.providers[0]!;
    this.ctx = options.ctx;
    this.backups = options.backups;
    this.providerSelect = h(
      "select",
      { attrs: { "aria-label": "Model" }, on: { change: () => this.switchProvider(this.providerSelect.value) } },
      this.providers.map((p) => h("option", { text: p.label, attrs: { value: p.id } })),
    );
    this.providerSelect.value = this.provider.id;
    this.providerSelect.hidden = this.providers.length < 2;
    this.forgetKeyButton = h("button", {
      class: "secondary",
      text: "Forget key",
      attrs: { title: "Remove the API key from this tab" },
      on: {
        click: () => {
          this.settings.forgetApiKey(this.provider);
          this.reset();
        },
      },
    });
    this.transcript = h("div", { class: "transcript", attrs: { "aria-live": "polite" } });
    this.input = h("textarea", {
      attrs: { rows: "3", placeholder: "Ask about your playlists… (Enter sends, Shift+Enter adds a line)", "aria-label": "Message" },
      on: {
        keydown: (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void this.send();
          }
        },
      },
    });
    this.sendButton = h("button", { text: "Send", on: { click: () => void this.send() } });
    this.stopButton = h("button", { class: "secondary", text: "Stop", attrs: { hidden: "" }, on: { click: () => this.controller?.abort() } });
    this.newButton = h("button", { class: "secondary", text: "New chat", on: { click: () => this.reset() } });
    this.status = h("span", { class: "muted status" });
    this.writesList = h("div", { class: "writes-list" });
    this.writesLog = h("details", { class: "writes-log", attrs: { hidden: "" } }, [h("summary", { text: "Writes this session" }), this.writesList]);
    this.element = h("section", { class: "chat" }, [
      this.writesLog,
      this.transcript,
      h("div", { class: "composer" }, [
        this.input,
        h("div", { class: "composer-actions" }, [this.status, this.providerSelect, this.forgetKeyButton, this.newButton, this.stopButton, this.sendButton]),
      ]),
    ]);
    this.renderEmpty();
  }

  /** The model for the selected provider, or why there is none (missing key, not configured). */
  private currentModel(): { model: ChatModel } | { problem: string; needsKey: boolean } {
    const key = this.provider.requiresKey ? this.settings.apiKey(this.provider) : null;
    if (this.provider.requiresKey && !key) return { problem: "API key needed", needsKey: true };
    try {
      return { model: this.provider.create(key) };
    } catch (exc) {
      return { problem: exc instanceof AgentError ? exc.message : "The model is not configured.", needsKey: false };
    }
  }

  private updateControls(): void {
    const hasKey = this.provider.requiresKey && Boolean(this.settings.apiKey(this.provider));
    this.forgetKeyButton.hidden = !hasKey;
    this.status.textContent = `Model: ${this.provider.model || "not configured"}`;
  }

  private switchProvider(id: string): void {
    const next = this.providers.find((p) => p.id === id);
    if (!next || next === this.provider) return;
    if (this.controller) {
      this.providerSelect.value = this.provider.id; // not while a turn runs
      return;
    }
    this.provider = next;
    this.settings.select(next);
    // A new chat: one provider's history (tool calls, provider data) may not be valid for another.
    this.reset();
  }

  private keyForm(): HTMLElement {
    const input = h("input", { attrs: { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "API key", "aria-label": "API key" } });
    const save = () => {
      if (!input.value.trim()) return;
      this.settings.setApiKey(this.provider, input.value);
      input.value = "";
      this.reset();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      }
    });
    return h("div", { class: "key-form" }, [
      h("p", {}, [h("strong", { text: `${this.provider.label} needs an API key.` })]),
      h("p", {
        class: "muted",
        text:
          `It stays only in this browser tab (sessionStorage, gone when the tab closes) and is sent only to ${this.provider.host}. ` +
          `Using this model sends the conversation and your playlist data (names, tracks, artists) to that provider; ` +
          `your Spotify token is never sent.`,
      }),
      h("div", { class: "open" }, [input, h("button", { text: "Use this key", on: { click: save } })]),
    ]);
  }

  private renderEmpty(): void {
    this.updateControls();
    const current = this.currentModel();
    this.input.disabled = "problem" in current;
    this.sendButton.disabled = "problem" in current;
    if ("problem" in current) {
      this.transcript.replaceChildren(current.needsKey ? this.keyForm() : h("p", { class: "notice", text: current.problem }));
      return;
    }
    this.transcript.replaceChildren(
      h("div", { class: "empty" }, [
        h("p", { class: "muted", text: "Ask about your playlists, search the catalog, create playlists, and add tracks. Removals, reorders, and renames come as plans that you review and apply yourself. Ask in any language." }),
        h(
          "div",
          { class: "suggestions" },
          SUGGESTIONS.map((text) =>
            h("button", {
              class: "secondary",
              text,
              on: {
                click: () => {
                  this.input.value = text;
                  void this.send();
                },
              },
            }),
          ),
        ),
      ]),
    );
  }

  private reset(): void {
    if (this.controller) return;
    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
    this.notices = [];
    this.renderEmpty();
    this.input.focus();
  }

  private recordWrite(report: WriteReport): void {
    const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    this.append(writeCard(report, time));
    this.writeCount += 1;
    this.writesList.prepend(writeCard(report, time));
    this.writesLog.hidden = false;
    this.writesLog.querySelector("summary")!.textContent = `Writes this session (${this.writeCount})`;
  }

  private append(node: HTMLElement): HTMLElement {
    this.transcript.querySelector(".empty")?.remove();
    this.transcript.append(node);
    node.scrollIntoView({ block: "end" });
    return node;
  }

  private setBusy(busy: boolean): void {
    this.input.disabled = busy;
    this.sendButton.disabled = busy;
    this.newButton.disabled = busy;
    this.stopButton.hidden = !busy;
    this.providerSelect.disabled = busy;
    this.forgetKeyButton.disabled = busy;
  }

  private startTimer(label: string): void {
    this.stopTimer();
    const started = performance.now();
    const tick = () => (this.status.textContent = `${label} ${Math.floor((performance.now() - started) / 1000)} s`);
    tick();
    this.timer = setInterval(tick, 1000);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.controller) return;
    const current = this.currentModel();
    if ("problem" in current) {
      this.renderEmpty();
      return;
    }
    const model = current.model;
    this.input.value = "";
    this.append(h("div", { class: "msg user" }, [text]));
    this.setBusy(true);
    this.controller = new AbortController();
    const toolLines = new Map<string, HTMLElement>();
    // Mutated from the event callback, so it lives in an object (TypeScript does not track closure writes).
    const stats: { promptTokens: number | null; checkpoint: ChatMessage[] | null; wrote: boolean; plans: Plan[] } = {
      promptTokens: null,
      checkpoint: null,
      wrote: false,
      plans: [],
    };
    // App notices go first, marked as such, so the model knows which plans the user applied or discarded.
    const notices = this.notices;
    this.notices = [];
    const content = notices.length ? `${notices.map((n) => `[App notice: ${n}]`).join("\n")}\n\n${text}` : text;

    const onEvent = (event: AgentEvent) => {
      switch (event.type) {
        case "model_start":
          this.startTimer(event.step === 1 ? "Thinking…" : `Thinking (step ${event.step})…`);
          break;
        case "model_end":
          this.stopTimer();
          stats.promptTokens = event.promptTokens ?? stats.promptTokens;
          break;
        case "note":
          this.append(h("div", { class: "msg assistant note" }, [renderText(event.content)]));
          break;
        case "tool_start": {
          const line = h("details", { class: "tool pending" }, [
            h("summary", {}, [h("code", { text: event.call.function.name }), ` ${compactArgs(event.call.function.arguments)}`]),
          ]);
          toolLines.set(event.call.id, this.append(line));
          break;
        }
        case "tool_end": {
          const line = toolLines.get(event.call.id);
          if (!line) break;
          const { execution } = event;
          line.classList.remove("pending");
          line.classList.add(execution.outcome.ok ? "ok" : "failed");
          line.querySelector("summary")?.append(h("span", { class: "muted", text: ` → ${execution.summary} · ${seconds(execution.ms)}` }));
          // The exact JSON the model received, for transparency.
          line.append(h("pre", { text: JSON.stringify(execution.outcome, null, 2) }));
          if (execution.write) {
            stats.wrote = true;
            this.recordWrite(execution.write);
          }
          // Plans built by this call, right after it, each with its Apply button.
          for (const plan of stats.plans.splice(0)) {
            this.append(
              planCard(plan, {
                client: this.ctx.client,
                backups: this.backups,
                onWrite: (report) => this.recordWrite(report),
                onNotice: (notice) => this.notices.push(notice),
              }),
            );
          }
          break;
        }
        case "checkpoint":
          stats.checkpoint = event.messages;
          break;
        case "answer":
          this.append(h("div", { class: "msg assistant" }, [renderText(event.content)]));
          break;
      }
    };

    try {
      const result = await runTurn(this.history, content, {
        model,
        tools: ALL_TOOLS,
        ctx: { ...this.ctx, onPlan: (plan) => stats.plans.push(plan) },
        signal: this.controller.signal,
        onEvent,
      });
      this.history = result.messages;
    } catch (exc) {
      // A failed or stopped turn is normally dropped: the conversation stays as it was before this message.
      // If it already wrote to Spotify, it is kept up to its last complete step, so the model knows what it did.
      const kept = stats.wrote && stats.checkpoint !== null;
      // Notices not delivered with a dropped turn are delivered with the next one.
      if (!kept) this.notices.unshift(...notices);
      if (kept) {
        const code = exc instanceof AgentError || exc instanceof SpotikitError ? exc.code : "ERROR";
        this.history = [...stats.checkpoint!, { role: "assistant", content: `(This turn was interrupted by ${code} after the writes above.)` }];
      }
      if (exc instanceof SpotikitError && (exc.code === "AUTH_REQUIRED" || exc.code === "AUTH_EXPIRED")) {
        this.onAuthError(exc);
      }
      const keptNote = kept
        ? "The conversation keeps the writes already made."
        : "This message was not kept in the conversation.";
      const message =
        exc instanceof AgentError && exc.code === "CANCELLED"
          ? `Stopped. ${keptNote}`
          : exc instanceof AgentError || exc instanceof SpotikitError
            ? `${exc.code}: ${exc.message} (${keptNote})`
            : `Unexpected error. See the browser console for details. ${keptNote}`;
      if (!(exc instanceof AgentError || exc instanceof SpotikitError)) console.error(exc);
      this.append(h("div", { class: "msg error" }, [message]));
    } finally {
      this.stopTimer();
      this.controller = null;
      this.setBusy(false);
      this.status.textContent =
        stats.promptTokens !== null ? `Context: ${stats.promptTokens.toLocaleString("en-US")} tokens` : "";
      this.input.focus();
    }
  }
}
