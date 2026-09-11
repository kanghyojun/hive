#!/usr/bin/env node
// node:sqlite ExperimentalWarning은 db.ts가 동적 import하기 전에 여기서 미리 걸러야 한다(실측).
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.error(w);
});

import { appendFileSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import {
  claudeUsageSnapshotPath,
  dbPath,
  ensureDirs,
  hiveHome,
  codexHookScriptPath,
  hookScriptPath,
  logsDir,
  cliEntryPath,
  setHiveHomeOverride,
  spoolDir,
} from "./paths.js";
import {
  setPaneOverride,
  setTmuxSocketOverride,
  currentPaneId,
  listPanes,
  serverInfo,
  switchClient,
} from "./tmux.js";
import { hideSidebar, showSidebar, selectSidebar, toggleSidebar, cleanupFromTui } from "./sidebar.js";
import { AGENT_KINDS, installHooks, statusHooks, uninstallHooks, type AgentKind } from "./hookInstall.js";
import {
  createInitScript,
  listWorktrees,
  planWtRemove,
  sessionsAfterKill,
  windowsInWorktree,
  wtNew,
  wtOpen,
  wtRemove,
  wtRunInit,
} from "./worktree.js";
import { ghErrorMessage, parsePrNumber, viewPullRequest, wtFromPr } from "./githubPr.js";
import { resolveRepo } from "./git.js";
import { abConfigPath, abLocalInstalled, parseAbConfig, probeAbBridge } from "./abBridge.js";
import { claudeSnapshotPath, readClaudeUsage, readCodexUsage } from "./usage.js";
import {
  SNAPSHOT_THROTTLE_MS,
  parseStatuslinePayload,
  shouldWriteSnapshot,
  writeSnapshot,
} from "./statusline.js";
import { openDb } from "./db.js";
import {
  DEFAULT_GRACE_MS,
  readCronConfig,
  removeJob,
  upsertJob,
  writeCronConfig,
  type CronJob,
  type CronWorktree,
} from "./cron.js";
import { nextDue, parseCron } from "./cronSpec.js";
import { cronServerKey, cronTick, executeJob } from "./cronRun.js";
import { ingestAll } from "./spool.js";
import { effectiveState, reduceAgent } from "./state.js";

const program = new Command();
program
  .name("hive")
  .description("tmux 위에서 여러 window의 AI agent 상태를 보여주는 쓰레드뷰 프로토타입")
  .option("--home <dir>", "HIVE_HOME 덮어쓰기")
  .option("--tmux-socket <path>", "tmux 소켓 경로 덮어쓰기")
  .option("--pane <id>", "기준 pane id. tmux 바인딩에서 '#{pane_id}'로 넘긴다");

program.hook("preAction", () => {
  const opts = program.opts<{ home?: string; tmuxSocket?: string; pane?: string }>();
  if (opts.home) setHiveHomeOverride(resolve(opts.home));
  if (opts.tmuxSocket) setTmuxSocketOverride(opts.tmuxSocket);
  if (opts.pane) setPaneOverride(opts.pane);
});

program
  .command("tui")
  .description("쓰레드뷰 TUI 실행")
  .action(async () => {
    const instance = render(<App />, { exitOnCtrlC: true });
    const cleanup = () => {
      try {
        cleanupFromTui();
      } catch {
        // best-effort
      }
    };
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGHUP", () => {
      cleanup();
      process.exit(0);
    });
    await instance.waitUntilExit();
  });

const sidebar = program.command("sidebar").description("사이드바 pane 제어");
sidebar
  .command("select")
  .description("사이드바를 열고 포커스 이동")
  .action(() => selectSidebar());
sidebar
  .command("show")
  .action(() => showSidebar());
sidebar
  .command("hide")
  .action(() => hideSidebar());
sidebar
  .command("toggle")
  .action(() => toggleSidebar());

// --agent를 안 주면 claude와 codex 둘 다 대상으로 한다.
function parseAgents(value: string | undefined): AgentKind[] | undefined {
  if (!value || value === "all") return undefined;
  const agents = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of agents) {
    if (!AGENT_KINDS.includes(a as AgentKind)) {
      throw new Error(`모르는 agent입니다: ${a} (${AGENT_KINDS.join(", ")}, all 중 하나)`);
    }
  }
  return agents as AgentKind[];
}

const hook = program.command("hook").description("Claude Code / Codex hook 등록 관리");
hook
  .command("install")
  .option("--agent <kinds>", "claude, codex, all (기본: all)")
  .option("--settings <path>", "Claude settings.json 경로")
  .option("--codex-hooks <path>", "Codex hooks.json 경로")
  .option("--dry-run", "실제로 쓰지 않고 결과만 표시")
  .action((opts) => {
    const results = installHooks({
      agents: parseAgents(opts.agent),
      settingsPath: opts.settings,
      codexHooksPath: opts.codexHooks,
      dryRun: opts.dryRun,
    });
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.agent === "codex")) {
      console.log("codex는 hooks.json 등록만으로 돌지 않습니다. codex를 새로 띄워 hook 신뢰를 승인하세요.");
      console.log("승인 여부는 hive hook status --agent codex의 trusted 열에서 확인합니다.");
    }
  });
hook
  .command("uninstall")
  .option("--agent <kinds>", "claude, codex, all (기본: all)")
  .option("--settings <path>", "Claude settings.json 경로")
  .option("--codex-hooks <path>", "Codex hooks.json 경로")
  .option("--dry-run", "실제로 쓰지 않고 결과만 표시")
  .action((opts) => {
    const results = uninstallHooks({
      agents: parseAgents(opts.agent),
      settingsPath: opts.settings,
      codexHooksPath: opts.codexHooks,
      dryRun: opts.dryRun,
    });
    console.log(JSON.stringify(results, null, 2));
  });
hook
  .command("status")
  .option("--agent <kinds>", "claude, codex, all (기본: all)")
  .option("--settings <path>", "Claude settings.json 경로")
  .option("--codex-hooks <path>", "Codex hooks.json 경로")
  .option("--codex-config <path>", "Codex config.toml 경로 (신뢰 승인 여부 확인용)")
  .action((opts) => {
    const rows = statusHooks({
      agents: parseAgents(opts.agent),
      settingsPath: opts.settings,
      codexHooksPath: opts.codexHooks,
      codexConfigPath: opts.codexConfig,
    });
    for (const { agent, event, installed, trusted } of rows) {
      const state = installed ? "installed" : "missing  ";
      const trust = trusted === undefined ? "" : `\t${trusted ? "trusted" : "untrusted"}`;
      console.log(`${agent}\t${state}${trust}\t${event}`);
    }
  });

function resolveRepoRoot(repoOpt: string | undefined): string {
  const cwd = repoOpt ? resolve(repoOpt) : process.cwd();
  const repo = resolveRepo(cwd);
  if (!repo) throw new Error(`git 저장소를 찾을 수 없습니다: ${cwd}`);
  return repo.repoRoot;
}

const wt = program.command("wt").description("git worktree 생성/관리");
wt
  .command("new <branch>")
  .option("--repo <path>", "저장소 경로 (기본: 현재 디렉토리)")
  .option("--base <ref>", "새 브랜치의 base ref")
  .option("--no-init", "init script 실행 건너뛰기")
  .action((branch, opts) => {
    const result = wtNew({ branch, repo: opts.repo, base: opts.base, noInit: !opts.init });
    console.log(JSON.stringify(result, null, 2));
  });
wt
  .command("run-init <path> [script]")
  .action(async (path, script) => {
    const code = await wtRunInit(path, script);
    process.exit(code);
  });
wt
  .command("init-script")
  .option("--repo <path>", "저장소 경로 (기본: 현재 디렉토리)")
  .option("--force", "이미 있어도 덮어쓰기")
  .action((opts) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    const result = createInitScript({ repoRoot, force: opts.force });
    console.log(JSON.stringify(result, null, 2));
  });
wt
  .command("open <target>")
  .description("이미 있는 worktree를 세션으로 열기 (branch, 경로, 디렉토리 이름 중 아무거나)")
  .option("--repo <path>", "저장소 경로 (기본: 현재 디렉토리)")
  .option("--init", "init script도 실행")
  .action((target, opts) => {
    const result = wtOpen({ repo: opts.repo, target, init: opts.init });
    console.log(JSON.stringify(result, null, 2));
  });
wt
  .command("pr <number>")
  .description("GitHub PR을 받아 worktree로 열기 (이미 있으면 그 자리를 연다)")
  .option("--repo <path>", "저장소 경로 (기본: 현재 디렉토리)")
  .option("--no-init", "init script 실행 건너뛰기")
  .action((number, opts) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    const prNumber = parsePrNumber(number);
    let pr;
    try {
      pr = viewPullRequest(repoRoot, prNumber);
    } catch (err) {
      // gh의 원본 stderr는 여러 줄이라 CLI 한 줄 에러로 줄여서 올린다.
      throw new Error(ghErrorMessage(err));
    }
    const result = wtFromPr({ repoRoot, pr, noInit: !opts.init });
    console.log(JSON.stringify({ ...result, number: pr.number, title: pr.title }, null, 2));
  });
wt
  .command("rm <target>")
  .alias("remove")
  .description("worktree 삭제 + 그 worktree를 쓰던 tmux 창 종료")
  .option("--repo <path>", "저장소 경로 (기본: 현재 디렉토리)")
  .option("--force", "커밋 안 된 변경이 있어도 지우기")
  .action((target, opts) => {
    // pane 목록은 한 번만 찍는다. 여러 번 찍으면 계획과 판정이 서로 다른 스냅샷 위에서 돈다.
    const panes = listPanes();
    const plan = planWtRemove({ repo: opts.repo, target, panes });
    const paneId = currentPaneId();
    const self = paneId ? panes.find((p) => p.paneId === paneId) : undefined;

    // TUI의 D와 같은 처리. 자기 세션이 통째로 사라지면 detach-on-destroy 때문에
    // 클라이언트가 떨어진다. 창을 죽이기 직전에만 다른 세션으로 옮긴다.
    const alive = sessionsAfterKill(panes, new Set(plan.windows.map((w) => w.windowId)));
    let beforeKill: (() => void) | undefined;
    if (self && !alive.has(self.sessionName)) {
      const other = [...alive][0];
      if (!other) {
        throw new Error("마지막 창이라 지울 수 없습니다. 다른 세션을 먼저 여세요");
      }
      beforeKill = () => {
        try {
          switchClient(other);
        } catch {
          // 붙어 있는 클라이언트가 없으면 옮길 화면도 없다. 여기서 던지면 git이 이미
          // worktree를 지운 뒤라 창만 남는다.
        }
      };
    }

    const result = wtRemove(plan, {
      force: !!opts.force,
      currentWindowId: self?.windowId,
      beforeKill,
      panes,
    });
    console.log(JSON.stringify({ ...result, changes: plan.changes }, null, 2));
  });
wt
  .command("list")
  .option("--repo <path>", "저장소 경로 (기본: 현재 디렉토리)")
  .action((opts) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    let panes: ReturnType<typeof listPanes> = [];
    try {
      panes = listPanes();
    } catch {
      panes = [];
    }
    const entries = listWorktrees(repoRoot).map((e) => ({ ...e, windows: windowsInWorktree(panes, e.path) }));
    console.log(JSON.stringify(entries, null, 2));
  });

// 400일 안에 예정 시각이 없는 스케줄(2월 30일 같은 것)도 있다. 그걸 1970년으로 찍으면 안 된다.
function cronNextIso(spec: Parameters<typeof nextDue>[0], enabled: boolean): string | null {
  if (!enabled) return null;
  const at = nextDue(spec, Date.now());
  return at === null ? null : new Date(at).toISOString();
}

function positiveInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label}에 숫자가 아닌 값이 왔습니다: ${value}`);
  return n;
}

function loadJob(id: string): { job: CronJob; jobs: CronJob[] } {
  const cfg = readCronConfig();
  const job = cfg.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`그런 cron job이 없습니다: ${id}`);
  return { job, jobs: cfg.jobs };
}

function liveWindowIds(): string[] {
  try {
    return [...new Set(listPanes().map((p) => p.windowId))];
  } catch {
    // tmux 밖이면 창을 하나도 못 본 것으로 둔다. reaper가 도는 잡을 함부로 마감하지 않는다.
    return [];
  }
}

const cron = program.command("cron").description("스케줄에 맞춰 worktree에서 에이전트 실행");
cron
  .command("list")
  .description("등록된 잡과 다음 실행 시각")
  .option("--json", "JSON으로 출력")
  .action(async (opts) => {
    ensureDirs();
    const cfg = readCronConfig();
    const db = await openDb(dbPath());
    const last = db.lastFireByJob();
    const running = new Set(db.runningCronRuns().map((r) => r.jobId));
    db.close();
    const hookInstalled = statusHooks({ agents: ["claude"] }).some((r) => r.installed);
    const rows = cfg.jobs.map((j) => ({
      id: j.id,
      enabled: j.enabled,
      schedule: j.schedule,
      repo: j.repo,
      worktree: j.worktree.mode,
      agent: j.agent,
      nextDue: cronNextIso(j.spec, j.enabled),
      lastFireAt: last.has(j.id) ? new Date(last.get(j.id)!).toISOString() : null,
      running: running.has(j.id),
    }));
    if (opts.json) {
      console.log(JSON.stringify({ jobs: rows, errors: cfg.errors, hookInstalled }, null, 2));
      return;
    }
    if (rows.length === 0) console.log("등록된 잡이 없습니다. hive cron add로 만드세요.");
    for (const r of rows) {
      const mark = r.enabled ? (r.running ? "*" : " ") : "-";
      console.log(`${mark} ${r.id}  ${r.schedule}  ${r.worktree}  next=${r.nextDue ?? "-"}  last=${r.lastFireAt ?? "-"}`);
    }
    for (const e of cfg.errors) console.log(`! ${e}`);
    if (!hookInstalled && rows.length > 0) {
      console.log("! claude hook이 설치돼 있지 않아 cron이 띄운 창이 사이드바에서 idle로만 보입니다 (hive hook install).");
    }
  });
cron
  .command("add <id>")
  .description("잡 추가 또는 덮어쓰기")
  .requiredOption("--schedule <spec>", "cron 5필드 (예: \"0 11 * * *\")")
  .requiredOption("--repo <path>", "저장소 경로")
  .requiredOption("--prompt <text>", "에이전트에게 넘길 프롬프트")
  .option("--worktree <mode>", "reuse | new | path (기본: reuse)", "reuse")
  .option("--path <path>", "worktree=path일 때 실행할 경로")
  .option("--branch <tpl>", "worktree=new일 때 브랜치 템플릿 ({date} {job} {ts})")
  .option("--base <ref>", "새 브랜치의 base ref")
  .option("--init", "worktree=new일 때 init script도 실행")
  .option("--agent <kind>", "claude | codex (기본: claude)", "claude")
  .option("--arg <value>", "에이전트 CLI에 넘길 인자 (여러 번)", (v: string, acc: string[]) => [...acc, v], [])
  .option("--grace <ms>", "놓친 실행을 따라잡을 유예 (ms)")
  .option("--overlap <mode>", "skip | allow (기본: skip)", "skip")
  .option("--no-keep-window", "실행이 끝나면 창을 닫는다")
  .option("--disabled", "꺼진 상태로 추가")
  .action((id, opts) => {
    const spec = parseCron(opts.schedule);
    if (!spec) throw new Error(`schedule을 읽을 수 없습니다: ${opts.schedule}`);
    let worktree: CronWorktree;
    switch (opts.worktree) {
      case "reuse":
        worktree = { mode: "reuse" };
        break;
      case "path":
        if (!opts.path) throw new Error("--worktree path 에는 --path 가 필요합니다");
        worktree = { mode: "path", path: resolve(opts.path) };
        break;
      case "new":
        if (!opts.branch) throw new Error("--worktree new 에는 --branch 가 필요합니다");
        worktree = { mode: "new", branch: opts.branch, base: opts.base, init: !!opts.init };
        break;
      default:
        throw new Error(`모르는 --worktree 값: ${opts.worktree}`);
    }
    const cfg = readCronConfig();
    const before = cfg.jobs.find((j) => j.id === id);
    const stored: CronJob = {
      id,
      enabled: !opts.disabled,
      schedule: opts.schedule,
      spec,
      repo: resolve(opts.repo),
      worktree,
      agent: opts.agent,
      args: opts.arg as string[],
      prompt: opts.prompt,
      graceMs: positiveInt(opts.grace, "--grace") ?? DEFAULT_GRACE_MS,
      overlap: opts.overlap,
      keepWindow: opts.keepWindow !== false,
      // 만든 시각보다 앞선 예정 시각은 흘려보낸다. 안 그러면 오늘 11시가 지난 뒤 잡을 만들면 곧바로 한 번 돈다.
      createdAt: before?.createdAt ?? Date.now(),
    };
    writeCronConfig(upsertJob(cfg.jobs, stored));
    console.log(JSON.stringify({ id, updated: !!before }, null, 2));
  });
cron
  .command("rm <id>")
  .description("잡 삭제")
  .action((id) => {
    const cfg = readCronConfig();
    const { jobs, removed } = removeJob(cfg.jobs, id);
    if (!removed) throw new Error(`그런 cron job이 없습니다: ${id}`);
    writeCronConfig(jobs);
    console.log(JSON.stringify({ id, removed }, null, 2));
  });
cron
  .command("enable <id>")
  .description("잡 켜기")
  .action((id) => {
    const { job, jobs } = loadJob(id);
    writeCronConfig(upsertJob(jobs, { ...job, enabled: true }));
    console.log(JSON.stringify({ id, enabled: true }, null, 2));
  });
cron
  .command("disable <id>")
  .description("잡 끄기")
  .action((id) => {
    const { job, jobs } = loadJob(id);
    writeCronConfig(upsertJob(jobs, { ...job, enabled: false }));
    console.log(JSON.stringify({ id, enabled: false }, null, 2));
  });
cron
  .command("run <id>")
  .description("잡을 지금 실행한다. 수집기가 자식으로 부르는 자리이기도 하다")
  .option("--fire-at <ms>", "소비할 예정 시각 (기본: 지금)")
  .option("--claim <rowid>", "수집기가 이미 잡아 둔 cron_runs 행")
  .option("--force", "이미 돈 예정 시각이어도 지금 시각으로 새로 잡는다")
  .action(async (id, opts) => {
    ensureDirs();
    const { job } = loadJob(id);
    const now = Date.now();
    const fireAt = opts.force ? now : (positiveInt(opts.fireAt, "--fire-at") ?? now);
    const db = await openDb(dbPath());
    try {
      const res = executeJob({
        db,
        job,
        fireAt,
        runId: positiveInt(opts.claim, "--claim") ?? null,
        serverKey: cronServerKey(),
        now,
      });
      console.log(JSON.stringify({ ...res, fireAt }, null, 2));
      if (res.status === "failed") process.exitCode = 1;
    } finally {
      db.close();
    }
  });
cron
  .command("runs")
  .description("실행 이력")
  .option("--id <job>", "잡 하나만")
  .option("--limit <n>", "최대 개수 (기본: 20)")
  .option("--json", "JSON으로 출력")
  .action(async (opts) => {
    ensureDirs();
    const db = await openDb(dbPath());
    const rows = db.listCronRuns(opts.id, positiveInt(opts.limit, "--limit") ?? 20);
    db.close();
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    for (const r of rows) {
      const fire = new Date(r.fireAt).toISOString();
      console.log(`${fire}  ${r.jobId}  ${r.status}  ${r.windowId ?? "-"}  ${r.error ?? ""}`.trimEnd());
    }
  });
cron
  .command("next")
  .description("다음 실행 시각만 계산한다 (디버깅)")
  .option("--at <iso>", "이 시각 기준으로 계산")
  .action((opts) => {
    const from = opts.at ? new Date(opts.at).getTime() : Date.now();
    if (Number.isNaN(from)) throw new Error(`시각을 읽을 수 없습니다: ${opts.at}`);
    const cfg = readCronConfig();
    console.log(
      JSON.stringify(
        cfg.jobs.map((j) => {
          const at = nextDue(j.spec, from);
          return { id: j.id, schedule: j.schedule, nextDue: at === null ? null : new Date(at).toISOString() };
        }),
        null,
        2
      )
    );
  });
cron
  .command("tick")
  .description("한 번 평가하고 실행한 뒤 끝낸다. crontab에 걸어도 된다")
  .option("--spawn", "실행을 자식 프로세스에 떼어낸다 (기본: 이 프로세스에서 실행)")
  .action(async (opts) => {
    ensureDirs();
    const db = await openDb(dbPath());
    try {
      const res = cronTick({ db, now: Date.now(), liveWindowIds: liveWindowIds(), inline: !opts.spawn, serverKey: cronServerKey() });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      db.close();
    }
  });

const ab = program.command("ab").description("맥 브라우저 브리지(ab-bridge) 상태");
ab
  .command("status")
  .description("tailscale IP + CDP /json/version으로 브리지 연결 확인")
  .action(async () => {
    let raw: string | undefined;
    try {
      raw = readFileSync(abConfigPath(), "utf8");
    } catch {
      // 설정 파일이 없으면 ab-bridge와 같은 기본값으로 돈다.
    }
    const cfg = parseAbConfig(raw);
    const { status, ip } = await probeAbBridge(cfg);
    console.log(
      JSON.stringify({ installed: abLocalInstalled(), macHost: cfg.macHost, port: cfg.port, ip, status }, null, 2)
    );
  });

program
  .command("usage")
  .description("claude/codex 창 사용률 원본 출력 (TUI 없이 데이터 경로 점검용)")
  .action(() => {
    console.log(
      JSON.stringify(
        { claude: readClaudeUsage(), codex: readCodexUsage(), claudeSnapshotPath: claudeSnapshotPath() },
        null,
        2
      )
    );
  });

program
  .command("ps")
  .description("agent 상태 디버그 출력")
  .option("--json", "JSON으로 출력")
  .action(async (opts) => {
    ensureDirs();
    const db = await openDb(dbPath());
    let tmuxPid = "";
    try {
      tmuxPid = serverInfo().pid;
    } catch {
      // tmux 밖에서 실행된 경우 전체 agent를 보여준다.
    }
    let panes: ReturnType<typeof listPanes> = [];
    try {
      panes = listPanes();
    } catch {
      panes = [];
    }
    const paneByPaneId = new Map(panes.map((p) => [p.paneId, p]));
    const now = Date.now();
    const agents = tmuxPid ? db.listAgents(tmuxPid) : db.listAgents();
    const rows = agents.map((agent) => {
      const pane = paneByPaneId.get(agent.paneId);
      const eff = effectiveState(agent, now, false);
      return {
        pane: agent.paneId,
        state: eff.state,
        source: eff.source,
        prompt: agent.prompt,
        toolName: agent.toolName,
        window: pane?.windowId ?? null,
        windowName: pane?.windowName ?? null,
        session: pane?.sessionName ?? null,
        cwd: pane?.paneCurrentPath ?? null,
        lastEvent: agent.lastEvent,
        lastTs: agent.lastTs,
      };
    });
    db.close();
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      for (const r of rows) {
        console.log(`${r.pane}\t${r.state}\t${r.window ?? "-"}\t${r.windowName ?? "-"}\t${r.cwd ?? "-"}`);
      }
    }
  });

program
  .command("ingest")
  .description("스풀을 한 번 흡수하고 종료 (테스트/디버깅용)")
  .action(async () => {
    ensureDirs();
    const db = await openDb(dbPath());
    const result = ingestAll(db, spoolDir(), reduceAgent);
    db.close();
    console.log(JSON.stringify(result));
  });

async function readAllStdin(): Promise<string> {
  // statusLine으로 돌 때는 항상 파이프로 들어온다. 사람이 터미널에서 직접 쳐 본 경우엔 기다리지 않는다.
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function saveStatuslineSnapshot(raw: string): void {
  const snapshot = parseStatuslinePayload(raw);
  if (!snapshot) return;
  const path = claudeUsageSnapshotPath();
  let prevRaw: string | undefined;
  let prevMtimeMs: number | undefined;
  try {
    prevRaw = readFileSync(path, "utf8");
    prevMtimeMs = statSync(path).mtimeMs;
  } catch {
    // 아직 스냅샷이 없는 첫 실행.
  }
  if (shouldWriteSnapshot(prevRaw, snapshot, prevMtimeMs, Date.now(), SNAPSHOT_THROTTLE_MS)) {
    writeSnapshot(snapshot);
  }
}

program
  .command("statusline")
  .description("Claude Code statusLine으로 등록해 창 사용률을 스냅샷으로 저장 (원래 쓰던 statusLine은 --exec로 감싼다)")
  .option("--exec <command>", "감쌀 statusLine 명령. stdin 원문을 그대로 넘기고 출력과 종료 코드를 그대로 전달한다")
  .action(async (opts: { exec?: string }) => {
    const raw = await readAllStdin();
    try {
      saveStatuslineSnapshot(raw);
    } catch {
      // statusLine이 hive 때문에 죽으면 안 된다. 저장 실패는 조용히 넘긴다.
    }
    if (!opts.exec) return;

    const code = await new Promise<number>((done) => {
      const child = spawn("sh", ["-c", opts.exec as string], { stdio: ["pipe", "inherit", "inherit"] });
      // 감싼 명령이 stdin을 안 읽으면 EPIPE가 난다. 그걸로 hive가 죽으면 statusLine이 통째로 빈다.
      child.stdin.on("error", () => {});
      child.stdin.end(raw);
      child.on("error", () => done(1));
      child.on("close", (c, signal) => done(c ?? (signal ? 1 : 0)));
    });
    process.exit(code);
  });

program
  .command("paths")
  .description("hive가 쓰는 절대경로 출력 (README 스니펫 채우기용)")
  .action(() => {
    console.log(`execPath\t${process.execPath}`);
    console.log(`cli\t${cliEntryPath()}`);
    console.log(`hookScript\t${hookScriptPath()}`);
    console.log(`codexHookScript\t${codexHookScriptPath()}`);
    console.log(`hiveHome\t${hiveHome()}`);
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // tmux 바인딩(run-shell)으로 돌면 stderr가 어디에도 표시되지 않고 tmux는 "returned 1"만 알려준다.
  // 원인을 추적할 곳이 필요해 스택을 로그 파일에 남긴다.
  const message = err instanceof Error ? err.message : String(err);
  console.error(`hive: ${message}`);
  try {
    ensureDirs();
    const detail = err instanceof Error ? (err.stack ?? message) : message;
    appendFileSync(
      join(logsDir(), "cli-error.log"),
      `${new Date().toISOString()} ${process.argv.slice(2).join(" ")}\n${detail}\n\n`
    );
  } catch {
    // 로그도 못 남기는 상황이면 stderr 한 줄로 끝낸다.
  }
  process.exit(1);
}
