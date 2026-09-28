import { AgentError, LlmClient } from "./agent/llm";
import { loadConfig } from "./config";
import { SpotifyAuth, takeCallbackParams } from "./spotify/auth";
import { SpotifyClient } from "./spotify/http";
import { WriteLog } from "./spotify/writelog";
import { openStore } from "./storage/kv";
import { App } from "./ui/app";
import { ChatView } from "./ui/chat";
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
  // IndexedDB (memory if unavailable): the write log for snapshot read lag, and backups before applying plans.
  const writeLog = new WriteLog(await openStore("write-log"));
  const backups = await openStore("plan-backups");
  const client = new SpotifyClient(auth, { fetch: (input, init) => window.fetch(input, init), writeLog });

  // The LLM client gets its own fetch and never sees `auth`: the Spotify token cannot reach the model.
  let model: LlmClient | null = null;
  let modelProblem: string | null = null;
  try {
    model = new LlmClient({ baseUrl: config.llmBaseUrl, model: config.llmModel, fetch: (input, init) => window.fetch(input, init) });
  } catch (exc) {
    modelProblem = exc instanceof AgentError ? exc.message : "The LLM is not configured.";
  }
  const chat = new ChatView(model, modelProblem, config.llmModel, { client }, backups);
  const app = new App(root, auth, client, chat);

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
