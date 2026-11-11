/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import { normalizeBasePath } from "./config/base.ts";
import { buildCsp } from "./config/csp.ts";

// The <meta> policy travels with the static build; the dev and preview servers also send it as a header,
// which additionally enforces frame-ancestors.
function cspMetaTag(policy: string): Plugin {
  return {
    name: "curatune-csp",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
      ],
    },
  };
}

// GitHub Pages has no SPA fallback, but it serves callback.html for /callback (no redirect, query string kept):
// a copy of the built index.html, CSP meta tag included, makes the OAuth callback URL load the app.
function callbackPage(): Plugin {
  return {
    name: "curatune-callback-page",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const index = bundle["index.html"];
      if (!index || index.type !== "asset") throw new Error("curatune-callback-page: index.html is not in the bundle.");
      this.emitFile({ type: "asset", fileName: "callback.html", source: index.source });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const llms = { llmBaseUrl: env.VITE_LLM_BASE_URL, hostedLlmBaseUrls: [env.VITE_HOSTED_LLM_BASE_URL, env.VITE_HOSTED_LLM_2_BASE_URL] };
  const headers = {
    "Content-Security-Policy": buildCsp({ ...llms, header: true }),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  return {
    // VITE_BASE_PATH is meant for builds (e.g. /curatune/ for a GitHub Pages project site); unset, it is "/".
    base: normalizeBasePath(env.VITE_BASE_PATH),
    plugins: [cspMetaTag(buildCsp(llms)), callbackPage()],
    // The OAuth redirect URI is the origin, the base, and "callback": in development
    // http://127.0.0.1:5173/callback, which must be registered in the Spotify dashboard.
    server: { host: "127.0.0.1", port: 5173, strictPort: true, headers },
    preview: { host: "127.0.0.1", port: 5173, strictPort: true, headers },
    build: { sourcemap: false },
    test: { environment: "node", include: ["tests/**/*.test.ts"] },
  };
});
