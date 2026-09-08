import { afterEach, describe, expect, it } from "vitest";
import { cleanGitError, parseWorktreeList, worktreeBasePath } from "./git.js";

// git 2.39.5의 `worktree list --porcelain` 실측 출력. 마지막 항목은 디렉토리를 손으로 지운 worktree다.
const PORCELAIN = `worktree /w/main
HEAD 8bdde1010fe361deda35ee91516278a2843c3132
branch refs/heads/main

worktree /w/main-worktrees/feat-x
HEAD 8bdde1010fe361deda35ee91516278a2843c3132
branch refs/heads/feat/x

worktree /w/main-worktrees/feat-y
HEAD 8bdde1010fe361deda35ee91516278a2843c3132
branch refs/heads/feat/y
prunable gitdir file points to non-existent location
`;

describe("parseWorktreeList", () => {
  it("항목 수와 경로를 그대로 읽는다", () => {
    const entries = parseWorktreeList(PORCELAIN);
    expect(entries.map((e) => e.path)).toEqual([
      "/w/main",
      "/w/main-worktrees/feat-x",
      "/w/main-worktrees/feat-y",
    ]);
  });

  it("branch는 refs/heads/ 없이 나온다", () => {
    expect(parseWorktreeList(PORCELAIN).map((e) => e.branch)).toEqual(["main", "feat/x", "feat/y"]);
  });

  it("prunable 줄이 붙은 항목만 prunable이다", () => {
    expect(parseWorktreeList(PORCELAIN).map((e) => e.prunable)).toEqual([false, false, true]);
  });

  it("detached HEAD는 branch가 null이다", () => {
    const entries = parseWorktreeList("worktree /w/d\nHEAD abc\ndetached\n");
    expect(entries).toEqual([{ path: "/w/d", head: "abc", branch: null, prunable: false }]);
  });
});

describe("cleanGitError", () => {
  // git 2.39.5 실측 stderr. 사이드바는 41칸이라 사유가 앞에 안 오면 화면에서 통째로 잘린다.
  it("fatal 접두사를 떼고 worktree 경로를 이름으로 줄인다", () => {
    const stderr = "fatal: '/home/ed/src/hive-worktrees/feat-x' contains modified or untracked files, use --force to delete it\n";
    expect(cleanGitError(stderr, "/home/ed/src/hive-worktrees/feat-x")).toBe(
      "'feat-x' contains modified or untracked files, use --force to delete it"
    );
  });

  it("여러 줄 stderr는 한 줄로 합친다", () => {
    const stderr = "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first\n";
    expect(cleanGitError(stderr, "/w/feat")).toBe(
      "cannot remove a locked working tree; use 'remove -f -f' to override or unlock first"
    );
  });

  it("stderr가 비면 자리를 지키는 문구를 쓴다", () => {
    expect(cleanGitError("   \n", "/w/feat")).toBe("git worktree remove 실패");
  });
});

describe("worktreeBasePath", () => {
  const saved = process.env.HIVE_WORKTREE_BASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.HIVE_WORKTREE_BASE;
    else process.env.HIVE_WORKTREE_BASE = saved;
  });

  it("hive-worktrees 한 곳에 모으고 그 안에서 저장소로 나눈다", () => {
    delete process.env.HIVE_WORKTREE_BASE;
    expect(worktreeBasePath("/home/ed/src/hive")).toBe("/home/ed/src/hive-worktrees/hive");
  });

  it("저장소 이름이 무엇이든 담는 디렉토리 이름은 hive-worktrees다", () => {
    delete process.env.HIVE_WORKTREE_BASE;
    expect(worktreeBasePath("/src/positivehotel/ph-daybook")).toBe(
      "/src/positivehotel/hive-worktrees/ph-daybook"
    );
  });

  it("부모가 같은 저장소들은 한 hive-worktrees를 나눠 쓴다", () => {
    delete process.env.HIVE_WORKTREE_BASE;
    expect(worktreeBasePath("/src/positivehotel/samata")).toBe("/src/positivehotel/hive-worktrees/samata");
  });

  it("HIVE_WORKTREE_BASE로 자리를 바꿀 수 있다", () => {
    process.env.HIVE_WORKTREE_BASE = "{repoParent}/wt/{repo}";
    expect(worktreeBasePath("/home/ed/src/hive")).toBe("/home/ed/src/wt/hive");
  });
});
