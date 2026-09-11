import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it } from "vitest";
import { attachSidebar, hideSidebar, selectSidebar } from "./sidebar.js";
import { setPaneOverride, setTmuxSocketOverride, SIDEBAR_MARK_OPTION, SIDEBAR_PANE_OPTION, splitLeft } from "./tmux.js";
import { sidebarFollowScriptPath } from "./paths.js";

// 클라이언트를 붙여야 세션 전환과 포커스 hook을 재현할 수 있어서 script로 pty를 만든다.
let hasTools = true;
try {
  execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 3000 });
  execFileSync("script", ["--version"], { stdio: "ignore", timeout: 3000 });
} catch { hasTools = false; }

let dir = "";
let socket = "";
const clients: ChildProcess[] = [];

function tmux(...args: string[]): string {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  }).trim();
}

async function until<T>(read: () => T, accept: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`기다리던 상태가 오지 않았습니다: ${String(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const where = (paneId: string) => tmux("display-message", "-p", "-t", paneId, "#{session_name}:#{window_index}");
const windowOf = (target: string) => tmux("display-message", "-p", "-t", target, "#{window_id}");

function markedPanes(): string[] {
  return tmux("list-panes", "-a", "-F", `#{pane_id} #{${SIDEBAR_MARK_OPTION}}`)
    .split("\n").filter((line) => line.endsWith(" 1")).map((line) => line.split(" ")[0]);
}

// 진짜 TUI 대신 표시만 붙인 pane이다. 옮기고 거두는 동작만 보면 되므로 프로세스는 무엇이든 된다.
function fakeSidebar(target: string): string {
  const paneId = tmux("split-window", "-hb", "-l", "41", "-d", "-P", "-F", "#{pane_id}", "-t", target, "sleep 120");
  tmux("set-option", "-p", "-t", paneId, SIDEBAR_MARK_OPTION, "1");
  return paneId;
}

function attachClient(session: string): ChildProcess {
  const client = spawn("script", ["-qfc", `stty cols 200 rows 50; exec tmux -S '${socket}' attach -t ${session}`, "/dev/null"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  clients.push(client);
  return client;
}

beforeEach(() => {
  if (!hasTools) return;
  dir = mkdtempSync("/tmp/hive-sidebar-test-");
  socket = join(dir, "tmux.sock");
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "a", "-x", "200", "-y", "50", "sleep 120");
  tmux("new-window", "-d", "-t", "a:", "sleep 120");
  tmux("new-session", "-d", "-s", "b", "-x", "200", "-y", "50", "sleep 120");
  tmux("new-window", "-d", "-t", "b:", "sleep 120");
  setTmuxSocketOverride(socket);
});

afterEach(() => {
  if (!hasTools) return;
  for (const client of clients.splice(0)) client.kill();
  try { tmux("kill-server"); } catch { /* 이미 내려갔으면 무시 */ }
  setTmuxSocketOverride(undefined);
  setPaneOverride(undefined);
  rmSync(dir, { recursive: true, force: true });
});

it.skipIf(!hasTools)("select는 다른 세션의 사이드바를 가져와 선택하고 반복해도 닫지 않는다", () => {
  const sidebar = fakeSidebar("a:0");
  const origin = tmux("display-message", "-p", "-t", "b:0", "#{pane_id}");
  setPaneOverride(origin);

  selectSidebar();

  expect(where(sidebar)).toBe("b:0");
  expect(tmux("display-message", "-p", "-t", sidebar, "#{pane_active}")).toBe("1");
  expect(markedPanes()).toEqual([sidebar]);

  setPaneOverride(sidebar);
  selectSidebar();
  expect(markedPanes()).toEqual([sidebar]);
  expect(tmux("display-message", "-p", "-t", sidebar, "#{pane_active}")).toBe("1");
});

it.skipIf(!hasTools)("select는 같은 창에서 다른 pane에 있어도 사이드바를 선택한다", () => {
  const sidebar = fakeSidebar("a:0");
  const origin = tmux("split-window", "-h", "-t", "a:0", "-P", "-F", "#{pane_id}", "sleep 120");
  setPaneOverride(origin);

  selectSidebar();

  expect(markedPanes()).toEqual([sidebar]);
  expect(tmux("display-message", "-p", "-t", sidebar, "#{pane_active}")).toBe("1");
});

it.skipIf(!hasTools)("세션마다 떠 있던 사이드바를 하나로 거두고 이후 창 이동도 따라간다", async () => {
  tmux("select-window", "-t", "b:1");
  fakeSidebar("a:0");
  const inB = fakeSidebar("b:0");
  tmux("set-hook", "-t", "b", "session-window-changed[77]", "set-option -s @legacy fired");
  tmux("set-option", "-t", "b", SIDEBAR_PANE_OPTION, inB);

  attachSidebar(windowOf("b:1"));

  const left = markedPanes();
  expect(left).toHaveLength(1);
  expect(where(left[0])).toBe("b:1");
  expect(tmux("show-options", "-sv", SIDEBAR_PANE_OPTION)).toBe(left[0]);
  expect(tmux("show-hooks", "-t", "b")).not.toContain("@legacy");
  expect(tmux("show-options", "-t", "b")).not.toContain(SIDEBAR_PANE_OPTION);

  tmux("select-window", "-t", "b:0");
  await until(() => where(left[0]), (w) => w === "b:0");
}, 10_000);

it.skipIf(!hasTools)("이전 정리에서 빈 hook 배열만 남은 세션도 전역 창 이동 hook을 상속한다", async () => {
  const sidebar = fakeSidebar("a:0");
  tmux("set-hook", "-t", "a", "session-window-changed[77]", "set-option -s @legacy fired");
  tmux("set-hook", "-u", "-t", "a", "session-window-changed[77]");
  expect(tmux("show-hooks", "-t", "a")).toContain("session-window-changed");

  attachSidebar(windowOf("a:0"));

  tmux("select-window", "-t", "a:1");
  await until(() => where(sidebar), (w) => w === "a:1");
}, 10_000);

it.skipIf(!hasTools)("예전 사이드바 hook을 정리할 때 다른 인덱스의 사용자 hook은 보존한다", () => {
  fakeSidebar("a:0");
  tmux("set-hook", "-t", "a", "session-window-changed[1]", "set-option -s @user_hook fired");
  tmux("set-hook", "-t", "a", "session-window-changed[77]", "set-option -s @legacy fired");

  attachSidebar(windowOf("a:0"));

  expect(tmux("show-hooks", "-t", "a")).toContain("@user_hook");
  expect(tmux("show-hooks", "-t", "a")).not.toContain("@legacy");
});

it.skipIf(!hasTools)("백그라운드 세션에는 끌려가지 않고, 사람이 옮겨 가거나 포커스를 준 곳으로 간다", async () => {
  const sidebar = fakeSidebar("a:0");
  attachSidebar(windowOf("a:0"));

  tmux("select-window", "-t", "a:1");
  await until(() => where(sidebar), (w) => w === "a:1");

  // 아무도 안 보는 세션의 창이 바뀌어도 끌려가면 안 된다.
  tmux("select-window", "-t", "b:1");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(where(sidebar)).toBe("a:1");

  const first = attachClient("a");
  const tty = await until(() => tmux("list-clients", "-F", "#{client_tty}"), (out) => out.length > 0);
  tmux("switch-client", "-c", tty, "-t", "b");
  await until(() => where(sidebar), (w) => w === "b:1");

  attachClient("a");
  await until(() => where(sidebar), (w) => w === "a:1");

  first.stdin!.write("\x1b[I");
  await until(() => where(sidebar), (w) => w === "b:1");
  expect(markedPanes()).toEqual([sidebar]);
}, 20_000);

it.skipIf(!hasTools)("show가 터미널 포커스 추적을 켠다", () => {
  expect(tmux("show-options", "-sv", "focus-events")).toBe("off");
  fakeSidebar("a:0");
  attachSidebar(windowOf("a:0"));
  expect(tmux("show-options", "-sv", "focus-events")).toBe("on");
});

it.skipIf(!hasTools)("이미 붙어 있는 다른 세션의 창 이동과 새 창도 따라간다", async () => {
  const sidebar = fakeSidebar("a:0");
  attachSidebar(windowOf("a:0"));

  attachClient("a");
  await until(() => tmux("list-clients", "-F", "#{session_name}"), (out) => out === "a");
  attachClient("b");
  await until(() => where(sidebar), (w) => w === "b:0");

  // 포커스 이벤트가 오지 않아도, 이미 다른 클라이언트가 붙은 세션의 창 이동을 따라야 한다.
  tmux("select-window", "-t", "a:1");
  await until(() => where(sidebar), (w) => w === "a:1");

  const newWindow = tmux("new-window", "-P", "-F", "#{window_id}", "-t", "b:", "sleep 120");
  await until(() => windowOf(sidebar), (w) => w === newWindow);
  expect(markedPanes()).toEqual([sidebar]);
}, 20_000);

it.skipIf(!hasTools)("hide는 서버 전체의 사이드바와 따라다니는 hook을 걷는다", () => {
  fakeSidebar("a:0");
  attachSidebar(windowOf("a:0"));

  hideSidebar();

  expect(markedPanes()).toEqual([]);
  expect(tmux("show-hooks", "-g")).not.toContain("sidebar-follow.sh");
  expect(tmux("show-options", "-s")).not.toContain(SIDEBAR_PANE_OPTION);
});

const geometry = (target: string) => tmux("list-panes", "-t", target, "-F",
  "#{pane_id}:#{pane_left}:#{pane_top}:#{pane_width}:#{pane_height}");

it.skipIf(!hasTools).each(["off", "top", "bottom"])("테두리 상태줄 %s에서 오른쪽 pane을 선택하고 왕복해도 배치를 보존한다", async (border) => {
  tmux("set-option", "-w", "-t", "a:0", "pane-border-status", border);
  const sidebar = fakeSidebar("a:0");
  const right = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", "a:0", "sleep 120");
  attachSidebar(windowOf("a:0"));
  const before = geometry("a:0");

  for (let i = 0; i < 5; i++) {
    tmux("select-pane", "-t", right);
    tmux("select-window", "-t", "a:1");
    await until(() => where(sidebar), (w) => w === "a:1");
    tmux("select-window", "-t", "a:0");
    await until(() => geometry("a:0"), (value) => value === before);
  }
}, 15_000);

it.skipIf(!hasTools)("사이드바를 켠 채 중첩 분할과 크기를 바꿔도 직접 show 왕복으로 배치를 보존한다", () => {
  const sidebar = fakeSidebar("a:0");
  const right = tmux("split-window", "-h", "-P", "-F", "#{pane_id}", "-t", "a:0", "sleep 120");
  tmux("split-window", "-v", "-t", right, "sleep 120");
  tmux("resize-pane", "-t", right, "-x", "60");
  attachSidebar(windowOf("a:0"));
  const before = geometry("a:0");

  for (let i = 0; i < 3; i++) {
    attachSidebar(windowOf("b:0"));
    attachSidebar(windowOf("a:0"));
    expect(geometry("a:0")).toBe(before);
  }
  expect(markedPanes()).toEqual([sidebar]);
});

it.skipIf(!hasTools)("사이드바 없는 동안 바꾼 분할은 이전 배치로 덮어쓰지 않는다", () => {
  fakeSidebar("a:0");
  attachSidebar(windowOf("a:0"));
  attachSidebar(windowOf("b:0"));
  const added = tmux("split-window", "-v", "-P", "-F", "#{pane_id}", "-t", "a:0", "sleep 120");
  const top = tmux("display-message", "-p", "-t", added, "#{pane_top}");

  attachSidebar(windowOf("a:0"));

  expect(tmux("display-message", "-p", "-t", added, "#{pane_top}")).toBe(top);
  expect(tmux("list-panes", "-t", "a:0", "-F", "#{pane_id}").split("\n")).toHaveLength(3);
  const before = geometry("a:0");
  attachSidebar(windowOf("b:0"));
  attachSidebar(windowOf("a:0"));
  expect(geometry("a:0")).toBe(before);
});

it.skipIf(!hasTools)("최초 사이드바도 활성 pane과 관계없이 창 전체의 맨 왼쪽에 만든다", () => {
  tmux("split-window", "-v", "-t", "a:0", "sleep 120");
  const sidebar = splitLeft({ target: windowOf("a:0"), width: 41, command: "sleep 120" });

  expect(tmux("list-panes", "-t", "a:0", "-F", "#{pane_id}").split("\n")[0]).toBe(sidebar);
  expect(tmux("display-message", "-p", "-t", sidebar,
    "#{pane_left}:#{pane_top}:#{pane_width}:#{pane_height}")).toBe("0:0:41:50");
});

it.skipIf(!hasTools)("잠금을 기다리던 이동이 중단돼도 이후 사이드바 이동이 막히지 않는다", async () => {
  const sidebar = fakeSidebar("a:0");
  attachSidebar(windowOf("a:0"));
  const holder = spawn("flock", [`${socket}.hive-sidebar.lock`, "sh", "-c", "printf ready; read release"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  clients.push(holder);
  await once(holder.stdout!, "data");
  const waiter = spawn("sh", [sidebarFollowScriptPath(), socket, sidebar, windowOf("b:0"), "41"], {
    stdio: "ignore",
  });
  clients.push(waiter);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stopped = once(waiter, "exit");
  waiter.kill();
  await stopped;
  const released = once(holder, "exit");
  holder.stdin!.end("release\n");
  await released;

  attachSidebar(windowOf("b:0"));
  expect(where(sidebar)).toBe("b:0");
}, 10_000);
