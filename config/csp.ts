// Content Security Policy for the page. The page holds a Spotify token, so it may only load its own
// scripts and styles and only talk to Spotify and the configured LLM endpoint.

export const SPOTIFY_ORIGINS = ["https://accounts.spotify.com", "https://api.spotify.com"] as const;

/** Origin of the LLM endpoint (scheme, host, port), or null when it is not configured. */
export function llmOrigin(baseUrl: string | undefined): string | null {
  const value = (baseUrl ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_LLM_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("VITE_LLM_BASE_URL must use http or https.");
  }
  return url.origin;
}

export interface CspOptions {
  llmBaseUrl?: string;
  /** frame-ancestors is ignored in a <meta> tag; only include it when the policy is sent as a header. */
  header?: boolean;
}

export function buildCsp({ llmBaseUrl, header = false }: CspOptions = {}): string {
  const llm = llmOrigin(llmBaseUrl);
  // 'self' in connect-src also covers the dev server's same-origin HMR WebSocket.
  const connect = ["'self'", ...SPOTIFY_ORIGINS, ...(llm ? [llm] : [])];
  const directives: [string, string[]][] = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'"]],
    ["connect-src", connect],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["object-src", ["'none'"]],
  ];
  if (header) directives.push(["frame-ancestors", ["'none'"]]);
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
