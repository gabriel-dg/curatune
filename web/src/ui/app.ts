// App shell: login, top bar, sidebar (playlists), chat in the centre, and a side panel (a playlist, the
// recording dates, or the session's activity). Routes live in the hash so reloads and the back button keep
// the view: #/ (no panel), #/playlist/<id>, #/recordings, #/activity.

import type { RecordingStore } from "../recordings/recordings";
import type { SpotifyAuth } from "../spotify/auth";
import { CuratuneError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/http";
import type { ActivityLog } from "./activity";
import { brandMark } from "./brand";
import type { ChatView } from "./chat";
import { cover } from "./covers";
import { h } from "./dom";
import { icon } from "./icons";
import { ResizableLayout } from "./layout";
import { renderPlaylistPanel } from "./playlist-panel";
import { renderActivityPanel, renderRecordingsPanel } from "./side-panels";
import { Sidebar } from "./sidebar";

/**
 * Spotify's attribution, once in the app shell so it covers every view that shows Spotify content (the
 * playlists, the panel, the chat). Spotify's Developer Policy (II.4.1) requires it, with the official full
 * logo (public/brand/, unmodified): at least 70 px wide, monochrome white on a dark background, with clear
 * space of half the icon's height around it.
 */
function spotifyAttribution(): HTMLElement {
  return h("span", { class: "attribution" }, [
    h("span", { class: "attribution-label hide-narrow", text: "Content from" }),
    h("img", { attrs: { src: `${import.meta.env.BASE_URL}brand/spotify-full-logo-white.svg`, alt: "Spotify", width: "80", height: "22" } }),
  ]);
}

type Route = { view: "home" } | { view: "playlist"; id: string } | { view: "recordings" } | { view: "activity" };

function parseRoute(hash: string): Route {
  const match = /^#\/playlist\/([A-Za-z0-9]{22})$/.exec(hash);
  if (match) return { view: "playlist", id: match[1]! };
  if (hash === "#/recordings") return { view: "recordings" };
  if (hash === "#/activity") return { view: "activity" };
  return { view: "home" };
}

function describeError(exc: unknown): string {
  if (exc instanceof CuratuneError) return `${exc.message} (${exc.code})`;
  return "Unexpected error. See the browser console for details.";
}

const isAuthError = (exc: unknown) => exc instanceof CuratuneError && (exc.code === "AUTH_REQUIRED" || exc.code === "AUTH_EXPIRED");

/** A button on a lasting warning. Its result replaces the warning's text; `retry: false` removes the button. */
export interface WarningAction {
  label: string;
  run: () => Promise<{ text: string; retry: boolean }>;
}

interface AppWarning {
  text: string;
  action?: WarningAction;
}

export class App {
  private readonly root: HTMLElement;
  private readonly auth: SpotifyAuth;
  private readonly client: SpotifyClient;
  private readonly chat: ChatView;
  private readonly recordings: RecordingStore;
  private readonly activity: ActivityLog;
  private shell: HTMLElement | null = null;
  private layout: ResizableLayout | null = null;
  private sidebar: Sidebar | null = null;
  private panel: HTMLElement | null = null;
  private notice: HTMLElement | null = null;
  private userLabel: HTMLElement | null = null;
  private loginError: unknown = null;
  /** Lasting warnings (unlike errors, not cleared on navigation), e.g. storage not persistent. */
  private readonly warnings: AppWarning[] = [];
  private renderId = 0;
  private route: Route = { view: "home" };
  /** What the panel shows (e.g. "playlist:<id>"): opening something else replaces it with a skeleton. */
  private panelKey: string | null = null;

  constructor(root: HTMLElement, auth: SpotifyAuth, client: SpotifyClient, chat: ChatView, recordings: RecordingStore, activity: ActivityLog) {
    this.root = root;
    this.auth = auth;
    this.client = client;
    this.chat = chat;
    this.recordings = recordings;
    this.activity = activity;
    this.chat.onAuthError = () => this.sessionEnded();
    this.chat.onOpenPlaylist = (id) => (location.hash = `#/playlist/${id}`);
    this.chat.onWrite = (report) => {
      if (report.playlistId && report.itemCount !== undefined) this.sidebar?.setCount(report.playlistId, report.itemCount);
      void this.sidebar?.load();
      // The panel shows data that just changed: refresh it.
      if ((this.route.view === "playlist" && report.playlistId === this.route.id) || this.route.view === "recordings") void this.renderPanel();
    };
    this.activity.subscribe(() => {
      this.sidebar?.setActivityCount(this.activity.entries.length);
      if (this.route.view === "activity") void this.renderPanel();
    });
    window.addEventListener("hashchange", () => void this.render());
  }

  showError(exc: unknown): void {
    if (!(exc instanceof CuratuneError)) console.error(exc);
    if (!this.notice) {
      // Not logged in yet (e.g. a failed login callback): shown on the login screen.
      this.loginError = exc;
      return;
    }
    const close = h("button", { class: "ghost tiny", attrs: { "aria-label": "Dismiss" }, on: { click: () => this.clearError() } }, [icon("close", 13)]);
    this.notice.replaceChildren(h("span", { text: describeError(exc) }), close);
    this.notice.hidden = false;
  }

  showWarning(text: string, action?: WarningAction): void {
    this.warnings.push({ text, action });
  }

  clearError(): void {
    if (!this.notice) return;
    this.notice.hidden = true;
    this.notice.replaceChildren();
  }

  async render(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      this.renderLogin();
      return;
    }
    if (!this.shell) this.buildShell();
    this.route = parseRoute(location.hash);
    this.clearError();
    this.shell!.classList.remove("sidebar-open");
    this.sidebar!.setActive(this.route);
    if (this.route.view !== "playlist") this.chat.setContext(null);
    else {
      // Set the chat's context right away when the name is known; the panel confirms it once loaded.
      const name = this.sidebar!.playlistOf(this.route.id)?.name;
      if (name) this.chat.setContext({ id: this.route.id, name });
    }
    await this.renderPanel();
  }

  // --- Login ------------------------------------------------------------------------------------

  private renderLogin(): void {
    this.layout?.dispose();
    this.layout = null;
    this.shell = null;
    this.sidebar = null;
    this.notice = null;
    this.panelKey = null;
    const status = h("div", { class: "error-text small", text: this.loginError ? describeError(this.loginError) : "" });
    this.loginError = null;
    const button = h("button", { class: "primary large" }, [icon("music", 18), "Log in with Spotify"]);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        location.assign(await this.auth.beginLogin());
      } catch (exc) {
        button.disabled = false;
        status.textContent = describeError(exc);
      }
    });
    this.root.replaceChildren(
      h("div", { class: "login" }, [
        h("div", { class: "login-card" }, [
          h("div", { class: "brand large" }, [brandMark(38), h("span", { text: "Curatune" })]),
          h("p", { class: "login-lead", text: "Curate your Spotify playlists by chatting." }),
          h("ul", { class: "login-points" }, [
            h("li", {}, [icon("search", 16), h("span", { text: "Find the right recordings and build playlists" })]),
            h("li", {}, [icon("calendar", 16), h("span", { text: "Keep them in recording order, without duplicates" })]),
            h("li", {}, [icon("check", 16), h("span", { text: "Removals and reorders only when you press Apply" })]),
          ]),
          button,
          status,
          h("p", { class: "muted small", text: "Your Spotify token stays in this browser tab and is only ever sent to Spotify." }),
        ]),
      ]),
    );
  }

  private sessionEnded(): void {
    this.auth.logout();
    void this.render();
  }

  // --- Shell ------------------------------------------------------------------------------------

  private warningElement(warning: AppWarning): HTMLElement {
    const text = h("span", { text: warning.text });
    const element = h("div", { class: "notice warn-notice", attrs: { role: "status" } }, [text]);
    if (warning.action) {
      const { label, run } = warning.action;
      const button = h("button", { class: "ghost small", text: label });
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const result = await run();
          warning.text = result.text;
          text.textContent = result.text;
          if (!result.retry) {
            warning.action = undefined;
            button.remove();
          }
          // Moved data shows at once (the Recordings panel reads the store again).
          void this.renderPanel();
        } catch (exc) {
          this.showError(exc);
        } finally {
          button.disabled = false;
        }
      });
      element.append(button);
    }
    const dismiss = () => {
      element.remove();
      const i = this.warnings.indexOf(warning);
      if (i >= 0) this.warnings.splice(i, 1);
    };
    element.append(h("button", { class: "ghost tiny", attrs: { "aria-label": "Dismiss" }, on: { click: dismiss } }, [icon("close", 13)]));
    return element;
  }

  private buildShell(): void {
    this.sidebar = new Sidebar(this.client);
    this.sidebar.setActivityCount(this.activity.entries.length);
    this.panel = h("section", { class: "panel", attrs: { hidden: "", "aria-label": "Details" } });
    this.notice = h("div", { class: "notice", attrs: { role: "alert", hidden: "" } });
    this.userLabel = h("span", { class: "user-name muted small" });
    const toggleSidebar = () => this.shell!.classList.toggle("sidebar-open");
    const topbar = h("header", { class: "topbar" }, [
      h("button", { class: "ghost icon-button only-narrow", attrs: { "aria-label": "Show playlists" }, on: { click: toggleSidebar } }, [icon("menu", 20)]),
      h("a", { class: "brand", attrs: { href: "#/" } }, [brandMark(24), h("span", { text: "Curatune" })]),
      h("span", { class: "spacer" }),
      spotifyAttribution(),
      this.userLabel,
      h("button", { class: "ghost small", attrs: { title: "Log out" }, on: { click: () => this.logout() } }, [icon("logout", 15), h("span", { class: "hide-narrow", text: "Log out" })]),
    ]);
    const workspace = h("div", { class: "workspace" }, [
      this.sidebar.element,
      h("div", { class: "scrim", on: { click: () => this.shell!.classList.remove("sidebar-open") } }),
      h("main", { class: "center" }, [this.notice, this.chat.element]),
      this.panel,
    ]);
    this.shell = h("div", { class: "shell" }, [topbar, workspace]);
    this.layout = new ResizableLayout(this.shell, workspace);
    for (const warning of this.warnings) this.notice.before(this.warningElement(warning));
    this.root.replaceChildren(this.shell);
    void this.sidebar.load();
    this.client.currentUser().then(
      (user) => (this.userLabel!.textContent = user.display_name ?? user.id),
      (exc: unknown) => isAuthError(exc) && this.sessionEnded(),
    );
  }

  private logout(): void {
    this.auth.logout();
    this.chat.forgetKeys();
    location.hash = "";
    void this.render();
  }

  // --- Panel ------------------------------------------------------------------------------------

  private framed(content: HTMLElement): HTMLElement[] {
    const close = h("button", { class: "ghost icon-button panel-close", attrs: { "aria-label": "Close panel", title: "Close" }, on: { click: () => (location.hash = "#/") } }, [icon("close", 18)]);
    return [close, content];
  }

  /**
   * Placeholder while a panel loads (a long playlist takes a few seconds): for a playlist, its cover and name
   * from the sidebar's list when known, then shimmering rows.
   */
  private skeleton(route: Exclude<Route, { view: "home" }>): HTMLElement {
    const bone = (cls: string) => h("div", { class: `skel ${cls}` });
    let head: HTMLElement[];
    if (route.view === "playlist") {
      const known = this.sidebar?.playlistOf(route.id) ?? null;
      head = [
        h("div", { class: "panel-hero" }, [
          known ? cover(known.images, known.name, 96, "panel-cover") : bone("panel-cover"),
          h("div", { class: "panel-hero-text" }, [
            h("div", { class: "panel-kicker muted small", text: "Playlist" }),
            known?.name ? h("h2", { class: "panel-title", text: known.name }) : bone("skel-title"),
          ]),
        ]),
      ];
    } else {
      head = [h("div", { class: "panel-kicker muted small" }), h("h2", { class: "panel-title", text: route.view === "recordings" ? "Recording dates" : "Activity" })];
    }
    return h("div", { class: "panel-content panel-skeleton" }, [
      ...head,
      h("div", { class: "facts" }, [bone("skel-pill"), bone("skel-pill"), bone("skel-pill")]),
      h("div", { class: "loading-line", attrs: { role: "status" } }, [h("span", { class: "spinner" }), h("span", { text: route.view === "playlist" ? "Loading the tracks from Spotify…" : "Loading…" })]),
      ...Array.from({ length: 8 }, () => h("div", { class: "skel-row" }, [bone("skel-line"), bone("skel-line short")])),
    ]);
  }

  private setPanelLoading(loading: boolean, playlistId: string | null = null): void {
    this.panel!.classList.toggle("loading", loading);
    this.panel!.setAttribute("aria-busy", String(loading));
    this.sidebar?.setLoading(loading ? playlistId : null);
  }

  private async renderPanel(): Promise<void> {
    const id = ++this.renderId;
    const route = this.route;
    const panel = this.panel!;
    if (route.view === "home") {
      panel.hidden = true;
      this.shell!.classList.remove("panel-open");
      this.layout?.update();
      this.setPanelLoading(false);
      return;
    }
    panel.hidden = false;
    this.shell!.classList.add("panel-open");
    this.layout?.update();
    // Something new: a skeleton right away, so the click visibly does something. The same view again (a
    // refresh after a write): keep it on screen, with only the loading bar on top.
    const key = route.view === "playlist" ? `playlist:${route.id}` : route.view;
    if (key !== this.panelKey) {
      panel.replaceChildren(...this.framed(this.skeleton(route)));
      panel.scrollTop = 0;
      this.panelKey = key;
    }
    this.setPanelLoading(true, route.view === "playlist" ? route.id : null);
    try {
      let content: HTMLElement;
      if (route.view === "playlist") {
        content = await renderPlaylistPanel(this.client, this.recordings, route.id, {
          askAbout: (p) => {
            this.chat.setContext(p);
            this.chat.focus();
          },
          ask: (p, text) => {
            this.chat.setContext(p);
            this.chat.ask(text);
          },
          loaded: (playlistId, itemCount) => this.sidebar?.setCount(playlistId, itemCount),
        });
      } else if (route.view === "recordings") {
        content = await renderRecordingsPanel(this.recordings, (exc) => this.showError(exc), () => void this.renderPanel());
      } else {
        content = renderActivityPanel(this.activity, (playlistId) => (location.hash = `#/playlist/${playlistId}`));
      }
      if (id !== this.renderId) return;
      panel.replaceChildren(...this.framed(content));
      // Opening a playlist makes it the chat's context (shown above the composer; it can be cleared).
      if (route.view === "playlist") {
        const title = content.querySelector(".panel-title")?.textContent;
        if (title) this.chat.setContext({ id: route.id, name: title });
      }
    } catch (exc) {
      if (id !== this.renderId) return;
      if (isAuthError(exc)) {
        this.sessionEnded();
        return;
      }
      panel.replaceChildren(...this.framed(h("div", { class: "panel-content" }, [h("div", { class: "card error-card", text: describeError(exc) })])));
    } finally {
      if (id === this.renderId) this.setPanelLoading(false);
    }
  }
}
