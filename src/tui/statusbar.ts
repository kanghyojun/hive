import stringWidth from "string-width";
import type { ViewMode } from "../model.js";
import type { AbStatus } from "../abBridge.js";

// 세그먼트 사이를 가르는 선. 목록 왼쪽의 RAIL과 같은 글자를 써서 화면이 한 벌로 보이게 한다.
export const STATUS_SEP = "│";

export interface StatusSegment {
  key: string;
  /** 좌우 공백까지 포함한다. 배경색을 입혔을 때 글자가 블록에 딱 붙지 않게 하려는 것이다. */
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
}

function scrollText(above: number, below: number): string {
  return `${above > 0 ? `↑${above}` : ""}${below > 0 ? `↓${below}` : ""}`;
}

// 하단 상태바에 늘어놓을 세그먼트. 앞에 있을수록 중요해서, 폭이 모자라면 뒤에서부터 버린다.
export function statusSegments(input: {
  mode: ViewMode;
  above: number;
  below: number;
  ab: AbStatus | null;
  showHelp: boolean;
}): StatusSegment[] {
  const segments: StatusSegment[] = [
    {
      key: "mode",
      text: ` ${input.mode.toUpperCase()} `,
      color: "black",
      backgroundColor: "cyan",
      bold: true,
    },
  ];

  const scroll = scrollText(input.above, input.below);
  if (scroll) segments.push({ key: "scroll", text: ` ${scroll} `, dim: true });

  // ab-local이 없는 머신에서는 아예 안 띄운다(App.tsx probe 주석).
  if (input.ab !== null) {
    segments.push({
      key: "ab",
      text: ` ab${input.ab === "up" ? "●" : "✗"} `,
      color: input.ab === "up" ? "green" : "red",
    });
  }

  segments.push({ key: "help", text: input.showHelp ? " ? 닫기 " : " ? help ", dim: true });
  return segments;
}

export function segmentsWidth(segments: StatusSegment[]): number {
  const text = segments.reduce((w, s) => w + stringWidth(s.text), 0);
  return text + Math.max(0, segments.length - 1) * stringWidth(STATUS_SEP);
}

// pane이 좁아지면 뒤 세그먼트부터 버린다. 정렬 모드는 마지막까지 남긴다.
export function fitSegments(segments: StatusSegment[], width: number): StatusSegment[] {
  let out = segments;
  while (out.length > 1 && segmentsWidth(out) > width) out = out.slice(0, -1);
  return out;
}
