import { describe, expect, it } from "vitest";
import { addLabel, stepStatus } from "../src/ui/step-status";

const failure = (code: string) => ({ outcome: { ok: false as const, error: { code, message: "m" } }, summary: `${code}: m` });

describe("chat step status", () => {
  it("shows the tool's summary when it worked", () => {
    expect(stepStatus({ outcome: { ok: true, result: {} }, summary: "added 2" })).toEqual({ kind: "ok", text: "added 2" });
  });

  it("shows the user's Cancel as cancelled, not as a failure", () => {
    expect(stepStatus(failure("USER_DECLINED"))).toEqual({ kind: "cancelled", text: "cancelled by you" });
  });

  it("names the error code of a failure, so a rejected call can be told apart", () => {
    expect(stepStatus(failure("INVALID_ARGUMENT"))).toEqual({ kind: "failed", text: "failed (INVALID_ARGUMENT)" });
  });

  it("does not say tracks were added before the user confirmed or after they cancelled", () => {
    expect(addLabel(1, "pending")).toBe("Adding 1 track");
    expect(addLabel(3, "ok")).toBe("Added 3 tracks");
    expect(addLabel(3, "cancelled")).toBe("Did not add 3 tracks");
    expect(addLabel(3, "failed")).toBe("Did not add 3 tracks");
    expect(addLabel(null, "pending")).toBe("Adding tracks");
  });
});