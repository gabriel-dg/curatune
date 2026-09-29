// App shell: login, header, and routes. Routes live in the hash so reloads and the back button keep the
// view: #/ (chat), #/playlists, #/playlist/<id>, #/recordings.

import type { SpotifyAuth } from "../spotify/auth";
import { SpotikitError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/http";
import { formatDuration, type Playlist, type PlaylistItem } from "../spotify/models";
import { getPlaylist, listPlaylists, type Warning } from "../spotify/playlists";
import { parseId } from "../spotify/refs";
import { lookup, type RecordingMap, type RecordingStore } from "../recordings/recordings";
import type { ChatView } from "./chat";
import { h } from "./dom";

type Route = { view: "chat" } | { view: "playlists" } | { view: "playlist"; id: string } | { view: "recordings" };

function parseRoute(hash: string): Route {
  const match = /^#\/playlist\/([A-Za-z0-9]{22})$/.exec(hash);
  if (match) return { view: "playlist", id: match[1]! };
  if (hash === "#/recordings") return { view: "recordings" };
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
  private readonly recordings: RecordingStore;
  private readonly header: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly main: HTMLElement;
  private renderId = 0;

  constructor(root: HTMLElement, auth: SpotifyAuth, client: SpotifyClient, chat: ChatView, recordings: RecordingStore) {
    this.root = root;
    this.auth = auth;
    this.client = client;
    this.chat = chat;
    this.recordings = recordings;
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
      else if (route.view === "recordings") await this.renderRecordings(id);
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
        navLink("Playlists", "#/playlists", route.view === "playlists" || route.view === "playlist"),
        navLink("Recordings", "#/recordings", route.view === "recordings"),
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
    const recordings = await this.recordings.load();
    if (renderId !== this.renderId) return;
    const dated = items.filter((i) => lookup(recordings, i.uri, i.isrc)[0]).length;

    const totalMs = items.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0);
    const facts = [
      `${items.length} items`,
      formatLongDuration(totalMs),
      `owner: ${playlist.owned ? "you" : (playlist.owner_name ?? playlist.owner_id ?? "?")}`,
      visibilityLabel(playlist),
      `recording dates: ${dated}/${items.length}`,
    ];
    this.main.replaceChildren(
      h("p", {}, [h("a", { text: "← Playlists", attrs: { href: "#/playlists" } })]),
      h("h2", {}, [spotifyLink(playlist.url, playlist.name || "(untitled)")]),
      ...(playlist.description ? [h("p", { class: "description", text: playlist.description })] : []),
      h("p", { class: "muted", text: facts.join(" · ") }),
      ...warnings.map(renderWarning),
      h("table", {}, [
        h("thead", {}, [
          h("tr", {}, [th("#", "num"), th("Title"), th("Artists"), th("Album"), th("Released"), th("Recorded"), th("Duration", "num")]),
        ]),
        h("tbody", {}, items.map((item) => renderItem(item, recordings))),
      ]),
    );
  }
  private async renderRecordings(renderId: number): Promise<void> {
    const data = await this.recordings.load();
    if (renderId !== this.renderId) return;
    const status = h("p", { class: "muted" });
    const fileInput = h("input", { attrs: { type: "file", accept: ".json,application/json", "aria-label": "Recordings JSON file" } });
    const importFile = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const result = await this.recordings.importJson(await file.text());
        this.clearError();
        await this.renderRecordings(this.renderId);
        this.main.querySelector(".import-status")!.textContent = `Imported: ${result.created} new, ${result.updated} updated, ${result.total} in total.`;
      } catch (exc) {
        this.showError(exc);
      }
    };
    fileInput.addEventListener("change", () => void importFile());
    const exportFile = async () => {
      const blob = new Blob([await this.recordings.exportJson()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      h("a", { attrs: { href: url, download: "recordings.json" } }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const entries = Object.entries(data).sort(([, a], [, b]) => (a.recorded < b.recorded ? -1 : a.recorded > b.recorded ? 1 : 0));
    const rows = entries.map(([uri, e]) =>
      h("tr", {}, [
        h("td", { text: e.recorded }),
        h("td", { text: e.name ?? uri }),
        h("td", { text: (e.artists ?? []).join(", ") }),
        h("td", { class: `recorded ${e.confidence}`, text: e.confidence }),
        h("td", { text: [e.source, e.note].filter(Boolean).join(" · ") }),
        h("td", {}, [
          h("button", {
            class: "secondary small",
            text: "Remove",
            on: {
              click: async () => {
                await this.recordings.remove([uri]);
                await this.renderRecordings(this.renderId);
              },
            },
          }),
        ]),
      ]),
    );
    status.className = "muted import-status";
    this.main.replaceChildren(
      h("h2", { text: `Recording dates (${entries.length})` }),
      h("p", {
        class: "muted",
        text:
          "Kept in this browser and used to order playlists by recording date. Same format as spotikit's " +
          "data/recordings.json: import it to bring your dates; export to back them up or take them back to spotikit.",
      }),
      h("div", { class: "open" }, [
        h("label", { class: "file-label" }, ["Import JSON ", fileInput]),
        h("button", { class: "secondary", text: "Export JSON", attrs: entries.length ? {} : { disabled: "" }, on: { click: () => void exportFile() } }),
      ]),
      status,
      entries.length
        ? h("table", {}, [
            h("thead", {}, [h("tr", {}, [th("Recorded"), th("Track"), th("Artists"), th("Confidence"), th("Source"), th("")])]),
            h("tbody", {}, rows),
          ])
        : h("p", { class: "muted", text: "No recording dates yet." }),
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

function renderItem(item: PlaylistItem, recordings: RecordingMap): HTMLTableRowElement {
  const unavailable = item.uri === null;
  const [recording, matchedBy] = lookup(recordings, item.uri, item.isrc);
  const recordedTitle = recording
    ? `${recording.confidence} confidence · ${recording.source}${matchedBy === "isrc" ? " · matched by ISRC" : ""}${recording.note ? ` · ${recording.note}` : ""}`
    : "No recording date stored";
  return h("tr", { class: unavailable ? "unavailable" : undefined }, [
    h("td", { class: "num", text: String(item.position + 1) }),
    h("td", {}, [item.name ?? (unavailable ? "(unavailable)" : ""), item.is_local ? " (local)" : ""]),
    h("td", { text: item.artists.map((a) => a.name ?? "").join(", ") }),
    h("td", { text: item.album?.name ?? "" }),
    h("td", { text: item.album?.release_date ?? "" }),
    h("td", { class: recording ? `recorded ${recording.confidence}` : "recorded muted", text: recording?.recorded ?? "—", attrs: { title: recordedTitle } }),
    h("td", { class: "num", text: item.duration ?? formatDuration(item.duration_ms) ?? "" }),
  ]);
}
