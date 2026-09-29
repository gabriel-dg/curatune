// Cards shared by the chat and the panels.

import type { WriteReport } from "../tools";
import { timeLabel } from "./activity";
import { h } from "./dom";
import { icon } from "./icons";

/** Link to a playlist in the Spotify app, only for well-formed IDs. */
export function spotifyPlaylistLink(id: string | null, label = "Open in Spotify"): HTMLElement | null {
  if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
  return h("a", { class: "link-external", attrs: { href: `https://open.spotify.com/playlist/${id}`, target: "_blank", rel: "noopener noreferrer" } }, [
    label,
    icon("external", 14),
  ]);
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
