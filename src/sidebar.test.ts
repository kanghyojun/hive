import { describe, expect, it } from "vitest";
import { sidebarPanes, sidebarPanesInWindow } from "./sidebar.js";
import type { PaneInfo } from "./tmux.js";

function pane(overrides: Partial<PaneInfo>): PaneInfo {
  return {
    sessionName: "s",
    sessionId: "$0",
    windowId: "@1",
    windowIndex: "1",
    windowName: "w1",
    windowAutoName: false,
    windowActive: false,
    windowActivity: 0,
    paneId: "%1",
    paneActive: true,
    paneCurrentPath: "/repo",
    paneCurrentCommand: "claude",
    paneTitle: "",
    panePid: "1",
    sidebarPaneId: "",
    sidebarMark: false,
    sessionAttached: false,
    ...overrides,
  };
}

describe("sidebarPanes", () => {
  it("사이드바 표시가 남은 pane만 고른다", () => {
    const panes = [
      pane({ paneId: "%1", sidebarMark: true }),
      pane({ paneId: "%2" }),
    ];
    expect(sidebarPanes(panes)).toEqual(["%1"]);
  });

  // 사이드바는 서버에 하나다. 다른 세션에 남은 것도 세야 show가 새로 띄우지 않고 데려오고,
  // 세션마다 하나씩 띄우던 시절의 사이드바를 하나로 거둘 수 있다.
  it("다른 세션의 사이드바도 센다", () => {
    const panes = [
      pane({ paneId: "%1", sessionName: "a", sidebarMark: true }),
      pane({ paneId: "%2", sessionName: "b", sidebarMark: true }),
    ];
    expect(sidebarPanes(panes)).toEqual(["%1", "%2"]);
  });

  // 서버 옵션이 비어 있어도 pane 표시로 살아 있는 사이드바를 찾는다.
  it("서버 옵션이 비어 있어도 살아 있는 사이드바를 찾는다", () => {
    const panes = [pane({ paneId: "%1", sidebarPaneId: "", sidebarMark: true })];
    expect(sidebarPanes(panes)).toEqual(["%1"]);
  });
});

describe("sidebarPanesInWindow", () => {
  it("그 창에 있는 사이드바만 고른다", () => {
    const panes = [
      pane({ paneId: "%1", windowId: "@1", sidebarMark: true }),
      pane({ paneId: "%2", windowId: "@2", sidebarMark: true }),
    ];
    expect(sidebarPanesInWindow(panes, "@1")).toEqual(["%1"]);
  });

  // 다른 곳에는 있어도 지금 보는 창에 없으면 사용자 눈에는 사이드바가 없는 것이다.
  // 이때 toggle이 끄기로 동작하면 "열었는데 아무것도 안 뜬다"가 된다.
  it("다른 창에만 있으면 비어 있다", () => {
    const panes = [pane({ paneId: "%1", windowId: "@2", sidebarMark: true })];
    expect(sidebarPanesInWindow(panes, "@1")).toEqual([]);
  });
});
