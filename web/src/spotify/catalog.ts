// Read-only catalog lookups: track search, single track, album track listing.
// Follows curatune commit b3531aa, src/curatune/catalog.py. Not ported: market-dependent reads. Batch search
// lives in the `search_many` tool (src/tools/read.ts): up to 25 searches per call, 4 at a time.

import { CuratuneError } from "./errors";
import type { SpotifyClient } from "./http";
import { normalizeAlbum, normalizeTrack, type Album, type Track } from "./models";
import { parseId } from "./refs";
import type { Warning } from "./playlists";

export const SEARCH_MAX_LIMIT = 10;

type Json = Record<string, unknown>;

export interface SearchFilters {
  query?: string;
  track?: string;
  artist?: string;
  album?: string;
  year?: string;
}

export interface SearchResult {
  query: string;
  limit: number;
  offset: number;
  total: number | null;
  next_offset: number | null;
  results: Track[];
  warnings: Warning[];
}

export interface AlbumTracks {
  album: Album & { id: string | null; total_tracks: number | null; url: string | null };
  tracks: Track[];
}

function filter(field: string, value: string): string {
  const clean = value.trim().replace(/"/g, "");
  return clean.includes(" ") ? `${field}:"${clean}"` : `${field}:${clean}`;
}

export function buildQuery({ query, track, artist, album, year }: SearchFilters): string {
  const parts = query?.trim() ? [query.trim()] : [];
  for (const [field, value] of [["track", track], ["artist", artist], ["album", album], ["year", year]] as const) {
    if (value?.trim()) parts.push(filter(field, value));
  }
  return parts.join(" ");
}

export async function searchTracks(
  client: SpotifyClient,
  filters: SearchFilters,
  limit = SEARCH_MAX_LIMIT,
  offset = 0,
): Promise<SearchResult> {
  const query = buildQuery(filters);
  if (!query) throw new CuratuneError("INVALID_ARGUMENT", "Provide a query or at least one filter.");
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new CuratuneError("INVALID_ARGUMENT", `limit must be between 1 and ${SEARCH_MAX_LIMIT}.`, { limit });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CuratuneError("INVALID_ARGUMENT", "offset must be >= 0.", { offset });
  }
  const data = await client.get<{ tracks?: Json }>("/search", { q: query, type: "track", limit, offset });
  const page = (data?.tracks ?? {}) as { items?: (Json | null)[]; total?: number; next?: string | null };
  const warnings: Warning[] = [];
  if (filters.year?.trim()) {
    warnings.push({
      code: "YEAR_IS_RELEASE_YEAR",
      message: "The year filter matches the edition's release year, not the recording year.",
    });
  }
  return {
    query,
    limit,
    offset,
    total: page.total ?? null,
    next_offset: page.next ? offset + limit : null,
    results: (page.items ?? []).filter((t): t is Json => Boolean(t)).map((t) => normalizeTrack(t)),
    warnings,
  };
}

export async function getTrack(client: SpotifyClient, ref: string): Promise<{ track: Track }> {
  const trackId = parseId(ref, "track");
  return { track: normalizeTrack(await client.get<Json>(`/tracks/${trackId}`)) };
}

export async function getAlbumTracks(client: SpotifyClient, ref: string): Promise<AlbumTracks> {
  const albumId = parseId(ref, "album");
  const album = await client.get<Json>(`/albums/${albumId}`);
  let page = (album.tracks ?? {}) as { items?: (Json | null)[]; next?: string | null };
  const raw = [...(page.items ?? [])];
  while (page.next) {
    page = await client.get(page.next);
    raw.push(...(page.items ?? []));
  }
  const normalized = normalizeAlbum(album)!;
  const albumOut = {
    ...normalized,
    id: (album.id as string | undefined) ?? null,
    total_tracks: (album.total_tracks as number | undefined) ?? null,
    url: ((album.external_urls as Json | undefined)?.spotify as string | undefined) ?? null,
  };
  return {
    album: albumOut,
    tracks: raw.filter((t): t is Json => Boolean(t)).map((t) => normalizeTrack(t, normalized)),
  };
}
