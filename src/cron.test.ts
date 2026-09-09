import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCron } from "./cronSpec.js";
import {
  DEFAULT_GRACE_MS,
  parseCronConfig,
  planCronTick,
  readCronConfig,
  upsertJob,
  removeJob,
  writeCronConfig,
  type CronJob,
} from "./cron.js";
import { setHiveHomeOverride } from "./paths.js";

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
    prompt: "hi",
    graceMs: DEFAULT_GRACE_MS,
    overlap: "skip",
    keepWindow: true,
    createdAt: 0,
    ...over,
  };
}

function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe("parseCronConfig", () => {
  it("정상 설정을 읽는다", () => {
    const { jobs, errors } = parseCronConfig(
      JSON.stringify({
        version: 1,
        jobs: [{ id: "a", schedule: "0 11 * * *", repo: "/r", prompt: "p" }],
      })
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].agent).toBe("claude");
    expect(jobs[0].enabled).toBe(true);
    expect(jobs[0].overlap).toBe("skip");
    expect(jobs[0].graceMs).toBe(DEFAULT_GRACE_MS);
    expect(jobs[0].worktree).toEqual({ mode: "reuse" });
  });

  it("깨진 잡 하나가 나머지를 막지 않는다", () => {
    const { jobs, errors } = parseCronConfig(
      JSON.stringify({
        jobs: [
          { id: "ok", schedule: "0 11 * * *", repo: "/r", prompt: "p" },
          { id: "bad", schedule: "이건 크론이 아니다", repo: "/r", prompt: "p" },
          { schedule: "0 11 * * *", repo: "/r", prompt: "p" },
        ],
      })
    );
    expect(jobs.map((j) => j.id)).toEqual(["ok"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("bad");
  });

  it("id가 겹치면 뒤엣것을 버린다", () => {
    const { jobs, errors } = parseCronConfig(
      JSON.stringify({
        jobs: [
          { id: "a", schedule: "0 11 * * *", repo: "/r", prompt: "p" },
          { id: "a", schedule: "0 12 * * *", repo: "/r", prompt: "p2" },
        ],
      })
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].prompt).toBe("p");
    expect(errors[0]).toContain("a");
  });

  it("JSON이 깨져도 던지지 않는다", () => {
    const { jobs, errors } = parseCronConfig("{not json");
    expect(jobs).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("worktree new는 branch가 있어야 한다", () => {
    const ok = parseCronConfig(
      JSON.stringify({
        jobs: [{ id: "a", schedule: "0 11 * * *", repo: "/r", prompt: "p", worktree: { mode: "new", branch: "cron/{date}" } }],
      })
    );
    expect(ok.jobs[0].worktree).toEqual({ mode: "new", branch: "cron/{date}", base: undefined, init: false });

    const bad = parseCronConfig(
      JSON.stringify({ jobs: [{ id: "a", schedule: "0 11 * * *", repo: "/r", prompt: "p", worktree: { mode: "new" } }] })
    );
    expect(bad.jobs).toEqual([]);
    expect(bad.errors).toHaveLength(1);
  });

  it("모르는 agent와 overlap 값은 잡을 버린다", () => {
    expect(
      parseCronConfig(
        JSON.stringify({ jobs: [{ id: "a", schedule: "0 11 * * *", repo: "/r", prompt: "p", agent: "gpt" }] })
      ).jobs
    ).toEqual([]);
  });
});

describe("planCronTick", () => {
  const fire = at(2026, 9, 9, 11, 0);
  const now = fire + 30_000;

  it("due면 계획에 넣는다", () => {
    const plan = planCronTick({ jobs: [job()], lastFireByJob: new Map(), runningJobIds: new Set(), now });
    expect(plan).toEqual([{ job: expect.objectContaining({ id: "j1" }), fireAt: fire }]);
  });

  it("disabled는 뺀다", () => {
    const plan = planCronTick({ jobs: [job({ enabled: false })], lastFireByJob: new Map(), runningJobIds: new Set(), now });
    expect(plan).toEqual([]);
  });

  it("이미 그 fire를 돌았으면 뺀다", () => {
    const plan = planCronTick({
      jobs: [job()],
      lastFireByJob: new Map([["j1", fire]]),
      runningJobIds: new Set(),
      now,
    });
    expect(plan).toEqual([]);
  });

  it("overlap skip이면 아직 도는 잡을 뺀다", () => {
    const plan = planCronTick({
      jobs: [job()],
      lastFireByJob: new Map(),
      runningJobIds: new Set(["j1"]),
      now,
    });
    expect(plan).toEqual([]);
  });

  it("overlap allow면 도는 중에도 넣는다", () => {
    const plan = planCronTick({
      jobs: [job({ overlap: "allow" })],
      lastFireByJob: new Map(),
      runningJobIds: new Set(["j1"]),
      now,
    });
    expect(plan).toHaveLength(1);
  });

  it("유예를 넘긴 잡은 뺀다", () => {
    const plan = planCronTick({
      jobs: [job()],
      lastFireByJob: new Map(),
      runningJobIds: new Set(),
      now: fire + DEFAULT_GRACE_MS + 60_000,
    });
    expect(plan).toEqual([]);
  });

  it("여러 잡이 동시에 due면 전부 넣는다", () => {
    const plan = planCronTick({
      jobs: [job({ id: "a" }), job({ id: "b" })],
      lastFireByJob: new Map(),
      runningJobIds: new Set(),
      now,
    });
    expect(plan.map((p) => p.job.id)).toEqual(["a", "b"]);
  });
});

describe("설정 파일 읽고 쓰기", () => {
  const dirs: string[] = [];
  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), "hive-cron-"));
    dirs.push(d);
    setHiveHomeOverride(d);
    return d;
  }
  afterEach(() => setHiveHomeOverride(undefined));

  it("파일이 없으면 빈 목록", () => {
    scratch();
    expect(readCronConfig().jobs).toEqual([]);
  });

  it("쓴 것을 그대로 다시 읽는다", () => {
    scratch();
    const j = job({ id: "a", args: ["--permission-mode", "acceptEdits"], graceMs: 1000 });
    writeCronConfig([j]);
    const back = readCronConfig();
    expect(back.errors).toEqual([]);
    expect(back.jobs).toHaveLength(1);
    expect(back.jobs[0].args).toEqual(["--permission-mode", "acceptEdits"]);
    expect(back.jobs[0].graceMs).toBe(1000);
  });

  it("직렬화에 파싱된 spec은 안 들어간다", () => {
    const d = scratch();
    writeCronConfig([job()]);
    const raw = JSON.parse(readFileSync(join(d, "cron.json"), "utf8")) as { version: number; jobs: Record<string, unknown>[] };
    expect(raw.jobs[0].spec).toBeUndefined();
    expect(raw.version).toBe(1);
  });

  it("upsert는 같은 id를 덮어쓰고 순서를 지킨다", () => {
    const a = job({ id: "a" });
    const b = job({ id: "b" });
    expect(upsertJob([a, b], job({ id: "a", prompt: "new" })).map((j) => j.prompt)).toEqual(["new", "hi"]);
    expect(upsertJob([a], b).map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("remove는 없는 id에 대해 false", () => {
    expect(removeJob([job({ id: "a" })], "a").removed).toBe(true);
    expect(removeJob([job({ id: "a" })], "zz").removed).toBe(false);
  });

  it("설정이 깨져 있어도 읽기는 던지지 않는다", () => {
    const d = scratch();
    writeFileSync(join(d, "cron.json"), "{broken");
    const back = readCronConfig();
    expect(back.jobs).toEqual([]);
    expect(back.errors).toHaveLength(1);
  });
});
