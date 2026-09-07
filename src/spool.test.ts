import { describe, expect, it } from "vitest";
import { parseSpoolLine, splitCompleteLines } from "./spool.js";

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
