/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPOTIFY_CLIENT_ID?: string;
  readonly VITE_LLM_BASE_URL?: string;
  readonly VITE_LLM_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
