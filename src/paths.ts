import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ServerInfo } from "./tmux.js";
import { serverKey } from "./tmux.js";

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

export function reposPath(): string {
  return join(hiveHome(), "repos.json");
}

export function cronPath(): string {
  return join(hiveHome(), "cron.json");
}

// cron 실패는 화면 수집을 막지 않고 별도 로그에 남긴다.
export function cronLogPath(): string {
  return join(logsDir(), "cron.log");
}

// claude-hud가 스냅샷을 써 줄 기본 경로. hud는 디렉토리가 이미 있을 때만 쓰므로 ensureDirs()가 만든 HIVE_HOME을 쓴다.
export function claudeUsageSnapshotPath(): string {
  return join(hiveHome(), "claude-usage.json");
}

export function hookScriptPath(): string {
  return join(packageRoot, "hooks", "claude-hook.sh");
}

export function codexHookScriptPath(): string {
  return join(packageRoot, "hooks", "codex-hook.sh");
}

export function sidebarFollowScriptPath(): string {
  return join(packageRoot, "hooks", "sidebar-follow.sh");
}

export function cliEntryPath(): string {
  // 개발 중(tsx)에는 src/cli.tsx, 빌드 후에는 dist/cli.js 자기 자신.
  return fileURLToPath(import.meta.url).replace(/paths\.(ts|js)$/, (_m, ext) =>
    ext === "ts" ? "cli.tsx" : "cli.js"
  );
}

// 자식에게 물려줄 수 있는 건 로더 계열뿐이다. --inspect는 자식이 같은 포트를 잡으려다 죽고,
// --eval이나 --heapsnapshot-signal은 자식이 물려받을 이유가 없다. 그래서 허용 목록으로 거른다.
const LOADER_FLAGS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader"]);

function loaderArgv(): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i];
    const eq = arg.indexOf("=");
    if (!LOADER_FLAGS.has(eq === -1 ? arg : arg.slice(0, eq))) continue;
    out.push(arg);
    // "--require X"처럼 값이 다음 토큰에 오는 형태면 그것까지 가져온다.
    if (eq === -1 && i + 1 < process.execArgv.length) out.push(process.execArgv[++i]);
  }
  return out;
}

// tmux pane이나 자식 프로세스로 자기 자신을 다시 띄울 때 쓰는 argv.
// 호출부마다 따로 조립하면 execArgv를 넘기는 곳과 빠뜨리는 곳이 갈려서(실측) 여기로 모았다.
// 개발 중에는 tsx 로더가 함께 실려 cliEntryPath()가 가리키는 src/cli.tsx가 그대로 뜬다.
export function selfRelaunchArgv(entry: string = cliEntryPath()): string[] {
  return [process.execPath, ...loaderArgv(), entry];
}

export function ensureDirs(): void {
  mkdirSync(spoolDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
}

export function canonicalHiveHome(home = hiveHome()): string {
  mkdirSync(home, { recursive: true });
  return realpathSync(home);
}

export function collectorEntryPath(): string {
  return fileURLToPath(import.meta.url).replace(/paths\.(ts|js)$/, "collectorEntry.$1");
}

export function collectorLogPath(): string {
  return join(logsDir(), "collector.log");
}

export function collectorSocketPath(home: string, server: ServerInfo): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("수집기는 Unix 환경에서 실행해야 합니다");
  // macOS의 Unix 소켓 경로 한계(104바이트)를 넘지 않도록 HIVE_HOME은 해시에만 넣는다.
  const runtimeDir = `/tmp/hive-${uid}`;
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
    throw new Error(`안전하지 않은 수집기 경로입니다: ${runtimeDir}`);
  }
  chmodSync(runtimeDir, 0o700);
  const hash = createHash("sha256").update(JSON.stringify([canonicalHiveHome(home), serverKey(server)])).digest("hex").slice(0, 32);
  return join(runtimeDir, `${hash}.sock`);
}
