import { spawnSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { cronServerKey, cronTick, executeJob } from "./cronRun.js";
import { openDb, processStart } from "./db.js";
import { readCronConfig, type CronJob } from "./cron.js";
import { parseCron } from "./cronSpec.js";
import { serverInfo, serverKey } from "./tmux.js";

vi.mock("./tmux.js", async (original) => ({
  ...await original<typeof import("./tmux.js")>(),
  listPanes: vi.fn(() => []),
  serverInfo: vi.fn(() => { throw new Error("서버 없음"); }),
}));
vi.mock("./worktree.js", async (original) => ({
  ...await original<typeof import("./worktree.js")>(),
  openWorktreeSession: vi.fn(() => {
    vi.mocked(serverInfo).mockReturnValue({ pid: String(process.pid), startTime: "100", socketPath: "/tmp/new-server" });
    return { sessionName: "cron-test", windowId: "@0" };
  }),
}));
vi.mock("./cron.js", async (original) => ({
  ...await original<typeof import("./cron.js")>(), readCronConfig: vi.fn(),
}));

const job: CronJob = {
  id: "manual", enabled: true, schedule: "* * * * *", spec: parseCron("* * * * *")!,
  repo: "/tmp", worktree: { mode: "reuse" }, agent: "claude", args: [], prompt: "테스트입니다",
  graceMs: 60_000, overlap: "skip", keepWindow: false, createdAt: 0,
};

beforeEach(() => {
  vi.mocked(serverInfo).mockImplementation(() => { throw new Error("서버 없음"); });
  vi.mocked(readCronConfig).mockReturnValue({ jobs: [job], errors: [] });
});

it("tmux가 없던 수동 cron도 창을 만들고 생성된 서버 key를 기록합니다", async () => {
  expect(cronServerKey()).toBeUndefined();
  const db = await openDb(":memory:");
  try {
    const result = executeJob({ db, fireAt: 1000, now: 1000, serverKey: cronServerKey(), job });
    expect(result.status).toBe("launched");
    expect(db.listCronRuns()[0]).toMatchObject({ status: "launched", serverKey: serverKey(serverInfo()),
      serverStart: processStart(process.pid), windowId: "@0" });
  } finally { db.close(); }
});

it("수집기와 서버가 함께 종료됐어도 새 서버의 cron은 다음 fire를 실행합니다", async () => {
  const stopped = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(stopped.status).toBe(0);
  const oldKey = serverKey({ pid: String(stopped.pid), startTime: "99", socketPath: "/tmp/new-server" });
  const current = { pid: String(process.pid), startTime: "100", socketPath: "/tmp/new-server" };
  vi.mocked(serverInfo).mockReturnValue(current);
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
  const db = await openDb(":memory:");
  try {
    const old = db.claimCronRun({ jobId: job.id, fireAt: now - 61_000, startedAt: now - 1,
      claimedBy: "stopped", serverKey: oldKey })!;
    db.markCronRun(old, { status: "launched", windowId: "@0" });
    const result = cronTick({ db, now, liveWindowIds: ["@0"], serverKey: serverKey(current), inline: true });
    expect(result).toMatchObject({ reaped: 1, errors: [] });
    expect(result.launched).toHaveLength(1);
    expect(db.listCronRuns().find((run) => run.id === old)?.status).toBe("done");
    expect(db.listCronRuns()[0]).toMatchObject({ status: "launched", serverKey: serverKey(current) });
  } finally { db.close(); }
});
