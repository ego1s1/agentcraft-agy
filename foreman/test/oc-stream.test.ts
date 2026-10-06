import { describe, expect, it, vi } from "vitest";
import { OcStreamMapper } from "../src/agents/opencode/stream.js";

function mockFm(agentState = "thinking") {
  return {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agent: vi.fn().mockReturnValue({ state: agentState, id: "kit" }),
    setAgent: vi.fn(),
    agentLog: vi.fn(),
    repos: { scheduleRefresh: vi.fn() },
  } as any;
}

describe("OcStreamMapper", () => {
  it("tracks session id and counts turns from step_start", () => {
    const fm = mockFm();
    const mapper = new OcStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine(JSON.stringify({ type: "step_start", sessionID: "ses-1", part: { type: "step-start" } }));
    mapper.handleLine(JSON.stringify({ type: "step_start", sessionID: "ses-1", part: { type: "step-start" } }));

    expect(mapper.stats.sessionId).toBe("ses-1");
    expect(mapper.stats.numTurns).toBe(2);
  });

  it("logs text and accumulates resultText", () => {
    const fm = mockFm();
    const mapper = new OcStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine(JSON.stringify({ type: "text", sessionID: "ses-1", part: { type: "text", text: "hello" } }));

    expect(fm.agentLog).toHaveBeenCalledWith("kit", "text", "hello");
    expect(fm.setAgent).toHaveBeenCalledWith("kit", expect.objectContaining({ state: "thinking" }));
    expect(mapper.stats.resultText).toBe("hello");
  });

  it("maps tool_use to activity and records tool failures", () => {
    const fm = mockFm();
    const mapper = new OcStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses-1",
        part: { type: "tool", tool: "shell", state: { status: "completed", input: { command: "npm test" }, output: "ok" } },
      }),
    );

    expect(fm.agentLog).toHaveBeenCalledWith("kit", "tool", expect.stringContaining("npm test"));
    expect(fm.setAgent).toHaveBeenCalledWith("kit", expect.objectContaining({ state: "testing" }));
    expect(mapper.stats.isError).toBe(false);

    mapper.handleLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses-1",
        part: { type: "tool", tool: "shell", state: { status: "error", input: { command: "npm test" }, output: "boom" } },
      }),
    );
    expect(mapper.stats.errors.length).toBeGreaterThan(0);
  });

  it("collects tokens from step_finish and flags abnormal endings", () => {
    const fm = mockFm();
    const mapper = new OcStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses-1",
        part: { type: "step-finish", reason: "stop", tokens: { input: 10, output: 5, reasoning: 2 } },
      }),
    );

    expect(mapper.stats.tokens).toMatchObject({ input: 10, output: 5, thinking: 2 });
    expect(mapper.stats.isError).toBe(false);

    mapper.handleLine(
      JSON.stringify({ type: "step_finish", sessionID: "ses-1", part: { type: "step-finish", reason: "aborted" } }),
    );
    expect(mapper.stats.isError).toBe(true);
  });

  it("handles error events", () => {
    const fm = mockFm();
    const mapper = new OcStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine(
      JSON.stringify({ type: "error", sessionID: "ses-1", error: { type: "provider.no-route", message: "Model unavailable" } }),
    );

    expect(mapper.stats.isError).toBe(true);
    expect(mapper.stats.errors.join(";")).toMatch(/Model unavailable/);
    expect(fm.agentLog).toHaveBeenCalledWith("kit", "error", expect.stringContaining("Model unavailable"));
  });

  it("ignores blank lines and invalid JSON", () => {
    const fm = mockFm();
    const mapper = new OcStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine("");
    mapper.handleLine("not json {");
    expect(mapper.stats.isError).toBe(false);
    expect(fm.log.debug).toHaveBeenCalled();
  });
});
