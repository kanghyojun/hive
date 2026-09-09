import { describe, expect, it } from "vitest";
import { sidebarPanesInWindow, sidebarPanesOf } from "./sidebar.js";
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

describe("sidebarPanesOf", () => {
  it("사이드바 표시가 남은 pane만 고른다", () => {
    const panes = [
      pane({ paneId: "%1", sidebarMark: true }),
      pane({ paneId: "%2" }),
    ];
    expect(sidebarPanesOf(panes, "s")).toEqual(["%1"]);
  });

  it("다른 세션의 사이드바는 세지 않는다", () => {
    const panes = [pane({ paneId: "%1", sessionName: "other", sidebarMark: true })];
    expect(sidebarPanesOf(panes, "s")).toEqual([]);
  });

  // 세션 옵션이 지워진 채로 사이드바를 다시 열면 같은 세션에 사이드바가 여럿 생긴다.
  // 이 상태를 알아채야 hide가 전부 지우고 show가 하나만 남길 수 있다.
  it("한 세션에 여러 개가 있으면 모두 돌려준다", () => {
    const panes = [
      pane({ paneId: "%1", windowId: "@1", sidebarMark: true }),
      pane({ paneId: "%3", windowId: "@1", sidebarMark: true }),
      pane({ paneId: "%2", windowId: "@1" }),
    ];
    expect(sidebarPanesOf(panes, "s")).toEqual(["%1", "%3"]);
  });

  // 세션 옵션만 보고 판단하던 때는 옵션이 비면 살아 있는 사이드바를 못 봤다.
  it("세션 옵션이 비어 있어도 살아 있는 사이드바를 찾는다", () => {
    const panes = [pane({ paneId: "%1", sidebarPaneId: "", sidebarMark: true })];
    expect(sidebarPanesOf(panes, "s")).toEqual(["%1"]);
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

  // 세션에는 있어도 지금 보는 창에 없으면 사용자 눈에는 사이드바가 없는 것이다.
  // 이때 toggle이 끄기로 동작하면 "열었는데 아무것도 안 뜬다"가 된다.
  it("세션에만 있고 창에 없으면 비어 있다", () => {
    const panes = [pane({ paneId: "%1", windowId: "@2", sidebarMark: true })];
    expect(sidebarPanesInWindow(panes, "@1")).toEqual([]);
  });
});
