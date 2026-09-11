import {
  currentPaneId,
  serverInfo,
  listPanes,
  joinPaneLeft,
  setGlobalHook,
  setPaneOption,
  setServerOption,
  SIDEBAR_MARK_OPTION,
  SIDEBAR_PANE_OPTION,
  splitLeft,
  tmux,
  unsetGlobalHook,
  unsetServerOption,
  unsetSessionHook,
  unsetSessionOption,
  type PaneInfo,
} from "./tmux.js";
import { canonicalHiveHome, selfRelaunchArgv } from "./paths.js";

import { shQuote } from "./sh.js";

export const SIDEBAR_WIDTH = 41;
const WINDOW_HOOK = "session-window-changed[77]";
// 사람이 다른 곳을 보기 시작하는 순간들이다. 세션을 옮기거나, 다른 터미널 창에 포커스를 주거나, 새로 붙는다.
const CLIENT_HOOKS = ["client-session-changed[77]", "client-focus-in[77]", "client-attached[77]"];

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
function joinHereCommand(): string {
  return `run-shell -b "tmux -S '#{socket_path}' join-pane -d -hb -l ${SIDEBAR_WIDTH} -s '#{${SIDEBAR_PANE_OPTION}}' -t '#{window_id}' >/dev/null 2>&1"`;
}

// 사이드바는 서버에 하나다. 창이 바뀐 세션 안에 사이드바가 있을 때만 따라간다. 아무도 안 보는 세션에서
// 창이 닫혀 현재 창이 바뀌어도 사이드바를 그리로 끌고 가지 않으려는 것이다.
export function windowHookCommand(): string {
  return `if-shell -F '#{W:#{P:#{${SIDEBAR_MARK_OPTION}}}}' { ${joinHereCommand()} }`;
}

// 클라이언트가 보는 창에 사이드바가 이미 있으면 건드리지 않는다. 포커스가 들어올 때마다 레이아웃이 흔들리지 않게.
export function clientHookCommand(): string {
  return `if-shell -F '#{?#{P:#{${SIDEBAR_MARK_OPTION}}},0,1}' { ${joinHereCommand()} }`;
}

function installFollowHooks(): void {
  setGlobalHook(WINDOW_HOOK, windowHookCommand());
  for (const hook of CLIENT_HOOKS) setGlobalHook(hook, clientHookCommand());
}

function uninstallFollowHooks(): void {
  unsetGlobalHook(WINDOW_HOOK);
  for (const hook of CLIENT_HOOKS) unsetGlobalHook(hook);
}

// 세션마다 사이드바를 두던 시절의 hook과 옵션을 걷는다. 옛 hook이 남아 있으면 그 세션의 창이 바뀔 때마다,
// 아무도 안 보고 있어도 사이드바를 그리로 끌고 간다.
function clearPerSessionState(panes: PaneInfo[]): void {
  for (const session of new Set(panes.map((p) => p.sessionName))) {
    unsetSessionHook(session, WINDOW_HOOK);
    unsetSessionOption(session, SIDEBAR_PANE_OPTION);
  }
}

// pane에 남긴 표시를 근거로 삼는다. 서버 옵션은 사이드바가 죽는 순서에 따라 실제 pane과 어긋날 수 있다.
export function sidebarPanes(panes: PaneInfo[]): string[] {
  return panes.filter((p) => p.sidebarMark).map((p) => p.paneId);
}

export function sidebarPanesInWindow(panes: PaneInfo[], windowId: string): string[] {
  return panes.filter((p) => p.windowId === windowId && p.sidebarMark).map((p) => p.paneId);
}

// 첫 번째 것을 서버의 사이드바로 등록하고 나머지는 거둔다.
function adoptSidebar(paneIds: string[]): string {
  const [keep, ...extra] = paneIds;
  for (const paneId of extra) killPane(paneId);
  setServerOption(SIDEBAR_PANE_OPTION, keep);
  installFollowHooks();
  return keep;
}

function killPane(paneId: string): void {
  try {
    tmux(["kill-pane", "-t", paneId]);
  } catch {
    // 이미 죽어 있으면 무시.
  }
}

// 사이드바를 이 window로 데려온다. 서버 어디에든 떠 있으면 옮기고, 하나도 없을 때만 새로 띄운다.
// 새로 띄우면 첫 화면까지 0.5초가 걸리지만 옮기는 건 몇 ms라 눈에 띄지 않는다(실측).
export function attachSidebar(windowId: string): void {
  const panes = listPanes();
  clearPerSessionState(panes);
  const existing = sidebarPanes(panes);
  if (existing.length > 0) {
    // 이미 이 창에 있는 것을 남겨야 옮길 일이 없다.
    const here = sidebarPanesInWindow(panes, windowId);
    const keep = adoptSidebar([...here, ...existing.filter((id) => !here.includes(id))]);
    if (here.length === 0) joinPaneLeft({ source: keep, target: windowId, width: SIDEBAR_WIDTH });
    return;
  }

  // React는 런타임에 NODE_ENV로 dev/prod 빌드를 고른다. tsc는 이 분기를 치환하지 않으므로
  // 여기서 붙이지 않으면 dev 빌드가 매 렌더 performance.measure를 쌓아 메모리가 계속 는다(실측).
  // 지금 프로세스 값을 그대로 물려줘서 개발 중(pnpm dev)에는 dev 빌드의 경고를 그대로 본다.
  const nodeEnv = process.env.NODE_ENV ?? "production";
  const command = [...selfRelaunchArgv(), "--home", canonicalHiveHome(),
    "--tmux-socket", serverInfo().socketPath, "tui"].map(shQuote).join(" ");
  const sidebarPaneId = splitLeft({
    target: windowId,
    width: SIDEBAR_WIDTH,
    command,
    env: { NODE_ENV: nodeEnv },
  });

  setPaneOption(sidebarPaneId, SIDEBAR_MARK_OPTION, "1");
  setServerOption(SIDEBAR_PANE_OPTION, sidebarPaneId);
  installFollowHooks();
}

export function showSidebar(): void {
  attachSidebar(requireCurrentPane().windowId);
}

export function hideSidebar(): void {
  const panes = listPanes();
  for (const paneId of sidebarPanes(panes)) killPane(paneId);
  uninstallFollowHooks();
  unsetServerOption(SIDEBAR_PANE_OPTION);
  clearPerSessionState(panes);
}

// 끄고 켜는 기준은 "지금 보는 창에 사이드바가 있는가"다. 다른 곳에만 있으면 사용자 눈에는 없는 것이니,
// 끄지 말고 이 창으로 데려온다.
export function toggleSidebar(): void {
  const pane = requireCurrentPane();
  if (sidebarPanesInWindow(listPanes(), pane.windowId).length > 0) {
    hideSidebar();
  } else {
    attachSidebar(pane.windowId);
  }
}

// TUI(q 키 등)가 스스로 종료할 때 부른다. 다른 사이드바가 남아 있으면 그쪽으로 넘긴다. 여기서 hook을
// 걷어 버리면 남은 사이드바가 주인 없는 채로 떠 있다가 다음에 열 때 하나 더 생긴다.
export function cleanupFromTui(): void {
  let pane;
  try {
    pane = requireCurrentPane();
  } catch {
    return;
  }
  const others = sidebarPanes(listPanes()).filter((id) => id !== pane.paneId);
  if (others.length > 0) {
    adoptSidebar(others);
    return;
  }
  uninstallFollowHooks();
  unsetServerOption(SIDEBAR_PANE_OPTION);
}
