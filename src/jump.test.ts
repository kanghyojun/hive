import { describe, expect, it } from "vitest";
import { jumpIndex, jumpLabel, jumpLabelWidth } from "./jump.js";

describe("jumpLabel", () => {
  it("앞 아홉 자리는 숫자만 쓴다", () => {
    expect(jumpLabel(0)).toBe("1");
    expect(jumpLabel(8)).toBe("9");
  });

  it("열 번째부터 l을 앞에 붙인다", () => {
    expect(jumpLabel(9)).toBe("l1");
    expect(jumpLabel(17)).toBe("l9");
  });

  it("l9 다음은 ll1이다", () => {
    expect(jumpLabel(18)).toBe("ll1");
    expect(jumpLabel(26)).toBe("ll9");
  });

  it("더 내려가면 l이 계속 늘어난다", () => {
    expect(jumpLabel(27)).toBe("lll1");
  });
});

describe("jumpIndex", () => {
  it("접두사가 없으면 숫자 그대로다", () => {
    expect(jumpIndex(0, 1)).toBe(0);
    expect(jumpIndex(0, 9)).toBe(8);
  });

  it("접두사 하나마다 아홉 칸씩 건너뛴다", () => {
    expect(jumpIndex(1, 1)).toBe(9);
    expect(jumpIndex(2, 1)).toBe(18);
  });

  it("라벨과 서로 짝이 맞는다", () => {
    for (const i of [0, 8, 9, 17, 18, 26, 27]) {
      const label = jumpLabel(i);
      const prefixLen = label.length - 1;
      expect(jumpIndex(prefixLen, Number(label.slice(-1)))).toBe(i);
    }
  });
});

describe("jumpLabelWidth", () => {
  it("아홉 개까지는 한 글자다", () => {
    expect(jumpLabelWidth(9)).toBe(1);
  });

  it("열 개가 되면 두 글자로 넓힌다", () => {
    expect(jumpLabelWidth(10)).toBe(2);
    expect(jumpLabelWidth(18)).toBe(2);
  });

  it("열아홉 개가 되면 세 글자다", () => {
    expect(jumpLabelWidth(19)).toBe(3);
  });

  it("빈 목록도 한 글자로 센다", () => {
    expect(jumpLabelWidth(0)).toBe(1);
  });
});
