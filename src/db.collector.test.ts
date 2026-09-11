import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, processStart } from "./db.js";
import { serverKey } from "./tmux.js";

const dirs: string[] = [];
function path(): string {
  const dir = mkdtempSync("/tmp/hive-owner-test-");
  dirs.push(dir);
  return join(dir, "hive.db");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("수집기 DB 소유권과 서버 격리", () => {
  it("살아 있는 owner는 빼앗지 않고 token이 일치할 때만 반납합니다", async () => {
    const db = await openDb(path());
    const owner = { pid: process.pid, start: processStart(process.pid)!, token: "first" };
    try {
      expect(owner.start).toBeTruthy();
      expect(db.acquireCollectorOwner("server", owner)).toBe(true);
      expect(db.acquireCollectorOwner("server", { ...owner, token: "second" })).toBe(false);
      db.releaseCollectorOwner("server", "second");
      expect(db.acquireCollectorOwner("server", owner)).toBe(false);
      db.releaseCollectorOwner("server", "first");
      expect(db.acquireCollectorOwner("server", { ...owner, token: "second" })).toBe(true);
    } finally { db.close(); }
  });

  it("같은 PID라도 시작 표식이 다르면 새 프로세스로 판단합니다", async () => {
    const db = await openDb(path());
    try {
      expect(db.acquireCollectorOwner("server", { pid: process.pid, start: "old", token: "old" })).toBe(true);
      expect(db.acquireCollectorOwner("server", { pid: process.pid, start: processStart(process.pid)!, token: "new" })).toBe(true);
    } finally { db.close(); }
  });

  it("기존 live flags만 한 번 옮기며 새 키의 값을 덮어쓰지 않습니다", async () => {
    const db = await openDb(path());
    const a = serverKey({ socketPath: "/tmp/a", pid: "1", startTime: "5" });
    const b = serverKey({ socketPath: "/tmp/b", pid: "2", startTime: "5" });
    try {
      db.setSleep("5", "@1", true);
      db.setUnread("5", "@2", true);
      db.setSleep(a, "@1", false);
      db.migrateWindowFlags("5", a, ["@1"]);
      db.migrateWindowFlags("5", b, ["@1"]);
      expect(db.getWindowFlags(a).get("@1")?.sleep).toBe(false);
      expect(db.getWindowFlags(b).get("@1")?.sleep).toBe(true);
      expect(db.getWindowFlags(a).has("@2")).toBe(false);
      db.setSleep(b, "@1", false);
      db.migrateWindowFlags("5", b, ["@1", "@2"]);
      expect(db.getWindowFlags(b).get("@1")?.sleep).toBe(false);
      expect(db.getWindowFlags(b).has("@2")).toBe(false);
    } finally { db.close(); }
  });

  it("새 cron은 자기 서버에서만 reap하며 기존 NULL 이력과 전역 fire 유일성을 유지합니다", async () => {
    const db = await openDb(path());
    try {
      for (const [jobId, key] of [["a", "a"], ["b", "b"], ["legacy", undefined]] as const) {
        const id = db.claimCronRun({ jobId, fireAt: 1, startedAt: 1, claimedBy: "test", serverKey: key })!;
        db.markCronRun(id, { status: "launched", windowId: "@0", serverKey: key });
      }
      expect(db.claimCronRun({ jobId: "a", fireAt: 1, startedAt: 1, claimedBy: "other", serverKey: "b" })).toBeNull();
      expect(db.reapCronRuns({ now: 100_000, liveWindowIds: ["@1"], serverKey: "a" })).toBe(2);
      expect(db.listCronRuns("b")[0]).toMatchObject({ status: "launched", serverKey: "b" });
      expect(db.listCronRuns("legacy")[0]).toMatchObject({ status: "done", serverKey: null });
      expect(db.reapCronRuns({ now: 100_000, liveWindowIds: ["@1"] })).toBe(0);
    } finally { db.close(); }
  });

  it("기존 DB에 nullable server_key를 추가하고 이력과 flags를 보존합니다", async () => {
    const file = path();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE cron_runs (id INTEGER PRIMARY KEY, job_id TEXT, fire_at INTEGER,
      started_at INTEGER, finished_at INTEGER, status TEXT, session_name TEXT, window_id TEXT,
      cwd TEXT, claimed_by TEXT, error TEXT, UNIQUE(job_id, fire_at));
      INSERT INTO cron_runs(job_id,fire_at,started_at,status) VALUES ('old',1,1,'done');
      CREATE TABLE window_flags(server_key TEXT, window_id TEXT, sleep INTEGER DEFAULT 0, PRIMARY KEY(server_key, window_id));
      INSERT INTO window_flags VALUES ('5','@1',1);`);
    raw.close();
    const db = await openDb(file);
    try {
      expect(db.listCronRuns()[0]).toMatchObject({ jobId: "old", serverKey: null });
      expect(db.getWindowFlags("5").get("@1")).toEqual({ sleep: true, unread: false, seenState: null });
    } finally { db.close(); }
  });

  it("종료된 서버의 실행 기록을 회수하고 살아 있는 다른 서버는 보존합니다", async () => {
    const stopped = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(stopped.status).toBe(0);
    const deadKey = serverKey({ socketPath: "/tmp/stopped", pid: String(stopped.pid), startTime: "5" });
    const liveKey = serverKey({ socketPath: "/tmp/live", pid: String(process.pid), startTime: "5" });
    const currentKey = serverKey({ socketPath: "/tmp/current", pid: String(process.pid), startTime: "6" });
    const db = await openDb(path());
    try {
      for (const [jobId, key] of [["stopped", deadKey], ["live", liveKey]]) {
        const id = db.claimCronRun({ jobId, fireAt: 1, startedAt: 99_999, claimedBy: "test", serverKey: key })!;
        db.markCronRun(id, { status: "launched", windowId: "@0" });
      }
      expect(db.reapCronRuns({ now: 100_000, liveWindowIds: ["@0"], serverKey: currentKey })).toBe(1);
      expect(db.listCronRuns("stopped")[0]).toMatchObject({ status: "done", serverKey: deadKey });
      expect(db.listCronRuns("live")[0]).toMatchObject({ status: "launched", serverKey: liveKey });
    } finally { db.close(); }
  });

  it("PID가 같아도 시작 표식이 달라졌을 때만 이전 실행을 회수합니다", async () => {
    const db = await openDb(path());
    try {
      for (const [jobId, start] of [["reused", "이전 프로세스"], ["live", processStart(process.pid)!]]) {
        const key = serverKey({ socketPath: `/tmp/${jobId}`, pid: String(process.pid), startTime: "5" });
        const id = db.claimCronRun({ jobId, fireAt: 1, startedAt: 1, claimedBy: "test", serverKey: key })!;
        db.markCronRun(id, { status: "launched", windowId: "@0", serverStart: start });
      }
      expect(db.reapCronRuns({ now: 100_000, liveWindowIds: ["@0"], serverKey: "current" })).toBe(1);
      expect(db.listCronRuns("reused")[0].status).toBe("done");
      expect(db.listCronRuns("live")[0].status).toBe("launched");
    } finally { db.close(); }
  });

  it("프로세스 표식을 조회할 수 없으면 살아 있는 PID의 기록을 보존합니다", async () => {
    const db = await openDb(path());
    const savedPath = process.env.PATH;
    try {
      const key = serverKey({ socketPath: "/tmp/unreadable", pid: String(process.pid), startTime: "5" });
      const id = db.claimCronRun({ jobId: "job", fireAt: 1, startedAt: 1, claimedBy: "test", serverKey: key })!;
      db.markCronRun(id, { status: "launched", windowId: "@0", serverStart: "이전 프로세스" });
      process.env.PATH = "";
      expect(db.reapCronRuns({ now: 100_000, liveWindowIds: ["@0"], serverKey: "current" })).toBe(0);
      expect(db.listCronRuns("job")[0].status).toBe("launched");
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      db.close();
    }
  });
});
