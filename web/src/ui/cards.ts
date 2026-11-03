// Cards shared by the chat and the panels.

import type { WriteReport } from "../tools";
import { timeLabel } from "./activity";
import { h } from "./dom";
import { icon } from "./icons";

/**
 * The page of a playlist, track, or album on Spotify, only for well-formed IDs. Spotify's Developer Policy
 * (II.4.2) asks that metadata and cover art link back to Spotify.
 */
export function spotifyUrl(kind: "playlist" | "track" | "album", id: string | null | undefined): string | null {
  return id && /^[A-Za-z0-9]{22}$/.test(id) ? `https://open.spotify.com/${kind}/${id}` : null;
}

const external = { target: "_blank", rel: "noopener noreferrer" };

/** Link to a playlist in the Spotify app. "Open Spotify" is one of the labels Spotify's design guidelines allow. */
export function spotifyPlaylistLink(id: string | null, label = "Open Spotify"): HTMLElement | null {
  const href = spotifyUrl("playlist", id);
  return href ? h("a", { class: "link-external", attrs: { href, ...external } }, [label, icon("external", 14)]) : null;
}

/** A track's name, linked to the track on Spotify when it has an ID (local files and unavailable items don't). */
export function trackNameLink(name: string, trackId: string | null | undefined): HTMLElement {
  const href = spotifyUrl("track", trackId);
  return href ? h("a", { class: "track-link", text: name, attrs: { href, ...external, title: "Open Spotify" } }) : h("span", { text: name });
}

/** A write performed (on Spotify or locally): always expanded, never folded like reads. */
export function writeCard(report: WriteReport, at: Date, onOpenPlaylist?: (id: string) => void): HTMLElement {
  const open =
    report.playlistId && onOpenPlaylist
      ? h("button", { class: "ghost small", text: "Show playlist", on: { click: () => onOpenPlaylist(report.playlistId!) } })
      : null;
  return h("div", { class: "card write-card", attrs: { role: "status" } }, [
    h("div", { class: "card-title" }, [
      h("span", { class: "badge ok" }, [icon("check", 14), "Done"]),
      h("strong", { text: report.title }),
      h("span", { class: "muted small", text: timeLabel(at) }),
    ]),
    report.lines.length ? h("div", { class: "write-lines", text: report.lines.join("\n") }) : null,
    ...report.warnings.map((w) => h("div", { class: "warning", text: w })),
    open || report.playlistId ? h("div", { class: "card-actions" }, [open, spotifyPlaylistLink(report.playlistId)]) : null,
  ]);
}
