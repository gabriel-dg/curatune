// Sidebar: the user's playlists (filterable), and links to Recordings and Activity.

import type { SpotifyClient } from "../spotify/http";
import type { Playlist } from "../spotify/models";
import { listPlaylists } from "../spotify/playlists";
import { h } from "./dom";
import { icon } from "./icons";

export class Sidebar {
  readonly element: HTMLElement;
  private readonly client: SpotifyClient;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly activityBadge: HTMLElement;
  private readonly footerLinks: Record<"recordings" | "activity", HTMLAnchorElement>;
  private readonly filterButtons: Record<"all" | "mine", HTMLButtonElement>;
  private playlists: Playlist[] = [];
  private filter: "all" | "mine" = "all";
  private activeId: string | null = null;
  /** The playlist whose panel is loading: its row shows a spinner. */
  private loadingId: string | null = null;
  private loaded = false;

  constructor(client: SpotifyClient) {
    this.client = client;
    this.search = h("input", { attrs: { type: "search", placeholder: "Filter playlists", "aria-label": "Filter playlists" }, on: { input: () => this.renderList() } });
    this.filterButtons = {
      all: h("button", { class: "chip active", text: "All", on: { click: () => this.setFilter("all") } }),
      mine: h("button", { class: "chip", text: "Mine", on: { click: () => this.setFilter("mine") } }),
    };
    this.list = h("nav", { class: "playlist-list", attrs: { "aria-label": "Playlists" } });
    this.activityBadge = h("span", { class: "count-badge", attrs: { hidden: "" } });
    this.footerLinks = {
      recordings: h("a", { class: "side-link", attrs: { href: "#/recordings" } }, [icon("calendar", 17), h("span", { text: "Recording dates" })]),
      activity: h("a", { class: "side-link", attrs: { href: "#/activity" } }, [icon("activity", 17), h("span", { text: "Activity" }), this.activityBadge]),
    };
    this.element = h("aside", { class: "sidebar" }, [
      h("div", { class: "side-section-title" }, [
        h("span", { text: "Your playlists" }),
        h("button", { class: "ghost tiny", attrs: { title: "Reload playlists", "aria-label": "Reload playlists" }, on: { click: () => void this.load() } }, [icon("refresh", 14)]),
      ]),
      h("div", { class: "side-search" }, [icon("search", 15), this.search]),
      h("div", { class: "chips" }, [this.filterButtons.all, this.filterButtons.mine]),
      this.list,
      h("div", { class: "side-footer" }, [this.footerLinks.recordings, this.footerLinks.activity]),
    ]);
    this.list.append(h("div", { class: "side-empty muted small", text: "Loading…" }));
  }

  async load(): Promise<void> {
    try {
      this.playlists = (await listPlaylists(this.client)).playlists;
      this.loaded = true;
    } catch {
      if (!this.loaded) this.list.replaceChildren(h("div", { class: "side-empty muted small", text: "Could not load playlists." }));
      return;
    }
    this.renderList();
  }

  /** Mark the playlist or page on screen. */
  setActive(route: { view: string; id?: string }): void {
    this.activeId = route.view === "playlist" ? (route.id ?? null) : null;
    this.footerLinks.recordings.classList.toggle("active", route.view === "recordings");
    this.footerLinks.activity.classList.toggle("active", route.view === "activity");
    this.renderList();
  }

  setLoading(id: string | null): void {
    if (id === this.loadingId) return;
    this.loadingId = id;
    this.renderList();
  }

  setActivityCount(count: number): void {
    this.activityBadge.hidden = count === 0;
    this.activityBadge.textContent = String(count);
  }

  nameOf(id: string): string | null {
    return this.playlists.find((p) => p.id === id)?.name ?? null;
  }

  private setFilter(filter: "all" | "mine"): void {
    this.filter = filter;
    this.filterButtons.all.classList.toggle("active", filter === "all");
    this.filterButtons.mine.classList.toggle("active", filter === "mine");
    this.renderList();
  }

  private renderList(): void {
    if (!this.loaded) return;
    const query = this.search.value.trim().toLocaleLowerCase();
    const shown = this.playlists.filter((p) => (this.filter === "all" || p.owned) && (!query || (p.name ?? "").toLocaleLowerCase().includes(query)));
    if (!shown.length) {
      this.list.replaceChildren(h("div", { class: "side-empty muted small", text: query ? "No playlist matches." : "No playlists." }));
      return;
    }
    this.list.replaceChildren(
      ...shown.map((p) => {
        const loading = p.id === this.loadingId;
        const glyph = loading ? [h("span", { class: "spinner", attrs: { role: "status", "aria-label": "Loading" } })] : [(p.name ?? "?").trim().charAt(0).toUpperCase() || "?"];
        return h("a", { class: `playlist-link${p.id === this.activeId ? " active" : ""}${loading ? " loading" : ""}`, attrs: { href: `#/playlist/${p.id}`, title: p.name ?? "" } }, [
          h("span", { class: "playlist-glyph" }, glyph),
          h("span", { class: "playlist-text" }, [
            h("span", { class: "playlist-name", text: p.name || "(untitled)" }),
            h("span", { class: "playlist-meta", text: `${p.item_count ?? 0} tracks${p.owned ? "" : ` · ${p.owner_name ?? p.owner_id ?? ""}`}` }),
          ]),
        ]);
      }),
    );
  }
}
