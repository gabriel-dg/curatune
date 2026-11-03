import { describe, expect, it } from "vitest";
import { CHAT_MIN, clampWidths, DEFAULT_WIDTHS, layoutFor, LIMITS, parseWidths } from "../src/ui/layout";

describe("layoutFor", () => {
  it("uses the stylesheet's breakpoints", () => {
    expect(layoutFor(1440)).toBe("wide");
    expect(layoutFor(1181)).toBe("wide");
    expect(layoutFor(1180)).toBe("medium");
    expect(layoutFor(781)).toBe("medium");
    expect(layoutFor(780)).toBe("narrow");
  });
});

describe("clampWidths", () => {
  it("keeps the defaults on a wide screen", () => {
    expect(clampWidths(DEFAULT_WIDTHS, 1440, true)).toEqual(DEFAULT_WIDTHS);
  });

  it("keeps each column within its limits", () => {
    expect(clampWidths({ sidebar: 50, panel: 100 }, 1440, true)).toEqual({ sidebar: LIMITS.sidebar[0], panel: LIMITS.panel[0] });
    expect(clampWidths({ sidebar: 999, panel: 440 }, 1920, true).sidebar).toBe(LIMITS.sidebar[1]);
  });

  it("leaves the chat its minimum width beside the panel", () => {
    const w = clampWidths({ sidebar: 300, panel: 2000 }, 1440, true);
    expect(w).toEqual({ sidebar: 300, panel: 1440 - 300 - CHAT_MIN });
  });

  it("settles the sidebar first, reserving the panel's minimum", () => {
    const w = clampWidths({ sidebar: 420, panel: 800 }, 1200, true);
    expect(w.sidebar).toBe(1200 - CHAT_MIN - LIMITS.panel[0]);
    expect(w.panel).toBe(LIMITS.panel[0]);
  });

  it("lets the floating panel cover most of the chat on medium screens", () => {
    expect(clampWidths({ sidebar: 264, panel: 2000 }, 1000, true).panel).toBe(1000 - 48);
  });

  it("keeps the chat's minimum beside the sidebar on medium screens", () => {
    expect(clampWidths({ sidebar: 420, panel: 500 }, 800, true)).toEqual({ sidebar: 800 - CHAT_MIN, panel: 500 });
  });
});

describe("parseWidths", () => {
  it("keeps only numbers within the limits", () => {
    expect(parseWidths('{"sidebar":300,"panel":600}')).toEqual({ sidebar: 300, panel: 600 });
    expect(parseWidths('{"sidebar":10,"panel":"600","extra":1}')).toEqual({});
    expect(parseWidths('{"panel":612.4}')).toEqual({ panel: 612 });
  });

  it("ignores missing or broken values", () => {
    expect(parseWidths(null)).toEqual({});
    expect(parseWidths("not json")).toEqual({});
    expect(parseWidths("[1,2]")).toEqual({});
  });
});
