// Tool execution logic for Antigravity backend (used by HTTP API, CLI and MCP bridge).
import { formatInbox } from "../../bus.js";
import type { Foreman } from "../../foreman.js";
import type { AgentState, TaskStatus } from "../../protocol.js";
import { MERGE_OPTIONS } from "../../protocol.js";
import { isPrBranch } from "../../pulls.js";
import { truncate } from "../../util/text.js";
import { boardSummary } from "../claude/prompts.js";
import { closeIfNoChanges, type ToolHooks, type TurnHandle } from "../claude/tools.js";
import { userName } from "../../user.js";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export async function executeTool(
  fm: Foreman,
  agentId: string,
  role: "lead" | "worker",
  toolName: string,
  input: Record<string, unknown>,
  hooks: ToolHooks,
  turn?: TurnHandle,
): Promise<ToolResult> {
  const withInbox = (text: string, isError = false): ToolResult => {
    const inbox = fm.bus.inbox(agentId, { markRead: true });
    const extra = inbox.length ? `\n\n[New messages]\n${formatInbox(inbox, (id) => fm.nameOf(id))}` : "";
    return { text: text + extra, ...(isError ? { isError: true } : {}) };
  };
  const fail = (text: string): ToolResult => withInbox(`Error: ${text}`, true);

  if (turn?.signal.aborted) {
    return fail("your turn was stopped; nothing was changed");
  }

  // normalize tool name
  const name = toolName.startsWith("mcp__") ? toolName.split("__").pop()! : toolName.replace(/^agentcraft[:_]/, "");

  switch (name) {
    case "send_message": {
      const to = String(input.to ?? "");
      const text = String(input.text ?? "");
      let target = to.trim().toLowerCase();
      if (target === "lead") target = "marlow";
      if (!["all", "user"].includes(target)) {
        const id = fm.resolveAgentId(target);
        if (!id) return fail(`no teammate "${to}". Team: ${fm.agents().filter((a) => a.active).map((a) => a.id).join(", ")}`);
        target = id;
      }
      if (target === agentId) return fail("you cannot message yourself");
      fm.bus.send(agentId, target, text);
      if (role === "lead" && !["all", "user"].includes(target) && !fm.agent(target)?.taskId) {
        return withInbox(
          `Sent to ${target}, but ${fm.nameOf(target)} is not on a task, so they will only read it when their next task starts. ` +
            `To have ${fm.nameOf(target)} do something now, create a task for it with create_task (assignee "${target}").`,
        );
      }
      return withInbox(`Sent to ${target}.`);
    }

    case "ask_user": {
      const question = String(input.question ?? "");
      const rawOptions = Array.isArray(input.options) ? (input.options as string[]) : [];
      const context = typeof input.context === "string" ? input.context : undefined;

      const prev = fm.agent(agentId);
      const home = role === "lead" ? "meeting" : "desk";
      const waiting = prev?.state === "waiting_user" || prev?.station === "user";
      const prevState = {
        state: waiting ? "thinking" : (prev?.state ?? "thinking"),
        station: waiting ? home : (prev?.station ?? home),
        activity: prev?.activity ?? "",
      };

      const d = fm.createDecision({
        agentId,
        kind: "question",
        question,
        options: rawOptions,
        ...(context ? { context } : {}),
        ...(prev?.taskId ? { taskId: prev.taskId } : {}),
      });

      fm.setAgent(agentId, { state: "waiting_user", station: "user", activity: "waiting for your answer" });
      hooks.onWaiting(agentId, true);

      const onAbort = () => {
        if (turn?.reason() !== "shutdown") fm.decisions.cancel(d.id, `${fm.nameOf(agentId)}'s turn was stopped`);
      };
      if (turn?.signal.aborted) onAbort();
      else turn?.signal.addEventListener("abort", onAbort, { once: true });

      const done = await fm.decisions.wait(d.id);
      turn?.signal.removeEventListener("abort", onAbort);
      hooks.onWaiting(agentId, false);

      if (turn?.signal.aborted) return withInbox(`Your turn was stopped before ${userName()} answered.`, true);
      fm.setAgent(agentId, { state: prevState.state as AgentState, station: prevState.station, activity: "got your answer" });
      if (done.status === "cancelled") return withInbox("The question was cancelled. Use your best judgement and note the assumption.");
      const ans = [done.answer?.option, done.answer?.text].filter(Boolean).join(" — ");
      return withInbox(`${userName()} answered: ${ans}`);
    }

    case "write_memory": {
      const title = String(input.title ?? "");
      const body = String(input.body ?? "");
      const scope = input.scope === "private" ? "private" : "shared";
      const mode = input.mode === "append" ? "append" : "replace";
      const e = fm.memory.write({
        scope: scope === "private" ? agentId : "shared",
        title,
        body,
        author: agentId,
        mode,
      });
      fm.bus.feed("memory", `${fm.nameOf(agentId)} wrote memory: ${e.title}`, { agentId });
      return withInbox(`Saved memory ${e.id}.`);
    }

    case "read_memory": {
      const id = typeof input.id === "string" ? input.id : undefined;
      const query = typeof input.query === "string" ? input.query : undefined;
      if (id) {
        const e = fm.memory.get(id) ?? fm.memory.get(`shared/${id}`) ?? fm.memory.get(`${agentId}/${id}`);
        if (!e || (e.scope !== "shared" && e.scope !== agentId)) return fail(`no memory ${id}`);
        return withInbox(`# ${e.title} (${e.id})\n\n${e.body}`);
      }
      const list = query ? fm.memory.search(query, agentId) : fm.memory.visibleTo(agentId);
      if (!list.length) return withInbox("No memory notes.");
      if (query && list.length <= 3) {
        return withInbox(list.map((e) => `# ${e.title} (${e.id})\n\n${truncate(e.body, 3000)}`).join("\n\n---\n\n"));
      }
      return withInbox(list.map((e) => `- ${e.id}: ${e.title}`).join("\n"));
    }

    case "update_task": {
      const taskId = String(input.task_id ?? "");
      const t = fm.tasks.get(taskId);
      if (!t) return fail(`no task ${taskId}. ${boardSummary(fm)}`);

      const status = typeof input.status === "string" ? input.status : undefined;
      const summary = typeof input.summary === "string" ? input.summary : undefined;
      const blocked_reason = typeof input.blocked_reason === "string" ? input.blocked_reason : undefined;
      const assignee = typeof input.assignee === "string" ? input.assignee : undefined;
      const title = typeof input.title === "string" ? input.title : undefined;
      const description = typeof input.description === "string" ? input.description : undefined;

      if (role === "worker") {
        const current = fm.agent(agentId)?.taskId;
        if (t.assignee !== agentId) return fail(`${t.id} is not your task`);
        if (current && t.id !== current) {
          return fail(`you are working on ${current}; you can only update that task. Tell Marlow (send_message to "lead") if ${t.id} is already covered.`);
        }
        if (status && !["review", "blocked", "doing"].includes(status)) {
          return fail("workers can set status review, blocked or doing");
        }
        if (assignee || title || description) return fail("only the lead can change assignee/title/description");
      }

      try {
        if (assignee) {
          const id = fm.resolveAgentId(assignee);
          if (!id) return fail(`no agent ${assignee}`);
          fm.tasks.update(t.id, { assignee: id });
        }
        if (title) fm.tasks.update(t.id, { title });
        if (description) fm.tasks.update(t.id, { description });
        if (summary) fm.tasks.update(t.id, { summary });

        if (status && status !== t.status) {
          const prev = t.status;
          fm.tasks.setStatus(t.id, status as TaskStatus, {
            force: role === "lead" || status === "review",
            ...(blocked_reason ? { reason: blocked_reason } : {}),
            ...(summary ? { summary } : {}),
          });
          fm.bus.feed("task", `${fm.nameOf(agentId)}: ${t.id} ${prev} -> ${status}`, { agentId });
          if (status === "review" && role === "worker") hooks.onReview(agentId, t.id);
          if (status === "doing" && prev === "review" && role === "lead") {
            hooks.onChangesRequested(t.id, summary ?? "see review comments");
          }
        }
        hooks.onTasksChanged();
        return withInbox(`Updated ${t.id}: ${fm.tasks.get(t.id)!.status}.`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    case "report_status": {
      const activity = String(input.activity ?? "");
      const note = typeof input.note === "string" ? input.note : undefined;
      fm.setAgent(agentId, { activity });
      if (note) fm.agentLog(agentId, "text", note);
      return withInbox("ok");
    }

    case "list_tasks": {
      const goalId = typeof input.goal_id === "string" ? input.goal_id : undefined;
      return withInbox(boardSummary(fm, goalId));
    }

    case "create_task": {
      if (role !== "lead") return fail("only the lead can create tasks");
      const title = String(input.title ?? "");
      const description = String(input.description ?? "");
      const deps = Array.isArray(input.deps) ? (input.deps as string[]) : [];
      const assignee = typeof input.assignee === "string" ? input.assignee : undefined;
      const priority = typeof input.priority === "number" ? input.priority : undefined;
      const start_branch = typeof input.start_branch === "string" ? input.start_branch : undefined;

      const goal = fm.currentGoal();
      if (start_branch && !isPrBranch(start_branch)) {
        return fail(`start_branch must be a fetched pull request branch (agentcraft/pr-<n>), not ${start_branch}`);
      }
      let who: string | undefined;
      if (assignee) {
        who = fm.resolveAgentId(assignee);
        if (!who) return fail(`no worker ${assignee}`);
        if (fm.agent(who)?.role === "lead") return fail("assign tasks to workers, not yourself");
      }
      try {
        const t = fm.tasks.create({
          title,
          description,
          deps,
          ...(who ? { assignee: who } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(start_branch ? { startBranch: start_branch } : {}),
          createdBy: agentId,
          ...(goal ? { goalId: goal.id } : {}),
          ...(goal?.repoId ? { repoId: goal.repoId } : {}),
        });
        fm.bus.feed("task", `Marlow created ${t.id}: ${t.title}`, { agentId });
        hooks.onTasksChanged();
        return withInbox(`Created ${t.id}.`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    case "request_merge": {
      if (role !== "lead") return fail("only the lead can request merges");
      const task_id = String(input.task_id ?? "");
      const summary = String(input.summary ?? "");
      const t = fm.tasks.get(task_id);
      if (!t) return fail(`no task ${task_id}`);
      if (t.status !== "review") return fail(`${t.id} is ${t.status}, not in review`);
      if (!t.worktree || !t.repoId) return fail(`${t.id} has no worktree to merge`);

      const open = fm.decisions.open().find((d) => d.kind === "merge" && d.taskId === t.id);
      if (open) return withInbox(`Merge decision ${open.id} for ${t.id} is already waiting for ${userName()}.`);
      if (await closeIfNoChanges(fm, t.id)) {
        hooks.onTasksChanged();
        return withInbox(`${t.id} changed no files, so there is nothing to merge: it is closed as done. Tell ${userName()} the result with send_message if you have not yet.`);
      }

      const wt = fm.repos.requireWorktree(t.repoId, t.worktree);
      const d = fm.createDecision({
        agentId,
        kind: "merge",
        question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
        options: [...MERGE_OPTIONS],
        context: `${summary}\n${wt.files} files, +${wt.additions} -${wt.deletions} | tests: ${t.ci}`,
        taskId: t.id,
        repoId: t.repoId,
        worktree: wt.id,
      });
      hooks.onMergeRequested(t.id, d);
      return withInbox(`Merge decision ${d.id} sent to ${userName()}.`);
    }

    default:
      return fail(`unknown tool: ${toolName}`);
  }
}
