// The Recording dates and Activity panels.

import type { RecordingStore } from "../recordings/recordings";
import { CuratuneError } from "../spotify/errors";
import type { ActivityLog } from "./activity";
import { trackNameLink, writeCard } from "./cards";
import { h } from "./dom";
import { icon } from "./icons";

export async function renderRecordingsPanel(store: RecordingStore, onError: (exc: unknown) => void, rerender: () => void): Promise<HTMLElement> {
  const data = await store.load();
  const status = h("div", { class: "muted small" });
  const fileInput = h("input", { class: "visually-hidden", attrs: { type: "file", accept: ".json,application/json", "aria-label": "Recordings JSON file" } });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const result = await store.importJson(await file.text());
      rerender();
      status.textContent = `Imported: ${result.created} new, ${result.updated} updated, ${result.total} in total.`;
    } catch (exc) {
      onError(exc instanceof CuratuneError ? exc : new CuratuneError("INVALID_ARGUMENT", "Could not import the file."));
    }
  });
  const exportFile = async () => {
    const blob = new Blob([await store.exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    h("a", { attrs: { href: url, download: "recordings.json" } }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const filter = h("input", { attrs: { type: "search", placeholder: "Filter by track, artist, or source", "aria-label": "Filter recording dates" } });
  const body = h("tbody");
  const entries = Object.entries(data).sort(([, a], [, b]) => (a.recorded < b.recorded ? -1 : a.recorded > b.recorded ? 1 : 0));
  const render = () => {
    const q = filter.value.trim().toLocaleLowerCase();
    const shown = entries.filter(([uri, e]) => !q || [e.name, e.source, e.note, uri, ...(e.artists ?? [])].some((t) => (t ?? "").toLocaleLowerCase().includes(q)));
    body.replaceChildren(
      ...shown.map(([uri, e]) =>
        h("tr", {}, [
          h("td", {}, [h("span", { class: `date-pill ${e.confidence}`, text: e.recorded, attrs: { title: `${e.confidence} confidence` } })]),
          h("td", { class: "title-cell" }, [h("div", { class: "track-name" }, [trackNameLink(e.name ?? uri, uri.startsWith("spotify:track:") ? uri.slice(14) : null)]), h("div", { class: "track-artists", text: (e.artists ?? []).join(", ") })]),
          h("td", { class: "muted small hide-narrow", text: [e.source, e.note].filter(Boolean).join(" · ") }),
          h("td", { class: "num" }, [
            h("button", {
              class: "ghost tiny",
              attrs: { title: "Remove this date", "aria-label": "Remove this date" },
              on: {
                click: async () => {
                  await store.remove([uri]);
                  rerender();
                },
              },
            }, [icon("close", 13)]),
          ]),
        ]),
      ),
    );
  };
  filter.addEventListener("input", render);
  render();
  const counts = { high: 0, medium: 0, low: 0 };
  for (const [, e] of entries) counts[e.confidence] += 1;
  return h("div", { class: "panel-content" }, [
    h("div", { class: "panel-header" }, [
      h("div", { class: "panel-kicker muted small", text: "Stored in this browser" }),
      h("h2", { class: "panel-title", text: "Recording dates" }),
      h("p", {
        class: "panel-description",
        text: "Used to put playlists in recording order. Same format as Curatune's data/recordings.json: import yours, or export to back them up.",
      }),
      h("div", { class: "facts" }, [
        h("span", { class: "fact", text: `${entries.length} tracks` }),
        h("span", { class: "fact", text: `${counts.high} high · ${counts.medium} medium · ${counts.low} low confidence` }),
      ]),
      h("div", { class: "panel-actions" }, [
        h("label", { class: "button primary" }, [icon("plus", 16), "Import JSON", fileInput]),
        h("button", { class: "ghost", attrs: entries.length ? {} : { disabled: "" }, on: { click: () => void exportFile() } }, [icon("external", 15), "Export JSON"]),
      ]),
      status,
    ]),
    entries.length
      ? h("div", {}, [
          h("div", { class: "table-tools" }, [h("div", { class: "side-search" }, [icon("search", 15), filter])]),
          h("div", { class: "table-wrap" }, [h("table", { class: "tracks" }, [h("thead", {}, [h("tr", {}, [h("th", { text: "Recorded" }), h("th", { text: "Track" }), h("th", { class: "hide-narrow", text: "Source" }), h("th", {})])]), body])]),
        ])
      : h("div", { class: "empty-panel muted", text: "No recording dates yet. Import Curatune's file, or ask the chat to put a playlist in recording order." }),
  ]);
}

export function renderActivityPanel(activity: ActivityLog, onOpenPlaylist: (id: string) => void): HTMLElement {
  return h("div", { class: "panel-content" }, [
    h("div", { class: "panel-header" }, [
      h("div", { class: "panel-kicker muted small", text: "This session" }),
      h("h2", { class: "panel-title", text: "Activity" }),
      h("p", { class: "panel-description", text: "Every change made in this session: playlists created, tracks added, plans applied, dates saved." }),
    ]),
    activity.entries.length
      ? h("div", { class: "activity-list" }, activity.entries.map((e) => writeCard(e.report, e.at, onOpenPlaylist)))
      : h("div", { class: "empty-panel muted", text: "Nothing changed yet in this session." }),
  ]);
}
