// The models the chat can use: the local one (LM Studio or Ollama, the default when configured) and, optionally,
// one or more models of a hosted provider (e.g. Gemini 3.8 Flash and 3.5 Flash Lite). The hosted provider's API
// key is pasted by the user, shared by its models, and kept only in this tab's sessionStorage, like the Spotify
// token; it is sent only to that provider (see src/agent/llm.ts).

import type { KeyValueStorage } from "../spotify/auth";
import { LlmClient, type ChatModel } from "../agent/llm";

export interface ProviderOption {
  /** "local", or "hosted:<model>". */
  id: string;
  /** Who serves it: "Local", or the hosted provider's name (e.g. "Gemini"). */
  name: string;
  /** Shown in the model selector, e.g. "Local · ornith-1.5-9b-mlx". */
  label: string;
  model: string;
  /** A hosted provider: playlist data leaves the user's machine (see hostedDataNotice). The default only in a
   * build without a local model, such as the public site, where it still needs the user's key first. */
  hosted: boolean;
  /** Hosted providers need an API key from the user. */
  requiresKey: boolean;
  /** Where the API key is kept: shared by every model of the same provider; null when none is needed. */
  keyId: string | null;
  /** Host that receives the conversation (and the key, for hosted providers). */
  host: string;
  /** Throws AgentError (LLM_NOT_CONFIGURED) when the provider cannot be used. */
  create(apiKey: string | null): ChatModel;
}

const KEY_PREFIX = "curatune-web.llm-key.";
const PROVIDER_KEY = "curatune-web.llm-provider";

/** API keys and the selected provider, per tab (sessionStorage in the app). */
export class LlmSettings {
  constructor(private readonly storage: KeyValueStorage) {}

  apiKey(provider: ProviderOption): string | null {
    return provider.keyId ? this.storage.getItem(KEY_PREFIX + provider.keyId) : null;
  }

  setApiKey(provider: ProviderOption, key: string): void {
    if (provider.keyId) this.storage.setItem(KEY_PREFIX + provider.keyId, key.trim());
  }

  forgetApiKey(provider: ProviderOption): void {
    if (provider.keyId) this.storage.removeItem(KEY_PREFIX + provider.keyId);
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
  config: { llmBaseUrl: string; llmModel: string; hostedLlm: { baseUrl: string; models: string[]; name: string } | null },
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): ProviderOption[] {
  const hosted = config.hostedLlm;
  // A build with a hosted model and no local one (the public site) must not offer, or default to, a local model
  // that can't work. With neither configured, the local entry stays so the chat says what to set.
  const hasLocal = Boolean(config.llmBaseUrl && config.llmModel);
  const providers: ProviderOption[] = [];
  if (hasLocal || !hosted?.models.length) {
    providers.push({
      id: "local",
      name: "Local",
      label: `Local · ${config.llmModel || "not configured"}`,
      model: config.llmModel,
      hosted: false,
      requiresKey: false,
      keyId: null,
      host: hostOf(config.llmBaseUrl),
      create: () => new LlmClient({ baseUrl: config.llmBaseUrl, model: config.llmModel, fetch }),
    });
  }
  for (const model of hosted?.models ?? []) {
    providers.push({
      id: `hosted:${model}`,
      name: hosted!.name,
      label: `${hosted!.name} · ${model}`,
      model,
      hosted: true,
      requiresKey: true,
      keyId: "hosted",
      host: hostOf(hosted!.baseUrl),
      create: (apiKey) => new LlmClient({ baseUrl: hosted!.baseUrl, model, fetch, apiKey: apiKey ?? undefined }),
    });
  }
  return providers;
}

/** Spotify's clauses on feeding its content to AI models, cited wherever a hosted model is in use. */
export const SPOTIFY_AI_TERMS = [
  { label: "Developer Terms, section IV.2.1", url: "https://developer.spotify.com/terms" },
  { label: "Developer Policy, section III.14", url: "https://developer.spotify.com/policy" },
] as const;

/** For a hosted model, what leaves the user's machine and where it goes; null for the local model. */
export function hostedDataNotice(provider: ProviderOption): string | null {
  if (!provider.hosted) return null;
  return (
    `${provider.label} is a hosted model: your messages and the playlist data the assistant reads ` +
    `(playlist names, track names, and artists) leave this computer and go to ${provider.host}.`
  );
}

/** The provider saved as selected in this tab; "hosted" (before several hosted models) means the first hosted
 * one; anything else, or nothing saved, means the first provider: the local one when the build has it. */
export function pickProvider(providers: ProviderOption[], selected: string | null): ProviderOption {
  return providers.find((p) => p.id === selected) ?? (selected === "hosted" ? providers.find((p) => p.keyId === "hosted") : undefined) ?? providers[0]!;
}
