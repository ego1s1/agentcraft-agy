import { describe, expect, it, vi } from "vitest";
import { AgyStreamMapper, type AgyEvent } from "../src/agents/antigravity/stream.js";

describe("AgyStreamMapper", () => {
  it("tracks session id from init event", () => {
    const fm = {
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agent: vi.fn(),
      setAgent: vi.fn(),
      agentLog: vi.fn(),
    } as any;

    const mapper = new AgyStreamMapper(fm, "marlow", "/repo", "lead");
    mapper.handleLine(JSON.stringify({
      event: "init",
      conversation_id: "conv-1234",
      init: { model: "gemini-3.8-flash-high" }
    }));

    expect(mapper.stats.sessionId).toBe("conv-1234");
    expect(fm.log.debug).toHaveBeenCalledWith(expect.stringContaining("conv-1234"));
  });

  it("handles agent response text deltas and done state", () => {
    const fm = {
      log: { debug: vi.fn() },
      agent: vi.fn().mockReturnValue({ state: "thinking" }),
      setAgent: vi.fn(),
      agentLog: vi.fn(),
    } as any;

    const mapper = new AgyStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Inspecting codebase..."
      }
    }));

    expect(fm.setAgent).toHaveBeenCalledWith("kit", {
      state: "thinking",
      activity: "Inspecting codebase..."
    });

    mapper.handleLine(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      }
    }));

    expect(fm.agentLog).toHaveBeenCalledWith("kit", "text", "Inspecting codebase...");
    expect(mapper.stats.tokens?.total).toBe(120);
  });

  it("handles tool invocation and completion", () => {
    const fm = {
      log: { debug: vi.fn() },
      agent: vi.fn().mockReturnValue({ repoId: "r1" }),
      setAgent: vi.fn(),
      agentLog: vi.fn(),
      repos: { scheduleRefresh: vi.fn() }
    } as any;

    const mapper = new AgyStreamMapper(fm, "kit", "/repo", "worker");
    mapper.handleLine(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: {
          name: "view_file",
          parameters: { absolute_path: "/repo/src/main.ts" }
        }
      }
    }));

    expect(fm.agentLog).toHaveBeenCalledWith("kit", "tool", "Read src/main.ts");
    expect(fm.setAgent).toHaveBeenCalledWith("kit", {
      state: "reading",
      station: "library",
      activity: "reading src/main.ts"
    });

    mapper.handleLine(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "view_file",
        tool_info: {
          name: "view_file",
          output: "line 1\nline 2\nline 3"
        }
      }
    }));

    expect(fm.agentLog).toHaveBeenCalledWith("kit", "result", "3 lines");
  });

  it("handles final result event", () => {
    const fm = {
      log: { debug: vi.fn() },
      agentLog: vi.fn()
    } as any;

    const mapper = new AgyStreamMapper(fm, "marlow", "/repo", "lead");
    mapper.handleLine(JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-1234",
        status: "SUCCESS",
        response: "All planned out.",
        num_turns: 3,
        usage: { total_tokens: 500 }
      }
    }));

    expect(mapper.stats.isError).toBe(false);
    expect(mapper.stats.numTurns).toBe(3);
    expect(mapper.stats.resultText).toBe("All planned out.");
    expect(fm.agentLog).toHaveBeenCalledWith("marlow", "result", "turn complete (3 steps)");
  });
});
