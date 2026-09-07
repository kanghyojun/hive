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
}

export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  } catch {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  const flush = () => {
    if (cur.path) entries.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? null });
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
  }
  flush();
  return entries;
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
  execFileSync("git", args, { encoding: "utf8" });
}

export function worktreeBasePath(repoRoot: string): string {
  const template = process.env.HIVE_WORKTREE_BASE || "{repoParent}/{repo}-worktrees";
  return template.replaceAll("{repoParent}", dirname(repoRoot)).replaceAll("{repo}", basename(repoRoot));
}
