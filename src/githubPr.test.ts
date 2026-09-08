import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ghErrorMessage,
  parsePr,
  parsePrList,
  parsePrNumber,
  prBranchName,
  prFetchRefspec,
  prLabel,
  prListArgs,
  prViewArgs,
  wtFromPr,
} from "./githubPr.js";
import { fetchPrRef } from "./git.js";
import { wtNew, wtOpen } from "./worktree.js";

// wtFromPr가 "받아올까 열기만 할까"를 어떻게 가르는지만 본다. 실제 git/tmux는 부르지 않는다.
vi.mock("./git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git.js")>()),
  fetchPrRef: vi.fn(),
}));
vi.mock("./worktree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worktree.js")>()),
  wtNew: vi.fn(),
  wtOpen: vi.fn(),
}));

// gh 2.93.0의 `pr list --json number,title,headRefName,author,isCrossRepository,updatedAt` 실측 출력.
// 두 번째 항목(dependabot)은 봇이라 author에 name 필드가 없다.
const GH_JSON = `[{"author":{"id":"U_kgDOBwVLSQ","is_bot":false,"login":"BlasCasale","name":"Blas Casale"},"headRefName":"fix-14372","isCrossRepository":true,"number":14384,"title":"fix: solving the issue 14372 for the panic","updatedAt":"2026-09-08T02:13:27Z"},{"author":{"is_bot":true,"login":"app/dependabot"},"headRefName":"dependabot/go_modules/github.com/yuin/goldmark-1.8.6","isCrossRepository":false,"number":14378,"title":"chore(deps): bump goldmark from 1.8.5 to 1.8.6","updatedAt":"2026-09-07T14:50:42Z"}]`;

describe("parsePrList", () => {
  it("번호와 제목과 헤드 브랜치를 읽는다", () => {
    const prs = parsePrList(GH_JSON);
    expect(prs).toHaveLength(2);
    expect(prs[0]).toMatchObject({
      number: 14384,
      title: "fix: solving the issue 14372 for the panic",
      headRefName: "fix-14372",
      isCrossRepository: true,
    });
  });

  it("작성자는 login으로 읽는다", () => {
    const prs = parsePrList(GH_JSON);
    expect(prs[0].author).toBe("BlasCasale");
    expect(prs[1].author).toBe("app/dependabot");
  });

  it("열린 PR이 없으면 빈 배열이다", () => {
    expect(parsePrList("[]")).toEqual([]);
  });

  it("JSON이 아니면 던진다", () => {
    expect(() => parsePrList("not json")).toThrow();
  });
});

describe("prBranchName", () => {
  it("번호와 헤드 브랜치를 이어 붙인다", () => {
    expect(prBranchName({ number: 12, headRefName: "fix-login" })).toBe("pr-12-fix-login");
  });

  it("슬래시는 하이픈으로 바꾼다", () => {
    expect(prBranchName({ number: 7, headRefName: "feature/login" })).toBe("pr-7-feature-login");
  });

  it("git 브랜치명에 못 쓰는 글자를 하이픈으로 바꾼다", () => {
    expect(prBranchName({ number: 3, headRefName: "wip: 로그인^2" })).toBe("pr-3-wip-2");
  });

  it("하이픈이 이어지면 하나로 줄인다", () => {
    expect(prBranchName({ number: 3, headRefName: "a//b" })).toBe("pr-3-a-b");
  });

  it("앞뒤에 남는 하이픈과 점은 버린다", () => {
    expect(prBranchName({ number: 3, headRefName: "/a.b./" })).toBe("pr-3-a.b");
  });

  it("긴 헤드 브랜치는 잘라내되 끝에 하이픈을 남기지 않는다", () => {
    const long = prBranchName({
      number: 14378,
      headRefName: "dependabot/go_modules/github.com/yuin/goldmark-1.8.6",
    });
    expect(long).toBe("pr-14378-dependabot-go_modules-github.com");
    expect(long.length).toBeLessThanOrEqual(50);
  });

  it("헤드 브랜치에 쓸 글자가 하나도 없으면 번호만 쓴다", () => {
    expect(prBranchName({ number: 9, headRefName: "///" })).toBe("pr-9");
  });
});

describe("prFetchRefspec", () => {
  it("PR의 head를 로컬 브랜치로 끌어오는 refspec을 만든다", () => {
    expect(prFetchRefspec({ number: 12, headRefName: "fix-login" })).toBe(
      "+refs/pull/12/head:pr-12-fix-login",
    );
  });

  it("fork PR도 같은 refspec으로 끌어온다", () => {
    expect(prFetchRefspec({ number: 14384, headRefName: "fix-14372" })).toBe(
      "+refs/pull/14384/head:pr-14384-fix-14372",
    );
  });

  it("force-push된 PR을 덮어쓸 수 있게 + 를 붙인다", () => {
    expect(prFetchRefspec({ number: 1, headRefName: "a" }).startsWith("+")).toBe(true);
  });
});

describe("wtFromPr", () => {
  const pr = {
    number: 12,
    title: "로그인 고침",
    headRefName: "fix-login",
    author: "kanghyojun",
    isCrossRepository: false,
    updatedAt: "2026-09-08T02:13:27Z",
  };
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "hive-pr-"));
    process.env.HIVE_WORKTREE_BASE = base;
    vi.mocked(fetchPrRef).mockReset();
    vi.mocked(wtNew).mockReset().mockReturnValue({ path: join(base, "pr-12-fix-login") });
    vi.mocked(wtOpen).mockReset().mockReturnValue({ path: join(base, "pr-12-fix-login") });
  });
  afterEach(() => {
    delete process.env.HIVE_WORKTREE_BASE;
  });

  it("worktree가 없으면 PR head를 받아 새로 만든다", () => {
    const result = wtFromPr({ repoRoot: "/repo", pr });
    expect(fetchPrRef).toHaveBeenCalledWith("/repo", "+refs/pull/12/head:pr-12-fix-login");
    expect(wtNew).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "/repo", branch: "pr-12-fix-login" }),
    );
    expect(result.branch).toBe("pr-12-fix-login");
    expect(result.reused).toBeFalsy();
  });

  it("worktree가 이미 있으면 받아오지 않고 그 자리를 연다", () => {
    mkdirSync(join(base, "pr-12-fix-login"));
    const result = wtFromPr({ repoRoot: "/repo", pr });
    // 열린 브랜치로는 fetch가 거부되고, 리뷰하다 다시 들어오는 게 흔한 길이다.
    expect(fetchPrRef).not.toHaveBeenCalled();
    expect(wtNew).not.toHaveBeenCalled();
    expect(wtOpen).toHaveBeenCalledWith(expect.objectContaining({ target: "pr-12-fix-login" }));
    expect(result.reused).toBe(true);
  });

  it("--no-init은 wtNew로 그대로 넘긴다", () => {
    wtFromPr({ repoRoot: "/repo", pr, noInit: true });
    expect(wtNew).toHaveBeenCalledWith(expect.objectContaining({ noInit: true }));
  });
});

describe("ghErrorMessage", () => {
  const failure = (stderr: string): Error =>
    Object.assign(new Error("Command failed: gh pr list"), { stderr });

  it("gh가 없으면 설치부터 알린다", () => {
    const err = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    expect(ghErrorMessage(err)).toBe("gh를 찾을 수 없습니다");
  });

  it("원격이 없으면 GitHub 저장소가 아니라고 알린다", () => {
    expect(ghErrorMessage(failure("no git remotes found\n"))).toBe("GitHub 저장소가 아닙니다");
  });

  it("GitHub 아닌 원격만 있어도 GitHub 저장소가 아니라고 알린다", () => {
    const stderr =
      "none of the git remotes configured for this repository point to a known GitHub host. " +
      "To tell gh about a new GitHub host, please use `gh auth login`\n";
    expect(ghErrorMessage(failure(stderr))).toBe("GitHub 저장소가 아닙니다");
  });

  it("인증이 안 됐으면 gh auth login을 알린다", () => {
    const stderr = "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com\n";
    expect(ghErrorMessage(failure(stderr))).toBe("gh 인증이 필요합니다 (gh auth login)");
  });

  it("모르는 실패는 stderr 첫 줄을 그대로 보여준다", () => {
    expect(ghErrorMessage(failure("HTTP 502: upstream 죽음\n두 번째 줄\n"))).toBe(
      "HTTP 502: upstream 죽음",
    );
  });

  it("stderr가 없으면 에러 message를 쓴다", () => {
    expect(ghErrorMessage(new Error("무슨 일인가 났다"))).toBe("무슨 일인가 났다");
  });
});

describe("gh 명령 인자", () => {
  it("목록은 열린 PR만 필요한 필드로 받아온다", () => {
    expect(prListArgs()).toEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,title,headRefName,author,isCrossRepository,updatedAt",
      "--limit",
      "30",
    ]);
  });

  it("단건 조회는 목록과 같은 필드를 받아온다", () => {
    expect(prViewArgs(12)).toEqual([
      "pr",
      "view",
      "12",
      "--json",
      "number,title,headRefName,author,isCrossRepository,updatedAt",
    ]);
  });
});

describe("parsePr", () => {
  it("단건 조회 출력을 하나로 읽는다", () => {
    const out = `{"author":{"login":"BlasCasale"},"headRefName":"fix-14372","isCrossRepository":true,"number":14384,"title":"fix: 패닉 고침","updatedAt":"2026-09-08T02:13:27Z"}`;
    expect(parsePr(out)).toMatchObject({ number: 14384, author: "BlasCasale", headRefName: "fix-14372" });
  });
});

describe("parsePrNumber", () => {
  it("숫자를 그대로 읽는다", () => {
    expect(parsePrNumber("12")).toBe(12);
  });

  it("앞에 붙은 #은 떼고 읽는다", () => {
    expect(parsePrNumber("#12")).toBe(12);
  });

  it("앞뒤 공백을 흘린다", () => {
    expect(parsePrNumber(" 12 ")).toBe(12);
  });

  it("숫자가 아니면 던진다", () => {
    expect(() => parsePrNumber("main")).toThrow(/PR 번호/);
  });

  it("0이나 음수는 PR 번호가 아니다", () => {
    expect(() => parsePrNumber("0")).toThrow(/PR 번호/);
    expect(() => parsePrNumber("-3")).toThrow(/PR 번호/);
  });
});

describe("prLabel", () => {
  it("번호와 제목과 작성자를 한 줄로 적는다", () => {
    expect(prLabel({ number: 12, title: "로그인 고침", author: "kanghyojun" })).toBe(
      "#12 로그인 고침 (kanghyojun)",
    );
  });

  it("작성자를 모르면 괄호를 붙이지 않는다", () => {
    expect(prLabel({ number: 12, title: "로그인 고침", author: "" })).toBe("#12 로그인 고침");
  });
});
