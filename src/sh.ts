// tmux에 넘기는 명령은 셸이 한 번 더 해석한다. 경로나 프롬프트에 공백·따옴표가 섞여도
// 한 덩어리로 남게 감싼다.
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
