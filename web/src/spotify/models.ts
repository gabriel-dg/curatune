// Normalization of Spotify API objects into the JSON shapes of curatune's docs/reference.md.
// Follows curatune commit b3531aa, src/curatune/models.py. Keys use curatune's snake_case so tool results
// match the CLI's. Difference: descriptions are unescaped with `unescapeHtml` (numeric and the basic named
// entities, which is what Spotify emits) instead of Python's full `html.unescape`.

type Json = Record<string, any>;

export interface Artist {
  name: string | null;
  uri: string | null;
}

export interface Album {
  name: string | null;
  uri: string | null;
  album_type: string | null;
  release_date: string | null;
  release_date_precision: string | null;
  artists: Artist[];
}

export interface Track {
  uri: string | null;
  id: string | null;
  type: string | null;
  name: string | null;
  artists: Artist[];
  album: Album | null;
  duration_ms: number | null;
  duration: string | null;
  disc_number: number | null;
  track_number: number | null;
  isrc: string | null;
  explicit: boolean | null;
  is_local: boolean;
  is_playable: boolean | null;
  url: string | null;
}

export interface PlaylistItem extends Track {
  position: number;
  added_at: string | null;
}

/** A cover image. Spotify's image URLs are temporary (they expire within a day): use them, never store them. */
export interface Image {
  url: string;
  width: number | null;
  height: number | null;
}

export interface Playlist {
  id: string | null;
  uri: string | null;
  name: string | null;
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  owned: boolean;
  collaborative: boolean | null;
  public: boolean | null;
  item_count: number | null;
  snapshot_id: string | null;
  url: string | null;
  /** Cover in Spotify's sizes (for mosaics 640, 300, 60; an uploaded cover comes once, unsized). UI only. */
  images: Image[];
}

export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function unescapeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

export function normalizeArtist(artist: Json): Artist {
  return { name: orNull(artist.name), uri: orNull(artist.uri) };
}

export function normalizeAlbum(album: Json | null | undefined): Album | null {
  if (!album) return null;
  return {
    name: orNull(album.name),
    uri: orNull(album.uri),
    album_type: orNull(album.album_type),
    release_date: orNull(album.release_date),
    release_date_precision: orNull(album.release_date_precision),
    artists: (album.artists ?? []).map(normalizeArtist),
  };
}

/**
 * Normalize a full or simplified track (or episode) object. `album` is used for simplified tracks (e.g.
 * from album listings), which lack the album field. A missing object (unavailable playlist item) yields
 * every key set to null.
 */
export function normalizeTrack(obj: Json | null | undefined, album: Album | null = null): Track {
  if (!obj) {
    return {
      uri: null, id: null, type: null, name: null, artists: [], album: null, duration_ms: null, duration: null,
      disc_number: null, track_number: null, isrc: null, explicit: null, is_local: false, is_playable: null,
      url: null,
    };
  }
  let albumOut: Album | null;
  if (obj.type === "episode") {
    const show = obj.show ?? {};
    albumOut = {
      name: orNull(show.name),
      uri: orNull(show.uri),
      album_type: "show",
      release_date: orNull(obj.release_date),
      release_date_precision: orNull(obj.release_date_precision),
      artists: [],
    };
  } else {
    albumOut = normalizeAlbum(obj.album) ?? album;
  }
  const durationMs = orNull<number>(obj.duration_ms);
  return {
    uri: orNull(obj.uri),
    id: orNull(obj.id),
    type: obj.type ?? "track",
    name: orNull(obj.name),
    artists: (obj.artists ?? []).map(normalizeArtist),
    album: albumOut,
    duration_ms: durationMs,
    duration: formatDuration(durationMs),
    disc_number: orNull(obj.disc_number),
    track_number: orNull(obj.track_number),
    isrc: orNull(obj.external_ids?.isrc),
    explicit: orNull(obj.explicit),
    is_local: Boolean(obj.is_local),
    is_playable: orNull(obj.is_playable),
    url: orNull(obj.external_urls?.spotify),
  };
}

export function normalizePlaylistItem(entry: Json, position: number): PlaylistItem {
  // "item" is the post-2026 field name; "track" is the deprecated alias.
  const track = normalizeTrack(entry.item ?? entry.track);
  track.is_local = Boolean(entry.is_local) || track.is_local;
  return { position, ...track, added_at: orNull(entry.added_at) };
}

export function normalizeImages(images: unknown): Image[] {
  if (!Array.isArray(images)) return [];
  const size = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  return images.filter((i): i is Json => typeof i?.url === "string" && i.url !== "").map((i) => ({ url: i.url, width: size(i.width), height: size(i.height) }));
}

export function normalizePlaylist(playlist: Json, currentUserId: string | null): Playlist {
  const owner = playlist.owner ?? {};
  const itemsRef = playlist.items ?? playlist.tracks ?? {};
  const description = playlist.description;
  return {
    id: orNull(playlist.id),
    uri: orNull(playlist.uri),
    name: orNull(playlist.name),
    // Spotify returns descriptions HTML-escaped (e.g. "&#x27;" for "'"); expose the plain text.
    description: typeof description === "string" ? unescapeHtml(description) : orNull(description),
    owner_id: orNull(owner.id),
    owner_name: orNull(owner.display_name),
    owned: currentUserId !== null && owner.id === currentUserId,
    collaborative: orNull(playlist.collaborative),
    public: orNull(playlist.public),
    item_count: orNull(itemsRef.total),
    snapshot_id: orNull(playlist.snapshot_id),
    url: orNull(playlist.external_urls?.spotify),
    images: normalizeImages(playlist.images),
  };
}
