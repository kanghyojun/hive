import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const CONTIGUOUS_BONUS = 5;
const HEAD_BONUS = 10;

/**
 * 질의 글자가 순서대로 다 들어 있으면 점수를, 아니면 null을 준다.
 * 붙어 있는 매치와 이름 첫 글자부터 시작하는 매치에 가산점을 줘서 정렬에 쓴다.
 */
export function fuzzyMatch(name: string, query: string): number | null {
  if (query === "") return 0;
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of needle) {
    const at = haystack.indexOf(ch, from);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += CONTIGUOUS_BONUS;
    if (at === 0) score += HEAD_BONUS;
    prev = at;
    from = at + 1;
  }
  return score;
}

export interface DirCandidate {
  name: string;
  path: string;
  isRepo: boolean;
}

export function expandHome(input: string, home: string = homedir()): string {
  if (input === "~") return home;
  // join을 쓰면 "~/"의 끝 슬래시가 사라져 홈이 아니라 홈의 부모를 뒤지게 된다.
  if (input.startsWith("~/")) return home + input.slice(1);
  return input;
}

/**
 * 입력 경로의 마지막 세그먼트를 질의로 보고 그 부모 디렉토리의 하위 디렉토리를 걸러 준다.
 * 홈 전체를 훑지 않고 한 단계씩만 읽는다.
 */
export function listDirCandidates(input: string, home: string = homedir()): DirCandidate[] {
  const expanded = expandHome(input, home);
  const listWhole = expanded.endsWith("/");
  const dir = listWhole ? expanded : dirname(expanded);
  const query = listWhole ? "" : basename(expanded);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 아직 다 안 친 경로거나 못 읽는 디렉토리다. 빈 목록이 곧 "여긴 없다"는 표시다.
    return [];
  }

  const showHidden = query.startsWith(".");
  const scored: { candidate: DirCandidate; score: number }[] = [];
  for (const entry of entries) {
    if (!isDirEntry(dir, entry)) continue;
    if (!showHidden && entry.name.startsWith(".")) continue;
    const score = fuzzyMatch(entry.name, query);
    if (score === null) continue;
    const path = join(dir, entry.name);
    scored.push({ candidate: { name: entry.name, path, isRepo: isRepoDir(path) }, score });
  }

  // 점수가 같으면 짧은 이름을 앞에 둔다. "hi"를 쳤을 때 highlevel보다 hive가 먼저다.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.name.length - b.candidate.name.length ||
      a.candidate.name.localeCompare(b.candidate.name)
  );
  return scored.map((s) => s.candidate);
}

// 심볼릭 링크로 걸어 둔 저장소는 readdir이 디렉토리로 안 알려준다. 링크만 따라가 본다.
function isDirEntry(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    // 끊어진 링크.
    return false;
  }
}

// worktree는 .git이 디렉토리가 아니라 gitdir을 가리키는 파일이다. 존재 여부만 본다.
function isRepoDir(path: string): boolean {
  return existsSync(join(path, ".git"));
}

export function collapseHome(path: string, home: string = homedir()): string {
  if (path === home) return "~";
  // 구분자까지 봐야 /home/ed가 /home/edward를 삼키지 않는다.
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** 커서가 항상 보이도록 후보 목록을 자를 시작 위치. */
export function sliceStart(cursor: number, total: number, max: number): number {
  return Math.max(0, Math.min(cursor - max + 1, total - max));
}
