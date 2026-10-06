// Map Antigravity (agy stream-json) events -> agent.log entries + agent state/station.
import type { Foreman } from "../../foreman.js";
import { firstLine, headLines, tailLines, truncate } from "../../util/text.js";
import { relPath, toolActivity } from "../activity.js";

export interface TurnStats {
  sessionId?: string;
  resultText?: string;
  isError: boolean;
  numTurns?: number;
  errors: string[];
  tokens?: {
    input?: number;
    output?: number;
    thinking?: number;
    total?: number;
  };
}

export interface AgyEvent {
  event: string;
  conversation_id?: string;
  init?: {
    model?: string;
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: "ACTIVE" | "DONE";
    step_type?: "user_input" | "agent_response" | "tool" | "system_message";
    text_delta?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: Record<string, unknown>;
      output?: unknown;
    };
    duration_seconds?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      total_tokens?: number;
    };
  };
  result?: {
    conversation_id?: string;
    status?: "SUCCESS" | "ERROR" | string;
    response?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      total_tokens?: number;
    };
  };
}

/** Short human summary of a tool result for the monitor. */
function summarizeResult(tool: string, text: string): string {
  const name = tool.startsWith("mcp__") ? tool.split("__").pop()! : tool;
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  switch (name) {
    case "Read":
    case "view_file":
      return `${lines.length} lines`;
    case "Grep":
    case "grep_search":
    case "Glob":
    case "LS":
    case "find_by_name":
    case "list_dir":
      return lines.length ? `${lines.length} results\n${headLines(lines.join("\n"), 4, 400)}` : "no matches";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "write_to_file":
      return firstLine(text, 160) || "ok";
    case "Bash":
    case "PowerShell":
    case "run_command":
      return tailLines(text, 8, 900) || "(no output)";
    default:
      return headLines(text, 4, 500) || "ok";
  }
}

/** -/+ lines from an Edit/Write tool input, for a diff log entry. */
function diffFromInput(tool: string, input: Record<string, unknown>, cwd: string): string | undefined {
  const file =
    (typeof input.file_path === "string" ? relPath(input.file_path, cwd) : undefined) ??
    (typeof input.target_file === "string" ? relPath(input.target_file, cwd) : undefined) ??
    (typeof input.path === "string" ? relPath(input.path, cwd) : undefined) ??
    "?";
  const clip = (s: string, n: number) => s.replace(/\r\n/g, "\n").split("\n").slice(0, n);

  if (tool === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    const out = [file, ...clip(input.old_string, 6).map((l) => `- ${l}`), ...clip(input.new_string, 8).map((l) => `+ ${l}`)];
    return out.join("\n");
  }

  if (tool === "replace_file_content" && typeof input.code_content === "string") {
    const lines = input.code_content.split("\n");
    return [`${file} (${lines.length} lines)`, ...clip(input.code_content, 8).map((l) => `+ ${l}`)].join("\n");
  }

  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    const out = [file];
    for (const e of (input.edits as Array<{ old_string?: string; new_string?: string }>).slice(0, 3)) {
      out.push(...clip(e.old_string ?? "", 3).map((l) => `- ${l}`), ...clip(e.new_string ?? "", 4).map((l) => `+ ${l}`));
    }
    return out.join("\n");
  }

  if ((tool === "Write" || tool === "write_to_file") && typeof (input.content ?? input.code_content) === "string") {
    const strContent = String(input.content ?? input.code_content);
    const all = strContent.split("\n");
    return [`${file} (${all.length} lines)`, ...clip(strContent, 10).map((l) => `+ ${l}`)].join("\n");
  }

  return undefined;
}

export class AgyStreamMapper {
  readonly stats: TurnStats = { isError: false, errors: [] };
  private activeResponseText = "";

  constructor(
    private fm: Foreman,
    private agentId: string,
    private cwd: string,
    private role: "lead" | "worker",
  ) {}

  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const evt = JSON.parse(trimmed) as AgyEvent;
      this.handleEvent(evt);
    } catch {
      // Non-JSON line or debug output
      this.fm.log.debug(`${this.agentId}: raw output: ${trimmed}`);
    }
  }

  handleEvent(evt: AgyEvent): void {
    const fm = this.fm;
    const id = this.agentId;

    switch (evt.event) {
      case "init": {
        if (evt.conversation_id) {
          this.stats.sessionId = evt.conversation_id;
          fm.log.debug(`${id}: conversation ${evt.conversation_id} (${evt.init?.model ?? "?"})`);
        }
        break;
      }

      case "step_update": {
        const su = evt.step_update;
        if (!su) break;
        if (su.conversation_id && !this.stats.sessionId) {
          this.stats.sessionId = su.conversation_id;
        }

        if (su.step_type === "agent_response") {
          if (su.state === "ACTIVE") {
            if (su.text_delta) {
              this.activeResponseText += su.text_delta;
              const a = fm.agent(id);
              if (a && a.state !== "waiting_user") {
                fm.setAgent(id, { state: "thinking", activity: firstLine(this.activeResponseText, 48) });
              }
            }
          } else if (su.state === "DONE") {
            if (this.activeResponseText.trim()) {
              fm.agentLog(id, "text", truncate(this.activeResponseText.trim(), 1200));
              this.activeResponseText = "";
            }
            if (su.usage) {
              this.stats.tokens = {
                input: su.usage.input_tokens,
                output: su.usage.output_tokens,
                thinking: su.usage.thinking_tokens,
                total: su.usage.total_tokens,
              };
            }
          }
        } else if (su.step_type === "tool") {
          const name = su.tool_name ?? su.tool_info?.name ?? "?";
          const params = (su.tool_info?.parameters ?? {}) as Record<string, unknown>;

          if (su.state === "ACTIVE") {
            const act = toolActivity(name, params, this.cwd);
            fm.agentLog(id, "tool", act.label);
            const diff = diffFromInput(name, params, this.cwd);
            if (diff) fm.agentLog(id, "diff", diff);
            fm.setAgent(id, { state: act.state, station: act.station, activity: act.activity });
            if ((act.state === "editing" || act.state === "running" || act.state === "testing") && this.role === "worker") {
              const repoId = fm.agent(id)?.repoId;
              if (repoId) fm.repos.scheduleRefresh(repoId, 1500);
            }
          } else if (su.state === "DONE") {
            const out =
              typeof su.tool_info?.output === "string"
                ? su.tool_info.output
                : JSON.stringify(su.tool_info?.output ?? "");
            fm.agentLog(id, "result", summarizeResult(name, out));
          }
        }
        break;
      }

      case "result": {
        const res = evt.result;
        if (!res) break;
        this.stats.sessionId ??= res.conversation_id;
        this.stats.isError = res.status !== "SUCCESS";
        this.stats.numTurns = res.num_turns;
        this.stats.resultText = res.response;
        if (res.usage) {
          this.stats.tokens = {
            input: res.usage.input_tokens,
            output: res.usage.output_tokens,
            thinking: res.usage.thinking_tokens,
            total: res.usage.total_tokens,
          };
        }
        if (res.status !== "SUCCESS" && res.response) {
          this.stats.errors.push(res.response);
        }
        fm.agentLog(
          id,
          this.stats.isError ? "error" : "result",
          `turn ${res.status === "SUCCESS" ? "complete" : `ended: ${res.status}`} (${res.num_turns ?? 1} steps)`,
        );
        break;
      }
    }
  }
}
