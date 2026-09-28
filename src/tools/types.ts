import type { SpotifyClient } from "../spotify/http";
import type { Args, ObjectSchema } from "./schema";

export interface ToolContext {
  client: SpotifyClient;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ObjectSchema;
  run(args: Args, ctx: ToolContext): Promise<unknown>;
  /** A few words for the UI (e.g. "12 items"); never sent to the model. */
  summarize?(result: unknown): string;
}

/** OpenAI-compatible function definition, as sent in the `tools` field of a chat completion. */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: ObjectSchema };
}
