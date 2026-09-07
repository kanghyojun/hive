import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface AbConfig {
  macHost: string;
  port: number;
}

// ab-bridge lib/config.sh와 같은 기본값. 설정 파일이 없어도 이 값으로 돈다.
const DEFAULT_MAC_HOST = "macbookpro";
const DEFAULT_PORT = 9222;
const PROBE_TIMEOUT_MS = 3000;

export function parseAbConfig(raw: string | undefined, profile = "main"): AbConfig {
  if (!raw) return { macHost: DEFAULT_MAC_HOST, port: DEFAULT_PORT };
  try {
    const cfg = JSON.parse(raw) as {
      macHost?: unknown;
      profiles?: Record<string, { port?: unknown } | undefined>;
    };
    const macHost = typeof cfg.macHost === "string" && cfg.macHost ? cfg.macHost : DEFAULT_MAC_HOST;
    const port = Number(cfg.profiles?.[profile]?.port);
    return { macHost, port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT };
  } catch {
    return { macHost: DEFAULT_MAC_HOST, port: DEFAULT_PORT };
  }
}

export function abConfigPath(): string {
  return process.env.AB_BRIDGE_CONFIG ?? join(process.env.HOME ?? "/root", ".config", "ab-bridge", "profiles.json");
}

// ab-bridge가 안 깔린 머신에서는 사이드바에 ab 상태를 아예 표시하지 않는다.
export function abLocalInstalled(): boolean {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, "ab-local")));
}

export type AbStatus = "up" | "down" | "no-ip" | "no-tailscale";

const execFileAsync = promisify(execFile);

// TUI tick이 최대 6초 멈추면 안 되므로 동기 호출을 쓰지 않는다.
export async function probeAbBridge(cfg: AbConfig): Promise<{ status: AbStatus; ip?: string }> {
  let ip: string;
  try {
    const { stdout } = await execFileAsync("tailscale", ["ip", "-4", cfg.macHost], { timeout: PROBE_TIMEOUT_MS });
    ip = stdout.trim().split("\n")[0] ?? "";
  } catch (err) {
    // 못 찾는 호스트에도 tailscale은 exit 1을 낸다(실측). 종료 코드만 보면 맥이 꺼진 것과
    // tailscale이 아예 없는 것이 구분이 안 돼 no-ip가 도달 불가 상태가 된다.
    // spawn 자체가 실패한 것(ENOENT 등)만 no-tailscale로 본다.
    const code = (err as { code?: unknown }).code;
    return { status: typeof code === "string" ? "no-tailscale" : "no-ip" };
  }
  if (!ip) return { status: "no-ip" };

  // MagicDNS 이름을 쓰면 Chrome이 Host 헤더를 보고 거절한다. tailnet IP로만 붙는다.
  try {
    const res = await fetch(`http://${ip}:${cfg.port}/json/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 이 포트에 CDP가 아닌 서버가 떠 있어도 200이 온다. 응답이 CDP인지까지 봐야 한다.
    // 본문을 안 읽고 버리면 소켓이 keep-alive로 남으므로 어느 쪽이든 끝까지 읽는다.
    if (!res.ok) {
      await res.body?.cancel();
      return { status: "down", ip };
    }
    const body = (await res.json()) as { webSocketDebuggerUrl?: unknown };
    return { status: typeof body.webSocketDebuggerUrl === "string" ? "up" : "down", ip };
  } catch {
    return { status: "down", ip };
  }
}
