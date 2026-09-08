import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { claudeUsageSnapshotPath, ensureDirs } from "./paths.js";

// claude-hud 0.7.1의 external-usage.ts가 쓰던 형식 그대로다. usage.ts의 parseClaudeSnapshot이
// 이 형식을 읽으므로 필드 이름이 어긋나면 사용량이 통째로 안 보인다.
export interface ClaudeUsageSnapshot {
  updated_at: string;
  five_hour: { used_percentage: number | null; resets_at: string | null };
  seven_day: { used_percentage: number | null; resets_at: string | null };
}

// statusLine은 매 렌더마다 불린다. 값이 같으면 이 간격 안에서는 다시 쓰지 않는다.
export const SNAPSHOT_THROTTLE_MS = 30_000;

function usedPercentage(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

// statusLine stdin의 resets_at은 epoch 초다.
function resetsAt(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function windowOf(value: unknown): ClaudeUsageSnapshot["five_hour"] {
  const w = (value && typeof value === "object" ? value : {}) as {
    used_percentage?: unknown;
    resets_at?: unknown;
  };
  return { used_percentage: usedPercentage(w.used_percentage), resets_at: resetsAt(w.resets_at) };
}

export function parseStatuslinePayload(raw: string): ClaudeUsageSnapshot | null {
  let obj: { rate_limits?: Record<string, unknown> } | null;
  try {
    obj = JSON.parse(raw) as typeof obj;
  } catch {
    return null;
  }
  const limits = obj?.rate_limits;
  if (!limits || typeof limits !== "object") return null;

  const fiveHour = windowOf(limits.five_hour);
  const sevenDay = windowOf(limits.seven_day);
  if (fiveHour.used_percentage === null && sevenDay.used_percentage === null) return null;

  return { updated_at: new Date().toISOString(), five_hour: fiveHour, seven_day: sevenDay };
}

function sameWindows(prevRaw: string, next: ClaudeUsageSnapshot): boolean {
  let prev: ClaudeUsageSnapshot;
  try {
    prev = JSON.parse(prevRaw) as ClaudeUsageSnapshot;
  } catch {
    return false;
  }
  return (
    JSON.stringify(prev?.five_hour) === JSON.stringify(next.five_hour) &&
    JSON.stringify(prev?.seven_day) === JSON.stringify(next.seven_day)
  );
}

export function shouldWriteSnapshot(
  prevRaw: string | undefined,
  next: ClaudeUsageSnapshot,
  prevMtimeMs: number | undefined,
  now: number,
  throttleMs: number
): boolean {
  if (prevRaw === undefined) return true;
  if (!sameWindows(prevRaw, next)) return true;
  if (prevMtimeMs === undefined) return true;
  return now - prevMtimeMs > throttleMs;
}

export function writeSnapshot(snapshot: ClaudeUsageSnapshot): void {
  ensureDirs();
  const path = claudeUsageSnapshotPath();
  // 읽는 쪽이 반쯤 쓴 파일을 보면 안 되므로 임시 파일에 쓰고 갈아끼운다.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  // mode는 새로 만들 때만 먹는다. 남아 있던 tmp를 덮어쓴 경우까지 맞춘다.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
