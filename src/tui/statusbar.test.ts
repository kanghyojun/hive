import { describe, expect, it } from "vitest";
import { fitSegments, segmentsWidth, statusSegments } from "./statusbar.js";

function keys(input: Parameters<typeof statusSegments>[0]): string[] {
  return statusSegments(input).map((s) => s.key);
}

const base = { mode: "recent" as const, above: 0, below: 0, ab: null, showHelp: false };

describe("statusSegments", () => {
  it("정렬 모드는 대문자 블록으로 맨 앞에 둔다", () => {
    const [first] = statusSegments({ ...base, mode: "group" });
    expect(first.text).toBe(" GROUP ");
    expect(first.backgroundColor).toBe("cyan");
  });

  it("잘린 목록이 없으면 스크롤 세그먼트를 빼고, 있으면 방향만 붙인다", () => {
    expect(keys(base)).not.toContain("scroll");
    expect(statusSegments({ ...base, above: 3, below: 5 })[1].text).toBe(" ↑3↓5 ");
    expect(statusSegments({ ...base, below: 5 })[1].text).toBe(" ↓5 ");
  });

  it("ab-local이 없는 머신(null)에서는 브리지 세그먼트를 아예 안 띄운다", () => {
    expect(keys(base)).not.toContain("ab");
    expect(statusSegments({ ...base, ab: "up" }).find((s) => s.key === "ab")).toMatchObject({
      text: " ab● ",
      color: "green",
    });
    expect(statusSegments({ ...base, ab: "down" }).find((s) => s.key === "ab")).toMatchObject({
      text: " ab✗ ",
      color: "red",
    });
  });

  it("도움말이 펼쳐져 있으면 닫는 방법으로 바꿔 적는다", () => {
    expect(statusSegments(base).at(-1)?.text).toBe(" ? help ");
    expect(statusSegments({ ...base, showHelp: true }).at(-1)?.text).toBe(" ? 닫기 ");
  });
});

describe("fitSegments", () => {
  const full = statusSegments({ mode: "recent", above: 3, below: 5, ab: "up", showHelp: false });

  it("사이드바 기본 폭에는 다 들어간다", () => {
    expect(fitSegments(full, 40)).toEqual(full);
  });

  it("폭이 모자라면 뒤에서부터 버린다", () => {
    const dropped = fitSegments(full, segmentsWidth(full) - 1);
    expect(dropped.map((s) => s.key)).toEqual(["mode", "scroll", "ab"]);
  });

  it("아무리 좁아도 정렬 모드는 남긴다", () => {
    expect(fitSegments(full, 1).map((s) => s.key)).toEqual(["mode"]);
  });

  it("구분선 폭까지 세어서 판단한다", () => {
    const two = full.slice(0, 2);
    expect(segmentsWidth(two)).toBe(two[0].text.length + 1 + two[1].text.length);
  });
});


describe("수집기 갱신 상태", () => {
  it("정상 연결은 표시를 추가하지 않습니다", () => {
    expect(keys({ ...base, collector: { connected: true, stale: false, error: null } })).toEqual(keys(base));
  });
  it("연결 대기와 오래된 snapshot을 좁은 화면에서도 표시합니다", () => {
    const pending = statusSegments({ ...base, collector: { connected: false, stale: true, error: null } });
    expect(fitSegments(pending, 15)[0].text).toBe(" 갱신 대기 ");
    const stale = statusSegments({ ...base, collector: { connected: true, stale: true, error: "일시 실패" } });
    expect(fitSegments(stale, 15)[0].text).toBe(" 갱신 중단 ");
  });
});
