// Sidebar: the user's playlists (filterable), and links to Recordings and Activity.

import type { SpotifyClient } from "../spotify/http";
import type { Playlist } from "../spotify/models";
import { listPlaylists } from "../spotify/playlists";
import { ENTRY_TTL_MS } from "../spotify/writelog";
import { cover } from "./covers";
import { h } from "./dom";
import { icon } from "./icons";

/**
 * The track count to show for a playlist: the one known from a write or a full read while Spotify's list
 * still disagrees, else the list's. `keep` is false when the known count is no longer needed (the list
 * caught up) or too old to trust (as old as the write log's entries).
 */
export function countToShow(listed: number | null, known: { count: number; at: number } | undefined, now: number): { count: number | null; keep: boolean } {
  if (!known) return { count: listed, keep: false };
  if (known.count === listed || now - known.at > ENTRY_TTL_MS) return { count: listed, keep: false };
  return { count: known.count, keep: true };
}

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
  private rows: { playlist: Playlist; link: HTMLAnchorElement; glyph: HTMLElement; meta: HTMLElement }[] = [];
  private readonly busy = h("span", { class: "glyph-busy", attrs: { role: "status", "aria-label": "Loading" } }, [h("span", { class: "spinner" })]);
  private filter: "all" | "mine" = "all";
  private activeId: string | null = null;
  /** The playlist whose panel is loading: its row shows a spinner. */
  private loadingId: string | null = null;
  private loaded = false;
  /**
   * Track counts known to be current (from this app's writes and from reading a playlist). After a write,
   * Spotify's playlist list keeps returning the old total for a while, like the snapshot_id read lag; a
   * known count wins until the list agrees or the entry is as old as the write log's.
   */
  private readonly knownCounts = new Map<string, { count: number; at: number }>();

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
      this.playlists = (await listPlaylists(this.client)).playlists.map((p) => ({ ...p, item_count: this.countFor(p) }));
      this.loaded = true;
    } catch {
      if (!this.loaded) this.list.replaceChildren(h("div", { class: "side-empty muted small", text: "Could not load playlists." }));
      return;
    }
    this.rows = this.playlists.map((playlist) => {
      const glyph = cover(playlist.images, playlist.name, 36, "playlist-glyph");
      const meta = h("span", { class: "playlist-meta", text: this.metaText(playlist) });
      const link = h("a", { class: "playlist-link", attrs: { href: `#/playlist/${playlist.id}`, title: playlist.name ?? "" } }, [
        glyph,
        h("span", { class: "playlist-text" }, [h("span", { class: "playlist-name", text: playlist.name || "(untitled)" }), meta]),
      ]);
      return { playlist, link, glyph, meta };
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

  /** A current track count for a playlist (after a write, or read in full): shown now and kept over a lagging list. */
  setCount(id: string, count: number): void {
    this.knownCounts.set(id, { count, at: Date.now() });
    const row = this.rows.find((r) => r.playlist.id === id);
    if (!row || row.playlist.item_count === count) return;
    row.playlist.item_count = count;
    row.meta.textContent = this.metaText(row.playlist);
  }

  private countFor(p: Playlist): number | null {
    if (!p.id) return p.item_count;
    const { count, keep } = countToShow(p.item_count, this.knownCounts.get(p.id), Date.now());
    if (!keep) this.knownCounts.delete(p.id);
    return count;
  }

  private metaText(p: Playlist): string {
    return `${p.item_count ?? 0} tracks${p.owned ? "" : ` · ${p.owner_name ?? p.owner_id ?? ""}`}`;
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
