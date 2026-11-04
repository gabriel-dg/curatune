// Parsing of Spotify references: bare IDs, URIs (spotify:<kind>:<id>) and open.spotify.com URLs.
// Follows curatune commit b3531aa, src/curatune/refs.py.

import { CuratuneError } from "./errors";

export const KINDS = ["playlist", "track", "album", "artist", "episode"] as const;
export type Kind = (typeof KINDS)[number];

const ID_RE = /^[A-Za-z0-9]{22}$/;

/** Return the 22-char Spotify ID of `ref`, which must refer to an object of `kind`. */
export function parseId(ref: string, kind: Kind): string {
  const value = (ref ?? "").trim();

  if (value.startsWith("spotify:")) {
    const parts = value.split(":");
    if (parts.length === 3 && parts[1] === kind && ID_RE.test(parts[2]!)) return parts[2]!;
    throw new CuratuneError("INVALID_REFERENCE", `Not a Spotify ${kind} URI.`, { ref });
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CuratuneError("INVALID_REFERENCE", `Not a Spotify ${kind} URL.`, { ref });
    }
    if (url.host !== "open.spotify.com") {
      throw new CuratuneError("INVALID_REFERENCE", "Only open.spotify.com URLs are supported.", { ref });
    }
    // Paths look like /playlist/<id> or /intl-es/playlist/<id>.
    const segments = url.pathname.split("/").filter(Boolean);
    const id = segments.at(-1);
    if (segments.length >= 2 && segments.at(-2) === kind && id && ID_RE.test(id)) return id;
    throw new CuratuneError("INVALID_REFERENCE", `Not a Spotify ${kind} URL.`, { ref });
  }

  if (ID_RE.test(value)) return value;
  throw new CuratuneError("INVALID_REFERENCE", `Cannot parse Spotify ${kind} reference.`, { ref });
}

export function toUri(kind: Kind, spotifyId: string): string {
  return `spotify:${kind}:${spotifyId}`;
}

/** Normalize a track or episode reference (a bare ID defaults to track) to its URI. */
export function normalizeItemUri(ref: string): string {
  const value = (ref ?? "").trim();
  if (value.startsWith("spotify:local:")) {
    throw new CuratuneError("INVALID_REFERENCE", "Local files cannot be added through the API.", { ref });
  }
  for (const kind of ["track", "episode"] as const) {
    if (value.startsWith(`spotify:${kind}:`) || value.includes(`/${kind}/`)) return toUri(kind, parseId(value, kind));
  }
  return toUri("track", parseId(value, "track"));
}
