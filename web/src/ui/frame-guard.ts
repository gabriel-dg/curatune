// Clickjacking guard for hosts that cannot send headers. The page holds a Spotify token and, optionally, a
// hosted provider's API key, so it must not run inside a frame. frame-ancestors only works as a header (it is
// ignored in a <meta> CSP, config/csp.ts), and static hosts such as GitHub Pages cannot send headers or
// X-Frame-Options; the dev and preview servers still send frame-ancestors 'none'. When framed, main.ts starts
// nothing (no callback handling, no storage) and shows only a link that opens the app in its own tab.

import { h } from "./dom";

/** The two window properties the check reads (a real `window` satisfies it). */
export interface FrameProbe {
  readonly top: unknown;
  readonly self: unknown;
}

/** True when the page is not the top-level browsing context. Any error reading `top` counts as framed. */
export function isFramed(win: FrameProbe): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/** Static notice shown instead of the app when it is framed. `appUrl` is the app's root, never the current URL
 * (on the OAuth callback that would carry `code` and `state` to the new tab). */
export function framedNotice(appUrl: string): HTMLElement {
  return h("div", { class: "framed-notice" }, [
    h("p", { text: "Curatune does not run inside a frame, to protect your Spotify session." }),
    h("a", { text: "Open Curatune in its own tab", attrs: { href: appUrl, target: "_blank", rel: "noopener noreferrer" } }),
  ]);
}
