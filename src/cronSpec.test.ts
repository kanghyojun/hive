import { describe, expect, it } from "vitest";
import { isDue, nextDue, parseCron, prevDue, renderTemplate } from "./cronSpec.js";

function spec(text: string) {
  const s = parseCron(text);
  if (!s) throw new Error(`파싱 실패: ${text}`);
  return s;
}

// 로컬 시각으로 Date를 만든다. epoch 상수를 박으면 CI 타임존에 따라 깨진다.
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe("parseCron", () => {
  it("매일 11시", () => {
    const s = spec("0 11 * * *");
    expect([...s.minute]).toEqual([0]);
    expect([...s.hour]).toEqual([11]);
    expect(s.domStar).toBe(true);
    expect(s.dowStar).toBe(true);
    expect(s.dom.size).toBe(31);
    expect(s.month.size).toBe(12);
    expect(s.dow.size).toBe(7);
  });

  it("리스트와 범위", () => {
    expect([...spec("0,30 * * * *").minute]).toEqual([0, 30]);
    expect([...spec("0 9-12 * * *").hour]).toEqual([9, 10, 11, 12]);
    expect([...spec("0 0 1,15 * *").dom]).toEqual([1, 15]);
  });

  it("스텝", () => {
    expect([...spec("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect([...spec("0 0-12/6 * * *").hour]).toEqual([0, 6, 12]);
    // */n 을 썼어도 필드 전체를 훑는 것이므로 star로 치지 않는다. 안 그러면 dom/dow OR 규칙이 어긋난다.
    expect(spec("*/2 * * * *").domStar).toBe(true);
    expect(spec("0 0 */2 * *").domStar).toBe(false);
  });

  it("요일과 월 이름", () => {
    expect([...spec("0 11 * * mon").dow]).toEqual([1]);
    expect([...spec("0 11 * * SUN,sat").dow]).toEqual([0, 6]);
    expect([...spec("0 0 1 jan *").month]).toEqual([1]);
    // 표준 cron은 7도 일요일로 받는다
    expect([...spec("0 0 * * 7").dow]).toEqual([0]);
  });

  it("깨진 입력은 null", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("0 11 * *")).toBeNull();
    expect(parseCron("0 11 * * * *")).toBeNull();
    expect(parseCron("60 11 * * *")).toBeNull();
    expect(parseCron("0 24 * * *")).toBeNull();
    expect(parseCron("0 0 0 * *")).toBeNull();
    expect(parseCron("0 0 * 13 *")).toBeNull();
    expect(parseCron("0 11 * * xyz")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("12-3 * * * *")).toBeNull();
  });
});

describe("prevDue", () => {
  const daily11 = spec("0 11 * * *");

  it("정확히 예정 시각이면 그 시각 자체를 돌려준다", () => {
    const t = at(2026, 9, 9, 11, 0);
    expect(prevDue(daily11, t)).toBe(t);
  });

  it("초는 버린다", () => {
    const t = at(2026, 9, 9, 11, 0);
    expect(prevDue(daily11, t + 45_000)).toBe(t);
  });

  it("예정 시각 1분 전이면 전날 것", () => {
    expect(prevDue(daily11, at(2026, 9, 9, 10, 59))).toBe(at(2026, 9, 8, 11, 0));
  });

  it("자정 직후면 전날 것", () => {
    expect(prevDue(daily11, at(2026, 9, 9, 0, 0))).toBe(at(2026, 9, 8, 11, 0));
  });

  it("주간 잡은 그 요일로 되돌아간다", () => {
    const mon11 = spec("0 11 * * mon");
    const got = prevDue(mon11, at(2026, 9, 9, 15, 0));
    expect(got).not.toBeNull();
    const d = new Date(got!);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(11);
    expect(d.getMinutes()).toBe(0);
    expect(got!).toBeLessThanOrEqual(at(2026, 9, 9, 15, 0));
  });

  it("lookback 밖이면 null", () => {
    // 1월 1일만 도는 잡을 9월에 물으면 8일 안에 없다
    expect(prevDue(spec("0 0 1 1 *"), at(2026, 9, 9, 12, 0))).toBeNull();
  });
});

describe("nextDue", () => {
  const daily11 = spec("0 11 * * *");

  it("예정 시각 자체는 지나간 것으로 보지 않고 다음을 준다", () => {
    expect(nextDue(daily11, at(2026, 9, 9, 11, 0))).toBe(at(2026, 9, 10, 11, 0));
  });

  it("같은 날 이른 시각이면 그날 것", () => {
    expect(nextDue(daily11, at(2026, 9, 9, 3, 0))).toBe(at(2026, 9, 9, 11, 0));
  });

  it("주간 잡", () => {
    const got = nextDue(spec("0 11 * * mon"), at(2026, 9, 9, 15, 0));
    expect(new Date(got!).getDay()).toBe(1);
    expect(new Date(got!).getHours()).toBe(11);
  });

  it("연 단위로 넘어가는 잡도 찾는다", () => {
    const got = nextDue(spec("0 0 1 1 *"), at(2026, 9, 9, 12, 0));
    const d = new Date(got!);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

describe("dom과 dow OR 규칙", () => {
  it("둘 다 지정되면 어느 한쪽만 맞아도 돈다", () => {
    // 매월 1일 또는 월요일
    const s = spec("0 11 1 * mon");
    const got = prevDue(s, at(2026, 9, 9, 23, 0));
    const d = new Date(got!);
    expect(d.getDate() === 1 || d.getDay() === 1).toBe(true);
  });

  it("dow만 지정되면 dom은 무시한다", () => {
    const got = prevDue(spec("0 11 * * mon"), at(2026, 9, 9, 23, 0));
    expect(new Date(got!).getDay()).toBe(1);
  });
});

describe("isDue", () => {
  const s = spec("0 11 * * *");
  const HOUR = 3600_000;
  const grace = 6 * HOUR;
  const since = at(2026, 1, 1);

  it("예정 시각 직후면 fire_at을 돌려준다", () => {
    const now = at(2026, 9, 9, 11, 0) + 30_000;
    expect(isDue({ spec: s, lastFireAt: null, since, now, graceMs: grace })).toBe(at(2026, 9, 9, 11, 0));
  });

  it("같은 fire를 두 번 돌려주지 않는다", () => {
    const fire = at(2026, 9, 9, 11, 0);
    const now = fire + 60_000;
    expect(isDue({ spec: s, lastFireAt: fire, since, now, graceMs: grace })).toBeNull();
  });

  it("유예 안이면 늦게 켜도 따라잡는다", () => {
    const fire = at(2026, 9, 9, 11, 0);
    expect(isDue({ spec: s, lastFireAt: null, since, now: fire + 5 * HOUR, graceMs: grace })).toBe(fire);
  });

  it("유예를 넘기면 흘려보낸다", () => {
    const fire = at(2026, 9, 9, 11, 0);
    expect(isDue({ spec: s, lastFireAt: null, since, now: fire + 7 * HOUR, graceMs: grace })).toBeNull();
  });

  it("잡을 만들기 전의 예정 시각은 무시한다", () => {
    const fire = at(2026, 9, 9, 11, 0);
    const now = fire + 60_000;
    expect(isDue({ spec: s, lastFireAt: null, since: fire + 30_000, now, graceMs: grace })).toBeNull();
  });

  it("직전 실행이 더 오래된 것이면 새 fire를 돌려준다", () => {
    const fire = at(2026, 9, 9, 11, 0);
    const now = fire + 60_000;
    expect(isDue({ spec: s, lastFireAt: at(2026, 9, 8, 11, 0), since, now, graceMs: grace })).toBe(fire);
  });
});

describe("renderTemplate", () => {
  it("date, job, ts를 치환한다", () => {
    const fireAt = at(2026, 9, 9, 11, 0);
    expect(renderTemplate("cron/{job}-{date}", { fireAt, jobId: "reflect" })).toBe("cron/reflect-2026-09-09");
    expect(renderTemplate("{ts}", { fireAt, jobId: "x" })).toBe(String(fireAt));
  });

  it("모르는 자리표시자는 그대로 둔다", () => {
    expect(renderTemplate("a/{nope}", { fireAt: 0, jobId: "x" })).toBe("a/{nope}");
  });
});
