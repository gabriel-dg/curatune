// App shell: login, header, and routes. Routes live in the hash so reloads and the back button keep the
// view: #/ (chat), #/playlists, #/playlist/<id>.

import type { SpotifyAuth } from "../spotify/auth";
import { SpotikitError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/http";
import { formatDuration, type Playlist, type PlaylistItem } from "../spotify/models";
import { getPlaylist, listPlaylists, type Warning } from "../spotify/playlists";
import { parseId } from "../spotify/refs";
import type { ChatView } from "./chat";
import { h } from "./dom";

type Route = { view: "chat" } | { view: "playlists" } | { view: "playlist"; id: string };

function parseRoute(hash: string): Route {
  const match = /^#\/playlist\/([A-Za-z0-9]{22})$/.exec(hash);
  if (match) return { view: "playlist", id: match[1]! };
  return hash === "#/playlists" ? { view: "playlists" } : { view: "chat" };
}

/** Only links to open.spotify.com are rendered; anything else from a response is shown as plain text. */
function spotifyLink(url: string | null, label: string): Node {
  if (url && /^https:\/\/open\.spotify\.com\//.test(url)) {
    return h("a", { text: label, attrs: { href: url, target: "_blank", rel: "noopener noreferrer" } });
  }
  return document.createTextNode(label);
}

function describeError(exc: unknown): string {
  if (exc instanceof SpotikitError) return `${exc.code}: ${exc.message}`;
  return "Unexpected error. See the browser console for details.";
}

export class App {
  private readonly root: HTMLElement;
  private readonly auth: SpotifyAuth;
  private readonly client: SpotifyClient;
  private readonly chat: ChatView;
  private readonly header: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly main: HTMLElement;
  private renderId = 0;

  constructor(root: HTMLElement, auth: SpotifyAuth, client: SpotifyClient, chat: ChatView) {
    this.root = root;
    this.auth = auth;
    this.client = client;
    this.chat = chat;
    this.chat.onAuthError = () => {
      this.auth.logout();
      void this.render();
    };
    this.header = h("header", { class: "top" });
    this.notice = h("div", { class: "notice", attrs: { role: "alert", hidden: "" } });
    this.main = h("main");
    this.root.replaceChildren(this.header, this.notice, this.main);
    window.addEventListener("hashchange", () => {
      this.clearError();
      void this.render();
    });
  }

  showError(exc: unknown): void {
    if (!(exc instanceof SpotikitError)) console.error(exc);
    this.notice.textContent = describeError(exc);
    this.notice.hidden = false;
  }

  clearError(): void {
    this.notice.textContent = "";
    this.notice.hidden = true;
  }

  async render(): Promise<void> {
    const id = ++this.renderId;
    if (!this.auth.isLoggedIn()) {
      this.renderLoggedOut();
      return;
    }
    const route = parseRoute(location.hash);
    this.renderHeader(null, route);
    this.main.replaceChildren(h("p", { class: "muted", text: "Loading…" }));
    try {
      const user = await this.client.currentUser();
      if (id !== this.renderId) return;
      this.renderHeader(user.display_name ?? user.id, route);
      if (route.view === "chat") this.main.replaceChildren(this.chat.element);
      else if (route.view === "playlist") await this.renderPlaylist(route.id, id);
      else await this.renderPlaylists(id);
    } catch (exc) {
      if (id !== this.renderId) return;
      if (exc instanceof SpotikitError && (exc.code === "AUTH_REQUIRED" || exc.code === "AUTH_EXPIRED")) {
        this.auth.logout();
        this.renderLoggedOut();
      } else {
        this.main.replaceChildren();
      }
      this.showError(exc);
    }
  }

  // --- Views ------------------------------------------------------------------------------------

  private renderLoggedOut(): void {
    this.header.replaceChildren(h("h1", { text: "spotikit-web" }));
    const button = h("button", {
      text: "Log in with Spotify",
      on: {
        click: async () => {
          button.disabled = true;
          try {
            location.assign(await this.auth.beginLogin());
          } catch (exc) {
            button.disabled = false;
            this.showError(exc);
          }
        },
      },
    });
    this.main.replaceChildren(
      h("section", { class: "login" }, [
        h("p", { text: "Log in to read your playlists. Your Spotify token stays in this browser tab." }),
        button,
      ]),
    );
  }

  private renderHeader(userLabel: string | null, route: Route): void {
    const status = this.auth.status();
    const missing = status?.missingScopes.length ? `Missing scopes: ${status.missingScopes.join(", ")}` : null;
    const navLink = (text: string, href: string, active: boolean) =>
      h("a", { text, class: active ? "active" : undefined, attrs: { href, ...(active ? { "aria-current": "page" } : {}) } });
    this.header.replaceChildren(
      h("h1", {}, [h("a", { text: "spotikit-web", attrs: { href: "#/" } })]),
      h("nav", {}, [
        navLink("Chat", "#/", route.view === "chat"),
        navLink("Playlists", "#/playlists", route.view !== "chat"),
      ]),
      h("div", { class: "user" }, [
        missing && h("span", { class: "warning", text: missing }),
        userLabel && h("span", { text: userLabel }),
        h("button", {
          class: "secondary",
          text: "Log out",
          on: {
            click: () => {
              this.auth.logout();
              this.clearError();
              location.hash = "";
              void this.render();
            },
          },
        }),
      ]),
    );
  }

  private async renderPlaylists(renderId: number): Promise<void> {
    const data = await listPlaylists(this.client);
    if (renderId !== this.renderId) return;

    const input = h("input", {
      attrs: { type: "text", placeholder: "Playlist URL, URI, or ID", "aria-label": "Playlist reference" },
    });
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      try {
        location.hash = `#/playlist/${parseId(input.value, "playlist")}`;
        this.clearError();
      } catch (exc) {
        this.showError(exc);
      }
    };
    const open = h("form", { class: "open", on: { submit: onSubmit } }, [
      input,
      h("button", { text: "Open", attrs: { type: "submit" } }),
    ]);

    const rows = data.playlists.map((p) =>
      h("tr", {}, [
        h("td", {}, [p.id ? h("a", { text: p.name || "(untitled)", attrs: { href: `#/playlist/${p.id}` } }) : p.name]),
        h("td", { text: p.owned ? "you" : (p.owner_name ?? p.owner_id ?? "") }),
        h("td", { class: "num", text: String(p.item_count ?? "") }),
        h("td", { text: visibilityLabel(p) }),
      ]),
    );
    this.main.replaceChildren(
      h("h2", { text: `Playlists (${data.count})` }),
      open,
      h("table", {}, [
        h("thead", {}, [h("tr", {}, [th("Name"), th("Owner"), th("Items", "num"), th("Visibility")])]),
        h("tbody", {}, rows),
      ]),
    );
  }

  private async renderPlaylist(playlistId: string, renderId: number): Promise<void> {
    const { playlist, items, warnings } = await getPlaylist(this.client, playlistId);
    if (renderId !== this.renderId) return;

    const totalMs = items.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0);
    const facts = [
      `${items.length} items`,
      formatLongDuration(totalMs),
      `owner: ${playlist.owned ? "you" : (playlist.owner_name ?? playlist.owner_id ?? "?")}`,
      visibilityLabel(playlist),
    ];
    this.main.replaceChildren(
      h("p", {}, [h("a", { text: "← Playlists", attrs: { href: "#/playlists" } })]),
      h("h2", {}, [spotifyLink(playlist.url, playlist.name || "(untitled)")]),
      ...(playlist.description ? [h("p", { class: "description", text: playlist.description })] : []),
      h("p", { class: "muted", text: facts.join(" · ") }),
      ...warnings.map(renderWarning),
      h("table", {}, [
        h("thead", {}, [
          h("tr", {}, [th("#", "num"), th("Title"), th("Artists"), th("Album"), th("Released"), th("Duration", "num")]),
        ]),
        h("tbody", {}, items.map(renderItem)),
      ]),
    );
  }
}

function th(text: string, cls?: string): HTMLTableCellElement {
  return h("th", { text, class: cls, attrs: { scope: "col" } });
}

function visibilityLabel(p: Playlist): string {
  if (p.collaborative) return "collaborative";
  if (p.public === null) return "";
  return p.public ? "public" : "private";
}

function formatLongDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function renderWarning(w: Warning): HTMLElement {
  // Track numbers are shown 1-based, as in the Spotify app and in what the model says.
  const positions = Array.isArray(w.positions) ? ` Tracks: ${w.positions.map((p: number) => p + 1).join(", ")}.` : "";
  return h("p", { class: "warning", text: `${w.code}: ${w.message}${positions}` });
}

function renderItem(item: PlaylistItem): HTMLTableRowElement {
  const unavailable = item.uri === null;
  return h("tr", { class: unavailable ? "unavailable" : undefined }, [
    h("td", { class: "num", text: String(item.position + 1) }),
    h("td", {}, [item.name ?? (unavailable ? "(unavailable)" : ""), item.is_local ? " (local)" : ""]),
    h("td", { text: item.artists.map((a) => a.name ?? "").join(", ") }),
    h("td", { text: item.album?.name ?? "" }),
    h("td", { text: item.album?.release_date ?? "" }),
    h("td", { class: "num", text: item.duration ?? formatDuration(item.duration_ms) ?? "" }),
  ]);
}
