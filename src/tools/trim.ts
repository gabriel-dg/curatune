// What the model sees of Spotify objects: compact, flat shapes (after spotikit's `brief_track`). Nothing
// else from the API reaches the LLM, and never anything about the session (tokens, snapshot IDs, URLs).
//
// Deliberate difference from spotikit: playlist items carry `number`, 1-based as in the Spotify app,
// instead of the 0-based `position`. The evaluation showed a small model mixing the two up ("track 3"
// read as position 3) even when told to convert. Below the tool layer everything stays 0-based.

import type { Album, Artist, Playlist, PlaylistItem, Track } from "../spotify/models";

export interface BriefTrack {
  number?: number;
  uri: string | null;
  name: string | null;
  artists: string[];
  album?: string | null;
  album_uri?: string | null;
  released?: string | null;
  duration: string | null;
  isrc?: string | null;
  track_number?: number | null;
  disc_number?: number | null;
}

const names = (artists: Artist[]): string[] => artists.map((a) => a.name ?? "").filter(Boolean);

/** A playlist item: album name and edition date, but no album URI (use track_show for it). */
export function briefItem(item: PlaylistItem): BriefTrack {
  return {
    number: item.position + 1,
    uri: item.uri,
    name: item.name,
    artists: names(item.artists),
    album: item.album?.name ?? null,
    released: item.album?.release_date ?? null,
    duration: item.duration,
    isrc: item.isrc,
  };
}

/** A search or track_show result: includes the album URI so the model can list the album. */
export function briefTrack(track: Track): BriefTrack {
  return {
    uri: track.uri,
    name: track.name,
    artists: names(track.artists),
    album: track.album?.name ?? null,
    album_uri: track.album?.uri ?? null,
    released: track.album?.release_date ?? null,
    duration: track.duration,
    isrc: track.isrc,
  };
}

/** A track inside an album listing: the album itself is described once, next to the list. */
export function briefAlbumTrack(track: Track): BriefTrack {
  return {
    uri: track.uri,
    name: track.name,
    artists: names(track.artists),
    duration: track.duration,
    track_number: track.track_number,
    disc_number: track.disc_number,
  };
}

export function briefAlbum(album: Album & { total_tracks?: number | null }) {
  return {
    uri: album.uri,
    name: album.name,
    artists: names(album.artists),
    album_type: album.album_type,
    released: album.release_date,
    total_tracks: album.total_tracks ?? null,
  };
}

export function briefPlaylist(p: Playlist) {
  return {
    id: p.id,
    name: p.name,
    owner: p.owned ? "you" : (p.owner_name ?? p.owner_id),
    owned: p.owned,
    collaborative: p.collaborative,
    items: p.item_count,
  };
}

export function formatTotalDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
