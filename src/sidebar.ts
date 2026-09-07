import {
  getSessionOption,
  listPanes,
  paneExists,
  setSessionHook,
  setSessionOption,
  splitLeft,
  tmux,
  unsetSessionHook,
  unsetSessionOption,
} from "./tmux.js";
import { selfCommand } from "./paths.js";

export const SIDEBAR_WIDTH = 34;
const SIDEBAR_PANE_OPTION = "@hive_sidebar_pane";
const SIDEBAR_HOOK_INDEX = "session-window-changed[77]";

function currentPane() {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) return undefined;
  return listPanes().find((p) => p.paneId === paneId);
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
  const pane = currentPane();
  if (!pane) throw new Error("tmux 안에서만 실행할 수 있습니다 (TMUX_PANE 없음)");
  attachSidebar(pane.sessionName, pane.windowId);
}

export function hideSidebar(): void {
  const pane = currentPane();
  if (!pane) throw new Error("tmux 안에서만 실행할 수 있습니다 (TMUX_PANE 없음)");
  hideSidebarForSession(pane.sessionName);
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
  const pane = currentPane();
  if (!pane) throw new Error("tmux 안에서만 실행할 수 있습니다 (TMUX_PANE 없음)");
  if (hasSidebar(pane.sessionName)) {
    hideSidebarForSession(pane.sessionName);
  } else {
    showSidebar();
  }
}

// TUI(q 키 등)가 스스로 종료할 때 자신이 속한 세션의 hook/옵션만 정리한다.
export function cleanupFromTui(): void {
  const pane = currentPane();
  if (!pane) return;
  unsetSessionHook(pane.sessionName, SIDEBAR_HOOK_INDEX);
  unsetSessionOption(pane.sessionName, SIDEBAR_PANE_OPTION);
}
