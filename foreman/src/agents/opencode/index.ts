// OpenCode CLI backend: runs lead (Marlow) and workers as `opencode run` child processes with JSON events.
import { spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpencodeConfig } from '../../config.js';
import { ClientError, type Backend, type Foreman } from '../../foreman.js';
import { withGitSafety } from '../../gitsafety.js';
import { agentGitIdentity } from '../../util/git.js';
import type { Decision, Goal, Task } from '../../protocol.js';
import { MERGE_OPTIONS } from '../../protocol.js';
import type { TestResult } from '../../repos.js';
import { renderDiffText } from '../../diff.js';
import { formatInbox } from '../../bus.js';
import { killTree, processTable, type ProcEntry } from '../../util/proc.js';
import { truncate } from '../../util/text.js';
import { leadSystemPrompt, planPrompt, RESUME_PROMPT, reviewPrompt, workerSystemPrompt, workPrompt } from '../claude/prompts.js';
import { fetchPulls, githubOrigin, pullBriefs, type PullRequest } from '../../pulls.js';
import { OcStreamMapper, type TurnStats } from './stream.js';
import { OcRunner } from './runner.js';
import { isTransientError, TRANSIENT_RETRY_DELAYS_MS, transientRetryDelayMs } from '../antigravity/transient.js';
import { executeTool } from '../antigravity/tools.js';
import { ocModelWithEffort } from '../../presets.js';
import { type ToolHooks, type TurnHandle } from '../claude/tools.js';
import { userName } from '../../user.js';

const LEAD = 'marlow';
const TURN_TIMEOUT_MS = 20 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type JobKind = 'plan' | 'work' | 'review' | 'followup';
type AbortReason = 'pause' | 'stop' | 'shutdown' | 'cancel' | 'timeout';

interface Job {
  kind: JobKind;
  agentId: string;
  prompt: string;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  fresh?: boolean;
  nudges?: number;
  resumed?: boolean;
  /** transient-error retries already spent on this job */
  transientRetries?: number;
}

interface Inflight {
  kind: JobKind;
  sessionKey: string;
  taskId?: string;
  goalId?: string;
  startedAt: number;
}

interface OpencodeState {
  inflight: Record<string, Inflight>;
  ciFixes: Record<string, number>;
  stopped: string[];
}

interface Running {
  abort: AbortController;
  job: Job;
  reason?: AbortReason;
  child?: ChildProcess;
  done?: Promise<void>;
  spawnedAt?: number;
  tree?: Promise<ProcEntry[] | undefined>;
  reaping?: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alive(child: ChildProcess | undefined): child is ChildProcess {
  return !!child && child.exitCode === null && child.signalCode === null;
}

function descendantsOf(table: ProcEntry[], rootPid: number): ProcEntry[] {
  const byParent = new Map<number, ProcEntry[]>();
  for (const e of table) {
    const list = byParent.get(e.ppid) ?? [];
    list.push(e);
    byParent.set(e.ppid, list);
  }
  const out: ProcEntry[] = [];
  const walk = (pid: number) => {
    for (const child of byParent.get(pid) ?? []) {
      out.push(child);
      walk(child.pid);
    }
  };
  walk(rootPid);
  return out;
}

function orphansOf(table: ProcEntry[], rootPid: number, spawnedAfterMs: number): ProcEntry[] {
  const byPid = new Map<number, ProcEntry>(table.map((e) => [e.pid, e]));
  const out: ProcEntry[] = [];
  for (const e of table) {
    if (e.createdMs && e.createdMs < spawnedAfterMs) continue;
    let p = e.ppid;
    const seen = new Set<number>();
    while (p && !seen.has(p)) {
      seen.add(p);
      if (p === rootPid) {
        out.push(e);
        break;
      }
      p = byPid.get(p)?.ppid ?? 0;
    }
  }
  return out;
}

async function killSnapshot(targets: ProcEntry[], currentTable: ProcEntry[]): Promise<number[]> {
  const current = new Map<number, ProcEntry>(currentTable.map((e) => [e.pid, e]));
  const killed: number[] = [];
  for (const t of targets) {
    const live = current.get(t.pid);
    if (!live) continue;
    if (t.created && live.created && t.created !== live.created) continue;
    try {
      process.kill(t.pid, 'SIGKILL');
      killed.push(t.pid);
    } catch {
      /* ignore */
    }
  }
  return killed;
}

function prRefs(text: string): number[] {
  const matches = text.match(/(?:^|\s)#(\d+)\b/g);
  if (!matches) return [];
  const nums = matches.map((m) => parseInt(m.trim().slice(1), 10));
  return [...new Set(nums)];
}

export interface OpencodeBackendOptions {
  runner?: OcRunner;
  skipAuthCheck?: boolean;
  /** backoff between transient-error retries (attempt 0, 1, 2, ...); default TRANSIENT_RETRY_DELAYS_MS */
  retryDelaysMs?: readonly number[];
}

export class OpencodeBackend implements Backend {
  readonly name = 'opencode' as const;
  private queues = new Map<string, Job[]>();
  private running = new Map<string, Running>();
  private pausedJobs = new Map<string, Job>();
  private tickTimer: NodeJS.Timeout | undefined;
  private authFailed = false;
  private stopping = false;
  private waitingUser = new Set<string>();
  private hooks: ToolHooks;
  private turnPromises = new Set<Promise<void>>();
  private reviewing = new Set<string>();
  private lastTurn = new Map<string, Running>();
  private handoffs = new Map<string, Promise<void>>();
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelayMs = 2000;
  private readonly runner: OcRunner;

  constructor(
    private fm: Foreman,
    private cfg: OpencodeConfig,
    private opts: OpencodeBackendOptions = {},
  ) {
    this.runner = opts.runner ?? new OcRunner(cfg.ocBin ?? 'opencode');
    this.hooks = {
      onReview: () => {
        /* handled after the worker's turn ends */
      },
      onChangesRequested: (taskId, feedback) =>
        this.sendBackToWorker(taskId, `Marlow reviewed your work on ${taskId} and asks for changes:\n${feedback}\n\nMake the changes, re-run the tests, then update_task("${taskId}", status "review", summary).`),
      onTasksChanged: () => this.tick(),
      onMergeRequested: (taskId) => this.fm.log.info(`merge decision opened for ${taskId}`),
      onWaiting: (agentId, waiting) => {
        if (waiting) this.waitingUser.add(agentId);
        else this.waitingUser.delete(agentId);
      },
    };
  }

  private get st(): OpencodeState {
    const b = this.fm.store.data.backend as Record<string, unknown>;
    let s = b.opencode as OpencodeState | undefined;
    if (!s) {
      s = { inflight: {}, ciFixes: {}, stopped: [] };
      b.opencode = s;
    }
    s.inflight ??= {};
    s.ciFixes ??= {};
    s.stopped ??= [];
    return s;
  }

  get team(): string[] {
    return this.cfg.workers.filter((w) => this.fm.agent(w));
  }

  private isStopped(agentId: string): boolean {
    return this.st.stopped.includes(agentId);
  }

  private setStopped(agentId: string, stopped: boolean): void {
    const s = this.st;
    s.stopped = s.stopped.filter((x) => x !== agentId);
    if (stopped) s.stopped.push(agentId);
    this.fm.store.markDirty();
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  async start(): Promise<void> {
    for (const a of this.fm.agents()) {
      const onTeam = (a.id === LEAD || this.team.includes(a.id)) && !this.isStopped(a.id);
      this.fm.setAgent(a.id, { active: onTeam });
      if (!onTeam) this.fm.setAgent(a.id, { state: 'idle', station: 'lounge', activity: this.isStopped(a.id) ? 'stopped - off shift' : 'off shift' });
      else if (a.activity === 'off shift' || a.activity.startsWith('stopped')) this.fm.setAgent(a.id, { activity: 'ready' });
    }

    await this.checkAuth();
    if (!this.cfg.resumeOnStart) {
      this.st.inflight = {};
    } else {
      this.recover();
    }

    for (const id of [LEAD, ...this.team]) this.deliverPending(id);
    void this.fm.repos.sweepPendingRemovals().catch((e) => this.fm.log.debug(`sweep: ${(e as Error).message}`));
    this.tick();
  }

  async checkAuth(): Promise<boolean> {
    if (this.opts.skipAuthCheck) {
      this.fm.setStatus({ auth: 'ok', message: `OpenCode (lead ${this.cfg.leadModel}, workers ${this.cfg.workerModel})` });
      return true;
    }
    const bin = this.cfg.ocBin ?? 'opencode';
    try {
      const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (res.status === 0 || res.stdout) {
        this.authFailed = false;
        const ver = (res.stdout || '').trim();
        this.fm.setStatus({ auth: 'ok', message: `OpenCode ${ver} (lead ${this.cfg.leadModel}, workers ${this.cfg.workerModel})` });
        this.fm.log.info(`opencode probe ok (${bin} ${ver})`);
        return true;
      }
      throw new Error(res.stderr || `exit code ${res.status}`);
    } catch (e) {
      const msg = `OpenCode CLI check failed (${bin}): ${(e as Error).message}. Verify that \`opencode\` is on PATH or pass --opencode-bin.`;
      this.authFailed = true;
      this.fm.setStatus({ auth: 'failed', message: msg });
      this.fm.log.error(msg);
      this.fm.bus.feed('error', msg);
      this.fm.notify('warn', msg);
      return false;
    }
  }

  private openQuestion(agentId: string): Decision | undefined {
    return this.fm.decisions.open().find((d) => d.kind === 'question' && d.agentId === agentId);
  }

  private hasQueued(agentId: string, pred: (j: Job) => boolean): boolean {
    const running = this.running.get(agentId);
    const paused = this.pausedJobs.get(agentId);
    return (this.queues.get(agentId) ?? []).some(pred) || (running ? pred(running.job) : false) || (paused ? pred(paused) : false);
  }

  private recover(): void {
    const st = this.st;
    for (const d of this.fm.decisions.open().filter((x) => x.kind === 'permission')) this.fm.decisions.cancel(d.id, 'Foreman restarted');
    for (const [agentId, inf] of Object.entries(st.inflight)) {
      if (this.isStopped(agentId) || !this.fm.agent(agentId)) {
        delete st.inflight[agentId];
        continue;
      }
      const openQ = this.openQuestion(agentId);
      if (openQ) {
        this.fm.log.info(`recover: ${agentId} is waiting on ${openQ.id}; will resume after answer`);
        this.fm.setAgent(agentId, { state: 'waiting_user', station: 'user', activity: 'waiting for your answer' });
        continue;
      }
      const session = this.fm.store.data.sessions[inf.sessionKey];
      if (session?.sessionId) {
        this.fm.log.info(`recover: resuming ${agentId} (${inf.kind}${inf.taskId ? ` ${inf.taskId}` : ''})`);
        this.enqueue({ kind: inf.kind, agentId, sessionKey: inf.sessionKey, prompt: RESUME_PROMPT, resumed: true, ...(inf.taskId ? { taskId: inf.taskId } : {}), ...(inf.goalId ? { goalId: inf.goalId } : {}) });
      } else {
        delete st.inflight[agentId];
      }
    }
    this.reconcile();
    this.fm.store.markDirty();
  }

  private reconcile(): void {
    const st = this.st;
    for (const g of this.fm.goals().filter((x) => x.status === 'planning')) {
      const leadOnIt = st.inflight[LEAD]?.goalId === g.id || this.hasQueued(LEAD, (j) => j.goalId === g.id) || this.openQuestion(LEAD) !== undefined;
      if (leadOnIt || this.isStopped(LEAD)) continue;
      if (this.fm.tasks.forGoal(g.id).length) this.promoteGoal(g, 'recovered');
      else {
        const repo = g.repoId ? this.fm.repos.get(g.repoId) : undefined;
        if (!repo) continue;
        this.fm.log.info(`recover: re-planning ${g.id}`);
        this.enqueue({ kind: 'plan', agentId: LEAD, goalId: g.id, sessionKey: `${LEAD}:${g.id}`, fresh: !this.fm.store.data.sessions[`${LEAD}:${g.id}`]?.sessionId, prompt: planPrompt(this.fm, g, repo.path, repo.branch) });
      }
    }
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'doing' || !t.assignee || t.assignee === LEAD) continue;
      const w = t.assignee;
      if (st.inflight[w]?.taskId === t.id || this.hasQueued(w, (j) => j.taskId === t.id)) continue;
      if (this.openQuestion(w)?.taskId === t.id) continue;
      this.fm.log.info(`recover: ${t.id} was doing without a running turn; re-queued`);
      this.fm.tasks.setStatus(t.id, 'todo', { force: true });
      if (this.isStopped(w)) this.fm.tasks.update(t.id, { assignee: null });
    }
    this.sweepReviews();
  }

  private sweepReviews(): void {
    const st = this.st;
    for (const t of this.fm.tasks.list()) {
      if (t.status !== 'review' || !t.worktree) continue;
      if (this.fm.decisions.open().some((d) => d.taskId === t.id)) continue;
      if (Object.values(st.inflight).some((i) => i.taskId === t.id)) continue;
      if (this.reviewing.has(t.id) || this.hasQueued(LEAD, (j) => j.taskId === t.id) || (t.assignee && this.hasQueued(t.assignee, (j) => j.taskId === t.id))) continue;
      void this.afterWorkerDone(t.id);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const turns = [...this.running.values()];
    for (const r of turns) this.abortTurn(r, 'shutdown');
    await Promise.race([Promise.allSettled([...this.turnPromises]), sleep(4000)]);
    await Promise.race([Promise.allSettled(turns.map((r) => this.reap(r, 1500))), sleep(3000)]);
    this.fm.store.markDirty();
  }

  private abortTurn(r: Running, reason: AbortReason): void {
    r.reason = reason;
    const pid = r.child?.pid;
    if (pid && alive(r.child) && !r.tree) r.tree = processTable().then((t) => (t ? descendantsOf(t, pid) : undefined)).catch(() => undefined);
    r.abort.abort();
  }

  private reap(r: Running, graceMs = 4000): Promise<void> {
    r.reaping ??= this.doReap(r, graceMs).catch((e) => this.fm.log.warn(`clean-up of ${r.job.agentId}'s turn: ${(e as Error).message}`));
    return r.reaping;
  }

  private async doReap(r: Running, graceMs: number): Promise<void> {
    const child = r.child;
    if (!child?.pid) return;
    if (alive(child)) {
      await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(graceMs)]);
      if (alive(child)) {
        killTree(child);
        await Promise.race([new Promise<void>((res) => child.once('exit', () => res())), sleep(2000)]);
      }
    }
    const snapshot = r.tree ? await r.tree : undefined;
    const table = await processTable();
    if (!table) return;
    const targets = new Map<number, ProcEntry>();
    for (const e of [...(snapshot ?? []), ...orphansOf(table, child.pid, r.spawnedAt ?? 0)]) targets.set(e.pid, e);
    const killed = (await killSnapshot([...targets.values()], table)) ?? [];
    if (killed.length) this.fm.log.info(`killed ${killed.length} leftover process(es) of ${r.job.agentId}'s stopped turn (pids ${killed.join(', ')})`);
  }

  private async quiesce(agentId: string, maxMs = 15_000): Promise<void> {
    const r = this.running.get(agentId) ?? this.lastTurn.get(agentId);
    if (!r) return;
    if (r.done) await Promise.race([r.done.catch(() => undefined), sleep(maxMs)]);
    await this.reap(r);
  }

  private handOff(taskId: string, fromAgent: string, why: string): void {
    if (this.handoffs.has(taskId)) return;
    const p = (async () => {
      try {
        await this.quiesce(fromAgent);
        const t = this.fm.tasks.get(taskId);
        const wt = t?.worktree && t.repoId ? this.fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
        if (t && wt && wt.agentId === fromAgent && wt.status === 'active') {
          await this.fm.repos.abandon(t.repoId!, wt.id, `agentcraft: ${t.id} work in progress (${why})`);
        }
      } catch (e) {
        this.fm.log.warn(`hand-off of ${taskId} from ${fromAgent}: ${(e as Error).message}`);
      } finally {
        this.handoffs.delete(taskId);
        this.tick();
      }
    })();
    this.handoffs.set(taskId, p);
  }

  private retryLater(): void {
    if (this.retryTimer || this.stopping) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(60_000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.tick();
    }, delay);
    this.retryTimer.unref?.();
  }

  private retryDelays(): readonly number[] {
    return this.opts.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  }

  /**
   * A turn died on a transient network error (WiFi drop, endpoint timeout):
   * re-run the same job after a backoff instead of blocking the task or
   * failing the goal. Returns true when a retry was scheduled.
   */
  private scheduleTransientRetry(job: Job, stats: TurnStats | undefined, what: string): boolean {
    const max = this.cfg.transientRetries ?? 3;
    const attempt = job.transientRetries ?? 0;
    const cause = stats?.errors.join('; ') ?? 'error';
    if (max <= 0 || attempt >= max || !isTransientError(cause)) return false;
    const delay = transientRetryDelayMs(attempt, this.retryDelays());
    const wait = delay >= 1000 ? `${Math.round(delay / 1000)}s` : `${delay}ms`;
    this.fm.setAgent(job.agentId, { state: 'running', station: 'terminal', activity: `${what}: net hiccup — retry ${attempt + 1}/${max} in ${wait}` });
    this.fm.agentLog(job.agentId, 'error', `transient error (${truncate(cause, 200)}), retry ${attempt + 1}/${max} in ${wait}`);
    this.fm.bus.feed('system', `${this.fm.nameOf(job.agentId)} hit a network hiccup on ${what} (${truncate(cause, 120)}); retrying in ${wait}`, { agentId: job.agentId });
    const timer = setTimeout(() => {
      if (this.stopping || this.isStopped(job.agentId)) return;
      this.enqueue({ ...job, fresh: false, transientRetries: attempt + 1 });
    }, delay);
    timer.unref?.();
    return true;
  }

  // ---- goals & scheduling -------------------------------------------------------------------

  async submitGoal(goal: Goal): Promise<void> {
    if (this.authFailed) {
      this.fm.setGoal(goal.id, { status: 'failed' });
      throw new ClientError(`OpenCode is not available: ${this.fm.status.message ?? 'auth failed'}`);
    }
    const repo = this.fm.repos.require(goal.repoId!);
    if (this.isStopped(LEAD)) {
      this.setStopped(LEAD, false);
      this.fm.bus.feed('system', 'Marlow is back on shift for the new goal', { agentId: LEAD });
    }
    for (const w of [LEAD, ...this.team]) if (!this.isStopped(w)) this.fm.setAgent(w, { active: true });
    this.fm.setAgent(LEAD, { state: 'thinking', station: 'meeting', activity: 'reading the goal', repoId: repo.id });
    const pulls = await this.intakePulls(goal, repo.path);
    this.enqueue({ kind: 'plan', agentId: LEAD, goalId: goal.id, sessionKey: `${LEAD}:${goal.id}`, fresh: true, prompt: planPrompt(this.fm, goal, repo.path, repo.branch, pulls) });
  }

  private async intakePulls(goal: Goal, repoPath: string): Promise<PullRequest[]> {
    const refs = prRefs(goal.text);
    if (!refs.length || !(await githubOrigin(repoPath))) return [];
    this.fm.setAgent(LEAD, { state: 'reading', station: 'library', activity: `fetching ${refs.length} pull request${refs.length === 1 ? '' : 's'}` });
    this.fm.bus.feed('system', `Fetching ${refs.length} pull request${refs.length === 1 ? '' : 's'} from GitHub`, { agentId: LEAD });
    const { pulls, errors } = await fetchPulls(repoPath, refs);
    for (const p of pulls) this.fm.bus.feed('task', `PR #${p.number} by @${p.author}: ${p.title}`, { agentId: LEAD });
    for (const e of errors) this.fm.bus.feed('error', `PR ${e}`, { agentId: LEAD });
    if (pulls.length) {
      this.fm.memory.write({ scope: 'shared', title: `Pull requests for ${goal.id}`, body: pullBriefs(pulls), author: LEAD, mode: 'replace' });
    }
    this.fm.setAgent(LEAD, { state: 'thinking', station: 'meeting', activity: 'reading the goal' });
    return pulls;
  }

  private promoteGoal(goal: Goal, why: string): void {
    if (goal.status !== 'planning') return;
    const n = this.fm.tasks.forGoal(goal.id).length;
    this.fm.setGoal(goal.id, { status: 'active' });
    this.fm.bus.feed('plan', `Marlow planned the goal into ${n} task${n === 1 ? '' : 's'}${why === 'recovered' ? ' (picked up after a restart)' : ''}`, { agentId: LEAD });
    this.tick();
  }

  tick(): void {
    if (this.tickTimer || this.stopping) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = undefined;
      this.schedule().catch((e) => {
        this.fm.log.error(`scheduler: ${(e as Error).stack ?? e}`);
        this.retryLater();
      });
    }, 50);
    this.tickTimer.unref?.();
  }

  private workersRunning(): number {
    return [...this.running.keys()].filter((id) => id !== LEAD).length;
  }

  private isFree(w: string): boolean {
    const a = this.fm.agent(w);
    if (!a || !a.active || a.paused || this.isStopped(w) || !this.team.includes(w)) return false;
    if (this.running.has(w) || (this.queues.get(w)?.length ?? 0) > 0) return false;
    return !this.fm.tasks.list().some((t) => t.assignee === w && t.status === 'doing');
  }

  private async schedule(): Promise<void> {
        if (this.authFailed || this.stopping) return;
    for (const goal of this.fm.goals().filter((g) => g.status === 'active')) {
      for (const t of this.fm.tasks.ready(goal.id)) {
        if (this.workersRunning() >= this.cfg.maxConcurrent) return;
        if (this.handoffs.has(t.id)) continue;
        let w: string | undefined;
        if (t.assignee && this.team.includes(t.assignee) && !this.isStopped(t.assignee)) {
          if (!this.isFree(t.assignee)) continue;
          w = t.assignee;
        } else {
          w = this.team.find((x) => this.isFree(x));
        }
        if (!w) continue;
        try {
          await this.startWork(w, t, goal);
          this.retryDelayMs = 2000;
        } catch (e) {
          this.fm.log.error(`could not start ${t.id} for ${w}: ${(e as Error).message}`);
          this.retryLater();
        }
      }
    }
    for (const id of this.queues.keys()) this.pump(id);
  }

  private async startWork(agentId: string, t: Task, goal: Goal): Promise<void> {
        if (!t.repoId) t.repoId = goal.repoId;
    this.fm.tasks.update(t.id, { assignee: agentId });
    let startPoint: string | undefined;
    let continuesFrom: string | undefined;
    const prev = t.worktree ? this.fm.repos.findWorktree(t.repoId!, t.worktree) : undefined;
    if (prev && prev.agentId !== agentId && prev.status !== 'merged') {
      if (prev.status === 'active') {
        if (this.lastTurn.get(prev.agentId)?.job.taskId === t.id) await this.quiesce(prev.agentId);
        await this.fm.repos.abandon(t.repoId!, prev.id, `agentcraft: ${t.id} work in progress (handed to ${this.fm.nameOf(agentId)})`).catch((e) => this.fm.log.warn(`abandon ${prev.id}: ${(e as Error).message}`));
      }
      startPoint = prev.branch;
      continuesFrom = prev.agentId;
    }
    const wt = await this.fm.repos.createWorktree(t.repoId!, agentId, t, startPoint ? { startPoint } : {});
    this.fm.tasks.update(t.id, { worktree: wt.id });
    this.fm.tasks.setStatus(t.id, 'doing');
    this.fm.setAgent(agentId, { taskId: t.id, state: 'thinking', station: 'desk', activity: `starting ${t.id}`, repoId: t.repoId, worktree: wt.id });
    this.fm.bus.feed('task', `${this.fm.nameOf(agentId)} picked up ${t.id}: ${t.title}`, { agentId });
    this.enqueue({
      kind: 'work',
      agentId,
      taskId: t.id,
      goalId: goal.id,
      sessionKey: `${agentId}:${t.id}`,
      fresh: !continuesFrom && !this.fm.store.data.sessions[`${agentId}:${t.id}`]?.sessionId,
      prompt: workPrompt(this.fm, t, goal, wt, '', continuesFrom),
    });
  }

  private enqueue(job: Job): void {
    const q = this.queues.get(job.agentId) ?? [];
    q.push(job);
    this.queues.set(job.agentId, q);
    this.pump(job.agentId);
  }

  private pump(agentId: string): void {
    if (this.stopping || this.running.has(agentId)) return;
    const q = this.queues.get(agentId);
    if (!q || !q.length) return;
    if (agentId !== LEAD && this.workersRunning() >= this.cfg.maxConcurrent) return;
    const job = q.shift()!;
    const p = this.runJob(job).finally(() => this.turnPromises.delete(p));
    this.turnPromises.add(p);
    const r = this.running.get(agentId);
    if (r) {
      r.done = p;
      this.lastTurn.set(agentId, r);
    }
  }

  private cwdFor(job: Job): { cwd: string; role: 'lead' | 'worker' } {
    if (job.agentId === LEAD) {
      const g = job.goalId ? this.fm.goal(job.goalId) : this.fm.currentGoal();
      const repo = g?.repoId ? this.fm.repos.get(g.repoId) : this.fm.repos.defaultRepo();
      return { cwd: repo?.path ?? process.cwd(), role: 'lead' };
    }
    const t = this.fm.tasks.require(job.taskId!);
    const wt = this.fm.repos.requireWorktree(t.repoId!, t.worktree!);
    return { cwd: wt.path, role: 'worker' };
  }

  private env(who: { agentId?: string; cwd?: string; role?: string } = {}): NodeJS.ProcessEnv {
    const toolsDir = path.resolve(__dirname, '../../../../tools');
    const pathEnv = who.cwd ? `${toolsDir}:${process.env.PATH ?? ''}` : process.env.PATH;
    return withGitSafety(
      process.env,
      {
        AGENTCRAFT_PORT: String(this.fm.config.port),
        ...(who.agentId ? { AGENTCRAFT_AGENT_ID: who.agentId } : {}),
        ...(who.role ? { AGENTCRAFT_ROLE: who.role } : {}),
        ...(pathEnv ? { PATH: pathEnv } : {}),
        ...(who.agentId ? (agentGitIdentity(who.agentId) as Record<string, string>) : {}),
      },
      who.cwd ? { ceiling: path.dirname(path.resolve(who.cwd)) } : {},
    );
  }

  /** Direct tool execution endpoint for local /api/tool calls. */
  async executeTool(agentId: string, role: 'lead' | 'worker', tool: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const running = this.running.get(agentId);
    const turn: TurnHandle | undefined = running ? { signal: running.abort.signal, reason: () => running.reason } : undefined;
    return executeTool(this.fm, agentId, role, tool, args, this.hooks, turn);
  }

  private async runJob(job: Job): Promise<void> {
    const agentId = job.agentId;
    const abort = new AbortController();
    const entry: Running = { abort, job };
    const previous = this.lastTurn.get(agentId);
    this.running.set(agentId, entry);
    let stats: TurnStats | undefined;
    let cwd = '';

    try {
      if (previous?.reaping) await Promise.race([previous.reaping, sleep(10_000)]);
      const where = this.cwdFor(job);
      cwd = where.cwd;
      const role = where.role;
      const session = this.fm.store.data.sessions[job.sessionKey];
      const resume = !job.fresh && session?.sessionId ? session.sessionId : undefined;
      this.st.inflight[agentId] = { kind: job.kind, sessionKey: job.sessionKey, startedAt: Date.now(), ...(job.taskId ? { taskId: job.taskId } : {}), ...(job.goalId ? { goalId: job.goalId } : {}) };
      this.fm.store.markDirty();

      let systemAppend: string;
      if (role === 'lead') systemAppend = leadSystemPrompt(this.fm, this.team);
      else {
        const t = this.fm.tasks.require(job.taskId!);
        systemAppend = workerSystemPrompt(this.fm, agentId, this.fm.repos.requireWorktree(t.repoId!, t.worktree!));
      }

      systemAppend += `\n\n# AgentCraft CLI Tool Bridge
To update task status, report activity, communicate, or ask questions, run \`agentcraft <cmd>\`:
- agentcraft create-task --title <title> --description <desc> [--assignee <id>] [--deps <id1,id2>]
- agentcraft update-task --task-id <id> [--status <todo|doing|review|blocked>] [--summary <summary>] [--blocked-reason <reason>]
- agentcraft report-status --activity <activity> [--note <note>]
- agentcraft list-tasks [--goal-id <id>]
- agentcraft request-merge --task-id <id> --summary <summary>
- agentcraft ask-user --question <question> [--options <opt1,opt2>] [--context <context>]
- agentcraft send-message --to <agent|lead|all|user> --text <message>
- agentcraft write-memory --title <title> --body <text> [--scope <shared|private>] [--mode <replace|append>]
- agentcraft read-memory [--id <id>] [--query <text>]

Example: run_command \`agentcraft update-task --task-id ${job.taskId ?? 'AC-1'} --status review --summary "done"\`.`;

      const baseModel = role === 'lead' ? (this.cfg.model ?? this.cfg.leadModel ?? 'opencode/muse-spark-1.3') : (this.cfg.model ?? this.cfg.workerModel ?? 'opencode/muse-spark-1.3');
      const effort = role === 'lead' ? (this.cfg.leadEffort ?? this.cfg.effort) : this.cfg.effort;
      const model = ocModelWithEffort(baseModel, effort);
      const agent = role === 'lead' ? this.cfg.leadAgent : this.cfg.workerAgent;

      this.fm.agentLog(agentId, 'text', `${resume ? 'Resuming' : 'Starting'} ${job.kind}${job.taskId ? ` ${job.taskId}` : ''} (${model})`);
      if (job.kind === 'followup' || job.resumed) this.fm.agentLog(agentId, 'text', truncate(job.prompt, 400));

      const mapper = new OcStreamMapper(this.fm, agentId, cwd, role);
      const timer = setTimeout(() => this.abortTurn(entry, 'timeout'), TURN_TIMEOUT_MS);
      timer.unref?.();

      const unread = this.fm.bus.inbox(agentId, { markRead: true });
      const promptBody = unread.length ? `${job.prompt}\n\n[New messages]\n${formatInbox(unread, (id) => this.fm.nameOf(id))}` : job.prompt;
      const fullPrompt = `${systemAppend}\n\n---\n\n${promptBody}`;

      try {
        const turnRes = await this.runner.runTurn({
          agentId,
          role,
          prompt: fullPrompt,
          sessionKey: resume,
          cwd,
          signal: abort.signal,
          model,
          agent,
          ocBin: this.cfg.ocBin,
          streamMapper: mapper,
          env: this.env({ agentId, cwd, role }),
          onChildSpawned: (child) => {
            entry.child = child;
            entry.spawnedAt = Date.now();
          },
        });
        stats = turnRes.stats;
      } finally {
        clearTimeout(timer);
      }

      if (stats?.sessionId) {
        this.recordSession(job.sessionKey, stats.sessionId, model, stats);
      }
    } catch (e) {
      const aborted = abort.signal.aborted;
      if (!aborted) {
        const msg = (e as Error).message ?? String(e);
        this.fm.log.error(`${agentId} ${job.kind} failed: ${msg}`);
        this.fm.agentLog(agentId, 'error', `session error: ${truncate(msg, 400)}`);
        stats = { isError: true, errors: [msg] };
      }
    } finally {
      this.running.delete(agentId);
    }

    const reason = entry.reason;
    if (reason === 'shutdown') return;
    if (reason) void this.reap(entry);
    delete this.st.inflight[agentId];
    this.fm.store.markDirty();

    if (reason === 'pause') {
      const next: Job = { ...job, fresh: false, resumed: true, prompt: `${userName()} paused you and has now resumed you. Any question you had open was withdrawn; ask again if you still need it. Continue your current job.` };
      if (this.fm.agent(agentId)?.paused) {
        this.pausedJobs.set(agentId, next);
        this.fm.setAgent(agentId, { state: 'idle', activity: 'paused' });
      } else this.enqueue(next);
    } else if (reason === 'stop') {
      if (this.isStopped(agentId)) this.fm.setAgent(agentId, { state: 'idle', station: 'lounge', activity: 'stopped - off shift', taskId: null, worktree: null });
    } else if (reason === 'cancel') {
      const a = this.fm.agent(agentId);
      if (a?.taskId === job.taskId) this.fm.setAgent(agentId, { state: 'idle', station: 'lounge', activity: 'task cancelled', taskId: null, worktree: null });
    } else if (reason === 'timeout') {
      this.fm.agentLog(agentId, 'error', `turn timed out after ${TURN_TIMEOUT_MS / 60_000} min`);
      await this.afterTurn(job, { isError: true, errors: ['turn timed out'] }).catch((e) => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    } else {
      await this.afterTurn(job, stats).catch((e) => this.fm.log.error(`afterTurn ${agentId}: ${(e as Error).stack ?? e}`));
    }
    this.pump(agentId);
    if (reason !== 'stop' && reason !== 'pause') this.deliverPending(agentId);
    this.tick();
  }

  private deliverPending(agentId: string): void {
    if (this.stopping || this.isStopped(agentId) || this.running.has(agentId) || this.pausedJobs.has(agentId) || (this.queues.get(agentId)?.length ?? 0) > 0) return;
    const a = this.fm.agent(agentId);
    if (!a?.active || a.paused) return;
    const fromUser = this.fm.bus.inbox(agentId).filter((m) => m.from === 'user' && m.to === agentId);
    if (!fromUser.length) return;
    this.fm.log.info(`delivering ${fromUser.length} message(s) from ${userName()} to ${agentId} that arrived after its last turn`);
    this.onUserMessage(agentId, fromUser[fromUser.length - 1]!.text);
  }

  private recordSession(key: string, sessionId: string, model: string, stats?: TurnStats): void {
    const s = (this.fm.store.data.sessions[key] ??= { turns: 0, costUsd: 0, updatedAt: Date.now() });
    s.sessionId = sessionId;
    s.model = model;
    s.updatedAt = Date.now();
    if (stats) {
      s.turns += stats.numTurns ?? 0;
    }
    this.fm.store.markDirty();
  }

  private failure(stats: TurnStats | undefined): string {
    return truncate(stats?.errors[0] ?? 'error', 36);
  }

  private async afterTurn(job: Job, stats: TurnStats | undefined): Promise<void> {
    const failed = !stats || stats.isError;
    if (job.agentId === LEAD) {
      if (failed && job.kind === 'plan' && job.goalId && this.scheduleTransientRetry(job, stats, `planning ${job.goalId}`)) return;
      this.fm.setAgent(LEAD, failed ? { state: 'error', station: 'meeting', activity: `turn failed: ${this.failure(stats)}` } : { state: 'idle', station: 'meeting', activity: 'watching the task wall' });
      const goal = job.goalId ? this.fm.goal(job.goalId) : undefined;
      if (goal && goal.status === 'planning') {
        const n = this.fm.tasks.forGoal(goal.id).length;
        if (n > 0) this.promoteGoal(goal, 'planned');
        else if (failed) {
          this.fm.setGoal(goal.id, { status: 'failed' });
          this.fm.bus.feed('error', `Marlow's planning turn ended without tasks${stats?.errors.length ? `: ${stats.errors.join('; ')}` : ''}`, { agentId: LEAD });
        } else if (job.kind === 'plan') {
          this.fm.setGoal(goal.id, { status: 'cancelled', progress: 0 });
          this.fm.bus.feed('goal', `Marlow planned no tasks: goal closed (${truncate(goal.text, 80)})`, { agentId: LEAD });
        }
      }
      if (job.kind === 'review' && job.taskId) {
        const t = this.fm.tasks.get(job.taskId);
        const hasDecision = this.fm.decisions.open().some((d) => d.kind === 'merge' && d.taskId === job.taskId);
        if (t && t.status === 'review' && !hasDecision) {
          this.openMergeDecision(t, `Marlow's review: ${truncate(stats?.resultText ?? '(no verdict)', 300)}`);
        }
      }
      return;
    }

    const t = job.taskId ? this.fm.tasks.get(job.taskId) : undefined;
    if (!t) {
      this.fm.setAgent(job.agentId, failed ? { state: 'error', station: 'desk', activity: `turn failed: ${this.failure(stats)}` } : { state: 'idle', station: 'lounge', activity: 'idle' });
      return;
    }
    if (t.status === 'review') {
      await this.afterWorkerDone(t.id);
      return;
    }
    if (t.status === 'doing') {
      const nudges = job.nudges ?? 0;
      if (!failed && nudges < 1) {
        this.enqueue({ ...job, kind: 'followup', fresh: false, nudges: nudges + 1, prompt: `You ended your turn but ${t.id} is still "doing". If the work is complete, run \`agentcraft update-task --task-id "${t.id}" --status review --summary "<summary>"\`. If stuck, run \`agentcraft update-task --task-id "${t.id}" --status blocked --blocked-reason "<reason>"\`.` });
        return;
      }
      const wt = t.worktree && t.repoId ? this.fm.repos.findWorktree(t.repoId, t.worktree) : undefined;
      if (wt) await this.fm.repos.refresh(t.repoId!);
      if (!failed && wt && wt.files > 0) {
        this.fm.tasks.setStatus(t.id, 'review', { summary: truncate(stats?.resultText ?? 'work complete', 400) });
        await this.afterWorkerDone(t.id);
      } else {
        if (failed && this.scheduleTransientRetry(job, stats, t.id)) return;
        this.fm.tasks.setStatus(t.id, 'blocked', { reason: failed ? `session ended: ${stats?.errors.join('; ') ?? 'error'}` : 'worker stopped without changes', force: true });
        this.fm.setAgent(job.agentId, failed ? { state: 'error', station: 'desk', activity: `${t.id}: ${this.failure(stats)}` } : { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
        this.fm.bus.send(job.agentId, LEAD, `${t.id} is blocked: ${this.fm.tasks.get(t.id)?.blockedReason}`);
        this.fm.notify('warn', `${this.fm.nameOf(job.agentId)}: ${t.id} ${failed ? 'failed' : 'is blocked'} (${this.fm.tasks.get(t.id)?.blockedReason ?? ''}) - /task ${t.id} retry when ready`);
      }
      return;
    }
    if (t.status === 'blocked') {
      this.fm.setAgent(job.agentId, { state: 'blocked', station: 'desk', activity: `${t.id} blocked` });
      this.fm.notify('warn', `${this.fm.nameOf(job.agentId)} is blocked on ${t.id}: ${t.blockedReason ?? ''}`);
      return;
    }
    this.fm.setAgent(job.agentId, { state: 'idle', station: 'lounge', activity: 'idle' });
  }

  private async afterWorkerDone(taskId: string): Promise<void> {
    if (this.reviewing.has(taskId)) return;
    this.reviewing.add(taskId);
    try {
      await this.ciThenReview(taskId);
    } finally {
      this.reviewing.delete(taskId);
    }
  }

  private async ciThenReview(taskId: string): Promise<void> {
    const t = this.fm.tasks.get(taskId);
    if (!t || t.status !== 'review' || !t.repoId || !t.worktree) return;
    const worker = t.assignee;
    if (worker) this.fm.setAgent(worker, { state: 'idle', station: 'lounge', activity: `${t.id} in review` });
    let ci: TestResult | undefined;
    try {
      this.fm.tasks.update(t.id, { ci: 'running' });
      this.fm.repos.setCi(t.repoId, 'running');
      if (worker) this.fm.agentLog(worker, 'tool', `CI: ${this.cfg.ciCommand ?? this.fm.repos.detectTestCommand(this.fm.repos.requireWorktree(t.repoId, t.worktree).path) ?? '(no tests)'}`);
      ci = await this.fm.repos.runTests(t.repoId, t.worktree, this.cfg.ciCommand);
      this.fm.tasks.update(t.id, { ci: ci.pass ? 'pass' : 'fail' });
      this.fm.repos.setCi(t.repoId, ci.pass ? 'pass' : 'fail');
      if (worker) this.fm.agentLog(worker, ci.pass ? 'result' : 'error', `CI ${ci.pass ? 'passed' : 'FAILED'} (${(ci.durationMs / 1000).toFixed(1)}s)\n${ci.output.split('\n').slice(-6).join('\n')}`);
      this.fm.bus.feed('ci', `${t.id}: tests ${ci.pass ? 'pass' : 'fail'} (${ci.command})`, { ...(worker ? { agentId: worker } : {}) });
    } catch (e) {
      this.fm.log.warn(`CI for ${t.id}: ${(e as Error).message}`);
    }
    await this.fm.repos.refresh(t.repoId);
    if (ci && !ci.pass && (this.st.ciFixes[t.id] ?? 0) < 1 && worker && !this.isStopped(worker)) {
      this.st.ciFixes[t.id] = (this.st.ciFixes[t.id] ?? 0) + 1;
      this.sendBackToWorker(t.id, `CI failed for ${t.id} (${ci.command}):\n${ci.output}\n\nFix the failures, re-run tests, then update_task("${t.id}", status "review", summary).`);
      return;
    }
    if (this.cfg.leadReview && !this.isStopped(LEAD)) {
      const diff = await this.fm.repos.diff(t.repoId, t.worktree);
      this.fm.setAgent(LEAD, { state: 'reading', station: 'mergestation', activity: `reviewing ${t.id}` });
      this.enqueue({ kind: 'review', agentId: LEAD, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${LEAD}:${t.goalId ?? 'adhoc'}`, prompt: reviewPrompt(this.fm, this.fm.tasks.require(t.id), renderDiffText(diff.files), diff.stats, ci) });
    } else {
      this.openMergeDecision(t, t.summary ?? 'Work complete.');
    }
  }

  private openMergeDecision(t: Task, summary: string): void {
    const wt = this.fm.repos.requireWorktree(t.repoId!, t.worktree!);
    this.fm.createDecision({
      agentId: LEAD,
      kind: 'merge',
      question: `Merge ${t.id} "${t.title}" (${wt.branch}) into ${wt.base}?`,
      options: [...MERGE_OPTIONS],
      context: `${summary}\n${wt.files} files, +${wt.additions} -${wt.deletions} | tests: ${t.ci}`,
      taskId: t.id,
      repoId: t.repoId!,
      worktree: wt.id,
    });
    if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'idle', station: 'mergestation', activity: `awaiting your review of ${t.id}` });
  }

  private sendBackToWorker(taskId: string, prompt: string): void {
    const t = this.fm.tasks.get(taskId);
    if (!t?.assignee) return;
    if (this.isStopped(t.assignee)) {
      this.fm.tasks.setStatus(t.id, 'todo', { force: true, summary: truncate(prompt, 400) });
      this.fm.tasks.update(t.id, { assignee: null });
      this.tick();
      return;
    }
    if (t.status !== 'doing') this.fm.tasks.setStatus(t.id, 'doing', { force: true });
    this.fm.setAgent(t.assignee, { taskId: t.id, state: 'thinking', station: 'desk', activity: `revising ${t.id}`, ...(t.repoId ? { repoId: t.repoId } : {}), ...(t.worktree ? { worktree: t.worktree } : {}) });
    this.enqueue({ kind: 'followup', agentId: t.assignee, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${t.assignee}:${t.id}`, prompt });
  }

  onUserMessage(to: string, text: string, note?: string): void {
    const id = to === 'all' ? LEAD : to;
    const a = this.fm.agent(id);
    if (!a) return;
    if (this.isStopped(id)) {
      this.fm.bus.send(id, 'user', `(${this.fm.nameOf(id)} is off shift - /resume @${id} to bring them back; your message is queued.)`);
      return;
    }
    if (this.running.has(id) || this.pausedJobs.has(id)) return;
    const mine = this.fm.bus.inbox(id).filter((m) => m.from === 'user' && (m.to === id || (to === 'all' && m.to === 'all')));
    const body = mine.length ? mine.map((m) => m.text).join('\n\n') : text;
    const consume = () => this.fm.bus.markRead(id, mine.map((m) => m.id));
    const prompt = `Message from ${userName()}: ${body}\n\n${note ? `${note}\n\n` : ''}Respond briefly with send_message(to "user") and act on it if needed (lead: create or update tasks; worker: adjust your work).`;
    if (id === LEAD) {
      const goal = this.fm.currentGoal();
      if (!goal) {
        consume();
        this.fm.bus.send(LEAD, 'user', 'No goal yet - type one in the console and I will plan it.');
        return;
      }
      consume();
      this.enqueue({ kind: 'followup', agentId: LEAD, goalId: goal.id, sessionKey: `${LEAD}:${goal.id}`, prompt });
      return;
    }
    const t = this.fm.tasks.list().filter((x) => x.assignee === id && (x.status === 'doing' || x.status === 'review')).pop();
    consume();
    if (!t) {
      this.fm.bus.send(id, 'user', 'I am not on a task right now - Marlow will pick that up.');
      this.fm.bus.send('user', LEAD, `(for ${this.fm.nameOf(id)}) ${body}`);
      const name = this.fm.nameOf(id);
      this.onUserMessage(
        LEAD,
        `(originally for ${name}) ${body}`,
        `${name} is not on a task, and workers only read messages while they work on one. If this needs ${name} to do something, create a task for it with create_task (assignee "${id}"); a send_message alone will not reach ${name}.`,
      );
      return;
    }
    this.enqueue({ kind: 'followup', agentId: id, taskId: t.id, ...(t.goalId ? { goalId: t.goalId } : {}), sessionKey: `${id}:${t.id}`, prompt });
  }

  onDecisionSettled(d: Decision): void {
    if (d.kind === 'question') {
      if (!this.waitingUser.has(d.agentId) && !this.running.has(d.agentId) && !this.isStopped(d.agentId)) {
        const ans = [d.answer?.option, d.answer?.text].filter(Boolean).join(' — ') || '(cancelled)';
        const inf = this.st.inflight[d.agentId];
        const t = d.taskId ? this.fm.tasks.get(d.taskId) : undefined;
        const goalId = inf?.goalId ?? t?.goalId ?? (d.agentId === LEAD ? this.fm.currentGoal()?.id : undefined);
        const sessionKey = inf?.sessionKey ?? (d.agentId === LEAD ? `${LEAD}:${goalId ?? 'adhoc'}` : t ? `${d.agentId}:${t.id}` : undefined);
        if (sessionKey) {
          this.enqueue({
            kind: inf?.kind ?? 'followup',
            agentId: d.agentId,
            sessionKey,
            resumed: true,
            ...(t ? { taskId: t.id } : inf?.taskId ? { taskId: inf.taskId } : {}),
            ...(goalId ? { goalId } : {}),
            prompt: `Earlier you asked ${userName()}: "${d.question}". ${userName()} answered: ${ans}. Continue.`,
          });
        }
      }
      return;
    }
    if (d.kind === 'merge' && d.taskId) {
      const t = this.fm.tasks.get(d.taskId);
      if (!t) return;
      if (d.answer?.option === 'Merge' && t.status === 'done') {
        if (t.assignee && this.fm.agent(t.assignee)?.taskId === t.id) this.fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} merged`, taskId: null, worktree: null });
        if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'idle', station: 'meeting', activity: 'watching the task wall' });
        const g = t.goalId ? this.fm.goal(t.goalId) : undefined;
        if (g && this.fm.tasks.goalComplete(g.id)) {
          this.fm.bus.send(LEAD, 'user', `Everything for "${truncate(g.text, 80)}" is merged. Nice working with you.`);
          for (const w of this.team) if (!this.isStopped(w)) this.fm.setAgent(w, { state: 'done', station: 'lounge', activity: 'goal done' });
          if (!this.isStopped(LEAD)) this.fm.setAgent(LEAD, { state: 'done', station: 'meeting', activity: 'goal done' });
        }
        this.tick();
      } else if (d.answer?.option === 'Request changes') {
        this.sendBackToWorker(t.id, `${userName()} reviewed ${t.id} and requested changes:\n${d.answer.text ?? '(no details given - ask_user if unclear)'}\n\nMake the changes, re-run tests, then update_task("${t.id}", status "review", summary).`);
      } else if (d.answer?.option === 'Reject') {
        if (t.assignee && this.fm.agent(t.assignee)?.taskId === t.id) this.fm.setAgent(t.assignee, { state: 'idle', station: 'lounge', activity: `${t.id} rejected`, taskId: null, worktree: null });
        this.tick();
      }
    }
  }

  onMergeConflict(task: Task, info: { base: string; branch: string; files: string[]; reason: string }): boolean {
    if (!task.assignee || this.isStopped(task.assignee)) return false;
    const files = info.files.length ? info.files.join(', ') : '(see git status)';
    this.sendBackToWorker(
      task.id,
      `${userName()} approved merging ${task.id}, but ${info.branch} now conflicts with ${info.base} in: ${files}.\n` +
        `In your worktree run \`git merge ${info.base}\`, resolve every conflict, run the tests, and commit the merge (git commit --no-edit). Then update_task("${task.id}", status "review", summary).`,
    );
    return true;
  }

  onTaskAction(task: Task, action: 'reassign' | 'cancel' | 'retry' | 'prioritize'): void {
    if (action === 'cancel' || action === 'reassign') {
      for (const [id, r] of this.running) {
        if (r.job.taskId === task.id && id !== LEAD && (action === 'cancel' || task.assignee !== id)) this.abortTurn(r, 'cancel');
      }
      for (const [id, q] of this.queues) this.queues.set(id, q.filter((j) => j.taskId !== task.id || (action === 'reassign' && task.assignee === id)));
      if (action === 'reassign' && task.repoId && task.worktree) {
        const wt = this.fm.repos.findWorktree(task.repoId, task.worktree);
        if (wt && wt.status === 'active' && wt.agentId !== task.assignee) this.handOff(task.id, wt.agentId, `reassigned to ${this.fm.nameOf(task.assignee ?? 'user')}`);
      }
    }
    this.tick();
  }

  private withdrawDecisions(agentId: string, why: string): void {
    for (const d of this.fm.decisions.open().filter((x) => x.agentId === agentId && x.kind !== 'merge')) this.fm.decisions.cancel(d.id, why);
  }

  async onAgentAction(agentId: string, action: 'pause' | 'resume' | 'stop' | 'spawn'): Promise<void> {
    const r = this.running.get(agentId);
    const name = this.fm.nameOf(agentId);
    if (action === 'pause') {
      if (r) this.abortTurn(r, 'pause');
      this.fm.setAgent(agentId, { state: 'idle', activity: 'paused' });
    } else if (action === 'resume' || action === 'spawn') {
      const wasStopped = this.isStopped(agentId);
      if (action === 'spawn' && agentId !== LEAD && !this.cfg.workers.includes(agentId)) this.cfg.workers.push(agentId);
      if (wasStopped || action === 'spawn') {
        this.setStopped(agentId, false);
        this.fm.setAgent(agentId, { active: true, paused: false, state: 'idle', station: 'lounge', activity: 'ready' });
        if (wasStopped) this.fm.bus.feed('system', `${name} is back on shift`, { agentId });
      } else {
        const a = this.fm.agent(agentId);
        if (a && a.activity === 'paused') {
          this.fm.setAgent(agentId, { state: 'idle', activity: 'ready' });
        }
      }
      const job = this.pausedJobs.get(agentId);
      this.pausedJobs.delete(agentId);
      if (job) this.enqueue(job);
      else this.pump(agentId);
      if (agentId === LEAD && wasStopped) this.reconcile();
      this.deliverPending(agentId);
    } else if (action === 'stop') {
      this.setStopped(agentId, true);
      if (r) this.abortTurn(r, 'stop');
      this.queues.delete(agentId);
      this.pausedJobs.delete(agentId);
      delete this.st.inflight[agentId];
      this.withdrawDecisions(agentId, `${name} was stopped`);
      if (agentId !== LEAD) {
        for (const t of this.fm.tasks.list().filter((x) => x.assignee === agentId && x.status === 'doing')) {
          this.fm.tasks.setStatus(t.id, 'todo', { force: true });
          this.fm.tasks.update(t.id, { assignee: null });
          this.fm.bus.feed('task', `${t.id} is back on the board (${name} was stopped)`, { agentId: 'user' });
          this.handOff(t.id, agentId, `${name} was stopped`);
        }
      }
      this.fm.setAgent(agentId, { active: false, paused: false, state: 'idle', station: 'lounge', activity: 'stopped - off shift', taskId: null, worktree: null });
    }
    this.tick();
  }
}
