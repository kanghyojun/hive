import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDue, parseCron, type CronSpec } from "./cronSpec.js";
import { cronPath, ensureDirs } from "./paths.js";

export const DEFAULT_GRACE_MS = 6 * 3600_000;

// worktree를 job마다 고른다. reuse는 repo 경로 그대로, path는 명시한 경로,
// new는 fire마다 브랜치 템플릿으로 worktree를 만든다(이미 있으면 그걸 쓴다).
export type CronWorktree =
  | { mode: "reuse" }
  | { mode: "path"; path: string }
  | { mode: "new"; branch: string; base: string | undefined; init: boolean };

export interface CronJob {
  id: string;
  enabled: boolean;
  schedule: string;
  // 파싱된 형태. 설정 파일에는 저장하지 않는다(schedule 문자열이 원본이다).
  spec: CronSpec;
  repo: string;
  worktree: CronWorktree;
  agent: "claude" | "codex";
  // 에이전트 CLI에 그대로 넘긴다. 권한 옵션을 여기에 적는다.
  args: string[];
  prompt: string;
  graceMs: number;
  overlap: "skip" | "allow";
  keepWindow: boolean;
  createdAt: number;
}

export interface CronConfig {
  jobs: CronJob[];
  // 잡 하나가 깨져서 나머지가 안 도는 게 최악이므로 잡 단위로 걸러내고 이유만 모은다.
  errors: string[];
}

// 창 이름(cron:<id>)과 브랜치 이름에 들어간다. tmux target 구분자와 셸 확장을 피한다.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function parseWorktree(v: unknown): CronWorktree | string {
  if (v === undefined) return { mode: "reuse" };
  if (!v || typeof v !== "object") return "worktree가 객체가 아니다";
  const o = v as Record<string, unknown>;
  switch (o.mode) {
    case undefined:
    case "reuse":
      return { mode: "reuse" };
    case "path": {
      const p = str(o.path);
      return p ? { mode: "path", path: p } : "worktree.path가 없다";
    }
    case "new": {
      const branch = str(o.branch);
      if (!branch) return "worktree.branch가 없다";
      const base = str(o.base);
      return { mode: "new", branch, base, init: o.init === true };
    }
    default:
      return `모르는 worktree.mode: ${String(o.mode)}`;
  }
}

function parseJob(raw: unknown, index: number): CronJob | string {
  if (!raw || typeof raw !== "object") return `jobs[${index}]: 객체가 아니다`;
  const o = raw as Record<string, unknown>;

  const id = str(o.id);
  if (!id) return `jobs[${index}]: id가 없다`;
  if (!ID_RE.test(id)) return `${id}: id에 쓸 수 없는 문자가 있다`;

  const schedule = str(o.schedule);
  if (!schedule) return `${id}: schedule이 없다`;
  const spec = parseCron(schedule);
  if (!spec) return `${id}: schedule을 읽을 수 없다 (${schedule})`;

  const repo = str(o.repo);
  if (!repo) return `${id}: repo가 없다`;
  const prompt = str(o.prompt);
  if (!prompt) return `${id}: prompt가 없다`;

  const worktree = parseWorktree(o.worktree);
  if (typeof worktree === "string") return `${id}: ${worktree}`;

  const agent = o.agent === undefined ? "claude" : o.agent;
  if (agent !== "claude" && agent !== "codex") return `${id}: 모르는 agent (${String(agent)})`;

  const overlap = o.overlap === undefined ? "skip" : o.overlap;
  if (overlap !== "skip" && overlap !== "allow") return `${id}: 모르는 overlap (${String(overlap)})`;

  let args: string[] = [];
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || o.args.some((a) => typeof a !== "string")) return `${id}: args가 문자열 배열이 아니다`;
    args = o.args as string[];
  }

  let graceMs = DEFAULT_GRACE_MS;
  if (o.graceMs !== undefined) {
    if (typeof o.graceMs !== "number" || !Number.isFinite(o.graceMs) || o.graceMs < 0) return `${id}: graceMs가 잘못됐다`;
    graceMs = o.graceMs;
  }

  const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : 0;

  return {
    id,
    enabled: o.enabled !== false,
    schedule,
    spec,
    repo,
    worktree,
    agent,
    args,
    prompt,
    graceMs,
    overlap,
    keepWindow: o.keepWindow !== false,
    createdAt,
  };
}

export function parseCronConfig(raw: string): CronConfig {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { jobs: [], errors: ["cron.json을 읽을 수 없다 (JSON 오류)"] };
  }
  const list = (obj && typeof obj === "object" ? (obj as { jobs?: unknown }).jobs : undefined) ?? [];
  if (!Array.isArray(list)) return { jobs: [], errors: ["cron.json의 jobs가 배열이 아니다"] };

  const jobs: CronJob[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of list.entries()) {
    const parsed = parseJob(entry, i);
    if (typeof parsed === "string") {
      errors.push(parsed);
      continue;
    }
    if (seen.has(parsed.id)) {
      errors.push(`${parsed.id}: id가 겹쳐서 뒤엣것을 버린다`);
      continue;
    }
    seen.add(parsed.id);
    jobs.push(parsed);
  }
  return { jobs, errors };
}

export function readCronConfig(): CronConfig {
  let raw: string;
  try {
    raw = readFileSync(cronPath(), "utf8");
  } catch {
    return { jobs: [], errors: [] };
  }
  return parseCronConfig(raw);
}

// spec은 schedule에서 다시 만들 수 있으므로 저장하지 않는다.
function toStored(job: CronJob): Record<string, unknown> {
  const { spec: _spec, ...rest } = job;
  return rest;
}

export function writeCronConfig(jobs: CronJob[]): void {
  ensureDirs();
  const path = cronPath();
  const tmp = `${path}.tmp`;
  // 잡 목록은 손으로 만든 것이라 쓰다 말면 아프다. 임시 파일에 다 쓰고 갈아끼운다.
  writeFileSync(tmp, `${JSON.stringify({ version: 1, jobs: jobs.map(toStored) }, null, 2)}\n`);
  renameSync(tmp, path);
}

export function upsertJob(jobs: CronJob[], job: CronJob): CronJob[] {
  const at = jobs.findIndex((j) => j.id === job.id);
  if (at < 0) return [...jobs, job];
  const next = [...jobs];
  next[at] = job;
  return next;
}

export function removeJob(jobs: CronJob[], id: string): { jobs: CronJob[]; removed: boolean } {
  const next = jobs.filter((j) => j.id !== id);
  return { jobs: next, removed: next.length !== jobs.length };
}

export interface CronPlanItem {
  job: CronJob;
  fireAt: number;
}

// DB도 tmux도 모른다. 무엇을 돌릴지만 정한다.
export function planCronTick(a: {
  jobs: CronJob[];
  lastFireByJob: Map<string, number>;
  runningJobIds: Set<string>;
  now: number;
}): CronPlanItem[] {
  const plan: CronPlanItem[] = [];
  for (const job of a.jobs) {
    if (!job.enabled) continue;
    if (job.overlap === "skip" && a.runningJobIds.has(job.id)) continue;
    const fireAt = isDue({
      spec: job.spec,
      lastFireAt: a.lastFireByJob.get(job.id) ?? null,
      since: job.createdAt,
      now: a.now,
      graceMs: job.graceMs,
    });
    if (fireAt === null) continue;
    plan.push({ job, fireAt });
  }
  return plan;
}
