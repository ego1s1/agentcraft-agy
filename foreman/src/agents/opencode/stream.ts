// Map opencode (`opencode run --format json`) NDJSON events -> agent.log entries + agent state/station.
//
// Observed event shapes (opencode CLI):
//   {"type":"step_start","sessionID":...,"part":{"type":"step-start",...}}
//   {"type":"text","sessionID":...,"part":{"type":"text","text":...}}
//   {"type":"tool_use","sessionID":...,"part":{"type":"tool","tool":...,"state":{"status","input","output","title"}}}
//   {"type":"step_finish","sessionID":...,"part":{"type":"step-finish","reason","cost","tokens":{...}}}
//   {"type":"error","sessionID":...,"error":{"type","message"}}
// The turn ends when the child exits; errors surface as events (exit code stays 0).
import type { Foreman } from "../../foreman.js";
import { firstLine, truncate } from "../../util/text.js";
import { toolActivity } from "../activity.js";
import type { TurnStats } from "../antigravity/stream.js";

export type { TurnStats };

export interface OcEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  session_id?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    title?: string;
    reason?: string;
    cost?: number;
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
    state?: { status?: string; input?: Record<string, unknown>; output?: unknown; title?: string };
  };
  error?: { type?: string; message?: string };
}

export class OcStreamMapper {
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
    let evt: OcEvent;
    try {
      evt = JSON.parse(trimmed) as OcEvent;
    } catch {
      this.fm.log.debug(`${this.agentId}: raw output: ${trimmed.slice(0, 200)}`);
      return;
    }
    this.handleEvent(evt);
  }

  handleEvent(evt: OcEvent): void {
    const fm = this.fm;
    const id = this.agentId;

    const sessionId = evt.sessionID ?? evt.session_id;
    if (sessionId) this.stats.sessionId ??= sessionId;

    switch (evt.type) {
      case "step_start":
        this.activeResponseText = "";
        this.stats.numTurns = (this.stats.numTurns ?? 0) + 1;
        break;

      case "text": {
        const text = evt.part?.text ?? "";
        if (text) {
          fm.agentLog(id, "text", truncate(text, 1200));
          const a = fm.agent(id);
          if (a && a.state !== "waiting_user") {
            fm.setAgent(id, { state: "thinking", activity: firstLine(text, 48) });
          }
          this.stats.resultText = (this.stats.resultText ? `${this.stats.resultText}\n` : "") + text;
        }
        break;
      }

      case "tool_use": {
        const part = evt.part;
        const name = part?.tool ?? "?";
        const params = (part?.state?.input ?? {}) as Record<string, unknown>;
        const act = toolActivity(name, params, this.cwd);
        fm.agentLog(id, "tool", act.label);
        fm.setAgent(id, { state: act.state, station: act.station, activity: act.activity });
        if ((act.state === "editing" || act.state === "running" || act.state === "testing") && this.role === "worker") {
          const repoId = fm.agent(id)?.repoId;
          if (repoId) fm.repos.scheduleRefresh(repoId, 1500);
        }
        const out = part?.state?.output;
        const outText = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
        if (outText) fm.agentLog(id, "result", truncate(firstLine(outText, 500), 900));
        const status = part?.state?.status;
        if (status && status !== "completed") {
          this.stats.errors.push(`tool ${name} ${status}: ${truncate(outText || part?.title || "failed", 200)}`);
        }
        break;
      }

      case "step_finish": {
        const tokens = evt.part?.tokens;
        if (tokens) {
          this.stats.tokens = {
            input: tokens.input,
            output: tokens.output,
            thinking: tokens.reasoning,
            total: (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0),
          };
        }
        const reason = evt.part?.reason;
        if (reason && reason !== "stop" && reason !== "tool-calls") {
          this.stats.errors.push(`step ended: ${reason}`);
          this.stats.isError = true;
        }
        break;
      }

      case "error": {
        const message = evt.error?.message ?? "unknown opencode error";
        this.stats.errors.push(`${evt.error?.type ? `${evt.error.type}: ` : ""}${message}`);
        this.stats.isError = true;
        fm.agentLog(id, "error", `turn ended: ERROR (${truncate(message, 200)})`);
        break;
      }
    }
  }
}
