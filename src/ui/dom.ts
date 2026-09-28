// Minimal DOM builder. Text is always inserted as text nodes: Spotify content (names, descriptions) is
// untrusted third-party text and must never be parsed as HTML.

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  for (const [type, listener] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, listener as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return el;
}
