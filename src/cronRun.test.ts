import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCron } from "./cronSpec.js";
import { DEFAULT_GRACE_MS, type CronJob } from "./cron.js";
import { buildLaunchCommand, resolveJobCwd } from "./cronRun.js";
import { resolveRepo, worktreeAdd } from "./git.js";

// resolveJobCwd만 git을 건드린다. 파일시스템은 진짜 임시 디렉토리를 쓴다.
vi.mock("./git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git.js")>()),
  resolveRepo: vi.fn(),
  worktreeAdd: vi.fn(),
}));
vi.mock("./worktree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worktree.js")>()),
  rememberRepo: vi.fn(),
}));

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "j1",
    enabled: true,
    schedule: "0 11 * * *",
    spec: parseCron("0 11 * * *")!,
    repo: "/tmp/repo",
    worktree: { mode: "reuse" },
    agent: "claude",
    args: [],
    prompt: "할 일을 정리해라",
    graceMs: DEFAULT_GRACE_MS,
    overlap: "skip",
    keepWindow: true,
    createdAt: 0,
    ...over,
  };
}

describe("buildLaunchCommand", () => {
  it("프롬프트를 인자로 주고 창을 남긴다", () => {
    expect(buildLaunchCommand(job())).toBe("'claude' '할 일을 정리해라'; exec ${SHELL:-sh}");
  });

  it("args를 프롬프트 앞에 그대로 넣는다", () => {
    expect(buildLaunchCommand(job({ args: ["--permission-mode", "acceptEdits"] }))).toBe(
      "'claude' '--permission-mode' 'acceptEdits' '할 일을 정리해라'; exec ${SHELL:-sh}"
    );
  });

  it("keepWindow가 false면 셸을 안 남긴다", () => {
    expect(buildLaunchCommand(job({ keepWindow: false }))).toBe("'claude' '할 일을 정리해라'");
  });

  it("작은따옴표가 든 프롬프트도 한 덩어리로 남는다", () => {
    const cmd = buildLaunchCommand(job({ prompt: "don't stop" }));
    expect(cmd).toBe("'claude' 'don'\\''t stop'; exec ${SHELL:-sh}");
  });

  it("codex도 같은 모양이다", () => {
    expect(buildLaunchCommand(job({ agent: "codex", keepWindow: false }))).toBe("'codex' '할 일을 정리해라'");
  });

  it("initPrefix를 주면 앞에 붙는다", () => {
    expect(buildLaunchCommand(job({ keepWindow: false }), "init.sh 실행")).toBe(
      "init.sh 실행; 'claude' '할 일을 정리해라'"
    );
  });
});

describe("resolveJobCwd", () => {
  let base: string;
  const fireAt = new Date(2026, 8, 9, 11, 0, 0, 0).getTime();

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "hive-cronrun-"));
    process.env.HIVE_WORKTREE_BASE = join(base, "wt");
    vi.mocked(resolveRepo).mockReturnValue({ toplevel: join(base, "repo"), repoRoot: join(base, "repo"), branch: "main" });
    vi.mocked(worktreeAdd).mockReset();
  });
  afterEach(() => {
    delete process.env.HIVE_WORKTREE_BASE;
    vi.restoreAllMocks();
  });

  it("reuse는 repo 경로를 그대로 쓴다", () => {
    const repo = join(base, "repo");
    mkdirSync(repo);
    expect(resolveJobCwd(job({ repo }), fireAt)).toEqual({ cwd: repo, created: false });
    expect(worktreeAdd).not.toHaveBeenCalled();
  });

  it("경로가 없으면 던진다", () => {
    expect(() => resolveJobCwd(job({ repo: join(base, "없음") }), fireAt)).toThrow(/없/);
  });

  it("path 모드는 명시한 경로를 쓴다", () => {
    const dir = join(base, "elsewhere");
    mkdirSync(dir);
    expect(resolveJobCwd(job({ worktree: { mode: "path", path: dir } }), fireAt)).toEqual({ cwd: dir, created: false });
  });

  it("new는 브랜치 템플릿을 풀어 worktree를 만든다", () => {
    const repo = join(base, "repo");
    mkdirSync(repo);
    const got = resolveJobCwd(
      job({ repo, worktree: { mode: "new", branch: "cron/{job}-{date}", base: "main", init: false } }),
      fireAt
    );
    expect(got.created).toBe(true);
    expect(got.cwd).toBe(join(base, "wt", "cron-j1-2026-09-09"));
    expect(worktreeAdd).toHaveBeenCalledWith({
      repoRoot: repo,
      branch: "cron/j1-2026-09-09",
      path: got.cwd,
      base: "main",
    });
  });

  it("new인데 worktree가 이미 있으면 그걸 쓴다", () => {
    const repo = join(base, "repo");
    mkdirSync(repo);
    const path = join(base, "wt", "cron-j1-2026-09-09");
    mkdirSync(path, { recursive: true });
    const got = resolveJobCwd(
      job({ repo, worktree: { mode: "new", branch: "cron/{job}-{date}", base: undefined, init: false } }),
      fireAt
    );
    expect(got).toEqual({ cwd: path, created: false });
    expect(worktreeAdd).not.toHaveBeenCalled();
  });

  it("git 저장소가 아니면 던진다", () => {
    vi.mocked(resolveRepo).mockReturnValue(null);
    expect(() =>
      resolveJobCwd(job({ worktree: { mode: "new", branch: "x", base: undefined, init: false } }), fireAt)
    ).toThrow(/저장소/);
  });
});
