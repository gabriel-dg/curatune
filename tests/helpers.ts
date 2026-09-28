import type { KeyValueStorage } from "../src/spotify/auth";

export class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  dump(): string {
    return [...this.data.values()].join("\n");
  }
}

export interface RecordedRequest {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A fetch stand-in that records every request and answers from a handler. */
export function fakeFetch(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url: input, init, headers: { ...(init.headers as Record<string, string> | undefined) } });
    return handler(new URL(input), init);
  };
  return { fetch, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export const noSleep = async (): Promise<void> => {};

export async function rejection<E extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
  try {
    await promise;
  } catch (exc) {
    if (exc instanceof type) return exc;
    throw exc;
  }
  throw new Error("expected a rejection");
}
