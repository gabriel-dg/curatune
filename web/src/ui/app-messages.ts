// What the app itself tells the model, inside the user's message: [App notice: …] lines (what the user did
// with a plan) and the [App context: …] line (the playlist in view). They carry only IDs, kinds, and counts,
// never Spotify text: a playlist name is written by its owner, and in a followed or collaborative playlist that
// can be someone else, who could otherwise close the bracket and write text that reads as the user's. The
// model reads names with its tools, where they arrive as tool results. Pure functions, no DOM.

import type { Plan } from "../plans/plans";

/** Anything that is not a plain ID character is dropped (IDs are base62; plan IDs add '-' and digits). */
export const safeId = (id: string | null | undefined): string => String(id ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);

/** Free text the app passes on (an error message): no brackets, quotes, or line breaks, and at most 300
 * characters, so it cannot end the notice and start something that reads as the user's. */
export function noticeText(text: string): string {
  const flat = String(text)
    .replace(/[\p{C}]/gu, " ")
    .replace(/[[\]"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= 300 ? flat : `${flat.slice(0, 299)}…`;
}

/** A plan described by kind, counts, and the playlist's ID only. */
export function planRef(plan: Plan): string {
  const playlist = `playlist id ${safeId(plan.playlist.id)}`;
  if (plan.kind === "remove") {
    const n = plan.changes.remove?.length ?? 0;
    return `remove ${n} track${n === 1 ? "" : "s"} from ${playlist}`;
  }
  if (plan.kind === "reorder") return `reorder the ${plan.after.length} tracks of ${playlist}`;
  const fields = Object.keys(plan.changes).filter((k) => k === "name" || k === "description");
  return `change the ${fields.join(" and ")} of ${playlist}`;
}

/** "plan <id> (<what it does>)", for notices. */
export const planLabel = (plan: Plan): string => `plan ${safeId(plan.plan_id)} (${planRef(plan)})`;

export interface ContextRef {
  id: string;
}

/** The lines that go before the user's text, marked as the app's. */
export function appPrefix(notices: string[], context: ContextRef | null): string[] {
  return [
    ...notices.map((n) => `[App notice: ${n}]`),
    ...(context ? [`[App context: the user is looking at the playlist with id ${safeId(context.id)}.]`] : []),
  ];
}

/** The user's message as the model receives it. */
export function withAppPrefix(text: string, notices: string[], context: ContextRef | null): string {
  const prefix = appPrefix(notices, context);
  return prefix.length ? `${prefix.join("\n")}\n\n${text}` : text;
}
