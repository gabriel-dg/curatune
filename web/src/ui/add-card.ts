// The question playlist_add asks before adding to a playlist not created in this session: the playlist and the
// tracks, by the number each one will get, read from Spotify just now, with Confirm and Cancel. The tool waits
// for the click; Stop (the turn's abort signal) counts as Cancel. Names come from Spotify: rendered as text.

import type { AddPreview } from "../spotify/writes";
import { spotifyPlaylistLink } from "./cards";
import { h } from "./dom";
import { icon } from "./icons";

export function addConfirmCard(preview: AddPreview, signal: AbortSignal): { element: HTMLElement; answer: Promise<boolean> } {
  const n = preview.add.length;
  const status = h("div", { class: "plan-status" }, [h("span", { class: "muted", text: "Waiting for you · nothing has changed yet" })]);
  const confirmButton = h("button", { class: "primary" }, [icon("check", 16), "Confirm"]);
  const cancelButton = h("button", { class: "ghost", text: "Cancel" });
  const rows = preview.add.map((track, i) =>
    h("div", { class: "diff-row kept" }, [
      h("span", { class: "diff-num", text: String(preview.position + i + 1) }),
      h("span", { class: "diff-track" }, [
        h("span", { class: "diff-name", text: track.name ?? track.uri }),
        h("span", { class: "diff-artists", text: track.artists.join(", ") }),
      ]),
      h("span", { class: "diff-note", text: "new" }),
    ]),
  );
  const element = h("div", { class: "card plan-card add-confirm" }, [
    h("div", { class: "card-title" }, [
      h("span", { class: "badge plan" }, ["Confirm"]),
      h("strong", { text: `Add ${n} track${n === 1 ? "" : "s"} to "${preview.playlist.name ?? preview.playlist.id}" (${preview.item_count} → ${preview.item_count + n})` }),
    ]),
    h("div", { class: "plan-reason", text: "The assistant wants to add these tracks to a playlist it did not create in this session. Nothing is added unless you confirm." }),
    h("div", { class: "diff" }, rows),
    preview.skipped.length ? h("div", { class: "plan-summary muted small", text: `${preview.skipped.length} already in the playlist or repeated: skipped.` }) : null,
    h("div", { class: "card-actions" }, [spotifyPlaylistLink(preview.playlist.id)]),
    h("div", { class: "plan-actions" }, [status, cancelButton, confirmButton]),
  ]);

  const answer = new Promise<boolean>((resolve) => {
    const finish = (yes: boolean, text: string) => {
      confirmButton.hidden = true;
      cancelButton.hidden = true;
      status.replaceChildren(h("span", { class: "muted", text }));
      element.classList.add(yes ? "plan-ok" : "plan-muted");
      signal.removeEventListener("abort", onAbort);
      resolve(yes);
    };
    const onAbort = () => finish(false, "Stopped · nothing was added");
    if (signal.aborted) return finish(false, "Stopped · nothing was added");
    signal.addEventListener("abort", onAbort);
    confirmButton.addEventListener("click", () => finish(true, "Confirmed · adding"));
    cancelButton.addEventListener("click", () => finish(false, "Cancelled · nothing was added"));
  });
  return { element, answer };
}
