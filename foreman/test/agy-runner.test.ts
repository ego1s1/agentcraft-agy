import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgyRunner } from "../src/agents/antigravity/runner.js";
import type { AgyStreamMapper } from "../src/agents/antigravity/stream.js";

const FIXTURE = path.resolve(__dirname, "fixtures/mock-agy.mjs");

describe("AgyRunner", () => {
  it("spawns command, pipes prompt, and processes stream lines", async () => {
    const streamMapper: AgyStreamMapper = {
      handleLine: vi.fn(),
      stats: {
        sessionId: "test-conv-123",
        isError: false,
        errors: [],
        resultText: "Done!",
        numTurns: 1,
      },
    } as any;

    const runner = new AgyRunner();

    const res = await runner.runTurn({
      agentId: "kit",
      role: "worker",
      prompt: "Hello world",
      cwd: process.cwd(),
      agyBin: FIXTURE,
      model: "test-model",
      streamMapper,
    });

    expect(streamMapper.handleLine).toHaveBeenCalled();
    expect(res.sessionId).toBe("test-conv-123");
    expect(res.isError).toBe(false);
  });

  it("handles abort signal by killing process", async () => {
    const streamMapper: AgyStreamMapper = {
      handleLine: vi.fn(),
      stats: {
        isError: false,
        errors: [],
      },
    } as any;

    const runner = new AgyRunner();
    const ac = new AbortController();

    const turnPromise = runner.runTurn({
      agentId: "kit",
      role: "worker",
      prompt: "Sleep test",
      cwd: process.cwd(),
      agyBin: FIXTURE,
      signal: ac.signal,
      streamMapper,
      env: {
        ...process.env,
        MOCK_AGY_HANG: "1",
      },
    });

    // Abort shortly after
    setTimeout(() => ac.abort(), 100);

    const res = await turnPromise;
    expect(res.isError).toBe(true);
  });
});
