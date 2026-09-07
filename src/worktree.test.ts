import { describe, expect, it } from "vitest";
import {
  resolveWorktreeTarget,
  sessionsAfterKill,
  uniqueSessionName,
  unopenedWorktrees,
  windowsInWorktree,
} from "./worktree.js";
import type { WorktreeEntry } from "./git.js";
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
    ...overrides,
  };
}

function entry(overrides: Partial<WorktreeEntry>): WorktreeEntry {
  return { path: "/w/feat", head: "abc", branch: null, prunable: false, ...overrides };
}

describe("uniqueSessionName", () => {
  const taken = (...names: string[]) => (name: string) => names.includes(name);

  it("비어 있는 이름은 그대로 쓴다", () => {
    expect(uniqueSessionName("codex-support", taken())).toBe("codex-support");
  });

  it("이미 있으면 -2부터 붙인다", () => {
    expect(uniqueSessionName("feat", taken("feat"))).toBe("feat-2");
    expect(uniqueSessionName("feat", taken("feat", "feat-2"))).toBe("feat-3");
  });

  it("tmux가 target 구분자로 쓰는 . : 와 공백은 -로 바꾼다", () => {
    expect(uniqueSessionName("release.1", taken())).toBe("release-1");
    expect(uniqueSessionName("fix:bug", taken())).toBe("fix-bug");
    expect(uniqueSessionName("my branch", taken())).toBe("my-branch");
  });

  it("치환 후 남는 앞뒤 -는 떼고, 전부 사라지면 hive로 둔다", () => {
    expect(uniqueSessionName(".hidden.", taken())).toBe("hidden");
    expect(uniqueSessionName("...", taken())).toBe("hive");
  });
});

describe("windowsInWorktree", () => {
  const panes = [
    pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/w/feat" }),
    pane({ windowId: "@1", paneId: "%2", paneCurrentPath: "/w/feat/src" }),
    pane({ windowId: "@2", paneId: "%3", sessionName: "other", paneCurrentPath: "/w/feat/src/tui" }),
    pane({ windowId: "@3", paneId: "%4", paneCurrentPath: "/w/feat-2" }),
    pane({ windowId: "@4", paneId: "%5", paneCurrentPath: "/w" }),
  ];

  it("worktree 안에 있는 창만 잡고 같은 창은 한 번만 센다", () => {
    expect(windowsInWorktree(panes, "/w/feat")).toEqual([
      { windowId: "@1", sessionName: "s" },
      { windowId: "@2", sessionName: "other" },
    ]);
  });

  it("이름이 접두사로만 겹치는 형제 경로는 잡지 않는다", () => {
    expect(windowsInWorktree(panes, "/w/feat-2")).toEqual([{ windowId: "@3", sessionName: "s" }]);
  });

  it("창이 없으면 빈 배열", () => {
    expect(windowsInWorktree(panes, "/w/none")).toEqual([]);
  });
});

describe("unopenedWorktrees", () => {
  const entries = [
    entry({ path: "/w/open", branch: "open" }),
    entry({ path: "/w/closed", branch: "closed" }),
    entry({ path: "/w/gone", branch: "gone", prunable: true }),
  ];
  const panes = [pane({ windowId: "@1", paneCurrentPath: "/w/open" })];

  it("창이 떠 있는 것과 prunable을 뺀다", () => {
    expect(unopenedWorktrees(entries, panes).map((e) => e.path)).toEqual(["/w/closed"]);
  });

  it("창이 하나도 없으면 prunable만 뺀다", () => {
    expect(unopenedWorktrees(entries, []).map((e) => e.path)).toEqual(["/w/open", "/w/closed"]);
  });
});

describe("resolveWorktreeTarget", () => {
  const entries = [
    entry({ path: "/w/main", branch: "main" }),
    entry({ path: "/w/feat-x", branch: "feat/x" }),
  ];

  it("절대경로로 찾는다", () => {
    expect(resolveWorktreeTarget(entries, "/w/feat-x")?.branch).toBe("feat/x");
  });

  it("브랜치명으로 찾는다", () => {
    expect(resolveWorktreeTarget(entries, "feat/x")?.path).toBe("/w/feat-x");
  });

  it("디렉토리 이름으로 찾는다", () => {
    expect(resolveWorktreeTarget(entries, "feat-x")?.path).toBe("/w/feat-x");
  });

  it("없으면 undefined", () => {
    expect(resolveWorktreeTarget(entries, "nope")).toBeUndefined();
  });
});

describe("sessionsAfterKill", () => {
  it("죽일 창이 없으면 모든 세션이 남는다", () => {
    const panes = [
      pane({ sessionName: "a", windowId: "@1" }),
      pane({ sessionName: "b", windowId: "@2" }),
    ];
    expect([...sessionsAfterKill(panes, new Set())].sort()).toEqual(["a", "b"]);
  });

  it("같은 세션에 다른 창이 남으면 그 세션은 살아남는다", () => {
    const panes = [
      pane({ sessionName: "solo", windowId: "@0" }),
      pane({ sessionName: "solo", windowId: "@1" }),
    ];
    expect([...sessionsAfterKill(panes, new Set(["@1"]))]).toEqual(["solo"]);
  });

  it("세션의 창을 다 죽이면 그 세션은 사라진다", () => {
    const panes = [
      pane({ sessionName: "a", windowId: "@1" }),
      pane({ sessionName: "b", windowId: "@2" }),
    ];
    expect([...sessionsAfterKill(panes, new Set(["@1"]))]).toEqual(["b"]);
  });

  it("모든 창이 대상이면 남는 세션이 없다", () => {
    const panes = [
      pane({ sessionName: "a", windowId: "@1" }),
      pane({ sessionName: "b", windowId: "@2" }),
    ];
    expect(sessionsAfterKill(panes, new Set(["@1", "@2"])).size).toBe(0);
  });

  it("한 창의 pane 여러 개를 하나로 센다", () => {
    const panes = [
      pane({ sessionName: "a", windowId: "@1", paneId: "%1" }),
      pane({ sessionName: "a", windowId: "@1", paneId: "%2" }),
    ];
    expect(sessionsAfterKill(panes, new Set(["@1"])).size).toBe(0);
  });
});
