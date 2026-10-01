// A deliberately small JSON Schema subset for tool parameters, plus the validator for the arguments the
// model sends. Model output is untrusted input: arguments are checked before any handler runs.

import { CuratuneError } from "../spotify/errors";

export type ParamSchema =
  | { type: "string"; description: string; minLength?: number }
  | { type: "integer"; description: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description: string }
  | { type: "array"; description: string; items: ItemSchema; minItems?: number; maxItems?: number };

/** Array items: strings, integers, or flat objects whose values are all strings. */
export type ItemSchema =
  | { type: "string" | "integer" }
  | { type: "object"; properties: Record<string, { type: "string"; description: string }>; additionalProperties: false };

export interface ObjectSchema {
  type: "object";
  properties: Record<string, ParamSchema>;
  required?: string[];
  additionalProperties: false;
}

export type Args = Record<string, string | number | boolean | string[] | number[] | Record<string, string>[]>;

export function validateArgs(schema: ObjectSchema, value: unknown): Args {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CuratuneError("INVALID_ARGUMENT", "Arguments must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !(key in schema.properties));
  if (unknown.length) {
    throw new CuratuneError("INVALID_ARGUMENT", `Unknown arguments: ${unknown.join(", ")}.`, { unknown });
  }
  const args: Args = {};
  for (const [key, param] of Object.entries(schema.properties)) {
    const raw = input[key];
    if (raw === undefined || raw === null) {
      if (schema.required?.includes(key)) {
        throw new CuratuneError("INVALID_ARGUMENT", `Missing required argument: ${key}.`);
      }
      continue;
    }
    if (param.type === "string") {
      if (typeof raw !== "string") throw new CuratuneError("INVALID_ARGUMENT", `${key} must be a string.`);
      if (param.minLength !== undefined && raw.trim().length < param.minLength) {
        throw new CuratuneError("INVALID_ARGUMENT", `${key} must not be empty.`);
      }
      args[key] = raw;
    } else if (param.type === "integer") {
      // Some models send numbers as strings ("10"); accept those when they are plain integers.
      const num = typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw;
      if (typeof num !== "number" || !Number.isInteger(num)) {
        throw new CuratuneError("INVALID_ARGUMENT", `${key} must be an integer.`);
      }
      if ((param.minimum !== undefined && num < param.minimum) || (param.maximum !== undefined && num > param.maximum)) {
        throw new CuratuneError("INVALID_ARGUMENT", `${key} must be between ${param.minimum ?? "-∞"} and ${param.maximum ?? "∞"}.`);
      }
      args[key] = num;
    } else if (param.type === "array") {
      if (!Array.isArray(raw)) throw new CuratuneError("INVALID_ARGUMENT", `${key} must be an array.`);
      let items: string[] | number[] | Record<string, string>[];
      const itemSchema = param.items;
      if (itemSchema.type === "string") {
        if (raw.some((item) => typeof item !== "string")) throw new CuratuneError("INVALID_ARGUMENT", `${key} must be an array of strings.`);
        items = raw as string[];
      } else if (itemSchema.type === "object") {
        items = raw.map((item, i) => {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new CuratuneError("INVALID_ARGUMENT", `${key}[${i}] must be an object.`);
          }
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (!(k in itemSchema.properties)) throw new CuratuneError("INVALID_ARGUMENT", `${key}[${i}] has an unknown key: ${k}.`);
            if (v === null || v === undefined) continue;
            if (typeof v !== "string") throw new CuratuneError("INVALID_ARGUMENT", `${key}[${i}].${k} must be a string.`);
            out[k] = v;
          }
          return out;
        });
      } else {
        items = raw.map((item) => (typeof item === "string" && /^\d+$/.test(item.trim()) ? Number(item) : item)) as number[];
        if (items.some((item) => typeof item !== "number" || !Number.isInteger(item))) {
          throw new CuratuneError("INVALID_ARGUMENT", `${key} must be an array of integers.`);
        }
      }
      if ((param.minItems !== undefined && items.length < param.minItems) || (param.maxItems !== undefined && items.length > param.maxItems)) {
        throw new CuratuneError("INVALID_ARGUMENT", `${key} must have between ${param.minItems ?? 0} and ${param.maxItems ?? "∞"} items.`);
      }
      args[key] = items;
    } else {
      const bool = raw === "true" ? true : raw === "false" ? false : raw;
      if (typeof bool !== "boolean") throw new CuratuneError("INVALID_ARGUMENT", `${key} must be a boolean.`);
      args[key] = bool;
    }
  }
  return args;
}
