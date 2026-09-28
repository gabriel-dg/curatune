// A proposed plan as the user sees it: what changes, the playlist before and after, and the only way to
// run it, the Apply button. Track numbers are 1-based, as in the Spotify app. Names come from Spotify and
// the reason from the model: all of it is rendered as text.

import { applyPlan, type AfterItem, type ApplyResult, type CompactItem, type Plan } from "../plans/plans";
import { SpotikitError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/http";
import type { KeyValueStore } from "../storage/kv";
import type { WriteReport } from "../tools";
import { h } from "./dom";

export interface PlanCardOptions {
  client: SpotifyClient;
  backups: KeyValueStore;
  /** A write happened (the plan was applied, verified or not). */
  onWrite: (report: WriteReport) => void;
  /** Something the model should learn in the next turn (applied, failed, discarded). */
  onNotice: (notice: string) => void;
}

const line = (i: { name: string | null; artists: string[]; album?: string | null }) =>
  `${i.name ?? "(unavailable)"}${i.artists.length ? ` - ${i.artists.filter(Boolean).join(", ")}` : ""}`;

function title(plan: Plan): string {
  const name = `"${plan.playlist.name ?? plan.playlist.id}"`;
  if (plan.kind === "remove") {
    const n = plan.changes.remove?.length ?? 0;
    return `Remove ${n} track${n === 1 ? "" : "s"} from ${name}`;
  }
  if (plan.kind === "reorder") return `Reorder ${name} (${plan.operations.length} move${plan.operations.length === 1 ? "" : "s"})`;
  return `Change the ${Object.keys(plan.changes).join(" and ")} of ${name}`;
}

function list(items: (CompactItem | AfterItem)[], mark?: (i: CompactItem | AfterItem) => string | null): HTMLElement {
  return h(
    "ol",
    { class: "plan-list" },
    items.map((i) => {
      const note = mark?.(i);
      return h("li", { class: note ? "changed" : undefined, attrs: { value: String(i.position + 1) } }, [line(i), note ? h("span", { class: "muted", text: ` ${note}` }) : null]);
    }),
  );
}

function changesView(plan: Plan): HTMLElement {
  if (plan.kind === "remove") {
    return h("div", {}, [h("div", { class: "muted", text: "Removes:" }), list(plan.changes.remove ?? [])]);
  }
  if (plan.kind === "reorder") {
    return h("div", {}, [
      h("div", { class: "muted", text: "New order:" }),
      list(plan.after, (a) => ((a as AfterItem).from_position !== a.position ? `(was ${(a as AfterItem).from_position + 1})` : null)),
    ]);
  }
  return h(
    "dl",
    { class: "plan-details" },
    Object.entries(plan.changes).flatMap(([field, change]) => [
      h("dt", { text: field === "name" ? "Name" : "Description" }),
      h("dd", {}, [h("span", { class: "old", text: change.from || "(empty)" }), " → ", h("strong", { text: change.to || "(empty)" })]),
    ]),
  );
}

function describeFailure(exc: unknown): string {
  if (!(exc instanceof SpotikitError)) return "Unexpected error; see the browser console.";
  if (exc.code === "SNAPSHOT_MISMATCH") return "The playlist changed since this plan was made. Nothing was modified; ask for a new plan.";
  if (exc.code === "APPLY_FAILED") return `${exc.message} A backup of the playlist before the change is stored in this browser (${String(exc.details.backup_key)}).`;
  if (exc.code === "VERIFICATION_FAILED") return `${exc.message} A backup is stored in this browser (${String(exc.details.backup_key)}).`;
  return `${exc.code}: ${exc.message}`;
}

export function planCard(plan: Plan, options: PlanCardOptions): HTMLElement {
  const status = h("div", { class: "plan-status muted", text: "Proposed. Nothing has changed yet." });
  const applyButton = h("button", { text: "Apply" });
  const discardButton = h("button", { class: "secondary", text: "Discard" });
  const card = h("div", { class: "plan-card" }, [
    h("div", { class: "plan-title" }, [h("span", { class: "plan-badge", text: "Plan" }), h("strong", { text: title(plan) })]),
    plan.reason ? h("div", { class: "plan-reason", text: plan.reason }) : null,
    changesView(plan),
    ...plan.warnings.map((w) => h("div", { class: "warning", text: `${w.code}: ${w.message}` })),
    plan.kind !== "details"
      ? h("details", {}, [h("summary", { text: `Before (${plan.before.length}) and after (${plan.after.length})` }), h("div", { class: "plan-columns" }, [
          h("div", {}, [h("div", { class: "muted", text: "Before" }), list(plan.before)]),
          h("div", {}, [h("div", { class: "muted", text: "After" }), list(plan.after)]),
        ])])
      : null,
    h("div", { class: "plan-actions" }, [status, discardButton, applyButton]),
  ]);

  const finish = (text: string, cls: string) => {
    applyButton.disabled = true;
    discardButton.disabled = true;
    status.textContent = text;
    status.className = `plan-status ${cls}`;
  };

  discardButton.addEventListener("click", () => {
    finish("Discarded. Nothing was changed.", "muted");
    options.onNotice(`The user discarded plan ${plan.plan_id} (${title(plan)}). Nothing was changed.`);
  });

  applyButton.addEventListener("click", async () => {
    applyButton.disabled = true;
    discardButton.disabled = true;
    status.textContent = "Applying…";
    let result: ApplyResult;
    try {
      result = await applyPlan(options.client, plan, options.backups);
    } catch (exc) {
      if (!(exc instanceof SpotikitError)) console.error(exc);
      const ranOperations = exc instanceof SpotikitError && (exc.code === "VERIFICATION_FAILED" || (exc.code === "APPLY_FAILED" && Number(exc.details.operations_done) > 0));
      const message = describeFailure(exc);
      finish(message, "failed");
      if (ranOperations) options.onWrite({ title: `Plan partly applied: ${title(plan)}`, lines: [message], playlistId: plan.playlist.id, warnings: [message] });
      const code = exc instanceof SpotikitError ? exc.code : "ERROR";
      options.onNotice(`The user pressed Apply on plan ${plan.plan_id} (${title(plan)}) and it failed with ${code}: ${message}`);
      // A plan that failed because the playlist changed can be retried after regenerating, not as is.
      return;
    }
    const verified = result.verified ? "Applied and verified." : "Applied, but reads do not show the change yet.";
    finish(verified, result.verified ? "ok" : "failed");
    const lines =
      plan.kind === "remove"
        ? (plan.changes.remove ?? []).map((i) => `Removed ${i.position + 1}. ${line(i)}`)
        : plan.kind === "reorder"
          ? [`New order of ${plan.after.length} tracks.`]
          : Object.entries(plan.changes).map(([k, c]) => `${k}: "${c.from}" → "${c.to}"`);
    options.onWrite({
      title: `Applied plan: ${title(plan)}`,
      lines,
      playlistId: plan.playlist.id,
      warnings: result.warnings.map((w) => w.message),
    });
    options.onNotice(`The user applied plan ${plan.plan_id} (${title(plan)}). ${verified}`);
  });

  return card;
}
