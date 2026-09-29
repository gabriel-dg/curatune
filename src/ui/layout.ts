// Resizable columns: drag the edge between the playlists and the chat, or between the chat and the panel;
// the chat takes the rest. Widths are clamped so the chat keeps a usable width, clamped again when the
// window changes, and remembered in localStorage. That key holds two numbers and nothing else: this is the
// only module allowed to use localStorage (tests/invariants.test.ts). Double-click an edge to reset it;
// arrow keys move a focused edge. Only while the columns sit side by side (not on phones).

import { h } from "./dom";

export interface Widths {
  sidebar: number;
  panel: number;
}

export type Column = keyof Widths;

export const DEFAULT_WIDTHS: Widths = { sidebar: 264, panel: 440 };
export const LIMITS: Record<Column, [number, number]> = { sidebar: [200, 420], panel: [360, 1400] };
/** The chat never gets narrower than this while the panel sits beside it. */
export const CHAT_MIN = 420;
const STORAGE_KEY = "spotikit.layout";
const STEP = 16;

/** Same breakpoints as style.css: the panel floats over the chat up to 1180 px, the sidebar is a drawer up to 780. */
export function layoutFor(viewport: number): "wide" | "medium" | "narrow" {
  return viewport <= 780 ? "narrow" : viewport <= 1180 ? "medium" : "wide";
}

const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(value, max)));

/** The widths to show for the preferred ones in this viewport. The sidebar is settled first; the panel gets what is left. */
export function clampWidths(preferred: Widths, viewport: number, panelOpen: boolean): Widths {
  const wide = layoutFor(viewport) === "wide";
  const reserved = CHAT_MIN + (wide && panelOpen ? LIMITS.panel[0] : 0);
  const sidebar = clamp(preferred.sidebar, LIMITS.sidebar[0], Math.min(LIMITS.sidebar[1], viewport - reserved));
  // Floating over the chat (medium screens), the panel may cover most of it.
  const panelRoom = wide ? viewport - sidebar - CHAT_MIN : viewport - 48;
  const panel = clamp(preferred.panel, LIMITS.panel[0], Math.min(LIMITS.panel[1], panelRoom));
  return { sidebar, panel };
}

/** Stored widths, keeping only numbers within the limits. */
export function parseWidths(raw: string | null): Partial<Widths> {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return {};
  }
  const out: Partial<Widths> = {};
  if (value && typeof value === "object") {
    for (const column of ["sidebar", "panel"] as const) {
      const n = (value as Record<string, unknown>)[column];
      if (typeof n === "number" && Number.isFinite(n) && n >= LIMITS[column][0] && n <= LIMITS[column][1]) out[column] = Math.round(n);
    }
  }
  return out;
}

function readStored(): Partial<Widths> {
  try {
    return parseWidths(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {}; // Blocked storage (private window, site data off): defaults.
  }
}

function writeStored(widths: Partial<Widths>): void {
  try {
    if (Object.keys(widths).length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not remembered; the layout still works for this page.
  }
}

export class ResizableLayout {
  private readonly shell: HTMLElement;
  private readonly handles: Record<Column, HTMLElement>;
  private readonly stored: Partial<Widths>;
  private preferred: Widths;
  private readonly abort = new AbortController();

  /** Adds the two drag handles to `workspace`, whose columns use `--sidebar` and `--panel` from `shell`. */
  constructor(shell: HTMLElement, workspace: HTMLElement) {
    this.shell = shell;
    this.stored = readStored();
    this.preferred = { ...DEFAULT_WIDTHS, ...this.stored };
    this.handles = { sidebar: this.handle("sidebar", "Resize the playlists column"), panel: this.handle("panel", "Resize the details panel") };
    workspace.append(this.handles.sidebar, this.handles.panel);
    window.addEventListener("resize", () => this.apply(), { signal: this.abort.signal });
    this.apply();
  }

  /** Call after the panel opens or closes: the room each column may take depends on it. */
  update(): void {
    this.apply();
  }

  dispose(): void {
    this.abort.abort();
  }

  private current(): Widths {
    return clampWidths(this.preferred, window.innerWidth, this.shell.classList.contains("panel-open"));
  }

  private apply(): void {
    const widths = this.current();
    if (layoutFor(window.innerWidth) === "narrow") {
      // Phones: the sidebar is a drawer and the panel is full width; the stylesheet's sizes apply.
      this.shell.style.removeProperty("--sidebar");
      this.shell.style.removeProperty("--panel");
    } else {
      this.shell.style.setProperty("--sidebar", `${widths.sidebar}px`);
      this.shell.style.setProperty("--panel", `${widths.panel}px`);
    }
    for (const column of ["sidebar", "panel"] as const) {
      const handle = this.handles[column];
      handle.setAttribute("aria-valuenow", String(widths[column]));
      handle.setAttribute("aria-valuemin", String(LIMITS[column][0]));
      handle.setAttribute("aria-valuemax", String(Math.max(LIMITS[column][0], clampWidths({ ...this.preferred, [column]: Infinity }, window.innerWidth, true)[column])));
    }
  }

  /**
   * Keep what is on screen as the preference for this column, and remember it. The other column keeps its
   * preference: squeezed now, it grows back when there is room again.
   */
  private commit(column: Column): void {
    this.preferred[column] = this.current()[column];
    this.stored[column] = this.preferred[column];
    writeStored(this.stored);
  }

  private reset(column: Column): void {
    this.preferred[column] = DEFAULT_WIDTHS[column];
    delete this.stored[column];
    writeStored(this.stored);
    this.apply();
  }

  private handle(column: Column, label: string): HTMLElement {
    const handle = h("div", {
      class: `resizer resizer-${column}`,
      attrs: { role: "separator", "aria-orientation": "vertical", "aria-label": label, tabindex: "0", title: "Drag to resize · double-click to reset" },
    });
    // The sidebar grows to the right, the panel to the left.
    const direction = column === "sidebar" ? 1 : -1;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const start = this.current()[column];
      this.shell.classList.add("resizing");
      handle.classList.add("active");
      const move = (e: PointerEvent) => {
        this.preferred[column] = start + direction * (e.clientX - startX);
        this.apply();
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        this.shell.classList.remove("resizing");
        handle.classList.remove("active");
        this.commit(column);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });

    handle.addEventListener("dblclick", () => this.reset(column));

    handle.addEventListener("keydown", (event) => {
      const arrow = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!arrow) return;
      event.preventDefault();
      this.preferred[column] = this.current()[column] + direction * arrow * (event.shiftKey ? STEP * 4 : STEP);
      this.apply();
      this.commit(column);
    });
    return handle;
  }
}
