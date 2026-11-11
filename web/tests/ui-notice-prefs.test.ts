import { describe, expect, it } from "vitest";
import { buildProviders, hostedDataNotice } from "../src/ui/llm-providers";
import { DismissedNotices, parseDismissed, type NoticeStorage } from "../src/ui/notice-prefs";
import { json, MemoryStorage } from "./helpers";

const KEY = "curatune-web.dismissed-hosted-notices";
const config = {
  llmBaseUrl: "http://llm.test:1234/v1",
  llmModel: "local-model",
  hostedLlms: [{ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], name: "Gemini" }],
};

const throwing: NoticeStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("dismissed hosted notices", () => {
  it("remembers a dismissal for the next page load, and only the host", () => {
    const storage = new MemoryStorage();
    const [, flash] = buildProviders(config, async () => json({}));
    new DismissedNotices(storage).dismiss(flash!.host);
    expect([...storage.data.entries()]).toEqual([[KEY, JSON.stringify(["generativelanguage.googleapis.com"])]]);
    expect(new DismissedNotices(storage).isDismissed(flash!.host)).toBe(true);
  });

  it("is scoped per host: every model of the provider, not another provider or host", () => {
    const storage = new MemoryStorage();
    const [local, flash, lite] = buildProviders(config, async () => json({}));
    const notices = new DismissedNotices(storage);
    notices.dismiss(flash!.host);
    expect(notices.isDismissed(lite!.host)).toBe(true);
    expect(notices.isDismissed(local!.host)).toBe(false);
    const [, moved] = buildProviders({ ...config, hostedLlms: [{ ...config.hostedLlms[0]!, baseUrl: "https://other.example/v1" }] }, async () => json({}));
    expect(new DismissedNotices(storage).isDismissed(moved!.host)).toBe(false);
  });

  it("does not change the notice itself, which the API key form keeps showing", () => {
    const [, flash] = buildProviders(config, async () => json({}));
    new DismissedNotices(new MemoryStorage()).dismiss(flash!.host);
    expect(hostedDataNotice(flash!)).toContain("leave this computer and go to generativelanguage.googleapis.com");
  });

  it("keeps hosts dismissed in another tab", () => {
    const storage = new MemoryStorage();
    const first = new DismissedNotices(storage);
    new DismissedNotices(storage).dismiss("a.example");
    first.dismiss("b.example");
    expect(parseDismissed(storage.getItem(KEY)).sort()).toEqual(["a.example", "b.example"]);
  });

  it("works for the page when storage is missing or throws", () => {
    for (const storage of [null, throwing]) {
      const notices = new DismissedNotices(storage);
      expect(notices.isDismissed("a.example")).toBe(false);
      notices.dismiss("a.example");
      expect(notices.isDismissed("a.example")).toBe(true);
      expect(new DismissedNotices(storage).isDismissed("a.example")).toBe(false);
    }
  });

  it("ignores stored garbage", () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("not json")).toEqual([]);
    expect(parseDismissed('{"a.example":true}')).toEqual([]);
    expect(parseDismissed('["a.example", 3, "", null, "a.example"]')).toEqual(["a.example"]);
  });
});
