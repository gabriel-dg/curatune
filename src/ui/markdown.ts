// A small, safe subset of Markdown for the model's answers: paragraphs, "-"/"*" and "1." lists, headings
// (shown as bold lines), **bold**, *italic*, and `code`. Parsing is pure (testable in Node); rendering
// only creates text nodes and a few elements. Links become clickable only for open.spotify.com: the model
// can be steered by third-party text (playlist descriptions), so other URLs stay plain text.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "heading"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] };

const SAFE_LINK = /^https:\/\/open\.spotify\.com\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9=&_-]*)?$/;
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)\s]+\)|https:\/\/open\.spotify\.com\/[^\s)]+)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "text", text: text.slice(last, index) });
    if (token.startsWith("**")) out.push({ kind: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("`")) out.push({ kind: "code", text: token.slice(1, -1) });
    else if (token.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token) ?? [];
      out.push(href && SAFE_LINK.test(href) ? { kind: "link", text: label!, href } : { kind: "text", text: label ? `${label} (${href})` : token });
    } else if (token.startsWith("https://")) {
      out.push(SAFE_LINK.test(token) ? { kind: "link", text: token, href: token } : { kind: "text", text: token });
    } else out.push({ kind: "em", text: token.slice(1, -1) });
    last = index + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: Inline[][] = [];
  let list: Extract<Block, { kind: "list" }> | null = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", inlines: parseInline(heading[1]!) });
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const text = numbered ? numbered[2]! : bullet![1]!;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { kind: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push(parseInline(text));
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // Indented continuation of the previous list item.
      list.items[list.items.length - 1]!.push({ kind: "text", text: ` ${line.trim()}` });
    } else {
      flushList();
      paragraph.push(parseInline(line));
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

function renderInlines(inlines: Inline[]): Node[] {
  return inlines.map((i) => {
    if (i.kind === "text") return document.createTextNode(i.text);
    if (i.kind === "link") {
      const a = document.createElement("a");
      a.textContent = i.text;
      a.href = i.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      return a;
    }
    const el = document.createElement(i.kind);
    el.textContent = i.text;
    return el;
  });
}

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    if (block.kind === "heading") {
      const p = document.createElement("p");
      p.className = "md-heading";
      p.append(...renderInlines(block.inlines));
      fragment.append(p);
    } else if (block.kind === "paragraph") {
      const p = document.createElement("p");
      block.lines.forEach((line, i) => {
        if (i) p.append(document.createElement("br"));
        p.append(...renderInlines(line));
      });
      fragment.append(p);
    } else {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
      for (const item of block.items) {
        const li = document.createElement("li");
        li.append(...renderInlines(item));
        list.append(li);
      }
      fragment.append(list);
    }
  }
  return fragment;
}
