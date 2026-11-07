// Which hosted providers' data notices the user dismissed in the chat, remembered across reloads and tabs
// in localStorage. That key holds a list of hostnames (where a hosted model sends the data) and nothing
// else; besides ui/layout.ts, this is the only module allowed to use localStorage (tests/invariants.test.ts).
// Scoped by host, so a provider moved to another host shows its notice again. The API key form always shows
// the notice, dismissed or not. When storage is unavailable, a dismissal lasts until the page reloads.

const STORAGE_KEY = "curatune-web.dismissed-hosted-notices";

export type NoticeStorage = Pick<Storage, "getItem" | "setItem">;

/** The hosts in a stored value; anything else (garbage, other types) is ignored. */
export function parseDismissed(raw: string | null): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return [];
  }
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))] : [];
}

/** The browser's localStorage, or null when it is blocked (private window, site data off). */
export function browserNoticeStorage(): NoticeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class DismissedNotices {
  private readonly hosts: Set<string>;

  constructor(private readonly storage: NoticeStorage | null) {
    this.hosts = new Set(this.read());
  }

  isDismissed(host: string): boolean {
    return this.hosts.has(host);
  }

  dismiss(host: string): void {
    if (!host) return;
    this.hosts.add(host);
    // Keep what other tabs dismissed meanwhile.
    for (const stored of this.read()) this.hosts.add(stored);
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.hosts]));
    } catch {
      // Not remembered; dismissed for this page only.
    }
  }

  private read(): string[] {
    try {
      return parseDismissed(this.storage?.getItem(STORAGE_KEY) ?? null);
    } catch {
      return []; // Unreadable: nothing dismissed.
    }
  }
}
