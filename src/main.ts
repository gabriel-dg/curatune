import { loadConfig } from "./config";
import { SpotifyAuth, takeCallbackParams } from "./spotify/auth";
import { SpotifyClient } from "./spotify/http";
import { WriteLog } from "./spotify/writelog";
import { openStore } from "./storage/kv";
import { RecordingStore } from "./recordings/recordings";
import { App } from "./ui/app";
import { ChatView } from "./ui/chat";
import { h } from "./ui/dom";
import { buildProviders, LlmSettings } from "./ui/llm-providers";

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
  // IndexedDB (memory if unavailable): the write log for snapshot read lag, and backups before applying plans.
  const writeLog = new WriteLog(await openStore("write-log"));
  const backups = await openStore("plan-backups");
  const recordings = new RecordingStore(await openStore("recordings"));
  const client = new SpotifyClient(auth, { fetch: (input, init) => window.fetch(input, init), writeLog });

  // LLM clients get their own fetch and never see `auth`: the Spotify token cannot reach a model. A hosted
  // provider's API key lives in sessionStorage (per tab), pasted by the user; never in the build.
  const providers = buildProviders(config, (input, init) => window.fetch(input, init));
  const settings = new LlmSettings(window.sessionStorage);
  const chat = new ChatView({ providers, settings, ctx: { client, recordings }, backups });
  const app = new App(root, auth, client, chat, recordings);

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
