// A deliberately small JSON Schema subset for tool parameters, plus the validator for the arguments the
// model sends. Model output is untrusted input: arguments are checked before any handler runs.

import { SpotikitError } from "../spotify/errors";

export type ParamSchema =
  | { type: "string"; description: string; minLength?: number }
  | { type: "integer"; description: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description: string };

export interface ObjectSchema {
  type: "object";
  properties: Record<string, ParamSchema>;
  required?: string[];
  additionalProperties: false;
}

export type Args = Record<string, string | number | boolean>;

export function validateArgs(schema: ObjectSchema, value: unknown): Args {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpotikitError("INVALID_ARGUMENT", "Arguments must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !(key in schema.properties));
  if (unknown.length) {
    throw new SpotikitError("INVALID_ARGUMENT", `Unknown arguments: ${unknown.join(", ")}.`, { unknown });
  }
  const args: Args = {};
  for (const [key, param] of Object.entries(schema.properties)) {
    const raw = input[key];
    if (raw === undefined || raw === null) {
      if (schema.required?.includes(key)) {
        throw new SpotikitError("INVALID_ARGUMENT", `Missing required argument: ${key}.`);
      }
      continue;
    }
    if (param.type === "string") {
      if (typeof raw !== "string") throw new SpotikitError("INVALID_ARGUMENT", `${key} must be a string.`);
      if (param.minLength !== undefined && raw.trim().length < param.minLength) {
        throw new SpotikitError("INVALID_ARGUMENT", `${key} must not be empty.`);
      }
      args[key] = raw;
    } else if (param.type === "integer") {
      // Some models send numbers as strings ("10"); accept those when they are plain integers.
      const num = typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw;
      if (typeof num !== "number" || !Number.isInteger(num)) {
        throw new SpotikitError("INVALID_ARGUMENT", `${key} must be an integer.`);
      }
      if ((param.minimum !== undefined && num < param.minimum) || (param.maximum !== undefined && num > param.maximum)) {
        throw new SpotikitError("INVALID_ARGUMENT", `${key} must be between ${param.minimum ?? "-∞"} and ${param.maximum ?? "∞"}.`);
      }
      args[key] = num;
    } else {
      const bool = raw === "true" ? true : raw === "false" ? false : raw;
      if (typeof bool !== "boolean") throw new SpotikitError("INVALID_ARGUMENT", `${key} must be a boolean.`);
      args[key] = bool;
    }
  }
  return args;
}
