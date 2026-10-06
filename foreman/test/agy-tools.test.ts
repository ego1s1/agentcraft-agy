import { describe, expect, it, vi } from "vitest";
import { executeTool } from "../src/agents/antigravity/tools.js";

describe("executeTool for Antigravity backend", () => {
  it("executes report_status", async () => {
    const fm = {
      bus: { inbox: vi.fn().mockReturnValue([]) },
      setAgent: vi.fn(),
      agentLog: vi.fn(),
    } as any;

    const res = await executeTool(
      fm,
      "kit",
      "worker",
      "report_status",
      { activity: "running unit tests" },
      {} as any,
    );

    expect(res.text).toBe("ok");
    expect(fm.setAgent).toHaveBeenCalledWith("kit", { activity: "running unit tests" });
  });

  it("executes send_message", async () => {
    const fm = {
      bus: {
        inbox: vi.fn().mockReturnValue([]),
        send: vi.fn(),
      },
      resolveAgentId: vi.fn().mockReturnValue("wren"),
      nameOf: vi.fn().mockReturnValue("Wren"),
      agents: vi.fn().mockReturnValue([{ id: "kit", active: true }, { id: "wren", active: true }]),
      agent: vi.fn().mockReturnValue({ taskId: "t1" }),
    } as any;

    const res = await executeTool(
      fm,
      "kit",
      "worker",
      "send_message",
      { to: "wren", text: "Ready to test." },
      {} as any,
    );

    expect(res.text).toBe("Sent to wren.");
    expect(fm.bus.send).toHaveBeenCalledWith("kit", "wren", "Ready to test.");
  });

  it("executes update_task for worker", async () => {
    const task = {
      id: "AC-1",
      assignee: "kit",
      status: "doing",
    };
    const fm = {
      bus: {
        inbox: vi.fn().mockReturnValue([]),
        feed: vi.fn(),
      },
      tasks: {
        get: vi.fn().mockReturnValue(task),
        update: vi.fn(),
        setStatus: vi.fn().mockImplementation((id, status) => {
          task.status = status;
        }),
      },
      agent: vi.fn().mockReturnValue({ taskId: "AC-1" }),
      nameOf: vi.fn().mockReturnValue("Kit"),
    } as any;

    const hooks = {
      onReview: vi.fn(),
      onChangesRequested: vi.fn(),
      onTasksChanged: vi.fn(),
    } as any;

    const res = await executeTool(
      fm,
      "kit",
      "worker",
      "update_task",
      { task_id: "AC-1", status: "review", summary: "Added feature" },
      hooks,
    );

    expect(res.text).toContain("Updated AC-1: review");
    expect(hooks.onReview).toHaveBeenCalledWith("kit", "AC-1");
    expect(hooks.onTasksChanged).toHaveBeenCalled();
  });

  it("prevents workers from creating tasks or requesting merges", async () => {
    const fm = {
      bus: { inbox: vi.fn().mockReturnValue([]) },
    } as any;

    const resCreate = await executeTool(
      fm,
      "kit",
      "worker",
      "create_task",
      { title: "Task" },
      {} as any,
    );
    expect(resCreate.text).toContain("only the lead can create tasks");

    const resMerge = await executeTool(
      fm,
      "kit",
      "worker",
      "request_merge",
      { task_id: "AC-1", summary: "done" },
      {} as any,
    );
    expect(resMerge.text).toContain("only the lead can request merges");
  });
});
