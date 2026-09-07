import { chmodSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { listWorktrees, resolveRepo, worktreeAdd, worktreeBasePath } from "./git.js";
import { currentSessionName, insideTmux, newWindow } from "./tmux.js";
import { attachSidebar, hasSidebar } from "./sidebar.js";
import { ensureDirs, logsDir, selfCommand } from "./paths.js";

export { listWorktrees };

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function findInitScript(repoRoot: string): string | undefined {
  const envScript = process.env.HIVE_INIT_SCRIPT;
  if (envScript) return resolve(envScript);
  const candidate = join(repoRoot, ".hive", "init.sh");
  return existsSync(candidate) ? candidate : undefined;
}

const INIT_SCRIPT_TEMPLATE = `#!/bin/sh
# hive worktree init script. cwd = 새로 만들어진 worktree 경로. 실패해도 worktree는 유지됩니다.
set -e
if [ -f pnpm-lock.yaml ]; then pnpm install; fi
if [ -f package-lock.json ]; then npm ci; fi
if [ -f uv.lock ]; then uv sync; fi
exit 0
`;

export interface CreateInitScriptResult {
  created: boolean;
  path: string;
}

export function createInitScript(opts: { repoRoot: string; force?: boolean }): CreateInitScriptResult {
  const dir = join(opts.repoRoot, ".hive");
  const path = join(dir, "init.sh");
  if (existsSync(path) && !opts.force) return { created: false, path };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, INIT_SCRIPT_TEMPLATE);
  chmodSync(path, 0o755);
  return { created: true, path };
}

export interface WtNewOptions {
  branch: string;
  repo?: string;
  base?: string;
  noInit?: boolean;
}

export interface WtNewResult {
  path: string;
  windowId?: string;
}

export function wtNew(opts: WtNewOptions): WtNewResult {
  const repoCwd = opts.repo ? resolve(opts.repo) : process.cwd();
  const repo = resolveRepo(repoCwd);
  if (!repo) throw new Error(`git 저장소를 찾을 수 없습니다: ${repoCwd}`);
  const repoRoot = repo.repoRoot;

  const safeBranch = opts.branch.replaceAll("/", "-");
  const path = join(worktreeBasePath(repoRoot), safeBranch);
  if (existsSync(path)) throw new Error(`이미 존재하는 경로입니다: ${path}`);

  worktreeAdd({ repoRoot, branch: opts.branch, path, base: opts.base });

  const script = opts.noInit ? undefined : findInitScript(repoRoot);

  if (!insideTmux()) {
    return { path };
  }

  const [node, cli] = selfCommand();
  const runInitArgs = script ? `${shQuote(path)} ${shQuote(script)}` : shQuote(path);
  const windowCommand = `${shQuote(node)} ${shQuote(cli)} wt run-init ${runInitArgs}; exec \${SHELL:-sh}`;
  const windowId = newWindow({ name: safeBranch, cwd: path, command: windowCommand });

  const sessionName = currentSessionName();
  if (sessionName && !hasSidebar(sessionName)) {
    attachSidebar(sessionName, windowId);
  }

  return { path, windowId };
}

// `hive wt run-init <path> [<script>]`의 구현체. 새로 연 tmux window 안에서 직접 실행된다.
export function wtRunInit(path: string, script?: string): Promise<number> {
  ensureDirs();
  const logPath = join(logsDir(), `wt-${basename(path)}.log`);

  if (!script) {
    console.log("[hive] no init script");
    return Promise.resolve(0);
  }

  return new Promise((resolvePromise) => {
    const logStream = createWriteStream(logPath, { flags: "a" });
    const child = spawn("sh", [script], { cwd: path, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const msg = `[hive] init exit=${exitCode} (log: ${logPath})\n`;
      process.stdout.write(msg);
      logStream.write(msg);
      logStream.end();
      resolvePromise(exitCode);
    });
  });
}
