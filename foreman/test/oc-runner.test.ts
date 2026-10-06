import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OcRunner } from "../src/agents/opencode/runner.js";
import type { OcStreamMapper } from "../src/agents/opencode/stream.js";

const FIXTURE = path.resolve(__dirname, "fixtures/mock-oc.mjs");

describe("OcRunner", () => {
  it("spawns command, pipes prompt over stdin, and processes stream lines", async () => {
    const streamMapper: OcStreamMapper = {
      handleLine: vi.fn(),
      stats: {
        sessionId: "ses-test-123",
        isError: false,
        errors: [],
        resultText: "Done!",
        numTurns: 1,
      },
    } as any;

    const runner = new OcRunner();

    const res = await runner.runTurn({
      agentId: "kit",
      role: "worker",
      prompt: "Hello world",
      cwd: process.cwd(),
      ocBin: FIXTURE,
      model: "test-model",
      streamMapper,
    });

    expect(streamMapper.handleLine).toHaveBeenCalled();
    expect(res.sessionId).toBe("ses-test-123");
    expect(res.isError).toBe(false);
  });

  it("detects turn errors from JSON events even though exit code is 0", async () => {
    const { OcStreamMapper } = await import("../src/agents/opencode/stream.js");
    const fm = {
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agent: vi.fn().mockReturnValue({ state: "thinking", id: "kit" }),
      setAgent: vi.fn(),
      agentLog: vi.fn(),
      repos: { scheduleRefresh: vi.fn() },
    } as any;
    const streamMapper = new OcStreamMapper(fm, "kit", process.cwd(), "worker");

    const runner = new OcRunner();
    const res = await runner.runTurn({
      agentId: "kit",
      role: "worker",
      prompt: "fail please",
      cwd: process.cwd(),
      ocBin: FIXTURE,
      streamMapper,
      env: { ...process.env, MOCK_OC_ERROR: "1" },
    });

    // mock-oc exits 0 with only an error event: classification must come from JSON.
    expect(res.isError).toBe(true);
    expect(res.stats.errors.join(";")).toMatch(/Model unavailable/);
  });

  it("handles abort signal by killing process", async () => {
    const streamMapper: OcStreamMapper = {
      handleLine: vi.fn(),
      stats: { isError: false, errors: [] },
    } as any;

    const runner = new OcRunner();
    const ac = new AbortController();

    const turnPromise = runner.runTurn({
      agentId: "kit",
      role: "worker",
      prompt: "Sleep test",
      cwd: process.cwd(),
      ocBin: FIXTURE,
      signal: ac.signal,
      streamMapper,
      env: { ...process.env, MOCK_OC_HANG: "1" },
    });

    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    const res = await turnPromise;
    expect(res.isError).toBe(true);
  });
});
