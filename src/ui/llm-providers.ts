// The models the chat can use: the local one (LM Studio or Ollama, the default) and an optional hosted one
// (e.g. Gemini). A hosted provider's API key is pasted by the user and kept only in this tab's
// sessionStorage, like the Spotify token; it is sent only to that provider (see src/agent/llm.ts).

import type { KeyValueStorage } from "../spotify/auth";
import { LlmClient, type ChatModel } from "../agent/llm";

export interface ProviderOption {
  id: "local" | "hosted";
  /** Shown in the model selector, e.g. "Local · ornith-1.5-9b-mlx". */
  label: string;
  model: string;
  /** Hosted providers need an API key from the user. */
  requiresKey: boolean;
  /** Host that receives the conversation (and the key, for hosted providers). */
  host: string;
  /** Throws AgentError (LLM_NOT_CONFIGURED) when the provider cannot be used. */
  create(apiKey: string | null): ChatModel;
}

const KEY_PREFIX = "spotikit-web.llm-key.";
const PROVIDER_KEY = "spotikit-web.llm-provider";

/** API keys and the selected provider, per tab (sessionStorage in the app). */
export class LlmSettings {
  constructor(private readonly storage: KeyValueStorage) {}

  apiKey(provider: ProviderOption): string | null {
    return this.storage.getItem(KEY_PREFIX + provider.id);
  }

  setApiKey(provider: ProviderOption, key: string): void {
    this.storage.setItem(KEY_PREFIX + provider.id, key.trim());
  }

  forgetApiKey(provider: ProviderOption): void {
    this.storage.removeItem(KEY_PREFIX + provider.id);
  }

  selected(): string | null {
    return this.storage.getItem(PROVIDER_KEY);
  }

  select(provider: ProviderOption): void {
    this.storage.setItem(PROVIDER_KEY, provider.id);
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function buildProviders(
  config: { llmBaseUrl: string; llmModel: string; hostedLlm: { baseUrl: string; model: string; name: string } | null },
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): ProviderOption[] {
  const providers: ProviderOption[] = [
    {
      id: "local",
      label: `Local · ${config.llmModel || "not configured"}`,
      model: config.llmModel,
      requiresKey: false,
      host: hostOf(config.llmBaseUrl),
      create: () => new LlmClient({ baseUrl: config.llmBaseUrl, model: config.llmModel, fetch }),
    },
  ];
  const hosted = config.hostedLlm;
  if (hosted) {
    providers.push({
      id: "hosted",
      label: `${hosted.name} · ${hosted.model}`,
      model: hosted.model,
      requiresKey: true,
      host: hostOf(hosted.baseUrl),
      create: (apiKey) => new LlmClient({ baseUrl: hosted.baseUrl, model: hosted.model, fetch, apiKey: apiKey ?? undefined }),
    });
  }
  return providers;
}
