// Build-time configuration from .env.local (see .env.example).

import { callbackPath } from "./spotify/auth";

export interface AppConfig {
  spotifyClientId: string;
  redirectUri: string;
  llmBaseUrl: string;
  llmModel: string;
  /**
   * Optional hosted LLM providers (e.g. Gemini, and Claude with `VITE_HOSTED_LLM_2_*`), each with one or more
   * models (comma separated) behind that provider's API key. Keys are not configuration: the user pastes
   * them in the app.
   */
  hostedLlms: HostedLlm[];
}

export interface HostedLlm {
  baseUrl: string;
  models: string[];
  name: string;
}

/** Variable prefix of each hosted provider: VITE_HOSTED_LLM_*, then VITE_HOSTED_LLM_2_*. */
export const HOSTED_LLM_PREFIXES = ["VITE_HOSTED_LLM_", "VITE_HOSTED_LLM_2_"] as const;

/** "a, b,,a" → ["a", "b"]. */
function modelList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((m) => m.trim()).filter(Boolean))];
}

export function loadConfig(env: ImportMetaEnv, origin: string): AppConfig {
  const vars = env as unknown as Record<string, string | undefined>;
  const hostedLlms = HOSTED_LLM_PREFIXES.flatMap((prefix, i) => {
    const baseUrl = vars[`${prefix}BASE_URL`]?.trim();
    const models = modelList(vars[`${prefix}MODEL`]);
    if (!baseUrl || !models.length) return [];
    return [{ baseUrl, models, name: vars[`${prefix}NAME`]?.trim() || (i === 0 ? "Hosted" : `Hosted ${i + 1}`) }];
  });
  return {
    spotifyClientId: (env.VITE_SPOTIFY_CLIENT_ID ?? "").trim(),
    // Origin + base path (VITE_BASE_PATH at build time) + "callback"; must be registered in the Spotify
    // dashboard. In development http://127.0.0.1:5173/callback; on GitHub Pages, for example,
    // https://<user>.github.io/callback or https://<user>.github.io/curatune/callback.
    redirectUri: `${origin}${callbackPath(env.BASE_URL ?? "/")}`,
    llmBaseUrl: (env.VITE_LLM_BASE_URL ?? "").trim(),
    llmModel: (env.VITE_LLM_MODEL ?? "").trim(),
    hostedLlms,
  };
}
