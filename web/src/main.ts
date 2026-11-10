import { loadConfig } from "./config";
import { SpotifyAuth, takeCallbackParams } from "./spotify/auth";
import { SpotifyClient } from "./spotify/http";
import { pruneBackups } from "./plans/plans";
import { WriteLog } from "./spotify/writelog";
import { indexedDbSupported, isPersistent, mergeLegacyDatabase, migrationOutcome, openStore } from "./storage/kv";
import { RecordingStore } from "./recordings/recordings";
import { ActivityLog } from "./ui/activity";
import { App } from "./ui/app";
import { ChatView } from "./ui/chat";
import { h } from "./ui/dom";
import { framedNotice, isFramed } from "./ui/frame-guard";
import { buildProviders, LlmSettings } from "./ui/llm-providers";
import { browserNoticeStorage, DismissedNotices } from "./ui/notice-prefs";
import { storageMoveNotice, storageRetryNotice } from "./ui/warnings";

async function start(root: HTMLElement): Promise<void> {
  // Strip `code` and `state` from the address bar and the session history before anything else runs.
  const callback = takeCallbackParams(window.location, window.history, import.meta.env.BASE_URL);

  const config = loadConfig(import.meta.env, window.location.origin);
  let auth: SpotifyAuth;
  try {
    auth = new SpotifyAuth({
      clientId: config.spotifyClientId,
      redirectUri: config.redirectUri,
      // Per tab; never localStorage. Closing the tab doesn't reliably clear it (reopening a closed tab,
      // session restore, and duplicating a tab bring it back): Log out does.
      storage: window.sessionStorage,
      fetch: (input, init) => window.fetch(input, init),
    });
  } catch (exc) {
    root.replaceChildren(h("p", { class: "notice", text: exc instanceof Error ? exc.message : "Configuration error." }));
    return;
  }
  // IndexedDB (memory if unavailable): the write log for snapshot read lag, backups before applying plans,
  // and recording dates.
  const [writeLogStore, backups, recordingsStore] = await Promise.all([openStore("write-log"), openStore("plan-backups"), openStore("recordings")]);
  const writeLog = new WriteLog(writeLogStore);
  // Copies of Spotify metadata are not kept indefinitely (Developer Terms IV.3): old backups and expired
  // write-log entries go now, in the background.
  void pruneBackups(backups).catch(() => {});
  void writeLog.prune().catch(() => {});
  const recordings = new RecordingStore(recordingsStore);
  const persistent = [writeLogStore, backups, recordingsStore].every(isPersistent);
  const client = new SpotifyClient(auth, { fetch: (input, init) => window.fetch(input, init), writeLog });

  // LLM clients get their own fetch and never see `auth`: the Spotify token cannot reach a model. A hosted
  // provider's API key lives in sessionStorage (per tab), pasted by the user; never in the build.
  const providers = buildProviders(config, (input, init) => window.fetch(input, init));
  const settings = new LlmSettings(window.sessionStorage);
  const activity = new ActivityLog();
  // Closing a hosted provider's data notice is remembered per host across tabs (localStorage); never the key.
  const dismissedNotices = new DismissedNotices(browserNoticeStorage());
  const chat = new ChatView({ providers, settings, ctx: { client, recordings }, backups, activity, dismissedNotices });
  const app = new App(root, auth, client, chat, recordings, activity);

  if (!persistent && indexedDbSupported()) {
    app.showWarning(
      "Local storage is unavailable, probably because another curatune-web tab runs an older version (close the other " +
        "curatune-web tabs), or the one-time move of older data is still running; reload in a moment. Until then, recording " +
        "dates and backups are not saved.",
    );
  }
  // Data saved under the app's former name moves to its storage once, as the stores open (storage/kv.ts).
  const moveNotice = storageMoveNotice(migrationOutcome());
  if (moveNotice) {
    const retry = { label: "Try again", run: async () => storageRetryNotice(await mergeLegacyDatabase()) };
    app.showWarning(moveNotice.text, moveNotice.retry ? retry : undefined);
  }
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
if (root) {
  // Before anything else (callback parameters, storage): a framed page starts nothing (ui/frame-guard.ts).
  if (isFramed(window)) root.replaceChildren(framedNotice(new URL(import.meta.env.BASE_URL, window.location.origin).href));
  else void start(root);
}
