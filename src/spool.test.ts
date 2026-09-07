import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { ingestAll, parseSpoolLine, splitCompleteLines } from "./spool.js";

describe("parseSpoolLine", () => {
  it("정상 줄을 파싱한다", () => {
    const line = '{"v":1,"ts":1788781121659,"pane":"%7","tmux":"/tmp/tmux-1001/default,1986967,0","payload":{"hook_event_name":"Stop"}}';
    const rec = parseSpoolLine(line);
    expect(rec).not.toBeNull();
    expect(rec?.pane).toBe("%7");
    expect(rec?.tmuxSocket).toBe("/tmp/tmux-1001/default");
    expect(rec?.tmuxServerPid).toBe("1986967");
    expect(rec?.payload).toEqual({ hook_event_name: "Stop" });
  });

  it("깨진 JSON은 null", () => {
    expect(parseSpoolLine("{not json")).toBeNull();
  });

  it("빈 줄은 null", () => {
    expect(parseSpoolLine("")).toBeNull();
    expect(parseSpoolLine("   ")).toBeNull();
  });

  it("필수 필드가 없으면 null", () => {
    expect(parseSpoolLine('{"v":1,"ts":1}')).toBeNull();
  });
});

describe("splitCompleteLines", () => {
  it("완결된 줄만 반환하고 offset을 누적한다", () => {
    const buf = 'line1\nline2\n';
    const { lines, nextOffset } = splitCompleteLines(buf, 0);
    expect(lines).toEqual([
      { offset: 0, text: "line1" },
      { offset: 6, text: "line2" },
    ]);
    expect(nextOffset).toBe(12);
  });

  it("개행 없는 마지막 줄은 보류한다", () => {
    const buf = 'line1\npartial';
    const { lines, nextOffset } = splitCompleteLines(buf, 0);
    expect(lines).toEqual([{ offset: 0, text: "line1" }]);
    expect(nextOffset).toBe(6);
  });

  it("startOffset을 기준으로 절대 위치를 계산한다", () => {
    const buf = 'lineA\nlineB\n';
    const { lines, nextOffset } = splitCompleteLines(buf, 100);
    expect(lines).toEqual([
      { offset: 100, text: "lineA" },
      { offset: 106, text: "lineB" },
    ]);
    expect(nextOffset).toBe(112);
  });

  it("멀티바이트 문자를 바이트 길이로 계산한다", () => {
    const buf = '한글\nabc\n';
    const { lines, nextOffset } = splitCompleteLines(buf, 0);
    const koreanBytes = Buffer.byteLength("한글\n", "utf8");
    expect(lines[0]).toEqual({ offset: 0, text: "한글" });
    expect(lines[1]).toEqual({ offset: koreanBytes, text: "abc" });
    expect(nextOffset).toBe(koreanBytes + Buffer.byteLength("abc\n", "utf8"));
  });
});

describe("ingestAll", () => {
  const spoolLine = (ts: number, event: string, extra = "") =>
    JSON.stringify({
      v: 1,
      ts,
      pane: "%1",
      tmux: "/tmp/sock,111,0",
      payload: { hook_event_name: event, session_id: "s1", note: extra },
    }) + "\n";

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), "hive-spool-test-"));
    const spool = join(root, "spool");
    mkdirSync(spool);
    const db = await openDb(join(root, "hive.db"));
    return { spool, file: join(spool, "pane-_1.jsonl"), db };
  }

  it("이어 붙은 줄만 새로 흡수한다", async () => {
    const { spool, file, db } = await setup();
    writeFileSync(file, spoolLine(1000, "UserPromptSubmit"));
    expect(ingestAll(db, spool)).toEqual({ inserted: 1, skipped: 0 });
    expect(ingestAll(db, spool)).toEqual({ inserted: 0, skipped: 0 });

    appendFileSync(file, spoolLine(2000, "Stop"));
    expect(ingestAll(db, spool)).toEqual({ inserted: 1, skipped: 0 });
    expect(db.getAgent("111", "%1")?.lastTs).toBe(2000);
    db.close();
  });

  // hook이 5MB 초과로 스풀을 비우면 offset이 0으로 돌아가면서 옛 행과 (spool_file, spool_offset)가
  // 겹친다. 겹친 행을 안 지우면 INSERT OR IGNORE가 새 이벤트를 조용히 버린다.
  it("truncate 후 새로 쌓인 이벤트를 흡수한다", async () => {
    const { spool, file, db } = await setup();
    let buf = "";
    for (let i = 0; i < 10; i++) buf += spoolLine(1000 + i, "Stop");
    writeFileSync(file, buf);
    expect(ingestAll(db, spool).inserted).toBe(10);
    expect(db.getAgent("111", "%1")?.lastTs).toBe(1009);

    writeFileSync(file, spoolLine(9000, "UserPromptSubmit"));
    expect(ingestAll(db, spool)).toEqual({ inserted: 1, skipped: 0 });
    const agent = db.getAgent("111", "%1");
    expect(agent?.lastTs).toBe(9000);
    expect(agent?.state).toBe("working");
    db.close();
  });

  // 옛 offset보다 크게 다시 쌓이면 크기 비교로는 truncate를 못 잡는다. 이어 읽기 지점이
  // 줄 경계인지로 판별한다.
  it("truncate 후 옛 offset을 넘겨 쌓여도 줄 중간부터 읽지 않는다", async () => {
    const { spool, file, db } = await setup();
    writeFileSync(file, spoolLine(1000, "Stop", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
    expect(ingestAll(db, spool).inserted).toBe(1);

    let buf = "";
    for (let i = 0; i < 5; i++) buf += spoolLine(9000 + i, "Stop", "y");
    writeFileSync(file, buf);
    expect(ingestAll(db, spool)).toEqual({ inserted: 5, skipped: 0 });
    expect(db.getAgent("111", "%1")?.lastTs).toBe(9004);
    db.close();
  });
});
