/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import { buildCsp } from "./config/csp.ts";

// The <meta> policy travels with the static build; the dev and preview servers also send it as a header,
// which additionally enforces frame-ancestors.
function cspMetaTag(policy: string): Plugin {
  return {
    name: "spotikit-csp",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
      ],
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const headers = {
    "Content-Security-Policy": buildCsp({ llmBaseUrl: env.VITE_LLM_BASE_URL, header: true }),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  return {
    plugins: [cspMetaTag(buildCsp({ llmBaseUrl: env.VITE_LLM_BASE_URL }))],
    // The OAuth redirect URI registered in the Spotify dashboard is http://127.0.0.1:5173/callback.
    server: { host: "127.0.0.1", port: 5173, strictPort: true, headers },
    preview: { host: "127.0.0.1", port: 5173, strictPort: true, headers },
    build: { sourcemap: false },
    test: { environment: "node", include: ["tests/**/*.test.ts"] },
  };
});
