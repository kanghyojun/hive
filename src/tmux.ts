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

function socketPath(): string | undefined {
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
    return execFileSync("tmux", fullArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
  const out = tmux(["display-message", "-p", "#{pid} #{start_time} #{socket_path}"]).trim();
  const [pid, startTime, sock] = out.split(" ");
  return { pid, startTime, socketPath: sock };
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
  /** 이 pane이 속한 세션의 hive 사이드바 pane id. 사이드바가 없으면 빈 문자열. */
  sidebarPaneId: string;
  /** 이 pane의 세션에 붙어 있는 클라이언트가 있는지. windowActive와 같이 봐야 "사람이 보고 있는 창"이 된다. */
  sessionAttached: boolean;
}

// sidebar.ts가 이 이름으로 세션 옵션을 심는다. 포맷 문자열 안에서는 값이 없어도 에러 대신 빈 문자열이 나온다(실측).
export const SIDEBAR_PANE_OPTION = "@hive_sidebar_pane";

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
  // 붙어 있는 클라이언트 수다. 0이면 아무도 이 세션을 보고 있지 않다.
  "#{session_attached}",
].join("\t");

export function listPanes(): PaneInfo[] {
  let out: string;
  try {
    out = tmux(["list-panes", "-a", "-F", PANE_FIELDS]);
  } catch {
    return [];
  }
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

// target을 주지 않으면 지금 클라이언트가 보고 있는 세션에 붙는다. 사람이 부르지 않은 자리
// (cron)에서는 붙을 클라이언트가 없거나 엉뚱한 세션일 수 있으므로 세션을 명시한다.
export function newWindow(opts: { name: string; cwd: string; command: string; target?: string }): string {
  return tmux([
    "new-window",
    "-P",
    "-F",
    "#{window_id}",
    ...(opts.target ? ["-t", opts.target] : []),
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

export function splitLeft(opts: { target: string; width: number; command: string }): string {
  return tmux([
    "split-window",
    "-hb",
    "-l",
    String(opts.width),
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    opts.target,
    opts.command,
  ]).trim();
}

// 커스텀(@) 옵션이 한 번도 set되지 않았으면 tmux가 빈 문자열이 아니라 "invalid option" 에러를 낸다(실측).
// #{@name} 포맷 문자열은 비어 있는 값을 그냥 돌려주지만 show-options -v는 그렇지 않다.
export function getSessionOption(session: string, name: string): string {
  try {
    return tmux(["show-options", "-t", session, "-v", name]).trim();
  } catch {
    return "";
  }
}

export function setSessionOption(session: string, name: string, value: string): void {
  tmux(["set-option", "-t", session, name, value]);
}

export function unsetSessionOption(session: string, name: string): void {
  try {
    tmux(["set-option", "-u", "-t", session, name]);
  } catch {
    // 옵션이 이미 없으면 tmux가 에러를 내므로 무시한다.
  }
}

export function setSessionHook(session: string, hookName: string, command: string): void {
  tmux(["set-hook", "-t", session, hookName, command]);
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
