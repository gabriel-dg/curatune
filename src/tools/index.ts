// Tool registry and execution. Every outcome the model sees is JSON: either {"ok": true, "result": …} or
// {"ok": false, "error": {"code", "message"}}. Authorization failures are not tool errors: they are
// rethrown so the UI can ask the user to log in again.

import { SpotikitError } from "../spotify/errors";
import { validateArgs, type Args } from "./schema";
import { PLAN_TOOLS } from "./plan";
import { READ_TOOLS } from "./read";
import type { Tool, ToolContext, ToolDefinition, WriteReport } from "./types";
import { WRITE_TOOLS } from "./write";

export type { Tool, ToolContext, ToolDefinition, WriteReport } from "./types";
export { PLAN_TOOLS, READ_TOOLS, WRITE_TOOLS };

/**
 * Every tool the model gets. Removals, reorders, and renames exist only as plans; there is deliberately no
 * tool that applies a plan or changes visibility.
 */
export const ALL_TOOLS: Tool[] = [...READ_TOOLS, ...WRITE_TOOLS, ...PLAN_TOOLS];

/** Tool results longer than this are replaced by an error, so one call cannot flood the model's context. */
export const MAX_RESULT_CHARS = 40_000;

export type ToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface ToolExecution {
  name: string;
  args: Args | null;
  outcome: ToolOutcome;
  /** JSON sent back to the model as the tool message content. */
  content: string;
  summary: string;
  ms: number;
  /** Set when the tool wrote to Spotify, for the UI. */
  write: WriteReport | null;
}

export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

const AUTH_CODES = new Set(["AUTH_REQUIRED", "AUTH_EXPIRED", "CONFIG_ERROR"]);

function failure(code: string, message: string): ToolOutcome {
  return { ok: false, error: { code, message } };
}

export async function executeTool(
  tools: Tool[],
  name: string,
  rawArguments: string,
  ctx: ToolContext,
  now: () => number = () => performance.now(),
): Promise<ToolExecution> {
  const started = now();
  const tool = tools.find((t) => t.name === name);
  let args: Args | null = null;
  let outcome: ToolOutcome;
  if (!tool) {
    outcome = failure("UNKNOWN_TOOL", `There is no tool named ${JSON.stringify(name)}. Available: ${tools.map((t) => t.name).join(", ")}.`);
  } else {
    try {
      let parsed: unknown;
      try {
        parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      } catch {
        throw new SpotikitError("INVALID_ARGUMENT", "Arguments are not valid JSON.");
      }
      args = validateArgs(tool.parameters, parsed);
      outcome = { ok: true, result: await tool.run(args, ctx) };
    } catch (exc) {
      if (exc instanceof SpotikitError) {
        if (AUTH_CODES.has(exc.code)) throw exc;
        outcome = failure(exc.code, exc.message);
      } else {
        throw exc;
      }
    }
  }
  let content = JSON.stringify(outcome);
  if (content.length > MAX_RESULT_CHARS) {
    outcome = failure("RESULT_TOO_LARGE", "The result is too large. Ask for fewer items with offset and limit.");
    content = JSON.stringify(outcome);
  }
  const summary = outcome.ok
    ? (tool?.summarize?.(outcome.result) ?? "ok")
    : `${outcome.error.code}: ${outcome.error.message}`;
  const write = outcome.ok && tool?.describeWrite ? tool.describeWrite(outcome.result) : null;
  return { name, args, outcome, content, summary, ms: now() - started, write };
}
