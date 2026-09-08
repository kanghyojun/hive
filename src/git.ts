import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export interface RepoInfo {
  toplevel: string;
  repoRoot: string;
  branch: string;
}

const cache = new Map<string, { value: RepoInfo | null; at: number }>();
const CACHE_TTL_MS = 60_000;

export function resolveRepo(cwd: string): RepoInfo | null {
  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const value = resolveRepoUncached(cwd);
  cache.set(cwd, { value, at: now });
  return value;
}

function repoRootFrom(toplevel: string, commonDir: string): string {
  // 주 저장소에서는 common-dir이 상대경로 ".git"으로 나오므로 toplevel 기준으로 절대화한다.
  return dirname(resolve(toplevel, commonDir));
}

function resolveRepoUncached(cwd: string): RepoInfo | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const [toplevel, commonDir, branch] = out.trim().split("\n");
    return { toplevel, repoRoot: repoRootFrom(toplevel, commonDir), branch };
  } catch {
    // 커밋이 하나도 없는 저장소(unborn HEAD)는 `--abbrev-ref HEAD`가 포함된 호출 전체가 rc=128로 실패한다(실측).
    // 이 경우만 symbolic-ref로 branch를 따로 구한다.
    try {
      const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const [toplevel, commonDir] = out.trim().split("\n");
      const branch = execFileSync("git", ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return { toplevel, repoRoot: repoRootFrom(toplevel, commonDir), branch };
    } catch {
      return null;
    }
  }
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  /** 디렉토리가 사라져 admin 항목만 남은 worktree. git이 prunable 줄로 알려준다. */
  prunable: boolean;
}

export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  const flush = () => {
    if (cur.path) {
      entries.push({
        path: cur.path,
        head: cur.head ?? "",
        branch: cur.branch ?? null,
        prunable: cur.prunable ?? false,
      });
    }
    cur = {};
  };
  for (const line of out.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) cur.path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) cur.branch = line.slice("branch refs/heads/".length);
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  flush();
  return entries;
}

export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }
  return parseWorktreeList(out);
}

export function worktreeChanges(path: string): number {
  try {
    const out = execFileSync("git", ["-C", path, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// execFileSync가 만드는 message는 "Command failed: git -C <절대경로> worktree remove <절대경로>"로
// 시작해서 진짜 사유가 뒤로 밀린다. 사이드바는 41칸이라 화면에는 명령어 앞부분만 남는다.
// 사유만 한 줄로 뽑아 앞에 세운다.
export function cleanGitError(stderr: string, worktreePath: string): string {
  const msg = stderr
    .replace(/^fatal:\s*/gm, "")
    .replaceAll(worktreePath, basename(worktreePath))
    .replace(/\s+/g, " ")
    .trim();
  return msg || "git worktree remove 실패";
}

export function worktreeRemove(opts: { repoRoot: string; path: string; force?: boolean }): void {
  const args = ["-C", opts.repoRoot, "worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(opts.path);
  try {
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr !== "string" || !stderr.trim()) throw err;
    throw new Error(cleanGitError(stderr, opts.path));
  }
}

export function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `refs/heads/${branch}`], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function worktreeAdd(opts: { repoRoot: string; branch: string; path: string; base?: string }): void {
  const args = ["-C", opts.repoRoot, "worktree", "add"];
  if (branchExists(opts.repoRoot, opts.branch)) {
    args.push(opts.path, opts.branch);
  } else {
    args.push("-b", opts.branch, opts.path);
    if (opts.base) args.push(opts.base);
  }
  // stdio를 안 주면 git의 "작업 트리 준비 중" 진행 메시지가 부모 stderr로 흘러 TUI 프레임을 깨뜨린다.
  // 실패 시 stderr는 execFileSync가 던지는 Error의 message에 붙으므로 호출부 표시에는 지장이 없다.
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// hive가 판 worktree는 hive-worktrees 한 곳에 모으고, 그 안에서 저장소 이름으로 나눈다.
// 디렉토리 이름이 곧 "hive가 만든 것"이라는 표시다. 저장소마다 <이름>-worktrees를 따로 만들면
// 저장소 부모가 그 디렉토리들로 어지러워지고, 한 곳에 모으면 이번엔 브랜치 이름이 서로 부딪힌다.
export function worktreeBasePath(repoRoot: string): string {
  const template = process.env.HIVE_WORKTREE_BASE || "{repoParent}/hive-worktrees/{repo}";
  return template.replaceAll("{repoParent}", dirname(repoRoot)).replaceAll("{repo}", basename(repoRoot));
}
