/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPOTIFY_CLIENT_ID?: string;
  readonly VITE_LLM_BASE_URL?: string;
  readonly VITE_LLM_MODEL?: string;
  readonly VITE_HOSTED_LLM_BASE_URL?: string;
  readonly VITE_HOSTED_LLM_MODEL?: string;
  readonly VITE_HOSTED_LLM_NAME?: string;
  readonly VITE_HOSTED_LLM_2_BASE_URL?: string;
  readonly VITE_HOSTED_LLM_2_MODEL?: string;
  readonly VITE_HOSTED_LLM_2_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
