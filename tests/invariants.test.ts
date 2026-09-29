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

function layer(re: RegExp): Record<string, string> {
  return Object.fromEntries(Object.entries(sources).filter(([path]) => re.test(path)));
}

describe("source invariants", () => {
  it("finds the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it("never uses localStorage; IndexedDB only in storage/, which knows nothing about auth", () => {
    expect(offenders(/localStorage/)).toEqual([]);
    expect(offenders(/indexedDB/).filter((path) => !path.includes("/storage/"))).toEqual([]);
    expect(offenders(/from "\.\.\/spotify\/auth"|accessToken|refreshToken|sessionStorage/, layer(/\/storage\//))).toEqual([]);
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

  it("lets only plans/ import the low-level mutating operations", () => {
    const importers = offenders(/from "[./]*(plans\/)?ops"/).filter((path) => !path.includes("/plans/"));
    expect(importers).toEqual([]);
  });

  it("never lets tools or the agent apply a plan (only the UI does)", () => {
    const agent = layer(/\/(tools|agent)\//);
    expect(offenders(/\bapplyPlan\b|plans\/ops/, agent)).toEqual([]);
    // The UI is the only caller of applyPlan outside plans/.
    const callers = offenders(/\bapplyPlan\(/).filter((path) => !path.includes("/plans/"));
    expect(callers.every((path) => path.includes("/ui/"))).toBe(true);
  });

  it("keeps recordings/ independent of the UI, the DOM, the LLM, and the auth module", () => {
    const recordings = layer(/\/recordings\//);
    expect(Object.keys(recordings).length).toBeGreaterThan(0);
    expect(offenders(/from "\.\.\/(ui|agent|tools)\//, recordings)).toEqual([]);
    expect(offenders(/\bdocument\.|\bwindow\.|console\.|indexedDB|from "\.\.\/spotify\/auth"/, recordings)).toEqual([]);
  });

  it("keeps plans/ independent of the UI, the DOM, and the LLM", () => {
    const plans = layer(/\/plans\//);
    expect(Object.keys(plans).length).toBeGreaterThan(1);
    expect(offenders(/from "\.\.\/(ui|agent|tools)\//, plans)).toEqual([]);
    expect(offenders(/\bdocument\.|\bwindow\.|console\./, plans)).toEqual([]);
  });

  it("never sends visibility to Spotify", () => {
    // `public:` appears only where playlists are read (models, trim), and in creation, which always
    // requests false. Plans, and anything that changes an existing playlist, never mention it.
    const allowed = ["../src/spotify/models.ts", "../src/spotify/writes.ts", "../src/tools/write.ts", "../src/tools/trim.ts"];
    const mentions = offenders(/\bpublic\s*:/).filter((path) => /\/(spotify|plans|tools)\//.test(path));
    expect(mentions.filter((path) => !allowed.includes(path))).toEqual([]);
    expect(offenders(/\bpublic\s*:/, layer(/\/plans\//))).toEqual([]);
    expect(offenders(/public:\s*true/, layer(/\/(spotify|plans|tools)\//))).toEqual([]);
  });

  it("loads no third-party scripts or styles", () => {
    expect(offenders(/<script[^>]+src="https?:|<link[^>]+href="https?:/)).toEqual([]);
  });
});
