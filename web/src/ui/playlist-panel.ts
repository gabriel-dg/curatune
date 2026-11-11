// Playlist panel: one playlist next to the chat. Facts, quick actions that ask the chat, and the tracks
// with a filter and sortable columns (sorting here only changes the view, never the playlist).

import { lookup, type RecordingMap, type RecordingStore } from "../recordings/recordings";
import type { SpotifyClient } from "../spotify/http";
import { formatDuration, type Playlist, type PlaylistItem } from "../spotify/models";
import { getPlaylist } from "../spotify/playlists";
import { spotifyPlaylistLink, trackNameLink } from "./cards";
import { cover } from "./covers";
import { h } from "./dom";
import { icon } from "./icons";
import { userWarnings } from "./warnings";

type SortKey = "number" | "title" | "artist" | "album" | "released" | "recorded" | "duration";

export interface PanelActions {
  /** Refer the chat to this playlist and focus it. */
  askAbout: (playlist: { id: string; name: string }) => void;
  /** Send a prepared request to the chat (with this playlist as context). */
  ask: (playlist: { id: string; name: string }, text: string) => void;
  /** The playlist was read: its real track count (the sidebar's list can lag behind after a write). */
  loaded?: (playlistId: string, itemCount: number) => void;
}

function formatLongDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function visibilityLabel(p: Playlist): string {
  if (p.collaborative) return "collaborative";
  if (p.public === null) return "";
  return p.public ? "public" : "private";
}

export async function renderPlaylistPanel(
  client: SpotifyClient,
  recordingsStore: RecordingStore,
  playlistId: string,
  actions: PanelActions,
): Promise<HTMLElement> {
  const [{ playlist, items, warnings }, recordings] = await Promise.all([getPlaylist(client, playlistId), recordingsStore.load()]);
  actions.loaded?.(playlistId, items.length);
  const name = playlist.name || "(untitled)";
  const ref = { id: playlist.id!, name };
  const recordedOf = (i: PlaylistItem) => lookup(recordings, i.uri, i.isrc)[0];
  const dated = items.filter(recordedOf).length;
  const datedList = items.map((i) => recordedOf(i)?.recorded).filter((d): d is string => Boolean(d));
  const chronological = dated === items.length && items.length > 1 && datedList.every((d, i) => i === 0 || d >= datedList[i - 1]!);
  const totalMs = items.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0);

  const facts = [
    `${items.length} tracks`,
    formatLongDuration(totalMs),
    playlist.owned ? "yours" : `by ${playlist.owner_name ?? playlist.owner_id ?? "?"}`,
    visibilityLabel(playlist),
  ].filter(Boolean);

  const quick = playlist.owned
    ? [
        ["Find duplicates", "Are there duplicates in this playlist?"],
        ["Recording order?", "Is this playlist in chronological order of recording?"],
        ["Sort by recording", "Sort this playlist by recording date"],
        ["Suggest tracks", "Suggest 5 tracks that would fit this playlist"],
      ]
    : [["Describe it", "Describe this playlist"]];

  const header = h("div", { class: "panel-header" }, [
    h("div", { class: "panel-hero" }, [
      cover(playlist.images, name, 96, "panel-cover"),
      h("div", { class: "panel-hero-text" }, [h("div", { class: "panel-kicker muted small", text: "Playlist" }), h("h2", { class: "panel-title", text: name })]),
    ]),
    playlist.description ? h("p", { class: "panel-description", text: playlist.description }) : null,
    h("div", { class: "facts" }, [
      ...facts.map((f) => h("span", { class: "fact", text: f })),
      h("span", { class: `fact ${dated === items.length && items.length ? "fact-ok" : ""}`, text: `${dated}/${items.length} recording dates` }),
      chronological ? h("span", { class: "fact fact-ok", text: "in recording order" }) : null,
    ]),
    h("div", { class: "panel-actions" }, [
      h("button", { class: "primary", on: { click: () => actions.askAbout(ref) } }, [icon("chat", 16), "Ask about this playlist"]),
      spotifyPlaylistLink(playlist.id),
    ]),
    h("div", { class: "quick-label" }, [icon("sparkle", 13), h("span", { text: "Quick ideas, or ask anything in the chat:" })]),
    h("div", { class: "quick-actions" }, quick.map(([label, text]) => h("button", { class: "chip", text: label, on: { click: () => actions.ask(ref, text!) } }))),
  ]);

  // --- Track table with filter and sort (view only) ---
  let sortKey: SortKey = "number";
  let descending = false;
  const filter = h("input", { attrs: { type: "search", placeholder: "Filter tracks, artists, albums", "aria-label": "Filter tracks" } });
  const body = h("tbody");
  const headCells: Record<SortKey, HTMLElement> = {} as Record<SortKey, HTMLElement>;
  const value = (i: PlaylistItem, key: SortKey): string | number => {
    switch (key) {
      case "number": return i.position;
      case "title": return (i.name ?? "").replace(/^[^\p{L}\p{N}]+/u, "").toLocaleLowerCase();
      case "artist": return (i.artists[0]?.name ?? "").toLocaleLowerCase();
      case "album": return (i.album?.name ?? "").toLocaleLowerCase();
      case "released": return i.album?.release_date ?? "";
      case "recorded": return recordedOf(i)?.recorded ?? "￿";
      case "duration": return i.duration_ms ?? 0;
    }
  };
  const render = () => {
    const query = filter.value.trim().toLocaleLowerCase();
    const shown = items
      .filter((i) => !query || [i.name, i.album?.name, ...i.artists.map((a) => a.name)].some((t) => (t ?? "").toLocaleLowerCase().includes(query)))
      .sort((a, b) => {
        const [va, vb] = [value(a, sortKey), value(b, sortKey)];
        const cmp = va < vb ? -1 : va > vb ? 1 : a.position - b.position;
        return descending ? -cmp : cmp;
      });
    body.replaceChildren(...shown.map((i) => trackRow(i, recordings)));
    for (const [key, cell] of Object.entries(headCells)) {
      cell.classList.toggle("sorted", key === sortKey);
      cell.dataset.dir = key === sortKey ? (descending ? "desc" : "asc") : "";
    }
  };
  const th = (label: string, key: SortKey, cls = "") => {
    const cell = h("th", { class: `sortable ${cls}`, attrs: { scope: "col", tabindex: "0", title: `Sort by ${label.toLowerCase()} (view only)` } }, [label]);
    const activate = () => {
      descending = sortKey === key ? !descending : false;
      sortKey = key;
      render();
    };
    cell.addEventListener("click", activate);
    cell.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), activate()));
    headCells[key] = cell;
    return cell;
  };
  filter.addEventListener("input", render);
  const table = h("table", { class: "tracks" }, [
    h("thead", {}, [
      h("tr", {}, [th("#", "number", "num"), th("Title", "title"), th("Recorded", "recorded"), th("Time", "duration", "num")]),
    ]),
    body,
  ]);
  render();

  return h("div", { class: "panel-content" }, [
    header,
    ...userWarnings(warnings).map((text) => h("div", { class: "warning", text })),
    h("div", { class: "table-tools" }, [h("div", { class: "side-search" }, [icon("search", 15), filter])]),
    h("div", { class: "table-wrap" }, [table]),
  ]);
}

function trackRow(item: PlaylistItem, recordings: RecordingMap): HTMLTableRowElement {
  const unavailable = item.uri === null;
  const [recording, matchedBy] = lookup(recordings, item.uri, item.isrc);
  const recordedTitle = recording
    ? `${recording.confidence} confidence · ${recording.source}${matchedBy === "isrc" ? " · matched by ISRC" : ""}${recording.note ? ` · ${recording.note}` : ""}`
    : "No recording date stored";
  return h("tr", { class: unavailable ? "unavailable" : undefined }, [
    h("td", { class: "num muted", text: String(item.position + 1) }),
    h("td", { class: "title-cell" }, [
      h("div", { class: "track-name" }, [
        trackNameLink(item.name ?? (unavailable ? "(unavailable)" : ""), item.is_local ? null : item.id),
        item.is_local ? " (local)" : null,
      ]),
      h("div", { class: "track-artists" }, [
        item.artists.map((a) => a.name ?? "").join(", "),
        item.album?.name ? h("span", { class: "track-album", text: ` · ${item.album.name}${item.album.release_date ? ` (${item.album.release_date.slice(0, 4)})` : ""}` }) : null,
      ]),
    ]),
    h("td", {}, [recording ? h("span", { class: `date-pill ${recording.confidence}`, text: recording.recorded, attrs: { title: recordedTitle } }) : h("span", { class: "muted", text: "—", attrs: { title: recordedTitle } })]),
    h("td", { class: "num muted", text: item.duration ?? formatDuration(item.duration_ms) ?? "" }),
  ]);
}
