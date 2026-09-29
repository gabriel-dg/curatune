// Sidebar: the user's playlists (filterable), and links to Recordings and Activity.

import type { SpotifyClient } from "../spotify/http";
import type { Playlist } from "../spotify/models";
import { listPlaylists } from "../spotify/playlists";
import { cover } from "./covers";
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
  /** One row per playlist, built once per load: filtering and marking reuse them, so covers are not refetched. */
  private rows: { playlist: Playlist; link: HTMLAnchorElement; glyph: HTMLElement }[] = [];
  private readonly busy = h("span", { class: "glyph-busy", attrs: { role: "status", "aria-label": "Loading" } }, [h("span", { class: "spinner" })]);
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
    this.rows = this.playlists.map((playlist) => {
      const glyph = cover(playlist.images, playlist.name, 36, "playlist-glyph");
      const link = h("a", { class: "playlist-link", attrs: { href: `#/playlist/${playlist.id}`, title: playlist.name ?? "" } }, [
        glyph,
        h("span", { class: "playlist-text" }, [
          h("span", { class: "playlist-name", text: playlist.name || "(untitled)" }),
          h("span", { class: "playlist-meta", text: `${playlist.item_count ?? 0} tracks${playlist.owned ? "" : ` · ${playlist.owner_name ?? playlist.owner_id ?? ""}`}` }),
        ]),
      ]);
      return { playlist, link, glyph };
    });
    this.renderList();
    this.mark();
  }

  /** Mark the playlist or page on screen. */
  setActive(route: { view: string; id?: string }): void {
    this.activeId = route.view === "playlist" ? (route.id ?? null) : null;
    this.footerLinks.recordings.classList.toggle("active", route.view === "recordings");
    this.footerLinks.activity.classList.toggle("active", route.view === "activity");
    this.mark();
  }

  setLoading(id: string | null): void {
    this.loadingId = id;
    this.mark();
  }

  setActivityCount(count: number): void {
    this.activityBadge.hidden = count === 0;
    this.activityBadge.textContent = String(count);
  }

  playlistOf(id: string): Playlist | null {
    return this.playlists.find((p) => p.id === id) ?? null;
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
    const shown = this.rows.filter(({ playlist: p }) => (this.filter === "all" || p.owned) && (!query || (p.name ?? "").toLocaleLowerCase().includes(query)));
    if (!shown.length) {
      this.list.replaceChildren(h("div", { class: "side-empty muted small", text: query ? "No playlist matches." : "No playlists." }));
      return;
    }
    this.list.replaceChildren(...shown.map((row) => row.link));
  }

  /** Highlight the playlist on screen and put the spinner on the one loading. */
  private mark(): void {
    let busyGlyph: HTMLElement | null = null;
    for (const { playlist, link, glyph } of this.rows) {
      const loading = playlist.id !== null && playlist.id === this.loadingId;
      link.classList.toggle("active", playlist.id !== null && playlist.id === this.activeId);
      link.classList.toggle("loading", loading);
      if (loading) busyGlyph = glyph;
    }
    if (!busyGlyph) this.busy.remove();
    else if (this.busy.parentElement !== busyGlyph) busyGlyph.append(this.busy);
  }
}
