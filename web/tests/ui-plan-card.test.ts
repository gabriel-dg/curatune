import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the plan card", () => {
  it("shows the model's reason under a label saying the app did not check it", () => {
    const card = readFileSync(new URL("../src/ui/plan-card.ts", import.meta.url), "utf-8");
    expect(card).toContain('export const REASON_LABEL = "The assistant\'s explanation (written by the AI, not checked by the app):";');
    // The reason is rendered after the label, as text, and never on its own.
    expect(card).toMatch(/plan\.reason\s*\?\s*h\("div", \{ class: "plan-reason" \}, \[h\("div", \{ class: "plan-reason-label[^"]*", text: REASON_LABEL \}\), h\("div", \{ text: `“\$\{plan\.reason\}”` \}\)\]\)/);
    expect(card).not.toContain('h("div", { class: "plan-reason", text: plan.reason })');
  });
});
