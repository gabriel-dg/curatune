// Content Security Policy for the page. The page holds a Spotify token, so it may only load its own
// scripts and styles and only talk to Spotify and the configured LLM endpoints (the local one and, when
// configured, the optional hosted ones). Images: its own, and playlist covers from Spotify's image CDNs.

export const SPOTIFY_ORIGINS = ["https://accounts.spotify.com", "https://api.spotify.com"] as const;
/** Where Spotify serves cover images (i.scdn.co, mosaic.scdn.co, image-cdn-*.spotifycdn.com, …). */
export const SPOTIFY_IMAGE_SOURCES = ["https://*.scdn.co", "https://*.spotifycdn.com"] as const;

/** Origin of an LLM endpoint (scheme, host, port), or null when it is not configured. */
export function llmOrigin(baseUrl: string | undefined, variable = "VITE_LLM_BASE_URL", httpsOnly = false): string | null {
  const value = (baseUrl ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${variable} must use http or https.`);
  }
  if (httpsOnly && url.protocol !== "https:") {
    // A hosted provider receives the user's API key: never over plain http.
    throw new Error(`${variable} must use https.`);
  }
  return url.origin;
}

export interface CspOptions {
  llmBaseUrl?: string;
  /** The optional hosted LLM providers, in order (VITE_HOSTED_LLM_BASE_URL, VITE_HOSTED_LLM_2_BASE_URL); leave
   * out one with no model, which the app does not offer. */
  hostedLlmBaseUrls?: (string | undefined)[];
  /** frame-ancestors is ignored in a <meta> tag; only include it when the policy is sent as a header. Hosts
   * that cannot send headers rely on the script guard in src/ui/frame-guard.ts. */
  header?: boolean;
}

export function buildCsp({ llmBaseUrl, hostedLlmBaseUrls = [], header = false }: CspOptions = {}): string {
  const hosted = hostedLlmBaseUrls.map((url, i) => llmOrigin(url, i === 0 ? "VITE_HOSTED_LLM_BASE_URL" : `VITE_HOSTED_LLM_${i + 1}_BASE_URL`, true));
  const llms = [llmOrigin(llmBaseUrl), ...hosted].filter(
    (o, i, all): o is string => o !== null && all.indexOf(o) === i,
  );
  // 'self' in connect-src also covers the dev server's same-origin HMR WebSocket.
  const connect = ["'self'", ...SPOTIFY_ORIGINS, ...llms];
  const directives: [string, string[]][] = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", ...SPOTIFY_IMAGE_SOURCES]],
    ["connect-src", connect],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["object-src", ["'none'"]],
  ];
  if (header) directives.push(["frame-ancestors", ["'none'"]]);
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
