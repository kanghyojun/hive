import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.js";

async function scratchDb(): Promise<string> {
  return join(mkdtempSync(join(tmpdir(), "hive-cron-db-")), "hive.db");
}

function claim(db: Db, jobId: string, fireAt: number, startedAt = fireAt) {
  return db.claimCronRun({ jobId, fireAt, startedAt, claimedBy: "test:1" });
}

describe("cron_runs claim", () => {
  it("커넥션이 둘이어도 같은 fire는 하나만 잡는다", async () => {
    const path = await scratchDb();
    const a = await openDb(path);
    const b = await openDb(path);
    try {
      const results = [claim(a, "j", 1000), claim(b, "j", 1000)];
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it("같은 잡의 다른 fire는 따로 잡는다", async () => {
    const db = await openDb(await scratchDb());
    try {
      expect(claim(db, "j", 1000)).not.toBeNull();
      expect(claim(db, "j", 1000)).toBeNull();
      expect(claim(db, "j", 2000)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("다른 잡은 같은 fire를 각자 잡는다", async () => {
    const db = await openDb(await scratchDb());
    try {
      expect(claim(db, "a", 1000)).not.toBeNull();
      expect(claim(db, "b", 1000)).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("cron_runs 조회와 갱신", () => {
  it("lastFireByJob은 잡별 최대 fire를 준다", async () => {
    const db = await openDb(await scratchDb());
    try {
      claim(db, "a", 1000);
      claim(db, "a", 3000);
      claim(db, "a", 2000);
      claim(db, "b", 500);
      const m = db.lastFireByJob();
      expect(m.get("a")).toBe(3000);
      expect(m.get("b")).toBe(500);
      expect(m.get("없는잡")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("markCronRun이 상태와 창 정보를 채운다", async () => {
    const db = await openDb(await scratchDb());
    try {
      const id = claim(db, "a", 1000)!;
      db.markCronRun(id, { status: "launched", sessionName: "s1", windowId: "@3", cwd: "/tmp/x" });
      const [row] = db.listCronRuns("a");
      expect(row.status).toBe("launched");
      expect(row.sessionName).toBe("s1");
      expect(row.windowId).toBe("@3");
      expect(row.cwd).toBe("/tmp/x");
      expect(row.finishedAt).toBeNull();

      db.markCronRun(id, { status: "failed", finishedAt: 9999, error: "터졌다" });
      expect(db.listCronRuns("a")[0].status).toBe("failed");
      expect(db.listCronRuns("a")[0].error).toBe("터졌다");
      // 안 넘긴 필드는 그대로 남는다
      expect(db.listCronRuns("a")[0].windowId).toBe("@3");
    } finally {
      db.close();
    }
  });

  it("runningCronRuns는 claimed와 launched만 준다", async () => {
    const db = await openDb(await scratchDb());
    try {
      claim(db, "a", 1000);
      const b = claim(db, "b", 1000)!;
      const c = claim(db, "c", 1000)!;
      db.markCronRun(b, { status: "launched" });
      db.markCronRun(c, { status: "done", finishedAt: 2000 });
      expect(db.runningCronRuns().map((r) => r.jobId).sort()).toEqual(["a", "b"]);
    } finally {
      db.close();
    }
  });

  it("listCronRuns는 최신 fire부터 주고 limit을 지킨다", async () => {
    const db = await openDb(await scratchDb());
    try {
      claim(db, "a", 1000);
      claim(db, "a", 2000);
      claim(db, "a", 3000);
      expect(db.listCronRuns("a").map((r) => r.fireAt)).toEqual([3000, 2000, 1000]);
      expect(db.listCronRuns("a", 2).map((r) => r.fireAt)).toEqual([3000, 2000]);
      expect(db.listCronRuns(undefined, 10)).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});

describe("reapCronRuns", () => {
  const STALE = 5 * 60_000;

  it("창을 못 띄운 claimed는 유예 뒤에 failed로 마감한다", async () => {
    const db = await openDb(await scratchDb());
    try {
      const id = claim(db, "a", 1000, 1000)!;
      expect(db.reapCronRuns({ liveWindowIds: ["@1"], now: 1000 + STALE - 1 })).toBe(0);
      expect(db.reapCronRuns({ liveWindowIds: ["@1"], now: 1000 + STALE + 1 })).toBe(1);
      const [row] = db.listCronRuns("a");
      expect(row.status).toBe("failed");
      expect(row.finishedAt).toBe(1000 + STALE + 1);
      expect(row.id).toBe(id);
    } finally {
      db.close();
    }
  });

  it("창이 사라진 launched는 done으로 마감한다", async () => {
    const db = await openDb(await scratchDb());
    try {
      const id = claim(db, "a", 1000, 1000)!;
      db.markCronRun(id, { status: "launched", windowId: "@7" });
      // 창이 아직 살아 있으면 건드리지 않는다
      expect(db.reapCronRuns({ liveWindowIds: ["@7"], now: 1000 + STALE + 1 })).toBe(0);
      expect(db.reapCronRuns({ liveWindowIds: ["@9"], now: 1000 + STALE + 1 })).toBe(1);
      expect(db.listCronRuns("a")[0].status).toBe("done");
    } finally {
      db.close();
    }
  });

  it("창 목록이 비면 launched는 건드리지 않는다", async () => {
    const db = await openDb(await scratchDb());
    try {
      const id = claim(db, "a", 1000, 1000)!;
      db.markCronRun(id, { status: "launched", windowId: "@7" });
      expect(db.reapCronRuns({ liveWindowIds: [], now: 1000 + STALE + 1 })).toBe(0);
      expect(db.listCronRuns("a")[0].status).toBe("launched");
    } finally {
      db.close();
    }
  });

  it("갓 띄운 launched는 창 목록에 아직 없어도 봐준다", async () => {
    const db = await openDb(await scratchDb());
    try {
      const id = claim(db, "a", 1000, 1000)!;
      db.markCronRun(id, { status: "launched", windowId: "@7" });
      expect(db.reapCronRuns({ liveWindowIds: ["@1"], now: 1000 + 5_000 })).toBe(0);
    } finally {
      db.close();
    }
  });
});
