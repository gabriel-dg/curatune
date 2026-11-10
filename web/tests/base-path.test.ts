import { describe, expect, it } from "vitest";
import { normalizeBasePath } from "../config/base";
import { loadConfig } from "../src/config";
import { callbackPath } from "../src/spotify/auth";

describe("normalizeBasePath", () => {
  it("defaults to the root", () => {
    expect(normalizeBasePath(undefined)).toBe("/");
    expect(normalizeBasePath("")).toBe("/");
    expect(normalizeBasePath("  ")).toBe("/");
    expect(normalizeBasePath("/")).toBe("/");
  });

  it("makes the path start and end with a slash", () => {
    for (const value of ["curatune", "/curatune", "curatune/", "/curatune/", " /curatune/ ", "//curatune//"]) {
      expect(normalizeBasePath(value)).toBe("/curatune/");
    }
    expect(normalizeBasePath("a/b")).toBe("/a/b/");
  });

  it("rejects relative bases and URLs", () => {
    for (const value of ["./", "../x", "/a/../b", "https://curatune.github.io/", "C:/x", "\\x"]) {
      expect(() => normalizeBasePath(value), value).toThrow(/VITE_BASE_PATH/);
    }
  });
});

describe("callbackPath", () => {
  it("appends callback to the base", () => {
    expect(callbackPath("/")).toBe("/callback");
    expect(callbackPath("/curatune/")).toBe("/curatune/callback");
    expect(callbackPath("/curatune")).toBe("/curatune/callback");
  });
});

describe("loadConfig redirect URI", () => {
  const config = (origin: string, base?: string) =>
    loadConfig((base === undefined ? {} : { BASE_URL: base }) as unknown as ImportMetaEnv, origin);

  it("is unchanged in development", () => {
    expect(config("http://127.0.0.1:5173", "/").redirectUri).toBe("http://127.0.0.1:5173/callback");
    expect(config("http://127.0.0.1:5173").redirectUri).toBe("http://127.0.0.1:5173/callback");
  });

  it("follows the base path", () => {
    expect(config("https://curatune.github.io", "/").redirectUri).toBe("https://curatune.github.io/callback");
    expect(config("https://curatune.github.io", "/curatune/").redirectUri).toBe(
      "https://curatune.github.io/curatune/callback",
    );
  });
});
