import { describe, expect, it } from "@jest/globals";
import { notifyProgress } from "../../src/core/progress";

describe("progress reporting", () => {
  it("does not let a reporter failure change workflow outcomes", () => {
    expect(() =>
      notifyProgress(() => {
        throw new Error("reporter unavailable");
      }, "Working..."),
    ).not.toThrow();
  });
});
