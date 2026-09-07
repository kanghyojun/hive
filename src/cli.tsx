#!/usr/bin/env node
// node:sqlite ExperimentalWarning은 db.ts가 동적 import하기 전에 여기서 미리 걸러야 한다(실측).
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name !== "ExperimentalWarning") console.error(w);
});

import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import {
  dbPath,
  ensureDirs,
  hiveHome,
  hookScriptPath,
  logsDir,
  selfCommand,
  setHiveHomeOverride,
  spoolDir,
} from "./paths.js";
import { setPaneOverride, setTmuxSocketOverride, listPanes, serverInfo } from "./tmux.js";
import { hideSidebar, showSidebar, toggleSidebar, cleanupFromTui } from "./sidebar.js";
import { installHooks, statusHooks, uninstallHooks } from "./hookInstall.js";
import { createInitScript, listWorktrees, wtNew, wtRunInit } from "./worktree.js";
import { resolveRepo } from "./git.js";
import { openDb } from "./db.js";
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
  .command("show")
  .action(() => showSidebar());
sidebar
  .command("hide")
  .action(() => hideSidebar());
sidebar
  .command("toggle")
  .action(() => toggleSidebar());

const hook = program.command("hook").description("Claude Code hook 등록 관리");
hook
  .command("install")
  .option("--settings <path>", "settings.json 경로")
  .option("--dry-run", "실제로 쓰지 않고 결과만 표시")
  .action((opts) => {
    const result = installHooks({ settingsPath: opts.settings, dryRun: opts.dryRun });
    console.log(JSON.stringify(result, null, 2));
  });
hook
  .command("uninstall")
  .option("--settings <path>", "settings.json 경로")
  .option("--dry-run", "실제로 쓰지 않고 결과만 표시")
  .action((opts) => {
    const result = uninstallHooks({ settingsPath: opts.settings, dryRun: opts.dryRun });
    console.log(JSON.stringify(result, null, 2));
  });
hook
  .command("status")
  .option("--settings <path>", "settings.json 경로")
  .action((opts) => {
    const result = statusHooks({ settingsPath: opts.settings });
    for (const { event, installed } of result) {
      console.log(`${installed ? "installed" : "missing  "}\t${event}`);
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
  .command("list")
  .option("--repo <path>", "저장소 경로 (기본: 현재 디렉토리)")
  .action((opts) => {
    const repoRoot = resolveRepoRoot(opts.repo);
    console.log(JSON.stringify(listWorktrees(repoRoot), null, 2));
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

program
  .command("paths")
  .description("hive가 쓰는 절대경로 출력 (README 스니펫 채우기용)")
  .action(() => {
    const [node, cli] = selfCommand();
    console.log(`execPath\t${node}`);
    console.log(`cli\t${cli}`);
    console.log(`hookScript\t${hookScriptPath()}`);
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
