import { describe, expect, it } from "vitest";
import { buildCsp, llmOrigin } from "../config/csp";

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values];
    }),
  );
}

describe("buildCsp", () => {
  it("allows only own scripts and styles, and connections to Spotify", () => {
    const csp = directives(buildCsp());
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["style-src"]).toEqual(["'self'"]);
    expect(csp["connect-src"]).toEqual(["'self'", "https://accounts.spotify.com", "https://api.spotify.com"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toBeUndefined();
  });

  it("never allows inline or eval, nor wildcards outside the cover image CDNs", () => {
    const policy = buildCsp({ llmBaseUrl: "http://llm.test:1234/v1", header: true });
    expect(policy).not.toMatch(/unsafe-|data:|blob:/);
    const { "img-src": _images, ...rest } = directives(policy);
    expect(Object.values(rest).flat().join(" ")).not.toMatch(/\*/);
  });

  it("allows images only from the page and Spotify's image CDNs", () => {
    expect(directives(buildCsp())["img-src"]).toEqual(["'self'", "https://*.scdn.co", "https://*.spotifycdn.com"]);
  });

  it("adds the LLM origin to connect-src only", () => {
    const csp = directives(buildCsp({ llmBaseUrl: "http://llm.test:1234/v1" }));
    expect(csp["connect-src"]).toContain("http://llm.test:1234");
    expect(csp["script-src"]).toEqual(["'self'"]);
  });

  it("adds frame-ancestors when sent as a header", () => {
    expect(directives(buildCsp({ header: true }))["frame-ancestors"]).toEqual(["'none'"]);
  });
});

describe("llmOrigin", () => {
  it("reduces the base URL to its origin", () => {
    expect(llmOrigin("https://llm.test/v1/")).toBe("https://llm.test");
    expect(llmOrigin("")).toBeNull();
    expect(llmOrigin(undefined)).toBeNull();
  });

  it("rejects invalid values", () => {
    expect(() => llmOrigin("not a url")).toThrow();
    expect(() => llmOrigin("ftp://llm.test")).toThrow();
    expect(() => llmOrigin("http://llm.test; script-src *")).toThrow();
  });
});
