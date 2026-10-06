// Child-process runner for the OpenCode CLI (`opencode run`).
//
// One turn = one `opencode run --format json` child. The prompt goes over
// stdin (argv has length limits and prompts are big); NDJSON comes back on
// stdout. Sessions resume with `--session <id>`; the model pins with
// `--model provider/model[#variant]` and the agent with `--agent <name>`.
// Errors surface as `{"type":"error",...}` events (exit code stays 0), so
// turn failure is detected from the stream, not the exit code.
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { killTree } from "../../util/proc.js";
import type { OcStreamMapper, TurnStats } from "./stream.js";

export interface OcRunTurnOptions {
  agentId: string;
  role: "lead" | "worker";
  prompt: string;
  sessionKey?: string;
  cwd: string;
  signal?: AbortSignal;
  model?: string;
  agent?: string;
  ocBin?: string;
  streamMapper: OcStreamMapper;
  env?: NodeJS.ProcessEnv;
  onChildSpawned?: (child: ChildProcess) => void;
}

export interface OcTurnResult {
  sessionId?: string;
  isError: boolean;
  resultText?: string;
  numTurns?: number;
  stats: TurnStats;
}

export class OcRunner {
  constructor(private defaultBin = "opencode") {}

  async runTurn(opts: OcRunTurnOptions): Promise<OcTurnResult> {
    const bin = opts.ocBin || this.defaultBin;
    const args = ["run", "--format", "json", "--auto"];

    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.agent) {
      args.push("--agent", opts.agent);
    }
    if (opts.sessionKey) {
      args.push("--session", opts.sessionKey);
    }

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    opts.onChildSpawned?.(child);

    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      opts.streamMapper.handleLine(line);
    });

    try {
      child.stdin!.write(opts.prompt);
      child.stdin!.end();
    } catch {
      // child may have failed to spawn or crashed immediately
    }

    const abortHandler = () => {
      try {
        killTree(child);
      } catch {
        /* ignore */
      }
    };

    if (opts.signal?.aborted) {
      abortHandler();
    } else {
      opts.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    const { exitCode, signalCode } = await new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (exitCode, signalCode) => resolve({ exitCode, signalCode }));
      child.on("error", () => resolve({ exitCode: -1, signalCode: null }));
    });

    opts.signal?.removeEventListener("abort", abortHandler);

    const stats = opts.streamMapper.stats;
    const wasAborted = !!opts.signal?.aborted || signalCode !== null;
    // NOTE: opencode exits 0 even when the turn errors; the JSON error event rules.
    const spawnFailed = exitCode === -1 || (exitCode !== 0 && exitCode !== null && !stats.sessionId && stats.errors.length === 0);
    const isError = stats.isError || wasAborted || spawnFailed;

    if (isError && stderrBuffer.trim()) {
      stats.errors.push(stderrBuffer.trim());
    }

    return {
      sessionId: stats.sessionId,
      isError,
      resultText: stats.resultText,
      numTurns: stats.numTurns,
      stats,
    };
  }
}
