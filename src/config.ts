// Build-time configuration from .env.local (see .env.example).

import { CALLBACK_PATH } from "./spotify/auth";

export interface AppConfig {
  spotifyClientId: string;
  redirectUri: string;
  llmBaseUrl: string;
  llmModel: string;
  /** Optional hosted LLM (e.g. Gemini). Its API key is not configuration: the user pastes it in the app. */
  hostedLlm: { baseUrl: string; model: string; name: string } | null;
}

export function loadConfig(env: ImportMetaEnv, origin: string): AppConfig {
  return {
    spotifyClientId: (env.VITE_SPOTIFY_CLIENT_ID ?? "").trim(),
    // Must be registered in the Spotify dashboard; in development http://127.0.0.1:5173/callback.
    redirectUri: `${origin}${CALLBACK_PATH}`,
    llmBaseUrl: (env.VITE_LLM_BASE_URL ?? "").trim(),
    llmModel: (env.VITE_LLM_MODEL ?? "").trim(),
    hostedLlm:
      env.VITE_HOSTED_LLM_BASE_URL?.trim() && env.VITE_HOSTED_LLM_MODEL?.trim()
        ? {
            baseUrl: env.VITE_HOSTED_LLM_BASE_URL.trim(),
            model: env.VITE_HOSTED_LLM_MODEL.trim(),
            name: env.VITE_HOSTED_LLM_NAME?.trim() || "Hosted",
          }
        : null,
  };
}
