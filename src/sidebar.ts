import {
  currentPaneId,
  serverInfo,
  getSessionOption,
  listPanes,
  paneExists,
  joinPaneLeft,
  setPaneOption,
  setSessionHook,
  setSessionOption,
  SIDEBAR_MARK_OPTION,
  SIDEBAR_PANE_OPTION,
  splitLeft,
  tmux,
  unsetSessionHook,
  unsetSessionOption,
  type PaneInfo,
} from "./tmux.js";
import { canonicalHiveHome, selfCommand } from "./paths.js";

import { shQuote } from "./sh.js";

export const SIDEBAR_WIDTH = 41;
const SIDEBAR_HOOK_INDEX = "session-window-changed[77]";

function requireCurrentPane() {
  const paneId = currentPaneId();
  if (!paneId) {
    throw new Error("tmux 안에서만 실행할 수 있습니다. tmux 바인딩이면 --pane '#{pane_id}'를 넘기세요.");
  }
  const pane = listPanes().find((p) => p.paneId === paneId);
  if (!pane) {
    throw new Error(`pane ${paneId}을 tmux 서버에서 찾을 수 없습니다. 소켓이 맞는지 확인하세요.`);
  }
  return pane;
}

// hook 안에서 join-pane을 직접 쓰면 동작하지 않아(실측) run-shell로 tmux 클라이언트를 다시 부른다.
// #{socket_path}, #{@hive_sidebar_pane}, #{window_id}는 $/%가 섞여 있어 반드시 작은따옴표로 감싼다.
function followHookCommand(): string {
  return `run-shell -b "tmux -S '#{socket_path}' join-pane -d -hb -l ${SIDEBAR_WIDTH} -s '#{${SIDEBAR_PANE_OPTION}}' -t '#{window_id}' >/dev/null 2>&1"`;
}

// 세션 옵션 하나만 믿으면, 옵션이 지워졌는데 사이드바 pane은 살아 있는 어긋난 상태에서
// 사이드바를 또 만든다. 그렇게 남은 사이드바는 hook이 window를 옮길 때마다 한 창에 겹쳐 쌓인다.
// pane에 남긴 표시는 pane과 운명을 같이하므로 이쪽을 실제 근거로 삼는다.
export function sidebarPanesOf(panes: PaneInfo[], sessionName: string): string[] {
  return panes.filter((p) => p.sessionName === sessionName && p.sidebarMark).map((p) => p.paneId);
}

export function sidebarPanesInWindow(panes: PaneInfo[], windowId: string): string[] {
  return panes.filter((p) => p.windowId === windowId && p.sidebarMark).map((p) => p.paneId);
}

function sidebarPanesInSession(sessionName: string): string[] {
  return sidebarPanesOf(listPanes(), sessionName);
}

export function hasSidebar(sessionName: string): boolean {
  return sidebarPanesInSession(sessionName).length > 0;
}

// 표시가 없던 시절에 뜬 사이드바와, 세션 옵션이 가리키는 pane까지 같이 거둔다.
function sidebarPanesToKill(sessionName: string): string[] {
  const ids = sidebarPanesInSession(sessionName);
  const fromOption = getSessionOption(sessionName, SIDEBAR_PANE_OPTION);
  if (fromOption && !ids.includes(fromOption) && paneExists(fromOption)) ids.push(fromOption);
  return ids;
}

// 이미 있는 사이드바를 세션의 사이드바로 다시 등록한다. 여분이 쌓여 있으면 하나만 남긴다.
function adoptSidebar(sessionName: string, paneIds: string[]): string {
  const [keep, ...extra] = paneIds;
  for (const paneId of extra) killPane(paneId);
  setSessionOption(sessionName, SIDEBAR_PANE_OPTION, keep);
  setSessionHook(sessionName, SIDEBAR_HOOK_INDEX, followHookCommand());
  return keep;
}

function killPane(paneId: string): void {
  try {
    tmux(["kill-pane", "-t", paneId]);
  } catch {
    // 이미 죽어 있으면 무시.
  }
}

// wt new처럼 사이드바를 붙일 window가 CLI 자신의 pane과 다를 때 쓰는 저수준 진입점.
export function attachSidebar(sessionName: string, windowId: string): void {
  const panes = listPanes();
  const existing = sidebarPanesOf(panes, sessionName);
  if (existing.length > 0) {
    // 사이드바는 세션에 하나뿐이다. hook이 놓친 창에서 불렀으면 새로 만들지 말고 데려온다.
    const keep = adoptSidebar(sessionName, existing);
    if (!sidebarPanesInWindow(panes, windowId).includes(keep)) {
      joinPaneLeft({ source: keep, target: windowId, width: SIDEBAR_WIDTH });
    }
    return;
  }

  const [node, cli] = selfCommand();
  const command = [node, ...process.execArgv, cli, "--home", canonicalHiveHome(),
    "--tmux-socket", serverInfo().socketPath, "tui"].map(shQuote).join(" ");
  const sidebarPaneId = splitLeft({ target: windowId, width: SIDEBAR_WIDTH, command });

  setPaneOption(sidebarPaneId, SIDEBAR_MARK_OPTION, "1");
  setSessionOption(sessionName, SIDEBAR_PANE_OPTION, sidebarPaneId);
  setSessionHook(sessionName, SIDEBAR_HOOK_INDEX, followHookCommand());
}

export function showSidebar(): void {
  const pane = requireCurrentPane();
  attachSidebar(pane.sessionName, pane.windowId);
}

export function hideSidebar(): void {
  hideSidebarForSession(requireCurrentPane().sessionName);
}

function hideSidebarForSession(sessionName: string): void {
  for (const paneId of sidebarPanesToKill(sessionName)) killPane(paneId);
  unsetSessionHook(sessionName, SIDEBAR_HOOK_INDEX);
  unsetSessionOption(sessionName, SIDEBAR_PANE_OPTION);
}

// 끄고 켜는 기준은 "지금 보는 창에 사이드바가 있는가"다. 세션에만 있고 창에 없으면
// 사용자 눈에는 없는 것이니, 끄지 말고 이 창으로 데려온다.
export function toggleSidebar(): void {
  const pane = requireCurrentPane();
  if (sidebarPanesInWindow(listPanes(), pane.windowId).length > 0) {
    hideSidebarForSession(pane.sessionName);
  } else {
    attachSidebar(pane.sessionName, pane.windowId);
  }
}

// TUI(q 키 등)가 스스로 종료할 때 자신이 속한 세션의 hook/옵션만 정리한다.
export function cleanupFromTui(): void {
  let pane;
  try {
    pane = requireCurrentPane();
  } catch {
    return;
  }
  // 같은 세션에 다른 사이드바가 남아 있으면 그쪽으로 넘긴다. 여기서 옵션을 지워 버리면
  // 남은 사이드바가 주인 없는 채로 떠 있다가 다음에 열 때 하나 더 생긴다.
  const others = sidebarPanesInSession(pane.sessionName).filter((id) => id !== pane.paneId);
  if (others.length > 0) {
    adoptSidebar(pane.sessionName, others);
    return;
  }
  unsetSessionHook(pane.sessionName, SIDEBAR_HOOK_INDEX);
  unsetSessionOption(pane.sessionName, SIDEBAR_PANE_OPTION);
}
