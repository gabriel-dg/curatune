// Static checks over the page source for the security invariants in AGENTS.md.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
const html = import.meta.glob<string>("../index.html", { query: "?raw", import: "default", eager: true });
const all = { ...sources, ...html };

// Comments may mention forbidden APIs (e.g. "never localStorage"); only code is checked.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offenders(pattern: RegExp, files: Record<string, string> = all): string[] {
  return Object.entries(files)
    .filter(([, text]) => pattern.test(stripComments(text)))
    .map(([path]) => path);
}

describe("source invariants", () => {
  it("finds the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it("never uses localStorage or IndexedDB for tokens", () => {
    // IndexedDB will hold the write log (phase 4), never tokens; revisit this check then.
    expect(offenders(/localStorage|indexedDB/)).toEqual([]);
  });

  it("never parses strings as HTML", () => {
    expect(offenders(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/)).toEqual([]);
  });

  it("has no eval-like constructs", () => {
    expect(offenders(/\beval\(|new Function\(/)).toEqual([]);
  });

  it("does not log from the Spotify layer", () => {
    const spotify = Object.fromEntries(Object.entries(sources).filter(([path]) => path.includes("/spotify/")));
    expect(offenders(/console\./, spotify)).toEqual([]);
  });

  it("keeps spotify/ independent of the UI and the LLM", () => {
    const spotify = Object.fromEntries(Object.entries(sources).filter(([path]) => path.includes("/spotify/")));
    expect(offenders(/from "\.\.\/(ui|agent|tools)\//, spotify)).toEqual([]);
    expect(offenders(/\bdocument\.|\bwindow\./, spotify)).toEqual([]);
  });

  it("keeps tools/ and agent/ free of the DOM and the UI", () => {
    const layers = Object.fromEntries(Object.entries(sources).filter(([path]) => /\/(tools|agent)\//.test(path)));
    expect(Object.keys(layers).length).toBeGreaterThan(3);
    expect(offenders(/from "\.\.\/ui\//, layers)).toEqual([]);
    expect(offenders(/\bdocument\.|\bwindow\.|console\./, layers)).toEqual([]);
  });

  it("never gives the agent access to the auth module (types only)", () => {
    const agent = Object.fromEntries(Object.entries(sources).filter(([path]) => /\/(tools|agent)\//.test(path)));
    expect(offenders(/^import (?!type )[^;]*from "\.\.\/spotify\/auth"/m, agent)).toEqual([]);
  });

  it("loads no third-party scripts or styles", () => {
    expect(offenders(/<script[^>]+src="https?:|<link[^>]+href="https?:/)).toEqual([]);
  });
});
