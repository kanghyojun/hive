import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  findLastCodexUsage,
  formatUsageLines,
  parseClaudeSnapshot,
  parseCodexRateLimits,
  type AgentUsage,
} from "./usage.js";

const SNAPSHOT = JSON.stringify({
  updated_at: "2026-09-08T00:00:00.000Z",
  five_hour: { used_percentage: 42, resets_at: "2026-09-08T01:20:00.000Z" },
  seven_day: { used_percentage: 18, resets_at: null },
});

// codex-cli 0.153.4 실측. 2026-09 플랜(prolite)은 7일 창만 준다.
const CODEX_SEP = JSON.stringify({
  timestamp: "2026-09-07T10:00:00.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: { input_tokens: 1 } },
    rate_limits: {
      primary: { used_percent: 8.0, window_minutes: 10080, resets_at: 1789368222 },
      secondary: null,
      plan_type: "prolite",
    },
  },
});

// 2026-02 파일은 primary가 5시간 창, secondary가 7일 창이다.
const CODEX_FEB = JSON.stringify({
  timestamp: "2026-02-10T10:00:00.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    rate_limits: {
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1770000000 },
      secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1770500000 },
    },
  },
});

// 실측 오탐 1: payload.type이 token_count인데 rate_limits가 null인 줄.
const CODEX_NULL_LIMITS = JSON.stringify({
  timestamp: "2026-09-07T11:00:00.000Z",
  type: "event_msg",
  payload: { type: "token_count", info: null, rate_limits: null },
});

// 실측 오탐 2: 도구 출력 본문에 token_count와 rate_limits 낱말이 그대로 들어간 줄.
const CODEX_ECHO = JSON.stringify({
  timestamp: "2026-09-07T12:00:00.000Z",
  type: "response_item",
  payload: {
    type: "function_call_output",
    output: 'const line = findLastCodexUsage(text); // token_count / rate_limits 를 찾는다',
  },
});

describe("parseClaudeSnapshot", () => {
  it("창 두 개와 ms 시각을 읽는다", () => {
    const usage = parseClaudeSnapshot(SNAPSHOT);
    expect(usage?.windows).toEqual([
      { label: "5h", usedPercent: 42, resetsAt: Date.parse("2026-09-08T01:20:00.000Z") },
      { label: "7d", usedPercent: 18, resetsAt: null },
    ]);
    expect(usage?.updatedAt).toBe(Date.parse("2026-09-08T00:00:00.000Z"));
  });

  it("used_percentage가 null인 창은 뺀다", () => {
    const raw = JSON.stringify({
      updated_at: "2026-09-08T00:00:00.000Z",
      five_hour: { used_percentage: 42, resets_at: null },
      seven_day: { used_percentage: null, resets_at: null },
    });
    expect(parseClaudeSnapshot(raw)?.windows).toHaveLength(1);
  });

  it("깨진 JSON은 null", () => {
    expect(parseClaudeSnapshot("{nope")).toBeNull();
  });
});

describe("parseCodexRateLimits", () => {
  it("secondary가 null이면 창 하나", () => {
    const usage = parseCodexRateLimits(CODEX_SEP);
    expect(usage?.windows).toEqual([{ label: "7d", usedPercent: 8, resetsAt: 1789368222000 }]);
    expect(usage?.note).toBe("마지막 응답 기준");
  });

  it("창 이름은 자리가 아니라 window_minutes로 정한다", () => {
    expect(parseCodexRateLimits(CODEX_FEB)?.windows.map((w) => w.label)).toEqual(["5h", "7d"]);
  });

  it("rate_limits가 없는 줄은 null", () => {
    expect(parseCodexRateLimits(JSON.stringify({ payload: { type: "token_count" } }))).toBeNull();
  });
});

describe("findLastCodexUsage", () => {
  it("마지막 줄이 잘린 JSON이면 앞 줄을 쓴다", () => {
    const text = `${CODEX_FEB}\n${CODEX_SEP}\n${CODEX_SEP.slice(0, 200)}`;
    expect(findLastCodexUsage(text)).toEqual(parseCodexRateLimits(CODEX_SEP));
  });

  it("rate_limits 줄이 없으면 null", () => {
    expect(findLastCodexUsage('{"type":"event_msg"}\n')).toBeNull();
  });

  it("rate_limits가 null인 token_count 줄은 건너뛰고 앞 줄을 쓴다", () => {
    const text = `${CODEX_FEB}\n${CODEX_NULL_LIMITS}`;
    expect(findLastCodexUsage(text)).toEqual(parseCodexRateLimits(CODEX_FEB));
  });

  it("두 낱말을 본문에 담은 도구 출력 줄은 건너뛴다", () => {
    const text = `${CODEX_FEB}\n${CODEX_ECHO}`;
    expect(findLastCodexUsage(text)).toEqual(parseCodexRateLimits(CODEX_FEB));
  });
});

describe("formatUsageLines", () => {
  const now = Date.parse("2026-09-08T00:02:00.000Z");
  const claude = parseClaudeSnapshot(SNAPSHOT) as AgentUsage;
  const codex = parseCodexRateLimits(CODEX_SEP) as AgentUsage;

  it("90% 이상은 red", () => {
    const hot: AgentUsage = { agent: "claude", windows: [{ label: "5h", usedPercent: 93, resetsAt: null }], updatedAt: now };
    expect(formatUsageLines([hot], now, 41)[1].color).toBe("red");
  });

  it("70% 이상은 yellow, 그 아래는 색 없음", () => {
    const lines = formatUsageLines([claude], now, 41);
    expect(lines[1].color).toBeUndefined();
    const warm: AgentUsage = { agent: "claude", windows: [{ label: "5h", usedPercent: 71, resetsAt: null }], updatedAt: now };
    expect(formatUsageLines([warm], now, 41)[1].color).toBe("yellow");
  });

  it("데이터가 없으면 안내 줄을 낸다", () => {
    const texts = formatUsageLines([], now, 41).map((l) => l.text);
    expect(texts.some((t) => t.includes("스냅샷 없음"))).toBe(true);
    expect(texts.some((t) => t.includes("codex 세션 없음"))).toBe(true);
  });

  it("모든 줄이 사이드바 폭 41 안에 들어간다", () => {
    for (const line of formatUsageLines([claude, codex], now, 41)) {
      expect(stringWidth(line.text)).toBeLessThanOrEqual(41);
    }
  });

  it("갱신 시각이 오래되면 표시한다", () => {
    const later = now + 2 * 3_600_000;
    const texts = formatUsageLines([claude], later, 41).map((l) => l.text);
    expect(texts.some((t) => t.includes("(오래됨)"))).toBe(true);
  });
});
