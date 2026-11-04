// Inline SVG icons built with the DOM API (no HTML parsing, CSP-friendly). Paths are simple 24x24
// strokes drawn for this app.

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  // A vinyl record: disc, label, and two grooves.
  logo: ["M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18Z", "M12 10a2 2 0 1 0 0 4a2 2 0 0 0 0-4Z", "M6.2 10a6 6 0 0 1 3.8-3.8", "M17.8 14a6 6 0 0 1-3.8 3.8"],
  send: ["M4 12l16-8-6 16-2.5-6.5L4 12Z"],
  stop: ["M7 7h10v10H7z"],
  plus: ["M12 5v14", "M5 12h14"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14Z", "M20 20l-4-4"],
  chat: ["M4 5h16v11H9l-5 4V5Z"],
  list: ["M8 6h12", "M8 12h12", "M8 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  calendar: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  activity: ["M3 12h4l3-7 4 14 3-7h4"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  tool: ["M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-2.5 2.5-2.5-1.5-1.5Z"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
  alert: ["M12 4l9 16H3L12 4Z", "M12 10v4", "M12 17h.01"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  key: ["M8 14a4 4 0 1 1 3.5-6h8.5v3h-2v2h-3v-2h-3.5A4 4 0 0 1 8 14Z"],
  sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"],
  arrowUp: ["M12 19V5", "M6 11l6-6 6 6"],
  arrowDown: ["M12 5v14", "M6 13l6 6 6-6"],
  logout: ["M15 4h4v16h-4", "M10 8l-4 4 4 4", "M6 12h10"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
  music: ["M9 18V6l10-2v12", "M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z", "M19 16a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z"],
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  for (const d of PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
