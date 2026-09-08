import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import stringWidth from "string-width";
import { claudeUsageSnapshotPath } from "./paths.js";
import { codexHome } from "./hookInstall.js";
import { AGENT_GLYPH, type AgentKind } from "./state.js";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** epoch ms. 모르면 null. */
  resetsAt: number | null;
}

export interface AgentUsage {
  agent: AgentKind;
  windows: UsageWindow[];
  updatedAt: number | null;
  note?: string;
}

export const USAGE_STALE_MS = 3_600_000;
const WARN_PERCENT = 70;
const DANGER_PERCENT = 90;
const BAR_CELLS = 10;
// 최신 rollout의 token_count 줄은 1KB 안팎이라 꼬리 256KB면 대개 잡힌다. 못 찾으면 한 번만 더 넓힌다.
const CODEX_TAIL_BYTES = [256 * 1024, 1024 * 1024];
const CODEX_RECENT_DAYS = 3;

function toMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function parseClaudeSnapshot(raw: string): AgentUsage | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const windows: UsageWindow[] = [];
  const add = (label: string, value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const w = value as { used_percentage?: unknown; resets_at?: unknown };
    if (typeof w.used_percentage !== "number") return;
    windows.push({ label, usedPercent: w.used_percentage, resetsAt: toMs(w.resets_at) });
  };
  add("5h", obj.five_hour);
  add("7d", obj.seven_day);
  if (windows.length === 0) return null;

  return { agent: "claude", windows, updatedAt: toMs(obj.updated_at) };
}

// claude-hud 0.7.1의 src/claude-config-dir.ts와 같은 규칙이어야 한다. 해석이 갈리면
// hud가 쓴 파일을 hive가 못 찾아 사용량이 통째로 안 보인다.
function claudeConfigDir(): string {
  const home = homedir();
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!env) return join(home, ".claude");
  if (env === "~") return home;
  if (env.startsWith("~/") || env.startsWith("~\\")) return resolve(join(home, env.slice(2)));
  return resolve(env);
}

// hive statusline이 생기기 전에는 hud가 스냅샷을 써 줬다. 그렇게 설정해 둔 사람을 위해 계속 읽는다.
function hudExternalUsagePath(): string | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(claudeConfigDir(), "plugins", "claude-hud", "config.json"), "utf8")
    ) as { display?: { externalUsageWritePath?: unknown } };
    const path = raw.display?.externalUsageWritePath;
    if (typeof path !== "string" || !path) return undefined;
    // hud는 절대경로이면서 .json인 것만 실제로 쓴다(resolveSnapshotWritePath).
    // 그 조건을 안 맞추면 hud가 안 쓴 자리를 가리키게 되므로 여기서도 같이 거른다.
    if (!isAbsolute(path) || extname(path).toLowerCase() !== ".json") return undefined;
    return normalize(path);
  } catch {
    return undefined;
  }
}

export function claudeSnapshotPath(): string {
  const env = process.env.HIVE_CLAUDE_USAGE_PATH;
  if (env) return env;
  // hive statusline이 쓴 자기 파일이 있으면 그게 이긴다. hud 경로는 그게 없을 때만 본다.
  const own = claudeUsageSnapshotPath();
  if (existsSync(own)) return own;
  return hudExternalUsagePath() || own;
}

export function readClaudeUsage(): AgentUsage | null {
  try {
    return parseClaudeSnapshot(readFileSync(claudeSnapshotPath(), "utf8"));
  } catch {
    return null;
  }
}

// 문자열 포함만으로 고른 줄은 실제 rate_limits가 아닐 수 있다. rate_limits가 null인
// token_count 줄이나, 두 낱말을 본문에 담은 도구 출력 줄이 실측으로 존재한다(실측).
// 그래서 후보 줄 하나로 끝내지 않고 파싱에 성공할 때까지 앞으로 계속 내려간다.
export function findLastCodexUsage(text: string): AgentUsage | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes("token_count") || !line.includes("rate_limits")) continue;
    // 꼬리를 자른 자리나 쓰다 만 마지막 줄도 여기서 null이 되어 앞 줄로 내려간다.
    const usage = parseCodexRateLimits(line);
    if (usage) return usage;
  }
  return null;
}

// 창 이름은 primary/secondary 자리가 아니라 window_minutes로 정한다. 플랜에 따라 자리가 바뀐다(실측).
// 값이 없거나 0이면 "0h" 같은 없는 창 이름을 지어내지 말고 모른다고 표시한다.
const UNKNOWN_WINDOW_LABEL = "?";
function windowLabel(minutes: unknown): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
    return UNKNOWN_WINDOW_LABEL;
  }
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  return `${Math.round(minutes / 60)}h`;
}

export function parseCodexRateLimits(line: string): AgentUsage | null {
  let obj: { timestamp?: unknown; payload?: { rate_limits?: Record<string, unknown> } };
  try {
    obj = JSON.parse(line) as typeof obj;
  } catch {
    return null;
  }
  const limits = obj.payload?.rate_limits;
  if (!limits || typeof limits !== "object") return null;

  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const value = limits[key];
    if (!value || typeof value !== "object") continue;
    const w = value as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
    if (typeof w.used_percent !== "number") continue;
    windows.push({
      label: windowLabel(w.window_minutes),
      usedPercent: w.used_percent,
      resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : null,
    });
  }
  if (windows.length === 0) return null;

  return { agent: "codex", windows, updatedAt: toMs(obj.timestamp), note: "마지막 응답 기준" };
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// 세션 파일이 1000개를 넘어서 전체 stat은 비싸다. YYYY/MM/DD 이름 정렬로 최신 며칠만 본다.
export function newestRolloutFile(sessionsDir: string): string | null {
  const dayDirs: string[] = [];
  for (const year of subdirs(sessionsDir)) {
    for (const month of subdirs(join(sessionsDir, year))) {
      for (const day of subdirs(join(sessionsDir, year, month))) {
        dayDirs.push(join(sessionsDir, year, month, day));
      }
    }
  }

  let best: { path: string; mtime: number } | null = null;
  for (const dir of dayDirs.slice(-CODEX_RECENT_DAYS)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const mtime = statSync(path).mtimeMs;
        if (!best || mtime > best.mtime) best = { path, mtime };
      } catch {
        // 그 사이 사라진 파일은 넘어간다.
      }
    }
  }
  return best?.path ?? null;
}

export function readTail(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(length);
    // allocUnsafe는 남의 메모리가 그대로 들어 있다. 실제로 읽은 바이트까지만 문자열로 바꾼다.
    const read = readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

export function readCodexUsage(): AgentUsage | null {
  const file = newestRolloutFile(join(codexHome(), "sessions"));
  if (!file) return null;
  for (const bytes of CODEX_TAIL_BYTES) {
    const usage = findLastCodexUsage(readTail(file, bytes));
    if (usage) return usage;
  }
  return null;
}

function clip(text: string, width: number): string {
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return "방금";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)));
  return "▓".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

export function formatUsageLines(
  usages: AgentUsage[],
  now: number,
  width: number
): { text: string; color?: string }[] {
  const lines: { text: string; color?: string }[] = [];
  const push = (text: string, color?: string): void => {
    lines.push(color ? { text: clip(text, width), color } : { text: clip(text, width) });
  };

  push("── 사용량 ──");

  for (const agent of ["claude", "codex"] as AgentKind[]) {
    const glyph = AGENT_GLYPH[agent];
    const usage = usages.find((u) => u.agent === agent);
    if (!usage) {
      push(agent === "claude" ? `${glyph} 스냅샷 없음 — hive statusline 등록` : `${glyph} codex 세션 없음`);
      continue;
    }

    for (const w of usage.windows) {
      const percent = Math.round(w.usedPercent);
      // 창이 이미 지났으면 이 %는 끝난 창의 값이다. 그대로 두면 경고색만 남아 거짓 알람이 된다.
      const expired = w.resetsAt !== null && w.resetsAt <= now;
      const remain = expired ? "지난 창" : w.resetsAt !== null ? formatDuration(w.resetsAt - now) : "";
      const color = expired
        ? undefined
        : percent >= DANGER_PERCENT
          ? "red"
          : percent >= WARN_PERCENT
            ? "yellow"
            : undefined;
      const label = w.label.padEnd(2);
      push(`${glyph} ${label} ${bar(w.usedPercent)} ${String(percent).padStart(3)}%  ${remain}`.trimEnd(), color);
    }

    const parts: string[] = [];
    if (usage.note) parts.push(usage.note);
    if (usage.updatedAt !== null) {
      parts.push(`${formatAgo(now - usage.updatedAt)}${now - usage.updatedAt > USAGE_STALE_MS ? " (오래됨)" : ""}`);
    }
    if (parts.length > 0) push(`  ${usage.note ? "" : "갱신 "}${parts.join(", ")}`);
  }

  return lines;
}
