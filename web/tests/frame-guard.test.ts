import { describe, expect, it } from "vitest";
import { isFramed } from "../src/ui/frame-guard";

describe("isFramed", () => {
  it("is false for the top-level window", () => {
    const win: { top: unknown; self: unknown } = { top: null, self: null };
    win.top = win;
    win.self = win;
    expect(isFramed(win)).toBe(false);
  });

  it("is true when top is another window", () => {
    const self = {};
    expect(isFramed({ top: {}, self })).toBe(true);
  });

  it("treats a SecurityError reading top as framed", () => {
    const win = {
      self: {},
      get top(): unknown {
        throw new DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
      },
    };
    expect(isFramed(win)).toBe(true);
  });

  it("treats any other error reading top as framed", () => {
    const win = {
      self: {},
      get top(): unknown {
        throw new TypeError("top is unavailable");
      },
    };
    expect(isFramed(win)).toBe(true);
  });
});
