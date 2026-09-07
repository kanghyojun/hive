import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  listWorktrees,
  resolveRepo,
  worktreeAdd,
  worktreeBasePath,
  worktreeChanges,
  worktreeRemove,
  type WorktreeEntry,
} from "./git.js";
import {
  insideTmux,
  killWindow,
  listPanes,
  newSession,
  sanitizeSessionName,
  sessionExists,
  switchClient,
  type PaneInfo,
} from "./tmux.js";
import { attachSidebar } from "./sidebar.js";
import { ensureDirs, logsDir, reposPath, selfCommand } from "./paths.js";

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
  sessionName?: string;
  windowId?: string;
  switched?: boolean;
}

// 이름이 겹치면 tmux가 new-session을 거부하므로 -2, -3을 붙여 비어 있는 이름을 찾는다.
export function uniqueSessionName(base: string, exists: (name: string) => boolean = sessionExists): string {
  const clean = sanitizeSessionName(base);
  if (!exists(clean)) return clean;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${clean}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`세션 이름을 정할 수 없습니다: ${clean}`);
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
  rememberRepo(repoRoot);

  const script = opts.noInit ? undefined : findInitScript(repoRoot);

  if (!insideTmux()) {
    return { path };
  }

  return openWorktreeSession({ path, name: safeBranch, script });
}

function openWorktreeSession(opts: { path: string; name: string; script?: string }): WtNewResult {
  const [node, cli] = selfCommand();
  const runInitArgs = opts.script ? `${shQuote(opts.path)} ${shQuote(opts.script)}` : shQuote(opts.path);
  const windowCommand = `${shQuote(node)} ${shQuote(cli)} wt run-init ${runInitArgs}; exec \${SHELL:-sh}`;
  // worktree 하나가 세션 하나다. 같은 세션에 window로 붙이면 브랜치를 오갈 때마다 window 목록이 섞인다.
  const { sessionName, windowId } = newSession({
    name: uniqueSessionName(opts.name),
    cwd: opts.path,
    command: windowCommand,
  });

  attachSidebar(sessionName, windowId);

  // run-shell처럼 붙어 있는 클라이언트가 없는 자리에서 부르면 switch-client가 실패한다.
  // 세션은 이미 만들어졌으니 이동 실패는 결과로만 알리고 넘어간다.
  let switched = true;
  try {
    switchClient(sessionName);
  } catch {
    switched = false;
  }

  return { path: opts.path, sessionName, windowId, switched };
}

function readRepos(): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(reposPath(), "utf8"));
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// 창이 하나도 안 떠 있는 저장소는 tmux만 봐서는 알 수 없다. wt를 한 번이라도 쓴 저장소를 적어 둔다.
export function rememberRepo(repoRoot: string): void {
  try {
    const repos = readRepos();
    if (repos.includes(repoRoot)) return;
    ensureDirs();
    writeFileSync(reposPath(), JSON.stringify([...repos, repoRoot], null, 2));
  } catch {
    // 저장 실패는 무시. 목록에 안 뜨는 것뿐이다.
  }
}

export function knownRepos(): string[] {
  return readRepos().filter((p) => existsSync(p));
}

export function resolveWorktreeTarget(entries: WorktreeEntry[], target: string): WorktreeEntry | undefined {
  const abs = resolve(target);
  return (
    entries.find((e) => e.path === abs) ??
    entries.find((e) => e.branch === target) ??
    entries.find((e) => basename(e.path) === target)
  );
}

// symlink를 사이에 두면 git이 주는 경로와 tmux의 pane_current_path가 달라진다.
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function windowsInWorktree(
  panes: PaneInfo[],
  worktreePath: string
): { windowId: string; sessionName: string }[] {
  const root = realpathOr(worktreePath);
  const seen = new Set<string>();
  const windows: { windowId: string; sessionName: string }[] = [];
  for (const pane of panes) {
    const cwd = realpathOr(pane.paneCurrentPath);
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    if (seen.has(pane.windowId)) continue;
    seen.add(pane.windowId);
    windows.push({ windowId: pane.windowId, sessionName: pane.sessionName });
  }
  return windows;
}

export function unopenedWorktrees(entries: WorktreeEntry[], panes: PaneInfo[]): WorktreeEntry[] {
  return entries.filter((e) => !e.prunable && windowsInWorktree(panes, e.path).length === 0);
}

/**
 * 주어진 창들을 죽인 뒤에도 남는 세션 이름. 세션은 창이 하나도 안 남으면 사라지고,
 * 세션이 하나도 안 남으면 tmux 서버까지 내려간다.
 */
export function sessionsAfterKill(panes: PaneInfo[], killWindowIds: Set<string>): Set<string> {
  const alive = new Set<string>();
  for (const pane of panes) {
    if (killWindowIds.has(pane.windowId)) continue;
    alive.add(pane.sessionName);
  }
  return alive;
}

function repoRootOf(repo: string | undefined): string {
  const repoCwd = repo ? resolve(repo) : process.cwd();
  const info = resolveRepo(repoCwd);
  if (!info) throw new Error(`git 저장소를 찾을 수 없습니다: ${repoCwd}`);
  return info.repoRoot;
}

export interface WtRemovePlan {
  repoRoot: string;
  entry: WorktreeEntry;
  changes: number;
  windows: { windowId: string; sessionName: string }[];
}

export function planWtRemove(opts: { repo?: string; target: string; panes?: PaneInfo[] }): WtRemovePlan {
  const repoRoot = repoRootOf(opts.repo);
  const entry = resolveWorktreeTarget(listWorktrees(repoRoot), opts.target);
  if (!entry) throw new Error(`worktree를 찾을 수 없습니다: ${opts.target}`);
  if (entry.path === repoRoot) throw new Error("메인 저장소는 지울 수 없습니다");
  return {
    repoRoot,
    entry,
    changes: worktreeChanges(entry.path),
    windows: windowsInWorktree(opts.panes ?? listPanes(), entry.path),
  };
}

export interface WtRemoveResult {
  path: string;
  killedWindows: number;
  skippedReason?: string;
}

// git을 먼저 부른다. git이 거부하면 tmux는 아무것도 안 건드린 상태로 남는다.
export function wtRemove(
  plan: WtRemovePlan,
  opts: { force: boolean; currentWindowId?: string }
): WtRemoveResult {
  if (plan.changes > 0 && !opts.force) {
    throw new Error(`커밋 안 된 변경이 ${plan.changes}개 있습니다. --force로 지우세요`);
  }
  rememberRepo(plan.repoRoot);
  worktreeRemove({ repoRoot: plan.repoRoot, path: plan.entry.path, force: opts.force });

  if (plan.windows.length === 0) return { path: plan.entry.path, killedWindows: 0 };

  // 마지막 세션이 사라지면 tmux 서버까지 내려간다(실측). 남는 세션이 없을 때만 창을 그대로 둔다.
  // 세션 이름이 아니라 창 단위로 본다. 대상 창을 다 죽여도 다른 창이 남는 세션은 살아남는다.
  const killIds = new Set(plan.windows.map((w) => w.windowId));
  if (sessionsAfterKill(listPanes(), killIds).size === 0) {
    return { path: plan.entry.path, killedWindows: 0, skippedReason: "마지막 창이라 창은 남겼습니다" };
  }

  // 자기 창이 먼저 죽으면 이 프로세스가 끝나 나머지가 안 죽는다.
  const ordered = [...plan.windows].sort(
    (a, b) => Number(a.windowId === opts.currentWindowId) - Number(b.windowId === opts.currentWindowId)
  );
  let killedWindows = 0;
  for (const w of ordered) {
    try {
      killWindow(w.windowId);
      killedWindows += 1;
    } catch {
      // 이미 닫힌 창은 넘어간다.
    }
  }
  return { path: plan.entry.path, killedWindows };
}

export function wtOpen(opts: {
  repo?: string;
  target: string;
  init?: boolean;
  panes?: PaneInfo[];
}): WtNewResult & { alreadyOpen?: string } {
  const repoRoot = repoRootOf(opts.repo);
  rememberRepo(repoRoot);
  const entry = resolveWorktreeTarget(listWorktrees(repoRoot), opts.target);
  if (!entry) throw new Error(`worktree를 찾을 수 없습니다: ${opts.target}`);
  if (entry.prunable) {
    throw new Error("디렉토리가 없는 worktree입니다. git worktree prune 후 wt new로 다시 만드세요");
  }

  const windows = windowsInWorktree(opts.panes ?? listPanes(), entry.path);
  if (windows.length > 0) {
    const sessionName = windows[0].sessionName;
    try {
      switchClient(sessionName);
    } catch {
      // 붙어 있는 클라이언트가 없으면 이동만 못 한다.
    }
    return { path: entry.path, sessionName, alreadyOpen: sessionName };
  }

  if (!insideTmux()) {
    return { path: entry.path };
  }

  return openWorktreeSession({
    path: entry.path,
    name: (entry.branch ?? basename(entry.path)).replaceAll("/", "-"),
    script: opts.init ? findInitScript(repoRoot) : undefined,
  });
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
