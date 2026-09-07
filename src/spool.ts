import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { reduceAgent, type AgentRecord, type RawEvent } from "./state.js";

export interface SpoolRecord {
  v: number;
  ts: number;
  pane: string;
  tmuxSocket: string | null;
  tmuxServerPid: string | null;
  payload: unknown;
}

export function parseSpoolLine(line: string): SpoolRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.v !== "number" || typeof rec.ts !== "number" || typeof rec.pane !== "string") return null;
  if (!("payload" in rec)) return null;

  const tmuxStr = typeof rec.tmux === "string" ? rec.tmux : "";
  const [socket, serverPid] = tmuxStr.split(",");
  return {
    v: rec.v,
    ts: rec.ts,
    pane: rec.pane,
    tmuxSocket: socket || null,
    tmuxServerPid: serverPid || null,
    payload: rec.payload,
  };
}

export interface SplitResult {
  lines: { offset: number; text: string }[];
  nextOffset: number;
}

// startOffset은 buf가 파일 안에서 시작하는 절대 바이트 위치. 개행 없는 마지막 줄은 다음 tick까지 보류한다.
export function splitCompleteLines(buf: string, startOffset: number): SplitResult {
  const lines: { offset: number; text: string }[] = [];
  let offset = startOffset;
  let searchFrom = 0;
  for (;;) {
    const idx = buf.indexOf("\n", searchFrom);
    if (idx === -1) break;
    const text = buf.slice(searchFrom, idx);
    lines.push({ offset, text });
    offset += Buffer.byteLength(buf.slice(searchFrom, idx + 1), "utf8");
    searchFrom = idx + 1;
  }
  return { lines, nextOffset: offset };
}

export interface IngestResult {
  inserted: number;
  skipped: number;
}

export type Reducer = (prev: AgentRecord | undefined, ev: RawEvent) => AgentRecord;

export function ingestAll(db: Db, spoolDir: string, reducer: Reducer = reduceAgent): IngestResult {
  let inserted = 0;
  let skipped = 0;

  let files: string[];
  try {
    files = readdirSync(spoolDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { inserted, skipped };
  }

  for (const file of files) {
    const full = join(spoolDir, file);
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }

    let offset = db.getOffset(file);
    if (offset > size) offset = 0; // hook이 5MB 초과로 truncate한 경우

    if (offset >= size) continue;

    const fileBuf = readFileSync(full);
    const chunk = fileBuf.subarray(offset).toString("utf8");
    const { lines, nextOffset } = splitCompleteLines(chunk, offset);
    if (lines.length === 0) continue;

    db.transaction(() => {
      for (const { offset: lineOffset, text } of lines) {
        const rec = parseSpoolLine(text);
        if (!rec) {
          skipped++;
          continue;
        }
        const payload =
          rec.payload && typeof rec.payload === "object" ? (rec.payload as Record<string, unknown>) : {};
        const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : null;
        const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
        const tmuxPid = rec.tmuxServerPid ?? "";

        const changes = db.insertEvent({
          spoolFile: file,
          spoolOffset: lineOffset,
          ts: rec.ts,
          tmuxPid,
          paneId: rec.pane,
          sessionId,
          event,
          toolName,
          payload: JSON.stringify(rec.payload),
        });

        if (changes === 1) {
          inserted++;
          const prev = db.getAgent(tmuxPid, rec.pane);
          const next = reducer(prev, { ts: rec.ts, event, payload: rec.payload, tmuxPid, paneId: rec.pane });
          db.upsertAgent(next);
        }
      }
      db.setOffset(file, nextOffset);
    });
  }

  return { inserted, skipped };
}
