// A proposed plan as the user sees it: a diff of the playlist (removed tracks struck through, moved
// tracks with how far they move, renamed fields old → new) and the only way to run it, the Apply button.
// Track numbers are 1-based, as in the Spotify app. Names come from Spotify and the reason from the model:
// all of it is rendered as text.

import { applyPlan, type AfterItem, type ApplyResult, type CompactItem, type ItemPlan, type Plan } from "../plans/plans";
import { CuratuneError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/http";
import type { KeyValueStore } from "../storage/kv";
import type { WriteReport } from "../tools";
import { noticeText, planLabel } from "./app-messages";
import { spotifyPlaylistLink } from "./cards";
import { h } from "./dom";
import { icon } from "./icons";
import { userWarnings } from "./warnings";

export interface PlanCardOptions {
  client: SpotifyClient;
  backups: KeyValueStore;
  /** A write happened (the plan was applied, verified or not). */
  onWrite: (report: WriteReport) => void;
  /** Something the model should learn in the next turn (applied, failed, discarded). IDs and counts only, no
   * Spotify text (./app-messages.ts). */
  onNotice: (notice: string) => void;
}

/** Above the model's reason, so it never reads as something the app checked (as curatune's confirm.py labels it). */
export const REASON_LABEL = "The assistant's explanation (written by the AI, not checked by the app):";

/** Above this many tracks, the diff shows only the changed ones (and their neighbours for removals). */
const FULL_DIFF_LIMIT = 40;

const who = (artists: string[]) => artists.filter(Boolean).join(", ");

export function planTitle(plan: Plan): string {
  const name = `"${plan.playlist.name ?? plan.playlist.id}"`;
  if (plan.kind === "remove") {
    const n = plan.changes.remove?.length ?? 0;
    return `Remove ${n} track${n === 1 ? "" : "s"} from ${name}`;
  }
  if (plan.kind === "reorder") {
    const carried = new Set((plan.changes.moves ?? []).flatMap((m) => m.items.map((i) => i.from_position)));
    const moved = plan.after.filter((a) => carried.has(a.from_position) && a.from_position !== a.position).length;
    return `Reorder ${name} (${moved} track${moved === 1 ? "" : "s"} moved)`;
  }
  return `Change the ${Object.keys(plan.changes).join(" and ")} of ${name}`;
}

function trackRow(number: number, item: CompactItem, cls: string, note: Node | null = null): HTMLElement {
  return h("div", { class: `diff-row ${cls}` }, [
    h("span", { class: "diff-num", text: String(number) }),
    h("span", { class: "diff-track" }, [h("span", { class: "diff-name", text: item.name ?? "(unavailable)" }), h("span", { class: "diff-artists", text: who(item.artists) })]),
    note ?? h("span", { class: "diff-note" }),
  ]);
}

function removeDiff(plan: ItemPlan): HTMLElement {
  const removed = new Set((plan.changes.remove ?? []).map((r) => r.position));
  const near = (p: number) => [...removed].some((r) => Math.abs(r - p) <= 1);
  const rows: HTMLElement[] = [];
  let skipped = 0;
  const flushSkipped = () => {
    if (skipped) rows.push(h("div", { class: "diff-gap", text: `… ${skipped} unchanged track${skipped === 1 ? "" : "s"}` }));
    skipped = 0;
  };
  for (const item of plan.before) {
    if (plan.before.length > FULL_DIFF_LIMIT && !near(item.position)) {
      skipped += 1;
      continue;
    }
    flushSkipped();
    const gone = removed.has(item.position);
    rows.push(trackRow(item.position + 1, item, gone ? "removed" : "kept", gone ? h("span", { class: "diff-note removed-note", text: "removed" }) : null));
  }
  flushSkipped();
  return h("div", { class: "diff" }, rows);
}

function reorderDiff(plan: ItemPlan): HTMLElement {
  const container = h("div", { class: "diff" });
  // The tracks the operations carry are the ones that "move"; the rest only shift to make room, which is
  // noise when one track goes to the top and fifty others shift by one.
  const carried = new Set((plan.changes.moves ?? []).flatMap((m) => m.items.map((i) => i.from_position)));
  const isMoved = (a: AfterItem) => carried.has(a.from_position) && a.from_position !== a.position;
  const moved = plan.after.filter(isMoved);
  const render = (onlyMoved: boolean) => {
    const rows = (onlyMoved ? moved : plan.after).map((a: AfterItem) => {
      const delta = a.from_position - a.position; // positive: moves up
      if (!isMoved(a)) {
        const shifted = delta !== 0 ? h("span", { class: "diff-note shifted", text: `was ${a.from_position + 1}` }) : null;
        return trackRow(a.position + 1, a, "kept", shifted);
      }
      const note = h("span", { class: `diff-note move ${delta > 0 ? "up" : "down"}` }, [
        icon(delta > 0 ? "arrowUp" : "arrowDown", 13),
        `${Math.abs(delta)} · was ${a.from_position + 1}`,
      ]);
      return trackRow(a.position + 1, a, "moved", note);
    });
    container.replaceChildren(...rows);
  };
  const long = plan.after.length > FULL_DIFF_LIMIT;
  render(long);
  if (!long) return container;
  let onlyMoved = true;
  const toggle = h("button", { class: "ghost small", text: `Show all ${plan.after.length} tracks` });
  toggle.addEventListener("click", () => {
    onlyMoved = !onlyMoved;
    render(onlyMoved);
    toggle.textContent = onlyMoved ? `Show all ${plan.after.length} tracks` : `Show only the ${moved.length} moved`;
  });
  return h("div", {}, [container, toggle]);
}

function detailsDiff(plan: Extract<Plan, { kind: "details" }>): HTMLElement {
  return h(
    "div",
    { class: "diff details-diff" },
    Object.entries(plan.changes).map(([field, change]) =>
      h("div", { class: "details-row" }, [
        h("span", { class: "details-field", text: field === "name" ? "Name" : "Description" }),
        h("span", { class: "details-old", text: change.from || "(empty)" }),
        icon("arrowDown", 14),
        h("span", { class: "details-new", text: change.to || "(empty)" }),
      ]),
    ),
  );
}

function describeFailure(exc: unknown): string {
  if (!(exc instanceof CuratuneError)) return "Unexpected error; see the browser console.";
  if (exc.code === "SNAPSHOT_MISMATCH") return "The playlist changed since this plan was made. Nothing was modified; ask for a new plan.";
  if (exc.code === "APPLY_FAILED") return `${exc.message} A backup of the playlist before the change is stored in this browser (${String(exc.details.backup_key)}).`;
  if (exc.code === "VERIFICATION_FAILED") return `${exc.message} A backup is stored in this browser (${String(exc.details.backup_key)}).`;
  return `${exc.code}: ${exc.message}`;
}

export function planCard(plan: Plan, options: PlanCardOptions): HTMLElement {
  const status = h("div", { class: "plan-status" }, [h("span", { class: "muted", text: "Proposed · nothing has changed yet" })]);
  const applyButton = h("button", { class: "primary" }, [icon("check", 16), "Apply"]);
  const discardButton = h("button", { class: "ghost", text: "Discard" });
  const summary =
    plan.kind === "details"
      ? null
      : h("div", { class: "plan-summary muted small", text: `${plan.before.length} → ${plan.after.length} tracks · ${plan.operations.length} operation${plan.operations.length === 1 ? "" : "s"}` });
  const card = h("div", { class: "card plan-card" }, [
    h("div", { class: "card-title" }, [h("span", { class: "badge plan" }, ["Plan"]), h("strong", { text: planTitle(plan) })]),
    plan.reason
      ? h("div", { class: "plan-reason" }, [h("div", { class: "plan-reason-label muted small", text: REASON_LABEL }), h("div", { text: `“${plan.reason}”` })])
      : null,
    plan.kind === "details" ? detailsDiff(plan) : plan.kind === "remove" ? removeDiff(plan) : reorderDiff(plan),
    summary,
    h("div", { class: "card-actions" }, [spotifyPlaylistLink(plan.playlist.id)]),
    ...userWarnings(plan.warnings).map((text) => h("div", { class: "warning", text })),
    h("div", { class: "plan-actions" }, [status, discardButton, applyButton]),
  ]);

  const finish = (text: string, kind: "ok" | "failed" | "muted") => {
    // Whatever the outcome, this plan is done: a failed plan is regenerated, never retried as is.
    applyButton.hidden = true;
    discardButton.hidden = true;
    status.replaceChildren(kind === "ok" ? h("span", { class: "badge ok" }, [icon("check", 14), text]) : h("span", { class: kind === "failed" ? "error-text" : "muted", text }));
    card.classList.add(`plan-${kind}`);
  };

  discardButton.addEventListener("click", () => {
    finish("Discarded · nothing was changed", "muted");
    options.onNotice(`The user discarded ${planLabel(plan)}. Nothing was changed.`);
  });

  applyButton.addEventListener("click", async () => {
    applyButton.disabled = true;
    discardButton.disabled = true;
    status.replaceChildren(h("span", { class: "muted", text: "Applying…" }));
    let result: ApplyResult;
    try {
      result = await applyPlan(options.client, plan, options.backups);
    } catch (exc) {
      if (!(exc instanceof CuratuneError)) console.error(exc);
      const ranOperations = exc instanceof CuratuneError && (exc.code === "VERIFICATION_FAILED" || (exc.code === "APPLY_FAILED" && Number(exc.details.operations_done) > 0));
      const message = describeFailure(exc);
      finish(message, "failed");
      if (ranOperations) options.onWrite({ title: `Plan partly applied: ${planTitle(plan)}`, lines: [message], playlistId: plan.playlist.id, warnings: [message] });
      const code = exc instanceof CuratuneError ? exc.code : "ERROR";
      options.onNotice(`The user pressed Apply on ${planLabel(plan)} and it failed with ${code}: ${noticeText(message)}`);
      return;
    }
    const verified = result.verified ? "Applied and verified" : "Applied, but reads do not show the change yet";
    finish(verified, result.verified ? "ok" : "failed");
    const lines =
      plan.kind === "remove"
        ? (plan.changes.remove ?? []).map((i) => `Removed ${i.position + 1}. ${i.name ?? "(unavailable)"}${i.artists.length ? ` - ${who(i.artists)}` : ""}`)
        : plan.kind === "reorder"
          ? [`New order of ${plan.after.length} tracks.`]
          : Object.entries(plan.changes).map(([k, c]) => `${k}: "${c.from}" → "${c.to}"`);
    options.onWrite({
      title: `Applied plan: ${planTitle(plan)}`,
      lines,
      playlistId: plan.playlist.id,
      warnings: userWarnings(result.warnings),
      ...(plan.kind === "details" ? {} : { itemCount: plan.after.length }),
    });
    options.onNotice(`The user applied ${planLabel(plan)}. ${verified}.`);
  });

  return card;
}
