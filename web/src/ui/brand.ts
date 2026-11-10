// The Curatune mark (public/brand/curatune-mark.svg), shared by the top bar, the login screen, and the
// chat's empty state. Decorative wherever it appears next to the product name or a heading, so alt="".

import { h } from "./dom";

export function brandMark(size: number): HTMLElement {
  return h("img", { class: "brand-mark", attrs: { src: `${import.meta.env.BASE_URL}brand/curatune-mark.svg`, alt: "", width: String(size), height: String(size) } });
}
