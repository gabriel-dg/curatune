// Build-time configuration from .env.local (see .env.example).

import { CALLBACK_PATH } from "./spotify/auth";

export interface AppConfig {
  spotifyClientId: string;
  redirectUri: string;
  llmBaseUrl: string;
  llmModel: string;
  /**
   * Optional hosted LLM (e.g. Gemini): one provider, one or more models (`VITE_HOSTED_LLM_MODEL`, comma
   * separated), all behind the same API key. The key is not configuration: the user pastes it in the app.
   */
  hostedLlm: { baseUrl: string; models: string[]; name: string } | null;
}

/** "a, b,,a" → ["a", "b"]. */
function modelList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((m) => m.trim()).filter(Boolean))];
}

export function loadConfig(env: ImportMetaEnv, origin: string): AppConfig {
  const hostedModels = modelList(env.VITE_HOSTED_LLM_MODEL);
  return {
    spotifyClientId: (env.VITE_SPOTIFY_CLIENT_ID ?? "").trim(),
    // Must be registered in the Spotify dashboard; in development http://127.0.0.1:5173/callback.
    redirectUri: `${origin}${CALLBACK_PATH}`,
    llmBaseUrl: (env.VITE_LLM_BASE_URL ?? "").trim(),
    llmModel: (env.VITE_LLM_MODEL ?? "").trim(),
    hostedLlm:
      env.VITE_HOSTED_LLM_BASE_URL?.trim() && hostedModels.length
        ? {
            baseUrl: env.VITE_HOSTED_LLM_BASE_URL.trim(),
            models: hostedModels,
            name: env.VITE_HOSTED_LLM_NAME?.trim() || "Hosted",
          }
        : null,
  };
}
