// 한 자리로 갈 수 있는 건 아홉 개까지다. 그 뒤로는 접두사를 하나씩 붙여 아홉 개씩 더 연다.
const DIGITS = 9;

/** 목록에서 열 번째부터 숫자 앞에 붙는 글자. 다른 단축키와 겹치지 않는 걸 쓴다. */
export const JUMP_PREFIX = "l";

/** 0-based 자리 번호를 화면에 찍을 라벨로. 0 → "1", 9 → "l1", 18 → "ll1". */
export function jumpLabel(index: number): string {
  return JUMP_PREFIX.repeat(Math.floor(index / DIGITS)) + String((index % DIGITS) + 1);
}

/** 사용자가 친 접두사 개수와 숫자를 0-based 자리 번호로. */
export function jumpIndex(prefixLen: number, digit: number): number {
  return prefixLen * DIGITS + (digit - 1);
}

/** 목록 길이에 맞춰 라벨 열을 몇 칸으로 잡을지. 아홉 개까지는 지금처럼 한 글자다. */
export function jumpLabelWidth(count: number): number {
  return count <= 0 ? 1 : 1 + Math.floor((count - 1) / DIGITS);
}
