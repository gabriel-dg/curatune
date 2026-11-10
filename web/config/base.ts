// The public base path of the build (Vite's `base`), from VITE_BASE_PATH at build time. "/" serves the app at
// the root of its origin (the dev server, https://<user>.github.io/); "/curatune/" serves it under a project
// path (https://<user>.github.io/curatune/). The OAuth redirect URI is the base followed by "callback".

/** "" or undefined → "/"; "curatune", "/curatune", "/curatune/" → "/curatune/". Rejects URLs and "."/"..". */
export function normalizeBasePath(value: string | undefined, variable = "VITE_BASE_PATH"): string {
  const raw = (value ?? "").trim();
  const segments = raw.split("/").filter(Boolean);
  if (raw.includes(":") || raw.includes("\\") || segments.some((s) => s === "." || s === "..")) {
    throw new Error(`${variable} must be an absolute path such as /curatune/, not ${JSON.stringify(raw)}.`);
  }
  return segments.length ? `/${segments.join("/")}/` : "/";
}
