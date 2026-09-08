import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fetchPrRef } from "./git.js";
import { worktreePathFor, wtNew, wtOpen, type WtNewResult } from "./worktree.js";

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  author: string;
  isCrossRepository: boolean;
  updatedAt: string;
}

interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  author?: { login?: string };
  isCrossRepository?: boolean;
  updatedAt: string;
}

function toPullRequest(pr: GhPullRequest): PullRequest {
  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    // 봇 계정은 author에 name이 없다. login은 언제나 있으므로 그쪽만 쓴다.
    author: pr.author?.login ?? "",
    isCrossRepository: !!pr.isCrossRepository,
    updatedAt: pr.updatedAt,
  };
}

export function parsePrList(stdout: string): PullRequest[] {
  return (JSON.parse(stdout) as GhPullRequest[]).map(toPullRequest);
}

export function parsePr(stdout: string): PullRequest {
  return toPullRequest(JSON.parse(stdout) as GhPullRequest);
}

// TUI 입력줄과 CLI가 같은 표기를 받게 한다. 목록에 #12로 보이는 걸 그대로 쳐도 되어야 한다.
export function parsePrNumber(input: string): number {
  const text = input.trim().replace(/^#/, "");
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < 1) {
    throw new Error(`PR 번호가 아닙니다: ${input}`);
  }
  return n;
}

const PR_FIELDS = "number,title,headRefName,author,isCrossRepository,updatedAt";
const PR_LIST_LIMIT = 30;

export function prListArgs(): string[] {
  return ["pr", "list", "--state", "open", "--json", PR_FIELDS, "--limit", String(PR_LIST_LIMIT)];
}

export function prViewArgs(number: number): string[] {
  return ["pr", "view", String(number), "--json", PR_FIELDS];
}

// 헤드 브랜치를 그대로 쓰면 dependabot처럼 슬래시가 겹겹인 이름이 그대로 디렉토리 이름이 된다.
// 앞에 번호를 붙이는 건 fork PR끼리 헤드 브랜치가 겹쳐도 갈라놓기 위해서다.
const SLUG_MAX = 32;

export function prBranchName(pr: { number: number; headRefName: string }): string {
  const cleaned = pr.headRefName.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-{2,}/g, "-");
  // 자르기 전에 앞을 털어야 앞에 붙은 하이픈이 글자 수를 잡아먹지 않는다.
  const slug = cleaned
    .replace(/^[-.]+/, "")
    .slice(0, SLUG_MAX)
    .replace(/[-.]+$/, "");
  return slug ? `pr-${pr.number}-${slug}` : `pr-${pr.number}`;
}

// 같은 저장소 PR과 fork PR을 한 경로로 처리하려고 refs/pull을 쓴다. 대신 upstream이 안 붙어
// push는 못 한다(리뷰용). PR에 force-push가 들어오면 로컬 브랜치와 갈라지므로 +로 덮어쓴다.
export function prFetchRefspec(pr: { number: number; headRefName: string }): string {
  return `+refs/pull/${pr.number}/head:${prBranchName(pr)}`;
}

export interface WtFromPrResult extends WtNewResult {
  branch: string;
  alreadyOpen?: string;
  // 받아오지 않고 있던 worktree를 그대로 열었다는 뜻.
  reused?: boolean;
}

export function wtFromPr(opts: {
  repoRoot: string;
  pr: PullRequest;
  noInit?: boolean;
}): WtFromPrResult {
  const branch = prBranchName(opts.pr);
  // 이미 있는 worktree에 fetch를 걸면 git이 "checked out at" 이라며 거부한다. PR은 리뷰하다
  // 나갔다 다시 들어오는 일이 잦으니, 있으면 받아오지 말고 그 자리를 열어 준다.
  if (existsSync(worktreePathFor(opts.repoRoot, branch))) {
    return { ...wtOpen({ repo: opts.repoRoot, target: branch }), branch, reused: true };
  }

  fetchPrRef(opts.repoRoot, prFetchRefspec(opts.pr));
  return { ...wtNew({ repo: opts.repoRoot, branch, noInit: opts.noInit }), branch };
}

// gh 실패는 사이드바 한 줄(41칸)에 들어가야 한다. 자주 나오는 세 가지만 짧은 말로 바꾸고
// 나머지는 stderr 첫 줄을 그대로 넘긴다. "known GitHub host" 안내에도 `gh auth login`이 들어 있어
// 인증 판정보다 먼저 걸러야 한다.
export function ghErrorMessage(err: unknown): string {
  const e = err as { code?: string; stderr?: string | Buffer; message?: string };
  if (e?.code === "ENOENT") return "gh를 찾을 수 없습니다";
  const stderr = e?.stderr ? String(e.stderr).trim() : "";
  if (/known GitHub host|no git remotes found/.test(stderr)) return "GitHub 저장소가 아닙니다";
  if (/gh auth login/.test(stderr)) return "gh 인증이 필요합니다 (gh auth login)";
  const text = stderr || e?.message || "gh 실행 실패";
  return text.split("\n")[0].trim();
}

// 41칸 사이드바에서 잘리는 건 뒤쪽이다. 고를 때 먼저 필요한 번호와 제목을 앞에 둔다.
export function prLabel(pr: { number: number; title: string; author: string }): string {
  const head = `#${pr.number} ${pr.title}`;
  return pr.author ? `${head} (${pr.author})` : head;
}

export function viewPullRequest(repoRoot: string, number: number): PullRequest {
  const out = execFileSync("gh", prViewArgs(number), {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parsePr(out);
}

// TUI에서 부르는 유일한 네트워크 호출이라 동기로 두면 그동안 사이드바가 통째로 멈춘다.
export function listPullRequests(repoRoot: string): Promise<PullRequest[]> {
  return new Promise((resolve, reject) => {
    execFile("gh", prListArgs(), { cwd: repoRoot, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parsePrList(stdout));
    });
  });
}
