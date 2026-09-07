import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexHookScriptPath, hookScriptPath } from "./paths.js";
import { AGENT_KINDS, type AgentKind } from "./state.js";

export { AGENT_KINDS, type AgentKind };

export interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

const TIMEOUT_SECONDS = 5;
// codex는 SessionEnd/Interrupt hook의 timeout을 3초로 잘라내고 그때마다 경고를 찍는다(실측).
const CODEX_SHORT_TIMEOUT_SECONDS = 3;

export interface HookEventSpec {
  event: string;
  matcher: boolean;
  timeout?: number;
}

// (*) 표시 4개(PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest)만 matcher "*"를 받는다. 나머지는 matcher 없이 전부 매치.
export const HIVE_HOOK_EVENTS: HookEventSpec[] = [
  { event: "SessionStart", matcher: false },
  { event: "SessionEnd", matcher: false },
  { event: "UserPromptSubmit", matcher: false },
  { event: "PreToolUse", matcher: true },
  { event: "PostToolUse", matcher: true },
  { event: "PostToolUseFailure", matcher: true },
  { event: "PermissionRequest", matcher: true },
  { event: "Notification", matcher: false },
  { event: "Stop", matcher: false },
  { event: "StopFailure", matcher: false },
  { event: "SubagentStart", matcher: false },
  { event: "SubagentStop", matcher: false },
  { event: "TeammateIdle", matcher: false },
  { event: "PostCompact", matcher: false },
];

// codex가 아는 이벤트만 등록한다. 모르는 이름을 넣으면 hooks.json 전체 파싱이 깨진다.
// codex 쪽 hook 설정에는 matcher를 쓰지 않는다(모든 tool을 그대로 받는다).
export const HIVE_CODEX_HOOK_EVENTS: HookEventSpec[] = [
  { event: "SessionStart", matcher: false },
  { event: "SessionEnd", matcher: false, timeout: CODEX_SHORT_TIMEOUT_SECONDS },
  { event: "UserPromptSubmit", matcher: false },
  { event: "PreToolUse", matcher: false },
  { event: "PostToolUse", matcher: false },
  { event: "PermissionRequest", matcher: false },
  { event: "Stop", matcher: false },
  { event: "SubagentStart", matcher: false },
  { event: "SubagentStop", matcher: false },
  { event: "PostCompact", matcher: false },
  { event: "Interrupt", matcher: false, timeout: CODEX_SHORT_TIMEOUT_SECONDS },
];

export function hookEventsFor(agent: AgentKind): HookEventSpec[] {
  return agent === "codex" ? HIVE_CODEX_HOOK_EVENTS : HIVE_HOOK_EVENTS;
}

export function hookScriptFor(agent: AgentKind): string {
  return agent === "codex" ? codexHookScriptPath() : hookScriptPath();
}

export function applyHiveHooks(
  settings: Settings,
  scriptPath: string,
  events: HookEventSpec[] = HIVE_HOOK_EVENTS
): Settings {
  const result: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const { event, matcher, timeout } of events) {
    const groups = (result.hooks![event] ?? []).map((g) => ({ ...g, hooks: [...g.hooks] }));
    const alreadyInstalled = groups.some((g) => g.hooks.some((h) => h.command === scriptPath));
    if (!alreadyInstalled) {
      const entry: HookEntry = { type: "command", command: scriptPath, timeout: timeout ?? TIMEOUT_SECONDS };
      groups.push(matcher ? { matcher: "*", hooks: [entry] } : { hooks: [entry] });
    }
    result.hooks![event] = groups;
  }
  return result;
}

export function removeHiveHooks(settings: Settings, scriptPath: string): Settings {
  const result: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const event of Object.keys(result.hooks!)) {
    const groups = result.hooks![event]
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.command !== scriptPath) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length > 0) result.hooks![event] = groups;
    else delete result.hooks![event];
  }
  if (Object.keys(result.hooks!).length === 0) delete result.hooks;
  return result;
}

export function hiveHookStatus(
  settings: Settings,
  scriptPath: string,
  events: HookEventSpec[] = HIVE_HOOK_EVENTS
): { event: string; installed: boolean }[] {
  return events.map(({ event }) => {
    const groups = settings.hooks?.[event] ?? [];
    const installed = groups.some((g) => g.hooks.some((h) => h.command === scriptPath));
    return { event, installed };
  });
}

export function defaultSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "/root", ".claude");
  return join(configDir, "settings.json");
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(process.env.HOME ?? "/root", ".codex");
}

export function defaultCodexHooksPath(): string {
  return join(codexHome(), "hooks.json");
}

export function defaultCodexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

export function defaultHookFilePath(agent: AgentKind): string {
  return agent === "codex" ? defaultCodexHooksPath() : defaultSettingsPath();
}

// codex는 hooks.json에 적힌 hook을 그냥 실행하지 않는다. config.toml의
// [hooks.state."<hooks.json 경로>:<event(snake_case)>:<그룹 index>:<hook index>"] 에
// enabled = true 와 trusted_hash 가 있어야 돈다. 승인은 codex TUI에서 사용자가 한다.
export function codexStateKey(hooksPath: string, event: string, groupIndex: number, hookIndex: number): string {
  const snake = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return `${hooksPath}:${snake}:${groupIndex}:${hookIndex}`;
}

// TOML 파서를 의존성으로 들이지 않고 [hooks.state."..."] 섹션의 enabled만 읽는다.
export function parseCodexHookState(toml: string): Map<string, boolean> {
  const state = new Map<string, boolean>();
  let current: string | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const header = /^\[hooks\.state\."(.*)"\]$/.exec(line);
    if (header) {
      current = header[1];
      if (!state.has(current)) state.set(current, false);
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (current && /^enabled\s*=\s*true\b/.test(line)) state.set(current, true);
  }
  return state;
}

// 설치된 hook이 hooks.json 안에서 몇 번째 그룹/항목인지가 신뢰 키에 들어가므로 위치를 그대로 찾는다.
function findHookPosition(
  settings: Settings,
  event: string,
  scriptPath: string
): { groupIndex: number; hookIndex: number } | undefined {
  const groups = settings.hooks?.[event] ?? [];
  for (const [groupIndex, group] of groups.entries()) {
    const hookIndex = group.hooks.findIndex((h) => h.command === scriptPath);
    if (hookIndex !== -1) return { groupIndex, hookIndex };
  }
  return undefined;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Settings;
}

function writeSettings(path: string, settings: Settings): void {
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function backupPath(path: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.hive-backup-${iso}`;
}

export interface HookIoOptions {
  agents?: AgentKind[];
  settingsPath?: string;
  codexHooksPath?: string;
  dryRun?: boolean;
}

export interface HookIoResult {
  agent: AgentKind;
  path: string;
  backupPath?: string;
  dryRun: boolean;
}

function writeWithBackup(
  agent: AgentKind,
  path: string,
  next: Settings,
  dryRun: boolean | undefined
): HookIoResult {
  if (dryRun) return { agent, path, dryRun: true };
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = backupPath(path);
    copyFileSync(path, backup);
  } else {
    // codex를 한 번도 안 쓴 환경에는 ~/.codex 자체가 없다.
    mkdirSync(dirname(path), { recursive: true });
  }
  writeSettings(path, next);
  return { agent, path, backupPath: backup, dryRun: false };
}

function pathFor(agent: AgentKind, opts: HookIoOptions): string {
  const override = agent === "codex" ? opts.codexHooksPath : opts.settingsPath;
  return override ?? defaultHookFilePath(agent);
}

function targetAgents(opts: { agents?: AgentKind[] }): AgentKind[] {
  return opts.agents ?? AGENT_KINDS;
}

export function installHooks(opts: HookIoOptions = {}): HookIoResult[] {
  return targetAgents(opts).map((agent) => {
    const path = pathFor(agent, opts);
    const next = applyHiveHooks(readSettings(path), hookScriptFor(agent), hookEventsFor(agent));
    return writeWithBackup(agent, path, next, opts.dryRun);
  });
}

export function uninstallHooks(opts: HookIoOptions = {}): HookIoResult[] {
  return targetAgents(opts).map((agent) => {
    const path = pathFor(agent, opts);
    const next = removeHiveHooks(readSettings(path), hookScriptFor(agent));
    return writeWithBackup(agent, path, next, opts.dryRun);
  });
}

export interface HookStatusRow {
  agent: AgentKind;
  event: string;
  installed: boolean;
  // codex만 채운다. hooks.json에 등록돼 있어도 신뢰 승인 전이면 hook이 돌지 않는다.
  trusted?: boolean;
}

export interface HookStatusOptions {
  agents?: AgentKind[];
  settingsPath?: string;
  codexHooksPath?: string;
  codexConfigPath?: string;
}

export function statusHooks(opts: HookStatusOptions = {}): HookStatusRow[] {
  const rows: HookStatusRow[] = [];
  for (const agent of targetAgents(opts)) {
    const path = pathFor(agent, opts);
    const settings = readSettings(path);
    const scriptPath = hookScriptFor(agent);
    const events = hookEventsFor(agent);

    if (agent !== "codex") {
      rows.push(...hiveHookStatus(settings, scriptPath, events).map((r) => ({ agent, ...r })));
      continue;
    }

    const configPath = opts.codexConfigPath ?? defaultCodexConfigPath();
    const state = parseCodexHookState(existsSync(configPath) ? readFileSync(configPath, "utf8") : "");
    for (const { event } of events) {
      const pos = findHookPosition(settings, event, scriptPath);
      const trusted =
        pos !== undefined && (state.get(codexStateKey(path, event, pos.groupIndex, pos.hookIndex)) ?? false);
      rows.push({ agent, event, installed: pos !== undefined, trusted });
    }
  }
  return rows;
}
