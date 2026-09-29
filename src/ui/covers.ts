// Playlist covers. Only Spotify's image CDNs (the CSP allows the same hosts), fetched lazily and without a
// referrer. The initial letter sits underneath: it shows while the image loads, when there is none, and
// when it fails. URLs come from API responses, so each one is checked before it is used.

import type { Image } from "../spotify/models";
import { h } from "./dom";

const COVER_HOST_SUFFIXES = [".scdn.co", ".spotifycdn.com"];

/** The URL when it is an https URL on Spotify's image CDNs, else null. */
export function safeImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  return COVER_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix)) ? parsed.href : null;
}

/**
 * `src` and, when Spotify gives several sizes, a `srcset` so the browser picks the smallest sharp one for
 * the screen (60 px for the sidebar at 1x, 300 px at 2x). Null when no image is usable.
 */
export function coverSources(images: Image[]): { src: string; srcset: string | null } | null {
  const usable = images.flatMap((i) => {
    const url = safeImageUrl(i.url);
    return url ? [{ url, width: i.width }] : [];
  });
  if (!usable.length) return null;
  const sized = usable.filter((i): i is { url: string; width: number } => i.width !== null).sort((a, b) => a.width - b.width);
  if (sized.length < 2 || sized.length !== usable.length) return { src: usable[0]!.url, srcset: null };
  const fallback = sized.find((i) => i.width >= 300) ?? sized[sized.length - 1]!;
  return { src: fallback.url, srcset: sized.map((i) => `${i.url} ${i.width}w`).join(", ") };
}

export function initial(name: string | null): string {
  return (name ?? "").trim().charAt(0).toUpperCase() || "?";
}

/** A square cover of `size` CSS pixels, with the playlist's initial underneath. Decorative: the name is next to it. */
export function cover(images: Image[], name: string | null, size: number, className: string): HTMLElement {
  const box = h("span", { class: className, attrs: { "aria-hidden": "true" } }, [initial(name)]);
  const sources = coverSources(images);
  if (!sources) return box;
  // Everything that affects the fetch (lazy, no referrer, srcset) is set before src.
  const attrs: Record<string, string> = { alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", width: String(size), height: String(size) };
  if (sources.srcset) Object.assign(attrs, { sizes: `${size}px`, srcset: sources.srcset });
  attrs.src = sources.src;
  const img = h("img", { attrs });
  img.addEventListener("error", () => img.remove(), { once: true });
  box.classList.add("has-cover");
  box.append(img);
  return box;
}
