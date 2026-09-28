// Build-time configuration from .env.local (see .env.example).

import { CALLBACK_PATH } from "./spotify/auth";

export interface AppConfig {
  spotifyClientId: string;
  redirectUri: string;
}

export function loadConfig(env: ImportMetaEnv, origin: string): AppConfig {
  return {
    spotifyClientId: (env.VITE_SPOTIFY_CLIENT_ID ?? "").trim(),
    // Must be registered in the Spotify dashboard; in development http://127.0.0.1:5173/callback.
    redirectUri: `${origin}${CALLBACK_PATH}`,
  };
}
