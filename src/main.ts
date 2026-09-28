import { loadConfig } from "./config";
import { SpotifyAuth, takeCallbackParams } from "./spotify/auth";
import { SpotifyClient } from "./spotify/http";
import { App } from "./ui/app";
import { h } from "./ui/dom";

async function start(root: HTMLElement): Promise<void> {
  // Strip `code` and `state` from the address bar and the session history before anything else runs.
  const callback = takeCallbackParams(window.location, window.history);

  const config = loadConfig(import.meta.env, window.location.origin);
  let auth: SpotifyAuth;
  try {
    auth = new SpotifyAuth({
      clientId: config.spotifyClientId,
      redirectUri: config.redirectUri,
      // Per tab and cleared when the tab closes; never localStorage.
      storage: window.sessionStorage,
      fetch: (input, init) => window.fetch(input, init),
    });
  } catch (exc) {
    root.replaceChildren(h("p", { class: "notice", text: exc instanceof Error ? exc.message : "Configuration error." }));
    return;
  }
  const client = new SpotifyClient(auth, { fetch: (input, init) => window.fetch(input, init) });
  const app = new App(root, auth, client);

  if (callback) {
    try {
      await auth.completeLogin(callback);
    } catch (exc) {
      app.showError(exc);
    }
  }
  await app.render();
}

const root = document.getElementById("app");
if (root) void start(root);
