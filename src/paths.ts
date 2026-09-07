import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

// dist/cli.js와 src/cli.tsx 둘 다에서 동작해야 하므로 패키지 루트는 이 파일 기준 상위 디렉토리로 구한다.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDir, "..");

let homeOverride: string | undefined;

export function setHiveHomeOverride(dir: string | undefined): void {
  homeOverride = dir;
}

export function hiveHome(): string {
  return homeOverride ?? process.env.HIVE_HOME ?? join(process.env.HOME ?? "/root", ".hive");
}

export function dbPath(): string {
  return join(hiveHome(), "hive.db");
}

export function spoolDir(): string {
  return join(hiveHome(), "spool");
}

export function logsDir(): string {
  return join(hiveHome(), "logs");
}

export function uiStatePath(): string {
  return join(hiveHome(), "ui.json");
}

export function hookScriptPath(): string {
  return join(packageRoot, "hooks", "claude-hook.sh");
}

export function codexHookScriptPath(): string {
  return join(packageRoot, "hooks", "codex-hook.sh");
}

export function cliEntryPath(): string {
  // 개발 중(tsx)에는 src/cli.tsx, 빌드 후에는 dist/cli.js 자기 자신.
  return fileURLToPath(import.meta.url).replace(/paths\.(ts|js)$/, (_m, ext) =>
    ext === "ts" ? "cli.tsx" : "cli.js"
  );
}

export function selfCommand(): [string, string] {
  return [process.execPath, cliEntryPath()];
}

export function ensureDirs(): void {
  mkdirSync(spoolDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
}
