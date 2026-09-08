import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_THROTTLE_MS,
  parseStatuslinePayload,
  shouldWriteSnapshot,
  type ClaudeUsageSnapshot,
} from "./statusline.js";
import { parseClaudeSnapshot } from "./usage.js";

// Claude Code가 statusLine 커맨드 stdin으로 넘기는 JSON 모양.
const PAYLOAD = JSON.stringify({
  hook_event_name: "Status",
  model: { display_name: "Opus" },
  cwd: "/home/ed/src/hive",
  context_window: { context_window_size: 200000, current_usage: { input_tokens: 1234 } },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: 1789372800 },
    seven_day: { used_percentage: 18.4, resets_at: 1789891200 },
    model_scoped: [],
  },
});

function snapshotOf(raw: string): ClaudeUsageSnapshot {
  const snapshot = parseStatuslinePayload(raw);
  if (!snapshot) throw new Error("스냅샷이 만들어지지 않았다");
  return snapshot;
}

describe("parseStatuslinePayload", () => {
  it("두 창을 다 읽는다", () => {
    const snapshot = snapshotOf(PAYLOAD);
    expect(snapshot.five_hour).toEqual({
      used_percentage: 42,
      resets_at: "2026-09-14T08:00:00.000Z",
    });
    expect(snapshot.seven_day).toEqual({
      used_percentage: 18,
      resets_at: "2026-09-20T08:00:00.000Z",
    });
    expect(Number.isFinite(Date.parse(snapshot.updated_at))).toBe(true);
  });

  it("seven_day만 있으면 그 창만 채운다", () => {
    const snapshot = snapshotOf(
      JSON.stringify({ rate_limits: { seven_day: { used_percentage: 61, resets_at: 1789891200 } } })
    );
    expect(snapshot.five_hour).toEqual({ used_percentage: null, resets_at: null });
    expect(snapshot.seven_day.used_percentage).toBe(61);
  });

  it("rate_limits가 없으면 null", () => {
    expect(parseStatuslinePayload(JSON.stringify({ model: { display_name: "Opus" } }))).toBe(null);
  });

  it("두 창 다 값이 없으면 null", () => {
    expect(parseStatuslinePayload(JSON.stringify({ rate_limits: { model_scoped: [] } }))).toBe(null);
  });

  it("깨진 JSON이면 null", () => {
    expect(parseStatuslinePayload('{"rate_limits":')).toBe(null);
  });

  it("used_percentage를 0~100으로 클램프한다", () => {
    const snapshot = snapshotOf(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 150 }, seven_day: { used_percentage: -3 } } })
    );
    expect(snapshot.five_hour.used_percentage).toBe(100);
    expect(snapshot.seven_day.used_percentage).toBe(0);
  });

  it("resets_at이 없거나 0이면 null", () => {
    const snapshot = snapshotOf(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 0 } } })
    );
    expect(snapshot.five_hour.resets_at).toBe(null);
  });
});

describe("shouldWriteSnapshot", () => {
  const next = snapshotOf(PAYLOAD);
  const same = JSON.stringify(next);
  const now = 1_000_000;

  it("이전 파일이 없으면 쓴다", () => {
    expect(shouldWriteSnapshot(undefined, next, undefined, now, SNAPSHOT_THROTTLE_MS)).toBe(true);
  });

  it("값이 같고 방금 썼으면 안 쓴다", () => {
    expect(shouldWriteSnapshot(same, next, now - 1_000, now, SNAPSHOT_THROTTLE_MS)).toBe(false);
  });

  it("값이 같아도 오래됐으면 쓴다", () => {
    expect(shouldWriteSnapshot(same, next, now - 60_000, now, SNAPSHOT_THROTTLE_MS)).toBe(true);
  });

  it("값이 다르면 바로 쓴다", () => {
    const prev = JSON.stringify({ ...next, five_hour: { used_percentage: 41, resets_at: null } });
    expect(shouldWriteSnapshot(prev, next, now - 1_000, now, SNAPSHOT_THROTTLE_MS)).toBe(true);
  });

  it("이전 파일이 깨져 있으면 쓴다", () => {
    expect(shouldWriteSnapshot("{", next, now - 1_000, now, SNAPSHOT_THROTTLE_MS)).toBe(true);
  });
});

// 이 왕복이 깨지면 statusline이 쓴 파일을 사용량 뷰가 못 읽는다. 두 형식을 묶어 두는 테스트다.
describe("statusline → usage 왕복", () => {
  it("만든 스냅샷을 parseClaudeSnapshot이 그대로 읽는다", () => {
    const usage = parseClaudeSnapshot(JSON.stringify(snapshotOf(PAYLOAD)));
    expect(usage?.agent).toBe("claude");
    expect(usage?.windows).toEqual([
      { label: "5h", usedPercent: 42, resetsAt: Date.parse("2026-09-14T08:00:00.000Z") },
      { label: "7d", usedPercent: 18, resetsAt: Date.parse("2026-09-20T08:00:00.000Z") },
    ]);
    expect(usage?.updatedAt).not.toBe(null);
  });

  it("한 창만 있는 스냅샷도 그 창만 읽힌다", () => {
    const snapshot = snapshotOf(
      JSON.stringify({ rate_limits: { seven_day: { used_percentage: 61, resets_at: 1789891200 } } })
    );
    const usage = parseClaudeSnapshot(JSON.stringify(snapshot));
    expect(usage?.windows.map((w) => w.label)).toEqual(["7d"]);
  });
});
