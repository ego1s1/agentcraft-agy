// Child-process runner for Antigravity CLI (`agy`).
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { killTree } from "../../util/proc.js";
import type { AgyStreamMapper, TurnStats } from "./stream.js";

export interface RunTurnOptions {
  agentId: string;
  role: "lead" | "worker";
  prompt: string;
  sessionKey?: string;
  cwd: string;
  signal?: AbortSignal;
  model?: string;
  effort?: string;
  maxTurns?: number;
  agyBin?: string;
  streamMapper: AgyStreamMapper;
  env?: NodeJS.ProcessEnv;
  onChildSpawned?: (child: ChildProcess) => void;
}

export interface TurnResult {
  sessionId?: string;
  isError: boolean;
  resultText?: string;
  numTurns?: number;
  stats: TurnStats;
}

export class AgyRunner {
  constructor(private defaultBin = "agy") {}

  async runTurn(opts: RunTurnOptions): Promise<TurnResult> {
    const bin = opts.agyBin || this.defaultBin;
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions"];

    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.effort) {
      args.push("--effort", opts.effort);
    }
    if (opts.sessionKey) {
      args.push("--conversation", opts.sessionKey);
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

    const userMessage = {
      event: "user",
      message: {
        content: [{ type: "text", text: opts.prompt }],
      },
    };

    try {
      child.stdin!.write(JSON.stringify(userMessage) + "\n");
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
    const isError = stats.isError || wasAborted || (exitCode !== 0 && exitCode !== null);

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
