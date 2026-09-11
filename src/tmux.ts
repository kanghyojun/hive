import { execFileSync } from "node:child_process";

export class TmuxError extends Error {
  constructor(
    public args: string[],
    public stderr: string
  ) {
    super(`tmux ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

let socketOverride: string | undefined;
let paneOverride: string | undefined;

export function setTmuxSocketOverride(socket: string | undefined): void {
  socketOverride = socket;
}

export function setPaneOverride(paneId: string | undefined): void {
  paneOverride = paneId;
}

// cron이 자식 프로세스를 띄울 때 지금 쓰는 소켓을 그대로 물려주려면 밖에서도 읽어야 한다.
export function socketPath(): string | undefined {
  if (socketOverride) return socketOverride;
  if (process.env.HIVE_TMUX_SOCKET) return process.env.HIVE_TMUX_SOCKET;
  const tmuxEnv = process.env.TMUX;
  if (tmuxEnv) return tmuxEnv.split(",")[0];
  return undefined;
}

export function tmux(args: string[]): string {
  const socket = socketPath();
  const fullArgs = socket ? ["-S", socket, ...args] : args;
  try {
    // execFileSync는 기본적으로 자식 stderr를 부모 stderr로 그대로 흘려보낸다(문서 확인). "옵션 없음" 같은
    // 예상 가능한 실패까지 새어나가지 않도록 stdio를 명시해 캡처한다.
    return execFileSync("tmux", fullArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : (e.message ?? String(err));
    throw new TmuxError(fullArgs, stderr);
  }
}

export function insideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

// tmux가 run-shell로 실행하는 명령에는 TMUX_PANE이 들어오지 않는다. -t를 줘도 마찬가지다(실측).
// 그래서 tmux 바인딩은 --pane '#{pane_id}'로 pane을 직접 넘기고, 그것도 없으면 활성 pane을 조회한다.
export function currentPaneId(): string | undefined {
  if (paneOverride) return paneOverride;
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  try {
    return tmux(["display-message", "-p", "#{pane_id}"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function currentSessionName(): string | undefined {
  const paneId = currentPaneId();
  if (!paneId) return undefined;
  return listPanes().find((p) => p.paneId === paneId)?.sessionName;
}

export interface ServerInfo {
  pid: string;
  startTime: string;
  socketPath: string;
}

export function serverInfo(): ServerInfo {
  const out = tmux(["display-message", "-p", "#{pid}\t#{start_time}\t#{socket_path}"]).trim();
  const [pid, startTime, sock] = out.split("\t");
  if (!pid || !startTime || !sock) throw new Error("tmux 서버 정보를 읽을 수 없습니다");
  return { pid, startTime, socketPath: sock };
}

export function serverKey(server: ServerInfo): string {
  return JSON.stringify([server.socketPath, server.pid, server.startTime]);
}

export interface PaneInfo {
  sessionName: string;
  sessionId: string;
  windowId: string;
  windowIndex: string;
  windowName: string;
  /** tmux가 활성 pane의 명령어로 창 이름을 자동으로 바꾸는 중인지. 켜져 있으면 창 이름은 라벨로 못 쓴다. */
  windowAutoName: boolean;
  windowActive: boolean;
  windowActivity: number;
  paneId: string;
  paneActive: boolean;
  paneCurrentPath: string;
  paneCurrentCommand: string;
  /** claude가 OSC로 써 넣는 제목. 작업이 진행되면서 바뀐다. */
  paneTitle: string;
  panePid: string;
  /** 서버에 하나뿐인 hive 사이드바의 pane id. 사이드바가 없으면 빈 문자열. */
  sidebarPaneId: string;
  /** 이 pane 자신이 사이드바인지. 서버 옵션과 달리 pane을 따라다녀서 어긋나지 않는다. */
  sidebarMark: boolean;
  /** 이 pane의 세션에 붙어 있는 클라이언트가 있는지. windowActive와 같이 봐야 "사람이 보고 있는 창"이 된다. */
  sessionAttached: boolean;
}

// sidebar.ts가 이 이름으로 서버 옵션을 심는다. 포맷 문자열 안에서는 값이 없어도 에러 대신 빈 문자열이 나온다(실측).
export const SIDEBAR_PANE_OPTION = "@hive_sidebar_pane";

// 서버 옵션은 사이드바가 죽는 순서나 join-pane에 따라 실제 pane과 어긋난다. pane 옵션은 pane과 함께
// 사라지고 join-pane으로 window를 옮겨도 따라온다(실측). 그래서 "사이드바인가"는 이쪽으로 판단한다.
export const SIDEBAR_MARK_OPTION = "@hive_sidebar";

const PANE_FIELDS = [
  "#{session_name}",
  "#{session_id}",
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{automatic-rename}",
  "#{window_active}",
  "#{window_activity}",
  "#{pane_id}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_title}",
  "#{pane_pid}",
  `#{${SIDEBAR_PANE_OPTION}}`,
  `#{${SIDEBAR_MARK_OPTION}}`,
  // 붙어 있는 클라이언트 수다. 0이면 아무도 이 세션을 보고 있지 않다.
  "#{session_attached}",
].join("\t");

export function listPanes(): PaneInfo[] {
  try {
    return listPanesStrict();
  } catch {
    return [];
  }
}

export function listPanesStrict(): PaneInfo[] {
  const out = tmux(["list-panes", "-a", "-F", PANE_FIELDS]);
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [
        sessionName,
        sessionId,
        windowId,
        windowIndex,
        windowName,
        windowAutoName,
        windowActive,
        windowActivity,
        paneId,
        paneActive,
        paneCurrentPath,
        paneCurrentCommand,
        paneTitle,
        panePid,
        sidebarPaneId,
        sidebarMark,
        sessionAttached,
      ] = line.split("\t");
      return {
        sessionName,
        sessionId,
        windowId,
        windowIndex,
        windowName,
        windowAutoName: windowAutoName === "1",
        windowActive: windowActive === "1",
        windowActivity: Number(windowActivity) || 0,
        paneId,
        paneActive: paneActive === "1",
        paneCurrentPath,
        paneCurrentCommand,
        paneTitle,
        panePid,
        sidebarPaneId,
        sidebarMark: sidebarMark === "1",
        sessionAttached: sessionAttached !== undefined && sessionAttached !== "0",
      };
    });
}

export function killWindow(windowId: string): void {
  tmux(["kill-window", "-t", windowId]);
}

export function paneExists(paneId: string): boolean {
  return listPanes().some((p) => p.paneId === paneId);
}

export interface ProcInfo {
  pid: string;
  ppid: string;
  comm: string;
}

// codex는 npm 래퍼(node)가 실제 바이너리를 자식으로 띄워서 #{pane_current_command}가 node로 나온다(실측).
// pane 하나씩 ps를 부르면 tick마다 pane 수만큼 프로세스를 띄우게 되므로 전체 목록을 한 번에 받는다.
export function listProcesses(): ProcInfo[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return [];
  }
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, ...rest] = parts;
    procs.push({ pid, ppid, comm: rest.join(" ") });
  }
  return procs;
}

export function selectWindow(windowId: string): void {
  tmux(["select-window", "-t", windowId]);
}

export function selectPane(paneId: string): void {
  tmux(["select-pane", "-t", paneId]);
}

export function resizePaneWidth(paneId: string, width: number): void {
  tmux(["resize-pane", "-t", paneId, "-x", String(width)]);
}

export function capturePaneTail(paneId: string, lines: number): string {
  try {
    return tmux(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
  } catch {
    return "";
  }
}

// session을 주지 않으면 지금 클라이언트가 보고 있는 세션에 붙는다. 사람이 부르지 않은 자리
// (cron)에서는 붙을 클라이언트가 없거나 엉뚱한 세션일 수 있으므로 세션을 명시한다.
// -t에 세션 이름만 주면 tmux는 그걸 "그 세션의 현재 창"으로 읽어서 인덱스가 겹친다고 거절한다(실측).
// 뒤에 :를 붙여야 세션 자체를 가리켜 빈 인덱스를 찾아 준다.
export function newWindow(opts: { name: string; cwd: string; command: string; session?: string }): string {
  return tmux([
    "new-window",
    "-P",
    "-F",
    "#{window_id}",
    ...(opts.session ? ["-t", `${opts.session}:`] : []),
    "-n",
    opts.name,
    "-c",
    opts.cwd,
    opts.command,
  ]).trim();
}

// tmux는 세션 이름에서 ., : 를 특별 취급한다(: 는 target 구분자, . 는 pane 구분자).
// 그대로 넘기면 이후 -t <name> 조회가 엉뚱한 대상을 가리키므로 여기서 -로 바꾼다.
export function sanitizeSessionName(name: string): string {
  return name.replaceAll(/[.:\s]/g, "-").replace(/^-+|-+$/g, "") || "hive";
}

export function sessionExists(name: string): boolean {
  try {
    // =을 붙여야 prefix 매칭이 아니라 정확히 같은 이름만 찾는다.
    tmux(["has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

export interface NewSessionResult {
  sessionName: string;
  windowId: string;
}

export interface TermSize {
  width: number;
  height: number;
}

// 클라이언트가 붙어 있지 않은 세션은 default-size(기본 80x24)로 만들어진다. 나중에 클라이언트가 붙어
// 크기가 커지면 tmux가 pane 폭을 비율로 늘리기 때문에, 그 전에 나눠 둔 사이드바가 같이 부풀어 오른다(실측).
// 그래서 새 세션은 처음부터 지금 보고 있는 window와 같은 크기로 만든다.
export function windowSize(target: string): TermSize | undefined {
  try {
    const out = tmux(["display-message", "-p", "-t", target, "#{window_width}\t#{window_height}"]).trim();
    const [width, height] = out.split("\t").map(Number);
    if (!width || !height) return undefined;
    return { width, height };
  } catch {
    return undefined;
  }
}

export function newSession(opts: { name: string; cwd: string; command: string; size?: TermSize }): NewSessionResult {
  const out = tmux([
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_name}\t#{window_id}",
    ...(opts.size ? ["-x", String(opts.size.width), "-y", String(opts.size.height)] : []),
    "-s",
    opts.name,
    // 세션 이름만 주면 첫 window 이름이 실행 명령(zsh)이 되어 사이드바에 브랜치가 안 보인다.
    "-n",
    opts.name,
    "-c",
    opts.cwd,
    opts.command,
  ]).trim();
  const [sessionName, windowId] = out.split("\t");
  return { sessionName, windowId };
}

export function splitLeft(
  opts: { target: string; width: number; command: string; env?: Record<string, string> }
): string {
  // 환경변수는 command 문자열에 끼워 넣지 않고 -e로 넘긴다. 명령은 셸이 해석하지만
  // -e는 tmux가 pane 환경에 직접 넣어 줘서 인용을 신경 쓸 필요가 없다.
  const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return tmux([
    "split-window",
    "-hb",
    "-l",
    String(opts.width),
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    ...envArgs,
    "-t",
    opts.target,
    opts.command,
  ]).trim();
}

// 사이드바를 지금 보는 창으로 데려올 때 쓴다. hook 안에서는 이 함수를 못 쓰고 tmux 명령 문자열을 짜야 한다.
export function joinPaneLeft(opts: { source: string; target: string; width: number }): void {
  tmux(["join-pane", "-d", "-hb", "-l", String(opts.width), "-s", opts.source, "-t", opts.target]);
}

export function setPaneOption(paneId: string, name: string, value: string): void {
  tmux(["set-option", "-p", "-t", paneId, name, value]);
}

// #{@name} 포맷은 어느 세션, 어느 pane에서 풀어도 서버 옵션 값을 돌려준다(실측).
export function setServerOption(name: string, value: string): void {
  tmux(["set-option", "-s", name, value]);
}

export function unsetServerOption(name: string): void {
  try {
    tmux(["set-option", "-su", name]);
  } catch {
    // 옵션이 이미 없으면 tmux가 에러를 내므로 무시한다.
  }
}

export function unsetSessionOption(session: string, name: string): void {
  try {
    tmux(["set-option", "-u", "-t", session, name]);
  } catch {
    // 옵션이 이미 없으면 tmux가 에러를 내므로 무시한다.
  }
}

export function setGlobalHook(hookName: string, command: string): void {
  tmux(["set-hook", "-g", hookName, command]);
}

export function unsetGlobalHook(hookName: string): void {
  try {
    tmux(["set-hook", "-gu", hookName]);
  } catch {
    // 이미 없으면 무시.
  }
}

export function unsetSessionHook(session: string, hookName: string): void {
  try {
    tmux(["set-hook", "-u", "-t", session, hookName]);
  } catch {
    // 이미 없으면 무시.
  }
}

export function switchClient(session: string): void {
  tmux(["switch-client", "-t", session]);
}
