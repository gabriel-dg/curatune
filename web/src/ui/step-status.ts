// How a finished tool step reads in the chat. Kept apart from chat.ts so it can be tested without a DOM.
import type { ToolExecution } from "../tools";

export type StepKind = "ok" | "failed" | "cancelled";

/** The user's Cancel is a choice, not an error: it reads as cancelled, in a neutral style. A failure shows
 * its code, so a step that failed before running (for example arguments the tool rejected) can be told apart. */
export function stepStatus(execution: Pick<ToolExecution, "outcome" | "summary">): { kind: StepKind; text: string } {
  if (execution.outcome.ok) return { kind: "ok", text: execution.summary };
  const { code } = execution.outcome.error;
  if (code === "USER_DECLINED") return { kind: "cancelled", text: "cancelled by you" };
  return { kind: "failed", text: `failed (${code})` };
}

export function tracks(count: number | null): string {
  return count === null ? "tracks" : `${count} track${count === 1 ? "" : "s"}`;
}

/** playlist_add's label while it runs (and waits for the user's confirmation) and once it is done. */
export function addLabel(count: number | null, kind: StepKind | "pending"): string {
  if (kind === "ok") return `Added ${tracks(count)}`;
  if (kind === "pending") return `Adding ${tracks(count)}`;
  return `Did not add ${tracks(count)}`;
}