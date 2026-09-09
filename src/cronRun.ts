import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { planCronTick, readCronConfig, type CronJob } from "./cron.js";
import { renderTemplate } from "./cronSpec.js";
import type { Db } from "./db.js";
import { resolveRepo, worktreeAdd } from "./git.js";
import { cronLogPath, ensureDirs, hiveHome, selfCommand } from "./paths.js";
import { shQuote } from "./sh.js";
import { listPanes, newWindow, socketPath } from "./tmux.js";
import { findInitScript, openWorktreeSession, rememberRepo, windowsInWorktree, worktreePathFor } from "./worktree.js";

// claude는 위치 인자로 프롬프트를 받으면 대화형으로 시작한다(-p가 아니다). 그래서 창이 남고,
// hook이 붙어 있으면 진행 상태가 스풀을 타고 사이드바에 그대로 나타난다.
export function buildLaunchCommand(job: CronJob, initPrefix?: string): string {
  const bin = job.agent === "codex" ? "codex" : "claude";
  const parts = [shQuote(bin), ...job.args.map(shQuote), shQuote(job.prompt)];
  const run = job.keepWindow ? `${parts.join(" ")}; exec \${SHELL:-sh}` : parts.join(" ");
  return initPrefix ? `${initPrefix}; ${run}` : run;
}

export function resolveJobCwd(job: CronJob, fireAt: number): { cwd: string; created: boolean } {
  const wt = job.worktree;
  if (wt.mode !== "new") {
    const cwd = resolve(wt.mode === "path" ? wt.path : job.repo);
    if (!existsSync(cwd)) throw new Error(`실행할 경로가 없습니다: ${cwd}`);
    return { cwd, created: false };
  }

  const repo = resolveRepo(resolve(job.repo));
  if (!repo) throw new Error(`git 저장소를 찾을 수 없습니다: ${job.repo}`);
  const branch = renderTemplate(wt.branch, { fireAt, jobId: job.id });
  const path = worktreePathFor(repo.repoRoot, branch);
  // 같은 fire를 손으로 다시 돌리는 경우가 있다. 이미 판 자리는 그대로 쓴다.
  if (existsSync(path)) return { cwd: path, created: false };
  worktreeAdd({ repoRoot: repo.repoRoot, branch, path, base: wt.base });
  rememberRepo(repo.repoRoot);
  return { cwd: path, created: true };
}

// cron은 창 명령을 통째로 갈아끼우므로 init 스크립트가 저절로 돌지 않는다. 필요하다고 적은 잡만 앞에 붙인다.
function initPrefixFor(job: CronJob, cwd: string): string | undefined {
  if (job.worktree.mode !== "new" || !job.worktree.init) return undefined;
  const script = findInitScript(cwd);
  if (!script) return undefined;
  const [node, cli] = selfCommand();
  return `${shQuote(node)} ${shQuote(cli)} wt run-init ${shQuote(cwd)} ${shQuote(script)}`;
}

// 그 worktree에 이미 창이 있으면 같은 세션에 창만 하나 더 붙인다. 없으면 세션을 새로 연다.
// 어느 쪽이든 사용자가 보던 화면을 뺏지 않는다(focus: false).
function launchJob(job: CronJob, cwd: string, command: string): { sessionName?: string; windowId?: string } {
  const windows = windowsInWorktree(listPanes(), cwd);
  if (windows.length > 0) {
    const target = windows[0].sessionName;
    return { sessionName: target, windowId: newWindow({ name: `cron:${job.id}`, cwd, command, session: target }) };
  }
  const res = openWorktreeSession({ path: cwd, name: `cron-${job.id}`, command, focus: false });
  return { sessionName: res.sessionName, windowId: res.windowId };
}

export interface ExecuteResult {
  status: "launched" | "skipped" | "failed";
  runId: number | null;
  cwd?: string;
  sessionName?: string;
  windowId?: string;
  error?: string;
}

function claimTag(): string {
  return `${hostname()}:${process.pid}`;
}

// TUI가 claim한 뒤 자식으로 부르는 자리이자, hive cron run이 손으로 부르는 자리다.
// 두 경로가 같은 코드를 타야 "손으로 한 번 돌려보기"가 진짜 검증이 된다.
export function executeJob(o: {
  db: Db;
  job: CronJob;
  fireAt: number;
  runId?: number | null;
  now?: number;
}): ExecuteResult {
  const now = o.now ?? Date.now();
  let runId = o.runId ?? null;
  if (runId === null) {
    runId = o.db.claimCronRun({ jobId: o.job.id, fireAt: o.fireAt, startedAt: now, claimedBy: claimTag() });
    if (runId === null) return { status: "skipped", runId: null };
  }

  try {
    const { cwd } = resolveJobCwd(o.job, o.fireAt);
    const command = buildLaunchCommand(o.job, initPrefixFor(o.job, cwd));
    const { sessionName, windowId } = launchJob(o.job, cwd, command);
    o.db.markCronRun(runId, { status: "launched", sessionName, windowId, cwd });
    return { status: "launched", runId, cwd, sessionName, windowId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    o.db.markCronRun(runId, { status: "failed", finishedAt: Date.now(), error });
    return { status: "failed", runId, error };
  }
}

export interface CronTickResult {
  reaped: number;
  launched: { jobId: string; fireAt: number; runId: number }[];
  errors: string[];
}

// TUI는 claim만 하고 실제 실행은 떼어낸 자식에게 맡긴다. git worktree add와 tmux new-session은
// 전부 동기 호출이라 1초 tick 안에서 부르면 사이드바가 그동안 얼어붙는다.
function spawnRunner(jobId: string, fireAt: number, runId: number): void {
  const [node, cli] = selfCommand();
  const args = [cli, "--home", hiveHome()];
  const socket = socketPath();
  if (socket) args.push("--tmux-socket", socket);
  args.push("cron", "run", jobId, "--fire-at", String(fireAt), "--claim", String(runId));
  spawn(node, args, { detached: true, stdio: "ignore" }).unref();
}

export function logCronError(message: string): void {
  try {
    ensureDirs();
    appendFileSync(cronLogPath(), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // 로그를 못 써도 tick은 계속 돌아야 한다.
  }
}

// TUI tick과 hive cron tick이 같이 쓴다. inline이면 이 프로세스에서 바로 실행한다.
export function cronTick(a: {
  db: Db;
  now: number;
  liveWindowIds: string[];
  inline?: boolean;
}): CronTickResult {
  const out: CronTickResult = { reaped: 0, launched: [], errors: [] };
  out.reaped = a.db.reapCronRuns({ liveWindowIds: a.liveWindowIds, now: a.now });

  const cfg = readCronConfig();
  out.errors.push(...cfg.errors);
  if (cfg.jobs.length === 0) return out;

  const plan = planCronTick({
    jobs: cfg.jobs,
    lastFireByJob: a.db.lastFireByJob(),
    runningJobIds: new Set(a.db.runningCronRuns().map((r) => r.jobId)),
    now: a.now,
  });

  for (const item of plan) {
    // 사이드바가 여럿이면 여기서 하나만 살아남는다.
    const runId = a.db.claimCronRun({
      jobId: item.job.id,
      fireAt: item.fireAt,
      startedAt: a.now,
      claimedBy: claimTag(),
    });
    if (runId === null) continue;

    if (a.inline) {
      const res = executeJob({ db: a.db, job: item.job, fireAt: item.fireAt, runId, now: a.now });
      if (res.status === "launched") out.launched.push({ jobId: item.job.id, fireAt: item.fireAt, runId });
      else out.errors.push(`${item.job.id}: ${res.error ?? res.status}`);
      continue;
    }

    try {
      spawnRunner(item.job.id, item.fireAt, runId);
      out.launched.push({ jobId: item.job.id, fireAt: item.fireAt, runId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      a.db.markCronRun(runId, { status: "failed", finishedAt: a.now, error });
      out.errors.push(`${item.job.id}: ${error}`);
    }
  }
  return out;
}
