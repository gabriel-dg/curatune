// Every write of this session (tool writes, applied plans, saved recording dates), shared by the chat, the
// plan cards, the sidebar badge, and the Activity panel. "New chat" does not clear it.

import type { WriteReport } from "../tools";

export interface ActivityEntry {
  report: WriteReport;
  at: Date;
}

export class ActivityLog {
  readonly entries: ActivityEntry[] = [];
  private readonly listeners = new Set<(entry: ActivityEntry) => void>();

  add(report: WriteReport): ActivityEntry {
    const entry = { report, at: new Date() };
    this.entries.unshift(entry);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  subscribe(listener: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function timeLabel(at: Date): string {
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
