import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OpencodeBackend } from "../src/agents/opencode/index.js";
import { OcRunner, type OcRunTurnOptions, type OcTurnResult } from "../src/agents/opencode/runner.js";
import { demoRepo, makeForeman, rmrf, tempDir, until } from "./helpers.js";

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) rmrf(d);
});

describe("OpencodeBackend orchestration", () => {
  it("runs full lifecycle: planning -> work -> review -> merge", async () => {
    const home = tempDir();
    const repoPath = await demoRepo();
    cleanup.push(home, path.dirname(repoPath));

    const h = makeForeman(home, ["--backend", "opencode", "--repo", repoPath]);

    let createdTaskId = "";

    class MockOcRunner extends OcRunner {
      override async runTurn(opts: OcRunTurnOptions): Promise<OcTurnResult> {
        const { agentId, role, prompt, streamMapper } = opts;

        const sid = `ses-${agentId}-1`;
        const text = (t: string) =>
          streamMapper.handleEvent({ type: "text", sessionID: sid, part: { type: "text", text: t } } as never);
        const finish = (ok: boolean, response: string) =>
          streamMapper.handleEvent({
            type: ok ? "step_finish" : "error",
            sessionID: sid,
            ...(ok
              ? { part: { type: "step-finish", reason: "stop", num_turns: 1 } }
              : { error: { type: "turn.failed", message: response } }),
          } as never);

        if (role === "lead" && prompt.includes("New goal from")) {
          // Lead planning
          await backend.executeTool(agentId, role, "write_memory", {
            title: "Plan: Add version flag",
            body: "# Plan\n1. Add version\n",
            scope: "shared",
          });

          const createRes = await backend.executeTool(agentId, role, "create_task", {
            title: "Add --version flag",
            description: "support --version argument",
            assignee: "kit",
          });

          const match = /Created (t\d+)/.exec(createRes.text);
          createdTaskId = match?.[1] ?? "t1";
          text("Planned successfully.");
          finish(true, "ok");
        } else if (role === "worker" && prompt.includes("Your task:")) {
          // Worker implementing task
          const cliFile = path.join(opts.cwd, "src", "cli.ts");
          const fs = await import("node:fs");
          if (fs.existsSync(cliFile)) {
            const original = fs.readFileSync(cliFile, "utf8");
            fs.writeFileSync(
              cliFile,
              original.replace("case 'help':", "case '--version':\n        return 0;\n      case 'help':"),
            );
          }

          streamMapper.handleEvent({
            type: "tool_use",
            sessionID: sid,
            part: { type: "tool", tool: "shell", state: { status: "completed", input: { command: "npm test" }, output: "ok" } },
          } as never);

          await backend.executeTool(agentId, role, "update_task", {
            task_id: createdTaskId,
            status: "review",
            summary: "Added --version flag and passed tests.",
          });
          text("Implemented and updated task to review.");
          finish(true, "ok");
        } else if (role === "lead" && prompt.includes("Review request")) {
          // Lead reviewing task
          await backend.executeTool(agentId, role, "request_merge", {
            task_id: createdTaskId,
            summary: "Code and tests look great.",
          });
          text("Review complete, merge requested.");
          finish(true, "ok");
        } else {
          text("OK");
          finish(true, "ok");
        }

        return {
          sessionId: streamMapper.stats.sessionId,
          isError: false,
          resultText: streamMapper.stats.resultText,
          stats: streamMapper.stats,
        };
      }
    }

    const mockRunner = new MockOcRunner();
    const backend = new OpencodeBackend(h.fm, h.cfg.opencode, {
      runner: mockRunner,
      skipAuthCheck: true,
      retryDelaysMs: [20, 20],
    });

    await h.fm.start(backend);

    // 1. Submit goal
    const goal = await h.fm.submitGoal("Add a --version flag to the CLI");
    expect(goal.status).toBe("planning");

    // 2. Wait for planning to finish and tasks to appear
    await until(() => h.fm.tasks.list().length > 0, 5000);
    expect(createdTaskId).toBeTruthy();
    expect(h.fm.goal(goal.id)?.status).toBe("active");

    // 3. Wait for worker to pick up task and move it to review
    await until(() => {
      const t = h.fm.tasks.get(createdTaskId);
      return t?.status === "review";
    }, 8000);

    // 4. Wait for merge decision to be opened by Marlow
    await until(() => {
      const d = h.fm.decisions.open().find((x) => x.kind === "merge" && x.taskId === createdTaskId);
      return !!d;
    }, 8000);

    const mergeDecision = h.fm.decisions.open().find((x) => x.kind === "merge" && x.taskId === createdTaskId)!;
    expect(mergeDecision).toBeDefined();

    // 5. User approves merge
    await h.fm.answerDecision(mergeDecision.id, "Merge");

    // 6. Wait for task to become done
    await until(() => {
      const t = h.fm.tasks.get(createdTaskId);
      return t?.status === "done";
    }, 5000);

    const finishedTask = h.fm.tasks.get(createdTaskId)!;
    expect(finishedTask.status).toBe("done");

    await backend.stop();
    await h.fm.close();
  });

  it("retries transient failures and surfaces the session", async () => {
    const home = tempDir();
    const repoPath = await demoRepo();
    cleanup.push(home, path.dirname(repoPath));

    const h = makeForeman(home, ["--backend", "opencode", "--repo", repoPath]);
    let createdTaskId = "";
    let workAttempts = 0;

    class FlakyOcRunner extends OcRunner {
      override async runTurn(opts: OcRunTurnOptions): Promise<OcTurnResult> {
        const { agentId, role, prompt, streamMapper } = opts;
        const sid = `ses-${agentId}-1`;
        if (role === "lead" && prompt.includes("New goal from")) {
          const createRes = await backend.executeTool(agentId, role, "create_task", {
            title: "Flaky oc task",
            description: "fails once, then lands",
            assignee: "kit",
          });
          const match = /Created (t\d+)/.exec(createRes.text);
          createdTaskId = match?.[1] ?? "t1";
          streamMapper.handleEvent({ type: "text", sessionID: sid, part: { type: "text", text: "ok" } } as never);
        } else if (role === "worker" && prompt.includes("Your task:")) {
          workAttempts += 1;
          if (workAttempts === 1) {
            streamMapper.handleEvent({
              type: "error",
              sessionID: sid,
              error: { type: "provider.timeout", message: "request timed out" },
            } as never);
          } else {
            await backend.executeTool(agentId, role, "update_task", {
              task_id: createdTaskId,
              status: "review",
              summary: "Landed on retry.",
            });
            streamMapper.handleEvent({ type: "text", sessionID: sid, part: { type: "text", text: "ok" } } as never);
          }
        } else {
          streamMapper.handleEvent({ type: "text", sessionID: sid, part: { type: "text", text: "ok" } } as never);
        }
        return {
          sessionId: streamMapper.stats.sessionId,
          isError: streamMapper.stats.isError,
          resultText: streamMapper.stats.resultText,
          stats: streamMapper.stats,
        };
      }
    }

    const backend = new OpencodeBackend(h.fm, h.cfg.opencode, {
      runner: new FlakyOcRunner(),
      skipAuthCheck: true,
      retryDelaysMs: [30, 60],
    });
    await h.fm.start(backend);

    await h.fm.submitGoal("Survive one hiccup");
    await until(() => h.fm.tasks.list().length > 0, 5000);
    await until(() => h.fm.tasks.get(createdTaskId)?.status === "review", 8000);
    expect(workAttempts).toBe(2);
    expect(h.fm.store.data.sessions[`kit:${createdTaskId}`]?.sessionId).toMatch(/^ses-/);

    await backend.stop();
    await h.fm.close();
  });
});
