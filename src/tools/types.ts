import type { Plan } from "../plans/plans";
import type { RecordingStore } from "../recordings/recordings";
import type { SpotifyClient } from "../spotify/http";
import type { Args, ObjectSchema } from "./schema";

export interface ToolContext {
  client: SpotifyClient;
  /**
   * Whether a 22-char Spotify ID appeared earlier in the conversation (a user message or a tool
   * result). Write tools refuse IDs the model did not get from somewhere: they would be invented.
   */
  isKnownId?: (id: string) => boolean;
  /** Receives every plan a tool builds, so the UI can show it with its Apply button. */
  onPlan?: (plan: Plan) => void;
  /** Recording dates (IndexedDB in the app); tools that need it fail cleanly without it. */
  recordings?: RecordingStore;
}

/** How the UI shows a write that was performed. */
export interface WriteReport {
  title: string;
  lines: string[];
  playlistId: string | null;
  warnings: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ObjectSchema;
  run(args: Args, ctx: ToolContext): Promise<unknown>;
  /** A few words for the UI (e.g. "12 items"); never sent to the model. */
  summarize?(result: unknown): string;
  /** Present on tools that write to Spotify: describes a successful write for the UI. */
  describeWrite?(result: unknown): WriteReport | null;
}

/** OpenAI-compatible function definition, as sent in the `tools` field of a chat completion. */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: ObjectSchema };
}
