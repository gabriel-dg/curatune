import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/ui/markdown";

describe("parseInline", () => {
  it("parses bold, italic, and code", () => {
    expect(parseInline("a **b** *c* `d` e")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " " },
      { kind: "em", text: "c" },
      { kind: "text", text: " " },
      { kind: "code", text: "d" },
      { kind: "text", text: " e" },
    ]);
  });

  it("links only open.spotify.com URLs", () => {
    expect(parseInline("see https://open.spotify.com/playlist/abc123")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://open.spotify.com/playlist/abc123", href: "https://open.spotify.com/playlist/abc123" },
    ]);
    expect(parseInline("[Open](https://open.spotify.com/track/xyz)")).toEqual([{ kind: "link", text: "Open", href: "https://open.spotify.com/track/xyz" }]);
  });

  it.each([
    "[Login here](https://evil.example/phish)",
    "[x](javascript:alert(1))",
    "[x](https://open.spotify.com.evil.example/a)",
    "[x](http://open.spotify.com/a)",
  ])("keeps %s as plain text", (text) => {
    const out = parseInline(text);
    expect(out.every((i) => i.kind === "text")).toBe(true);
  });

  it("does not treat multiplication or lone asterisks as emphasis", () => {
    expect(parseInline("3 * 4 = 12").every((i) => i.kind === "text")).toBe(true);
  });
});

describe("parseMarkdown", () => {
  it("groups paragraphs, lists, and headings", () => {
    const blocks = parseMarkdown("# Title\nline one\nline two\n\n- a\n- **b**\n\n1. x\n2. y\n\nend");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "list", "paragraph"]);
    expect(blocks[1]).toMatchObject({ kind: "paragraph", lines: [[{ text: "line one" }], [{ text: "line two" }]] });
    expect(blocks[2]).toMatchObject({ kind: "list", ordered: false, items: [[{ text: "a" }], [{ kind: "strong", text: "b" }]] });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true, start: 1 });
  });

  it("keeps the start number of ordered lists", () => {
    expect(parseMarkdown("7. seven\n8. eight")[0]).toMatchObject({ kind: "list", ordered: true, start: 7 });
  });

  it("joins indented continuation lines to the list item", () => {
    const [list] = parseMarkdown("- first\n  continued\n- second");
    expect(list).toMatchObject({ kind: "list", items: [[{ text: "first" }, { text: " continued" }], [{ text: "second" }]] });
  });
});
