import {
  currentPaneId,
  getSessionOption,
  listPanes,
  paneExists,
  setSessionHook,
  setSessionOption,
  SIDEBAR_PANE_OPTION,
  splitLeft,
  tmux,
  unsetSessionHook,
  unsetSessionOption,
} from "./tmux.js";
import { selfCommand } from "./paths.js";

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

export function hasSidebar(sessionName: string): boolean {
  const existing = getSessionOption(sessionName, SIDEBAR_PANE_OPTION);
  return Boolean(existing) && paneExists(existing);
}

// wt new처럼 사이드바를 붙일 window가 CLI 자신의 pane과 다를 때 쓰는 저수준 진입점.
export function attachSidebar(sessionName: string, windowId: string): void {
  if (hasSidebar(sessionName)) return;

  const [node, cli] = selfCommand();
  const command = `${node} ${cli} tui`;
  const sidebarPaneId = splitLeft({ target: windowId, width: SIDEBAR_WIDTH, command });

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
  const sidebarPaneId = getSessionOption(sessionName, SIDEBAR_PANE_OPTION);
  if (sidebarPaneId && paneExists(sidebarPaneId)) {
    try {
      tmux(["kill-pane", "-t", sidebarPaneId]);
    } catch {
      // 이미 죽어 있으면 무시.
    }
  }
  unsetSessionHook(sessionName, SIDEBAR_HOOK_INDEX);
  unsetSessionOption(sessionName, SIDEBAR_PANE_OPTION);
}

export function toggleSidebar(): void {
  const pane = requireCurrentPane();
  if (hasSidebar(pane.sessionName)) {
    hideSidebarForSession(pane.sessionName);
  } else {
    showSidebar();
  }
}

// TUI(q 키 등)가 스스로 종료할 때 자신이 속한 세션의 hook/옵션만 정리한다.
export function cleanupFromTui(): void {
  let sessionName: string;
  try {
    sessionName = requireCurrentPane().sessionName;
  } catch {
    return;
  }
  unsetSessionHook(sessionName, SIDEBAR_HOOK_INDEX);
  unsetSessionOption(sessionName, SIDEBAR_PANE_OPTION);
}
