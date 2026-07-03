import { describe, it, expect } from "@jest/globals";
import { AgentSignal, parseAgentSignal } from "../../src/agents/base-agent.js";

describe("AgentSignal enum", () => {
  it("should have the correct string values", () => {
    expect(AgentSignal.SLICE_DONE).toBe("SLICE_DONE");
    expect(AgentSignal.BROWSER_TEST_PASS).toBe("BROWSER_TEST_PASS");
    expect(AgentSignal.REVIEW_PASS).toBe("REVIEW_PASS");
    expect(AgentSignal.ERROR).toBe("ERROR");
  });
});

describe("parseAgentSignal", () => {
  it("should return SLICE_DONE when output contains SLICE_DONE", () => {
    const output = "All tasks complete. SLICE_DONE\nSummary: ...";
    expect(parseAgentSignal(output)).toBe(AgentSignal.SLICE_DONE);
  });

  it("should return BROWSER_TEST_PASS when output contains BROWSER_TEST_PASS", () => {
    const output = "Running browser tests... BROWSER_TEST_PASS\nAll passed.";
    expect(parseAgentSignal(output)).toBe(AgentSignal.BROWSER_TEST_PASS);
  });

  it("should return REVIEW_PASS when output contains REVIEW_PASS", () => {
    const output = "Code review completed. REVIEW_PASS";
    expect(parseAgentSignal(output)).toBe(AgentSignal.REVIEW_PASS);
  });

  it("should return ERROR when output does not match any signal", () => {
    const output = "Something went wrong during execution.";
    expect(parseAgentSignal(output)).toBe(AgentSignal.ERROR);
  });

  it("should return ERROR for empty output", () => {
    expect(parseAgentSignal("")).toBe(AgentSignal.ERROR);
  });

  it("should prefer SLICE_DONE over other signals when multiple are present", () => {
    const output = "REVIEW_PASS BROWSER_TEST_PASS SLICE_DONE";
    expect(parseAgentSignal(output)).toBe(AgentSignal.SLICE_DONE);
  });

  it("should prefer BROWSER_TEST_PASS over REVIEW_PASS when both are present", () => {
    const output = "REVIEW_PASS and BROWSER_TEST_PASS";
    expect(parseAgentSignal(output)).toBe(AgentSignal.BROWSER_TEST_PASS);
  });

  it("should return REVIEW_PASS when only REVIEW_PASS is present among signals", () => {
    const output = "All reviews done. REVIEW_PASS confirmed.";
    expect(parseAgentSignal(output)).toBe(AgentSignal.REVIEW_PASS);
  });

  it("should handle output with only whitespace", () => {
    expect(parseAgentSignal("   \n\t  ")).toBe(AgentSignal.ERROR);
  });
});
