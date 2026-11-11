import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

describe("the Confirm card for additions", () => {
  it("is what the chat gives playlist_add, tied to the turn's Stop", () => {
    const chat = read("../src/ui/chat.ts");
    expect(chat).toMatch(/confirmAdd: \(preview\) => \{\s*const \{ element, answer \} = addConfirmCard\(preview, signal\);/);
    expect(read("../src/main.ts")).toContain("createdPlaylists: new Set<string>()");
  });

  it("answers once: Confirm is the only yes, Cancel and Stop are no, and Spotify text is rendered as text", () => {
    const card = read("../src/ui/add-card.ts");
    expect(card).toContain('confirmButton.addEventListener("click", () => finish(true');
    expect(card).toContain('cancelButton.addEventListener("click", () => finish(false');
    expect(card).toContain('signal.addEventListener("abort", onAbort)');
    expect(card).toContain("if (signal.aborted) return finish(false");
    expect(card).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
});
