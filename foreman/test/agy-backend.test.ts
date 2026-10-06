import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AntigravityBackend } from "../src/agents/antigravity/index.js";
import { AgyRunner, type RunTurnOptions, type TurnResult } from "../src/agents/antigravity/runner.js";
import { demoRepo, makeForeman, rmrf, tempDir, until } from "./helpers.js";

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) rmrf(d);
});

describe("AntigravityBackend orchestration", () => {
  it("runs full lifecycle: planning -> work -> review -> merge", async () => {
    const home = tempDir();
    const repoPath = await demoRepo();
    cleanup.push(home, path.dirname(repoPath));

    const h = makeForeman(home, ["--backend", "antigravity", "--repo", repoPath]);

    let createdTaskId = "";

    class MockAgyRunner extends AgyRunner {
      override async runTurn(opts: RunTurnOptions): Promise<TurnResult> {
        const { agentId, role, prompt, streamMapper } = opts;

        streamMapper.handleEvent({
          event: "init",
          conversation_id: `conv-${agentId}-1`,
        });

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
          createdTaskId = match ? match[1] : "t1";

          streamMapper.handleEvent({
            event: "result",
            result: {
              conversation_id: `conv-${agentId}-1`,
              status: "SUCCESS",
              response: "Planned successfully.",
              num_turns: 2,
            },
          });
        } else if (role === "worker" && prompt.includes("Your task:")) {
          // Worker implementing task
          const cliFile = path.join(opts.cwd, "src", "cli.ts");
          if (fs.existsSync(cliFile)) {
            const original = fs.readFileSync(cliFile, "utf8");
            fs.writeFileSync(
              cliFile,
              original.replace("case 'help':", "case '--version':\n        return 0;\n      case 'help':"),
            );
          }

          streamMapper.handleEvent({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: {
                name: "run_command",
                parameters: { CommandLine: "npm test" },
              },
            },
          });

          await backend.executeTool(agentId, role, "update_task", {
            task_id: createdTaskId,
            status: "review",
            summary: "Added --version flag and passed tests.",
          });

          streamMapper.handleEvent({
            event: "result",
            result: {
              conversation_id: `conv-${agentId}-1`,
              status: "SUCCESS",
              response: "Implemented and updated task to review.",
              num_turns: 3,
            },
          });
        } else if (role === "lead" && prompt.includes("Review request")) {
          // Lead reviewing task
          await backend.executeTool(agentId, role, "request_merge", {
            task_id: createdTaskId,
            summary: "Code and tests look great.",
          });

          streamMapper.handleEvent({
            event: "result",
            result: {
              conversation_id: `conv-${agentId}-1`,
              status: "SUCCESS",
              response: "Review complete, merge requested.",
              num_turns: 1,
            },
          });
        } else {
          streamMapper.handleEvent({
            event: "result",
            result: {
              conversation_id: `conv-${agentId}-1`,
              status: "SUCCESS",
              response: "OK",
              num_turns: 1,
            },
          });
        }

        return {
          sessionId: streamMapper.stats.sessionId,
          isError: false,
          resultText: streamMapper.stats.resultText,
          stats: streamMapper.stats,
        };
      }
    }

    const mockRunner = new MockAgyRunner();
    const backend = new AntigravityBackend(h.fm, h.cfg.antigravity, {
      runner: mockRunner,
      skipAuthCheck: true,
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

  it("handles agent pause and resume actions", async () => {
    const home = tempDir();
    const repoPath = await demoRepo();
    cleanup.push(home, path.dirname(repoPath));

    const h = makeForeman(home, ["--backend", "antigravity", "--repo", repoPath]);

    const backend = new AntigravityBackend(h.fm, h.cfg.antigravity, {
      skipAuthCheck: true,
    });

    await h.fm.start(backend);

    expect(h.fm.agent("kit")?.active).toBe(true);

    // Pause kit
    await backend.onAgentAction("kit", "pause");
    expect(h.fm.agent("kit")?.activity).toBe("paused");

    // Resume kit
    await backend.onAgentAction("kit", "resume");
    expect(h.fm.agent("kit")?.activity).toBe("ready");

    // Stop kit
    await backend.onAgentAction("kit", "stop");
    expect(h.fm.agent("kit")?.active).toBe(false);
    expect(h.fm.agent("kit")?.activity).toBe("stopped - off shift");

    await backend.stop();
    await h.fm.close();
  });
});
