// Local store of recording metadata, keyed by track URI.
// Follows spotikit commit b3531aa, src/spotikit/recordings.py. Differences, all deliberate:
// - Stored in IndexedDB (through an async KeyValueStore) instead of data/recordings.json. The JSON format
//   is the same, so importJson/exportJson move data to and from spotikit.
// - All entries live under one key, so an upsert replaces the whole map at once (all-or-nothing).
//
// Spotify only exposes the release date of an edition, not when a track was recorded. Recording dates
// come from discographies, the user, or a model's knowledge, and are stored with their source and
// confidence. The store is data, not judgment: deciding a date is the caller's job; this module only
// validates, stores, and joins it.

import { SpotikitError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/http";
import type { Playlist, PlaylistItem } from "../spotify/models";
import { getPlaylist, type Warning } from "../spotify/playlists";
import { normalizeItemUri } from "../spotify/refs";
import type { KeyValueStore } from "../storage/kv";

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export interface RecordingEntry {
  recorded: string;
  confidence: Confidence;
  source: string;
  note?: string;
  name?: string;
  isrc?: string;
  artists?: string[];
}

export type RecordingMap = Record<string, RecordingEntry>;

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const OPTIONAL_TEXT = ["note", "name", "isrc"] as const;
const STORE_KEY = "entries";

const invalid = (message: string, details: Record<string, unknown> = {}) => new SpotikitError("INVALID_ARGUMENT", message, details);

export function validateRecorded(value: unknown): string {
  const match = typeof value === "string" ? DATE_RE.exec(value) : null;
  if (!match) throw invalid("recorded must be YYYY, YYYY-MM, or YYYY-MM-DD.", { recorded: value });
  const [year, month, day] = [match[1], match[2], match[3]].map((g) => (g ? Number(g) : null));
  const date = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== (month ?? 1) - 1 || date.getUTCDate() !== (day ?? 1)) {
    throw invalid("recorded is not a valid date.", { recorded: value });
  }
  return value as string;
}

/** Validate one input entry; returns [uri, normalized entry]. */
export function validateEntry(raw: unknown): [string, RecordingEntry] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("uri" in raw)) {
    throw invalid("Each recording entry must be an object with a 'uri'.", { entry: raw });
  }
  const r = raw as Record<string, unknown>;
  const uri = normalizeItemUri(String(r.uri));
  if (!(CONFIDENCE_LEVELS as readonly unknown[]).includes(r.confidence)) {
    throw invalid(`confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}.`, { uri, confidence: r.confidence });
  }
  if (typeof r.source !== "string" || !r.source.trim()) throw invalid("source is required (where the date comes from).", { uri });
  const entry: RecordingEntry = { recorded: validateRecorded(r.recorded), confidence: r.confidence as Confidence, source: r.source.trim() };
  for (const key of OPTIONAL_TEXT) if (r[key]) entry[key] = String(r[key]);
  if (Array.isArray(r.artists) && r.artists.length) entry.artists = r.artists.map(String);
  return [uri, entry];
}

export interface UpsertResult {
  created: number;
  updated: number;
  total: number;
}

export class RecordingStore {
  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<RecordingMap> {
    return (await this.kv.get<RecordingMap>(STORE_KEY)) ?? {};
  }

  private async save(data: RecordingMap): Promise<void> {
    await this.kv.set(STORE_KEY, data);
  }

  /** Add or update entries. Every entry is validated before anything is written. */
  async upsert(rawEntries: unknown[]): Promise<UpsertResult> {
    if (!Array.isArray(rawEntries) || !rawEntries.length) throw invalid("Expected a non-empty array of recording entries.");
    const validated = rawEntries.map(validateEntry); // all-or-nothing
    const data = await this.load();
    const created = new Set(validated.map(([uri]) => uri).filter((uri) => !(uri in data)));
    for (const [uri, entry] of validated) data[uri] = entry;
    await this.save(data);
    return { created: created.size, updated: validated.length - created.size, total: Object.keys(data).length };
  }

  async remove(uris: string[]): Promise<number> {
    const data = await this.load();
    const removed = uris.filter((uri) => uri in data);
    for (const uri of removed) delete data[uri];
    await this.save(data);
    return removed.length;
  }

  /** Import spotikit's data/recordings.json (an object keyed by URI), merging into this store. */
  async importJson(text: string): Promise<UpsertResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid("The file is not valid JSON.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalid("Expected an object keyed by track URI, like spotikit's data/recordings.json.");
    }
    return this.upsert(Object.entries(parsed as Record<string, unknown>).map(([uri, entry]) => ({ ...(entry as object), uri })));
  }

  /** The same format as spotikit's data/recordings.json: keys sorted, 2-space indent. */
  async exportJson(): Promise<string> {
    const data = await this.load();
    const sorted = Object.fromEntries(
      Object.keys(data)
        .sort()
        .map((uri) => [uri, Object.fromEntries(Object.entries(data[uri]!).sort(([a], [b]) => (a < b ? -1 : 1)))]),
    );
    return JSON.stringify(sorted, null, 2);
  }
}

export function lookup(data: RecordingMap, uri: string | null, isrc: string | null | undefined): [RecordingEntry | null, "uri" | "isrc" | null] {
  if (uri && data[uri]) return [data[uri], "uri"];
  if (isrc) {
    for (const entry of Object.values(data)) if (entry.isrc === isrc) return [entry, "isrc"];
  }
  return [null, null];
}

export interface PlaylistRecordings {
  playlist: Playlist;
  items: {
    position: number;
    uri: string | null;
    name: string | null;
    artists: string[];
    isrc: string | null;
    recording: RecordingEntry | null;
    matched_by: "uri" | "isrc" | null;
  }[];
  missing: { position: number; uri: string | null; name: string | null }[];
  chronological: boolean;
  warnings: Warning[];
}

/** Join a playlist's items with the store. Items without a recording date are listed in `missing`. */
export async function playlistRecordings(client: SpotifyClient, store: RecordingStore, ref: string): Promise<PlaylistRecordings> {
  const state = await getPlaylist(client, ref); // no market: URIs exactly as stored in the playlist
  const data = await store.load();
  const items = state.items.map((item) => {
    const [recording, matchedBy] = lookup(data, item.uri, item.isrc);
    return {
      position: item.position,
      uri: item.uri,
      name: item.name,
      artists: item.artists.map((a) => a.name ?? ""),
      isrc: item.isrc,
      recording,
      matched_by: matchedBy,
    };
  });
  const missing = items.filter((i) => !i.recording).map((i) => ({ position: i.position, uri: i.uri, name: i.name }));
  const dated = items.filter((i) => i.recording).map((i) => i.recording!.recorded);
  const chronological = !missing.length && dated.every((d, i) => i === 0 || d >= dated[i - 1]!);
  return { playlist: state.playlist, items, missing, chronological, warnings: state.warnings };
}

/** New order (as current positions) sorted by recording date; ties keep their current order. */
export function chronologicalOrder(items: PlaylistItem[], data: RecordingMap): number[] {
  const keyed: [string, number][] = [];
  const missing: { position: number; uri: string | null; name: string | null }[] = [];
  for (const item of items) {
    const [entry] = lookup(data, item.uri, item.isrc);
    if (entry) keyed.push([entry.recorded, item.position]);
    else missing.push({ position: item.position, uri: item.uri, name: item.name });
  }
  if (missing.length) {
    throw new SpotikitError("RECORDING_DATES_MISSING", "Some items have no recording date; store them with recordings_set first.", { missing });
  }
  return keyed.sort(([a, pa], [b, pb]) => (a < b ? -1 : a > b ? 1 : pa - pb)).map(([, position]) => position);
}
