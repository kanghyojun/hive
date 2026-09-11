import { StringDecoder } from "node:string_decoder";
import type { AbStatus } from "./abBridge.js";
import type { Row, ViewMode } from "./model.js";
import type { PaneInfo, ServerInfo } from "./tmux.js";
import type { AgentUsage } from "./usage.js";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_SEND_BUFFER_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_STALE_MS = 5000;

export interface CollectorSnapshot {
  version: typeof PROTOCOL_VERSION;
  server: ServerInfo;
  collectorPid: number;
  sequence: number;
  lastSuccessAt: number | null;
  error: string | null;
  rows: Row[];
  panes: PaneInfo[];
  mode: ViewMode;
  ab: AbStatus | null;
  usage: AgentUsage[];
}

export type CollectorCommand =
  | { type: "toggleSleep" | "toggleUnread" | "activate"; windowId: string }
  | { type: "setMode"; mode: ViewMode }
  | { type: "refresh" }
  | { type: "usage"; interested: boolean };

export interface CollectorRequest { id: string; command: CollectorCommand }
export type CollectorMessage =
  | { type: "snapshot"; snapshot: CollectorSnapshot }
  | { type: "response"; id: string; ok: boolean; error?: string };

export function isServerInfo(value: unknown): value is ServerInfo {
  if (!value || typeof value !== "object") return false;
  const s = value as ServerInfo;
  return typeof s.pid === "string" && /^\d+$/.test(s.pid)
    && typeof s.startTime === "string" && /^\d+$/.test(s.startTime)
    && typeof s.socketPath === "string" && s.socketPath.startsWith("/");
}

export function parseRequest(value: unknown): CollectorRequest {
  if (!value || typeof value !== "object") throw new Error("잘못된 수집기 요청입니다");
  const { id, command: c } = value as CollectorRequest;
  if (typeof id !== "string" || !id.length || id.length > 128 || !c || typeof c !== "object") {
    throw new Error("잘못된 수집기 요청입니다");
  }
  switch (c.type) {
    case "toggleSleep": case "toggleUnread": case "activate":
      if (typeof c.windowId === "string" && /^@\d+$/.test(c.windowId)) return { id, command: c };
      break;
    case "setMode":
      if (c.mode === "recent" || c.mode === "group") return { id, command: c };
      break;
    case "refresh": return { id, command: c };
    case "usage":
      if (typeof c.interested === "boolean") return { id, command: c };
      break;
  }
  throw new Error("잘못된 수집기 명령입니다");
}

export function encodeMessage(message: unknown): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("수집기 메시지가 너무 큽니다");
  return `${line}\n`;
}

export class NdjsonDecoder {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;

  constructor(private receive: (value: unknown) => void, private maxBytes = MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      this.bytes += piece.length;
      if (this.bytes > this.maxBytes) throw new Error("수집기 메시지가 너무 큽니다");
      this.pending += this.decoder.write(piece);
      if (end < 0) return;
      const line = this.pending + this.decoder.end();
      this.pending = "";
      this.bytes = 0;
      this.decoder = new StringDecoder("utf8");
      if (line.trim()) this.receive(JSON.parse(line));
      start = end + 1;
    }
  }
}
