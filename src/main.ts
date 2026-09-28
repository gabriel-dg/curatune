import { AgentError, LlmClient } from "./agent/llm";
import { loadConfig } from "./config";
import { SpotifyAuth, takeCallbackParams } from "./spotify/auth";
import { SpotifyClient } from "./spotify/http";
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
  const client = new SpotifyClient(auth, { fetch: (input, init) => window.fetch(input, init) });

  // The LLM client gets its own fetch and never sees `auth`: the Spotify token cannot reach the model.
  let model: LlmClient | null = null;
  let modelProblem: string | null = null;
  try {
    model = new LlmClient({ baseUrl: config.llmBaseUrl, model: config.llmModel, fetch: (input, init) => window.fetch(input, init) });
  } catch (exc) {
    modelProblem = exc instanceof AgentError ? exc.message : "The LLM is not configured.";
  }
  const chat = new ChatView(model, modelProblem, config.llmModel, { client });
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
