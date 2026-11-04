// Chat view: the conversation with the model, the steps it takes (tool calls), plans, and writes.
// Everything the model or Spotify wrote is rendered as text nodes (./markdown.ts creates only elements and
// text; links only to open.spotify.com).

import { AgentError, type ChatMessage, type ChatModel } from "../agent/llm";
import { runTurn, type AgentEvent } from "../agent/loop";
import { SYSTEM_PROMPT } from "../agent/prompt";
import type { Plan } from "../plans/plans";
import { CuratuneError } from "../spotify/errors";
import type { KeyValueStore } from "../storage/kv";
import { ALL_TOOLS, type ToolContext, type ToolExecution, type WriteReport } from "../tools";
import type { ActivityLog } from "./activity";
import { writeCard } from "./cards";
import { h } from "./dom";
import { icon, type IconName } from "./icons";
import { hostedDataNotice, pickProvider, SPOTIFY_AI_TERMS, type LlmSettings, type ProviderOption } from "./llm-providers";
import { renderMarkdown } from "./markdown";
import { planCard } from "./plan-card";

export interface PlaylistContext {
  id: string;
  name: string;
}

const GENERAL_SUGGESTIONS = [
  "Which playlists do I have?",
  "Create a playlist with 10 essential bebop recordings, in chronological order",
  "Find versions of Salt Peanuts by Dizzy Gillespie",
  "Which of my playlists have duplicates?",
];

const GENERAL_PLACEHOLDER = "Write anything, e.g. “60s soul ballads, one song per artist”…";
const playlistPlaceholder = (name: string) => `Ask anything about "${name}", or say what to change…`;

const playlistSuggestions = (name: string) => [
  `Are there duplicates in "${name}"?`,
  `Is "${name}" in chronological order of recording?`,
  `Sort "${name}" by recording date`,
  `Suggest 5 tracks that would fit "${name}"`,
];

/** A few words for each tool call, for people rather than developers. */
function describeCall(name: string, rawArgs: string): { label: string; icon: IconName } {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    // Shown as is below.
  }
  const quoted = (v: unknown) => (typeof v === "string" && v ? `"${v}"` : "");
  switch (name) {
    case "playlists_list":
      return { label: "Listed your playlists", icon: "list" };
    case "playlist_show":
      return { label: args.offset ? `Read a playlist (from track ${Number(args.offset) + 1})` : "Read a playlist", icon: "list" };
    case "search_tracks":
      return { label: `Searched ${quoted(args.track ?? args.query) || "the catalog"}${args.artist ? ` by ${String(args.artist)}` : ""}`, icon: "search" };
    case "search_many":
      return { label: `Searched ${Array.isArray(args.searches) ? args.searches.length : "several"} tracks`, icon: "search" };
    case "track_show":
      return { label: "Looked up a track", icon: "music" };
    case "album_tracks":
      return { label: "Listed an album", icon: "music" };
    case "playlist_create":
      return { label: `Created playlist ${quoted(args.name)}`, icon: "plus" };
    case "playlist_add":
      return { label: `Added ${Array.isArray(args.track_uris) ? args.track_uris.length : ""} tracks`, icon: "plus" };
    case "plan_remove":
    case "plan_reorder":
    case "plan_details":
      return { label: "Prepared a plan for you to review", icon: "sparkle" };
    case "recordings_show":
      return { label: "Checked recording dates", icon: "calendar" };
    case "recordings_set":
      return { label: `Saved ${Array.isArray(args.entries) ? args.entries.length : ""} recording dates`, icon: "calendar" };
    default:
      return { label: name, icon: "tool" };
  }
}

/** Spotify's clauses on AI models, with links, after a hosted model's data notice. */
function aiTermsNote(): (string | HTMLElement)[] {
  const link = (t: (typeof SPOTIFY_AI_TERMS)[number]) => h("a", { text: t.label, attrs: { href: t.url, target: "_blank", rel: "noopener noreferrer" } });
  return [
    " Spotify restricts feeding its content into AI models (",
    link(SPOTIFY_AI_TERMS[0]),
    "; ",
    link(SPOTIFY_AI_TERMS[1]),
    "): you are responsible for using your Spotify app within those terms. The local model keeps this data on your machine.",
  ];
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export class ChatView {
  readonly element: HTMLElement;
  /** Called when a turn fails because the Spotify session is gone. */
  onAuthError: (exc: CuratuneError) => void = () => {};
  /** Called after every write (tool write or applied plan), e.g. to refresh the sidebar and panel. */
  onWrite: (report: WriteReport) => void = () => {};
  /** Called when the user wants to see a playlist mentioned in a write. */
  onOpenPlaylist: (id: string) => void = () => {};

  private readonly providers: ProviderOption[];
  private readonly settings: LlmSettings;
  private provider: ProviderOption;
  private readonly ctx: ToolContext;
  private readonly backups: KeyValueStore;
  private readonly activity: ActivityLog;
  private context: PlaylistContext | null = null;
  /** What the user did with plans since the last message; prepended to the next one for the model. */
  private notices: string[] = [];
  private history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  private readonly transcript: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly newButton: HTMLButtonElement;
  private readonly providerSelect: HTMLSelectElement;
  private readonly forgetKeyButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly contextBar: HTMLElement;
  /** Visible while a hosted model is selected. */
  private readonly hostedNotice: HTMLElement;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private thinking: HTMLElement | null = null;
  private steps: HTMLElement | null = null;

  constructor(options: { providers: ProviderOption[]; settings: LlmSettings; ctx: ToolContext; backups: KeyValueStore; activity: ActivityLog }) {
    this.providers = options.providers;
    this.settings = options.settings;
    this.provider = pickProvider(this.providers, this.settings.selected());
    this.ctx = options.ctx;
    this.backups = options.backups;
    this.activity = options.activity;

    this.transcript = h("div", { class: "transcript", attrs: { "aria-live": "polite" } });
    this.input = h("textarea", {
      attrs: { rows: "1", placeholder: GENERAL_PLACEHOLDER, "aria-label": "Message" },
      on: {
        keydown: (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void this.send();
          }
        },
      },
    });
    this.sendButton = h("button", { class: "primary icon-button", attrs: { title: "Send (Enter)", "aria-label": "Send" }, on: { click: () => void this.send() } }, [icon("send", 18)]);
    this.stopButton = h("button", { class: "ghost", attrs: { hidden: "" }, on: { click: () => this.controller?.abort() } }, [icon("stop", 16), "Stop"]);
    this.newButton = h("button", { class: "ghost small", on: { click: () => this.reset() } }, [icon("plus", 15), "New chat"]);
    this.providerSelect = h(
      "select",
      { attrs: { "aria-label": "Model" }, on: { change: () => this.switchProvider(this.providerSelect.value) } },
      this.providers.map((p) => h("option", { text: p.label, attrs: { value: p.id } })),
    );
    this.providerSelect.value = this.provider.id;
    this.providerSelect.hidden = this.providers.length < 2;
    this.forgetKeyButton = h("button", {
      class: "ghost small",
      attrs: { title: "Remove the API key from this tab" },
      on: {
        click: () => {
          this.settings.forgetApiKey(this.provider);
          this.reset();
        },
      },
    }, [icon("key", 14), "Forget key"]);
    this.status = h("span", { class: "composer-status muted small" });
    this.contextBar = h("div", { class: "context-bar", attrs: { hidden: "" } });
    this.hostedNotice = h("div", { class: "hosted-notice small", attrs: { role: "note", hidden: "" } });

    this.element = h("section", { class: "chat" }, [
      h("header", { class: "chat-header" }, [
        h("div", { class: "chat-title" }, [icon("chat", 18), h("span", { text: "Chat" })]),
        h("div", { class: "chat-header-actions" }, [this.newButton]),
      ]),
      this.transcript,
      h("div", { class: "composer" }, [
        this.hostedNotice,
        h("div", { class: "composer-box" }, [
          this.contextBar,
          this.input,
          h("div", { class: "composer-row" }, [this.providerSelect, this.forgetKeyButton, this.status, h("span", { class: "spacer" }), this.stopButton, this.sendButton]),
        ]),
        h("div", { class: "composer-hint muted small", text: "Enter to send · Shift+Enter for a new line · removals and reorders always come as plans you apply" }),
      ]),
    ]);
    this.renderEmpty();
  }

  // --- Public API -------------------------------------------------------------------------------

  /** The playlist the user is looking at; the next messages mention it to the model. */
  setContext(context: PlaylistContext | null): void {
    this.context = context;
    this.input.placeholder = context ? playlistPlaceholder(context.name) : GENERAL_PLACEHOLDER;
    if (!context) {
      this.contextBar.hidden = true;
      this.contextBar.replaceChildren();
    } else {
      this.contextBar.hidden = false;
      this.contextBar.replaceChildren(
        icon("list", 14),
        h("span", { text: "About " }),
        h("strong", { text: context.name }),
        h("button", { class: "ghost tiny", attrs: { title: "Stop referring to this playlist", "aria-label": "Clear context" }, on: { click: () => this.setContext(null) } }, [icon("close", 13)]),
      );
    }
    if (this.transcript.querySelector(".empty")) this.renderEmpty();
  }

  /** Send a message as if the user had typed it (used by the panels' quick actions). */
  ask(text: string): void {
    if (this.controller) return;
    this.input.value = text;
    void this.send();
    this.input.focus();
  }

  focus(): void {
    this.input.focus();
  }

  // --- Providers ----------------------------------------------------------------------------------

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
    this.forgetKeyButton.hidden = !(this.provider.requiresKey && this.settings.apiKey(this.provider));
    if (this.providers.length < 2) this.status.textContent = this.provider.model ? `Model: ${this.provider.model}` : "";
    const notice = hostedDataNotice(this.provider);
    this.hostedNotice.hidden = notice === null;
    this.hostedNotice.replaceChildren(...(notice ? [icon("alert", 16), h("span", {}, [notice, ...aiTermsNote()])] : []));
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
    const input = h("input", { attrs: { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Paste the API key", "aria-label": "API key" } });
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
    return h("div", { class: "card key-form" }, [
      h("div", { class: "card-title" }, [icon("key", 18), h("strong", { text: `${this.provider.name} needs an API key` })]),
      h("p", {
        class: "muted",
        text:
          `The key stays only in this browser tab (sessionStorage, gone when the tab closes) and is sent only to ${this.provider.host}` +
          `${this.providers.filter((p) => p.keyId !== null && p.keyId === this.provider.keyId).length > 1 ? `, for every ${this.provider.name} model in the list` : ""}. ` +
          "Your Spotify token is never sent.",
      }),
      h("p", {}, [hostedDataNotice(this.provider) ?? "", ...aiTermsNote()]),
      h("div", { class: "inline-form" }, [input, h("button", { class: "primary", text: "Use this key", on: { click: save } })]),
    ]);
  }

  // --- Transcript ---------------------------------------------------------------------------------

  private renderEmpty(): void {
    this.updateControls();
    const current = this.currentModel();
    this.input.disabled = "problem" in current;
    this.sendButton.disabled = "problem" in current;
    if ("problem" in current) {
      this.transcript.replaceChildren(h("div", { class: "empty" }, [current.needsKey ? this.keyForm() : h("div", { class: "card error-card", text: current.problem })]));
      return;
    }
    const suggestions = this.context ? playlistSuggestions(this.context.name) : GENERAL_SUGGESTIONS;
    // The suggestions are examples, not a menu: say so before and after them, and point at the composer.
    this.transcript.replaceChildren(
      h("div", { class: "empty" }, [
        h("div", { class: "empty-mark" }, [icon("logo", 40)]),
        h("h2", { text: this.context ? `What should we do with "${this.context.name}"?` : "What should we do with your playlists?" }),
        h("p", { class: "empty-lead", text: "Write whatever you want, in any language, as you would ask a person." }),
        h("p", {
          class: "muted small",
          text: "I can read your playlists, search Spotify, create playlists, and add tracks. Removals, reorders, and renames come as plans that you review and apply.",
        }),
        h("div", { class: "suggestions-label" }, [icon("sparkle", 14), h("span", { text: "A few ideas to get started" })]),
        h(
          "div",
          { class: "suggestions" },
          suggestions.map((text) => h("button", { class: "suggestion", on: { click: () => this.ask(text) } }, [icon("sparkle", 15), h("span", { text })])),
        ),
        h("button", { class: "free-hint", on: { click: () => this.input.focus() } }, [icon("arrowDown", 15), h("span", { text: "These are only examples: type your own request in the box below" })]),
      ]),
    );
  }

  private reset(): void {
    if (this.controller) return;
    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
    this.notices = [];
    this.steps = null;
    this.renderEmpty();
    this.input.focus();
  }

  private append(node: HTMLElement): HTMLElement {
    this.transcript.querySelector(".empty")?.remove();
    if (this.thinking && node !== this.thinking) this.transcript.insertBefore(node, this.thinking);
    else this.transcript.append(node);
    node.scrollIntoView({ block: "end", behavior: "smooth" });
    return node;
  }

  private recordWrite(report: WriteReport): void {
    const entry = this.activity.add(report);
    this.steps = null;
    this.append(writeCard(report, entry.at, (id) => this.onOpenPlaylist(id)));
    this.onWrite(report);
  }

  private assistantMessage(content: string, note = false): HTMLElement {
    const copy = h("button", { class: "ghost tiny", attrs: { title: "Copy", "aria-label": "Copy answer" } }, [icon("copy", 14)]);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(content);
        copy.replaceChildren(icon("check", 14));
        setTimeout(() => copy.replaceChildren(icon("copy", 14)), 1500);
      } catch {
        // Clipboard access denied: nothing to do.
      }
    });
    return h("div", { class: `msg assistant${note ? " note" : ""}` }, [
      h("div", { class: "avatar" }, [icon("sparkle", 16)]),
      h("div", { class: "msg-body" }, [h("div", { class: "md" }, [renderMarkdown(content)]), note ? null : h("div", { class: "msg-actions" }, [copy])]),
    ]);
  }

  private stepsGroup(): HTMLElement {
    if (!this.steps || !this.steps.isConnected) this.steps = this.append(h("div", { class: "steps" }));
    return this.steps;
  }

  private setBusy(busy: boolean): void {
    this.input.disabled = busy;
    this.sendButton.hidden = busy;
    this.newButton.disabled = busy;
    this.stopButton.hidden = !busy;
    this.providerSelect.disabled = busy;
    this.forgetKeyButton.disabled = busy;
  }

  private showThinking(step: number): void {
    this.hideThinking();
    const label = h("span", {});
    this.thinking = h("div", { class: "thinking" }, [h("span", { class: "dots" }, [h("i"), h("i"), h("i")]), label]);
    this.transcript.append(this.thinking);
    this.thinking.scrollIntoView({ block: "end", behavior: "smooth" });
    const started = performance.now();
    const tick = () => {
      const s = Math.floor((performance.now() - started) / 1000);
      label.textContent = `${step === 1 ? "Thinking" : `Thinking · step ${step}`}${s >= 2 ? ` · ${s} s` : ""}`;
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  private hideThinking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.thinking?.remove();
    this.thinking = null;
  }

  // --- Sending --------------------------------------------------------------------------------------

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
    const context = this.context;
    this.steps = null;
    this.append(
      h("div", { class: "msg user" }, [
        h("div", { class: "bubble" }, [context ? h("div", { class: "bubble-context", text: `About "${context.name}"` }) : null, h("div", { text })]),
      ]),
    );
    this.setBusy(true);
    this.controller = new AbortController();
    const stepRows = new Map<string, HTMLElement>();
    // Mutated from the event callback, so it lives in an object (TypeScript does not track closure writes).
    const stats: { promptTokens: number | null; checkpoint: ChatMessage[] | null; wrote: boolean; plans: Plan[] } = {
      promptTokens: null,
      checkpoint: null,
      wrote: false,
      plans: [],
    };
    // App notices and the playlist in view go first, marked as such, for the model.
    const notices = this.notices;
    this.notices = [];
    const prefix = [
      ...notices.map((n) => `[App notice: ${n}]`),
      ...(context ? [`[App context: the user is looking at their playlist "${context.name}" (id ${context.id}).]`] : []),
    ];
    const content = prefix.length ? `${prefix.join("\n")}\n\n${text}` : text;

    const onEvent = (event: AgentEvent) => {
      switch (event.type) {
        case "model_start":
          this.showThinking(event.step);
          break;
        case "model_end":
          this.hideThinking();
          stats.promptTokens = event.promptTokens ?? stats.promptTokens;
          break;
        case "note":
          this.steps = null;
          this.append(this.assistantMessage(event.content, true));
          break;
        case "tool_start": {
          const { label, icon: iconName } = describeCall(event.call.function.name, event.call.function.arguments);
          const row = h("details", { class: "step pending" }, [
            h("summary", {}, [icon(iconName, 15), h("span", { class: "step-label", text: label }), h("span", { class: "step-meta muted" })]),
          ]);
          stepRows.set(event.call.id, row);
          this.stepsGroup().append(row);
          row.scrollIntoView({ block: "end", behavior: "smooth" });
          break;
        }
        case "tool_end": {
          const row = stepRows.get(event.call.id);
          if (!row) break;
          const { execution } = event;
          this.finishStep(row, event.call.function.name, event.call.function.arguments, execution);
          if (execution.write) {
            stats.wrote = true;
            this.recordWrite(execution.write);
          }
          // Plans built by this call, right after it, each with its Apply button.
          for (const plan of stats.plans.splice(0)) {
            this.steps = null;
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
          this.steps = null;
          this.append(this.assistantMessage(event.content));
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
      this.hideThinking();
      // A failed or stopped turn is normally dropped: the conversation stays as it was before this message.
      // If it already wrote to Spotify, it is kept up to its last complete step, so the model knows what it did.
      const kept = stats.wrote && stats.checkpoint !== null;
      if (kept) {
        const code = exc instanceof AgentError || exc instanceof CuratuneError ? exc.code : "ERROR";
        this.history = [...stats.checkpoint!, { role: "assistant", content: `(This turn was interrupted by ${code} after the writes above.)` }];
      } else {
        // Notices not delivered with a dropped turn are delivered with the next one.
        this.notices.unshift(...notices);
      }
      if (exc instanceof CuratuneError && (exc.code === "AUTH_REQUIRED" || exc.code === "AUTH_EXPIRED")) this.onAuthError(exc);
      const keptNote = kept ? "The conversation keeps the writes already made." : "This message was not kept in the conversation.";
      const stopped = exc instanceof AgentError && exc.code === "CANCELLED";
      const message = stopped
        ? `Stopped. ${keptNote}`
        : exc instanceof AgentError || exc instanceof CuratuneError
          ? `${exc.message} (${exc.code}) ${keptNote}`
          : `Unexpected error; see the browser console. ${keptNote}`;
      if (!(exc instanceof AgentError || exc instanceof CuratuneError)) console.error(exc);
      this.steps = null;
      this.append(h("div", { class: `card ${stopped ? "muted-card" : "error-card"}`, text: message }));
    } finally {
      this.hideThinking();
      this.controller = null;
      this.setBusy(false);
      if (stats.promptTokens !== null) this.status.textContent = `${stats.promptTokens.toLocaleString("en-US")} tokens of context`;
      this.input.focus();
    }
  }

  private finishStep(row: HTMLElement, name: string, rawArgs: string, execution: ToolExecution): void {
    row.classList.remove("pending");
    row.classList.add(execution.outcome.ok ? "ok" : "failed");
    row.querySelector(".step-meta")!.textContent = `${execution.outcome.ok ? execution.summary : "failed"} · ${seconds(execution.ms)}`;
    // What the model sent and the exact JSON it received, for transparency.
    row.append(
      h("div", { class: "step-details" }, [
        h("div", { class: "muted small", text: `${name}(${rawArgs || "{}"})` }),
        h("pre", { text: JSON.stringify(execution.outcome, null, 2) }),
      ]),
    );
  }
}
