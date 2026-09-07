import { describe, expect, it } from "vitest";
import { buildRows, type Row } from "./model.js";
import type { AgentRecord } from "./state.js";
import type { PaneInfo } from "./tmux.js";
import type { RepoInfo } from "./git.js";

const TMUX_PID = "1";

function pane(overrides: Partial<PaneInfo>): PaneInfo {
  return {
    sessionName: "s",
    sessionId: "$0",
    windowId: overrides.windowId ?? "@1",
    windowIndex: "1",
    windowName: overrides.windowName ?? "w1",
    windowActive: false,
    windowActivity: 0,
    paneId: overrides.paneId ?? "%1",
    paneActive: true,
    paneCurrentPath: overrides.paneCurrentPath ?? "/repo",
    paneCurrentCommand: "claude",
    panePid: "1",
    ...overrides,
  };
}

function agent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    tmuxPid: TMUX_PID,
    paneId: "%1",
    state: "working",
    source: "hook",
    toolName: null,
    prompt: null,
    lastEvent: "UserPromptSubmit",
    lastTs: 1000,
    lastPromptTs: 1000,
    subagents: "{}",
    ended: 0,
    ...overrides,
  };
}

function windowRows(rows: Row[]): Row[] {
  return rows.filter((r) => r.kind === "window");
}

describe("buildRows recent 모드", () => {
  it("lastInputTs 내림차순으로 정렬한다", () => {
    const panes = [
      pane({ windowId: "@1", paneId: "%1" }),
      pane({ windowId: "@2", paneId: "%2" }),
    ];
    const agents = [
      agent({ paneId: "%1", lastPromptTs: 1000 }),
      agent({ paneId: "%2", lastPromptTs: 2000 }),
    ];
    const rows = windowRows(
      buildRows({
        panes,
        agents,
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows.map((r) => r.windowId)).toEqual(["@2", "@1"]);
  });

  it("sleep인 window는 맨 아래로 내려간다", () => {
    const panes = [
      pane({ windowId: "@1", paneId: "%1" }),
      pane({ windowId: "@2", paneId: "%2" }),
    ];
    const agents = [
      agent({ paneId: "%1", lastPromptTs: 5000 }),
      agent({ paneId: "%2", lastPromptTs: 1000 }),
    ];
    const rows = windowRows(
      buildRows({
        panes,
        agents,
        repoByCwd: new Map(),
        sleepMap: new Map([["@1", true]]),
        now: 6000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows.map((r) => r.windowId)).toEqual(["@2", "@1"]);
    expect(rows.find((r) => r.windowId === "@1")?.sleep).toBe(true);
  });

  it("agent 기록이 없으면 window_activity를 폴백으로 쓰고 플래그를 세운다", () => {
    const panes = [pane({ windowId: "@1", paneId: "%1", windowActivity: 42 })];
    const rows = windowRows(
      buildRows({
        panes,
        agents: [],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 6000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows[0].lastInputTs).toBe(42000);
    expect(rows[0].lastInputIsFallback).toBe(true);
  });

  it("한 window 안 여러 pane 중 waiting이 working보다 우선한다", () => {
    const panes = [
      pane({ windowId: "@1", paneId: "%1" }),
      pane({ windowId: "@1", paneId: "%2" }),
    ];
    const agents = [
      agent({ paneId: "%1", state: "working" }),
      agent({ paneId: "%2", state: "waiting", prompt: "which?" }),
    ];
    const rows = windowRows(
      buildRows({
        panes,
        agents,
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("waiting");
    expect(rows[0].prompt).toBe("which?");
  });
});

describe("buildRows group 모드", () => {
  it("repoRoot -> worktree 순으로 묶는다", () => {
    const repoA: RepoInfo = { toplevel: "/repo-a", repoRoot: "/repo-a", branch: "main" };
    const repoAWt: RepoInfo = { toplevel: "/repo-a-wt", repoRoot: "/repo-a", branch: "feature" };
    const panes = [
      pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/repo-a" }),
      pane({ windowId: "@2", paneId: "%2", paneCurrentPath: "/repo-a-wt" }),
    ];
    const agents = [
      agent({ paneId: "%1", lastPromptTs: 1000 }),
      agent({ paneId: "%2", lastPromptTs: 2000 }),
    ];
    const repoByCwd = new Map<string, RepoInfo | null>([
      ["/repo-a", repoA],
      ["/repo-a-wt", repoAWt],
    ]);
    const rows = buildRows({
      panes,
      agents,
      repoByCwd,
      sleepMap: new Map(),
      now: 5000,
      mode: "group",
      tmuxPid: TMUX_PID,
    });

    expect(rows[0].kind).toBe("group");
    expect(rows[0].name).toBe("repo-a");
    const windows = rows.filter((r) => r.kind === "window");
    expect(windows.map((r) => r.windowId)).toEqual(["@2", "@1"]);
  });

  it("repo가 다른 window는 별도 그룹으로 나뉜다", () => {
    const repoA: RepoInfo = { toplevel: "/repo-a", repoRoot: "/repo-a", branch: "main" };
    const repoB: RepoInfo = { toplevel: "/repo-b", repoRoot: "/repo-b", branch: "main" };
    const panes = [
      pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/repo-a" }),
      pane({ windowId: "@2", paneId: "%2", paneCurrentPath: "/repo-b" }),
    ];
    const agents = [
      agent({ paneId: "%1", lastPromptTs: 1000 }),
      agent({ paneId: "%2", lastPromptTs: 2000 }),
    ];
    const repoByCwd = new Map<string, RepoInfo | null>([
      ["/repo-a", repoA],
      ["/repo-b", repoB],
    ]);
    const rows = buildRows({
      panes,
      agents,
      repoByCwd,
      sleepMap: new Map(),
      now: 5000,
      mode: "group",
      tmuxPid: TMUX_PID,
    });
    const groupNames = rows.filter((r) => r.kind === "group").map((r) => r.name);
    expect(groupNames).toEqual(["repo-b", "repo-a"]);
  });
});
