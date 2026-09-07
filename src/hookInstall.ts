import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookScriptPath } from "./paths.js";

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

// (*) 표시 4개(PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest)만 matcher "*"를 받는다. 나머지는 matcher 없이 전부 매치.
export const HIVE_HOOK_EVENTS: { event: string; matcher: boolean }[] = [
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

export function applyHiveHooks(settings: Settings, scriptPath: string): Settings {
  const result: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const { event, matcher } of HIVE_HOOK_EVENTS) {
    const groups = (result.hooks![event] ?? []).map((g) => ({ ...g, hooks: [...g.hooks] }));
    const alreadyInstalled = groups.some((g) => g.hooks.some((h) => h.command === scriptPath));
    if (!alreadyInstalled) {
      const entry: HookEntry = { type: "command", command: scriptPath, timeout: TIMEOUT_SECONDS };
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

export function hiveHookStatus(settings: Settings, scriptPath: string): { event: string; installed: boolean }[] {
  return HIVE_HOOK_EVENTS.map(({ event }) => {
    const groups = settings.hooks?.[event] ?? [];
    const installed = groups.some((g) => g.hooks.some((h) => h.command === scriptPath));
    return { event, installed };
  });
}

export function defaultSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "/root", ".claude");
  return join(configDir, "settings.json");
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
  settingsPath?: string;
  dryRun?: boolean;
}

export interface HookIoResult {
  path: string;
  backupPath?: string;
  dryRun: boolean;
}

function writeWithBackup(path: string, next: Settings, dryRun: boolean | undefined): HookIoResult {
  if (dryRun) return { path, dryRun: true };
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = backupPath(path);
    copyFileSync(path, backup);
  }
  writeSettings(path, next);
  return { path, backupPath: backup, dryRun: false };
}

export function installHooks(opts: HookIoOptions = {}): HookIoResult {
  const path = opts.settingsPath ?? defaultSettingsPath();
  const next = applyHiveHooks(readSettings(path), hookScriptPath());
  return writeWithBackup(path, next, opts.dryRun);
}

export function uninstallHooks(opts: HookIoOptions = {}): HookIoResult {
  const path = opts.settingsPath ?? defaultSettingsPath();
  const next = removeHiveHooks(readSettings(path), hookScriptPath());
  return writeWithBackup(path, next, opts.dryRun);
}

export function statusHooks(opts: { settingsPath?: string } = {}): { event: string; installed: boolean }[] {
  const path = opts.settingsPath ?? defaultSettingsPath();
  return hiveHookStatus(readSettings(path), hookScriptPath());
}
