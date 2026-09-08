import { describe, expect, it } from "vitest";
import { buildRows, resolvePaneAgents, unreadUpdates, type Row } from "./model.js";
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
    windowAutoName: false,
    windowActive: false,
    windowActivity: 0,
    paneId: overrides.paneId ?? "%1",
    paneActive: true,
    paneCurrentPath: overrides.paneCurrentPath ?? "/repo",
    paneCurrentCommand: "claude",
    paneTitle: "",
    panePid: "1",
    sidebarPaneId: "",
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
    title: null,
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

describe("buildRows 정렬 우선순위", () => {
  it("recent 모드에서 waiting과 done을 더 최근에 입력한 working보다 위로 올린다", () => {
    const rows = windowRows(
      buildRows({
        panes: [
          pane({ windowId: "@1", paneId: "%1" }),
          pane({ windowId: "@2", paneId: "%2" }),
          pane({ windowId: "@3", paneId: "%3" }),
        ],
        agents: [
          agent({ paneId: "%1", state: "working", lastPromptTs: 3000 }),
          agent({ paneId: "%2", state: "done", lastPromptTs: 2000 }),
          agent({ paneId: "%3", state: "waiting", lastPromptTs: 1000 }),
        ],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows.map((r) => r.windowId)).toEqual(["@3", "@2", "@1"]);
  });

  // 실측: tmux의 window_activity는 "출력이 있었던 시각"이라 hive가 화면을 갱신하는 것만으로도
  // 매초 올라간다. 창마다 갱신 시점이 1초씩 어긋나 순위가 계속 뒤집혔다.
  it("입력 기록이 없는 창은 window_activity가 1초 흔들려도 순서를 지킨다", () => {
    const order = (actA: number, actB: number) =>
      windowRows(
        buildRows({
          panes: [
            pane({ windowId: "@15", paneId: "%15", windowActivity: actA }),
            pane({ windowId: "@45", paneId: "%45", windowActivity: actB }),
          ],
          agents: [
            agent({ paneId: "%15", state: "idle", lastPromptTs: null }),
            agent({ paneId: "%45", state: "idle", lastPromptTs: null }),
          ],
          repoByCwd: new Map(),
          sleepMap: new Map([
            ["@15", true],
            ["@45", true],
          ]),
          now: 1788833200000,
          mode: "recent",
          tmuxPid: TMUX_PID,
        })
      ).map((r) => r.windowId);

    const settled = order(1788833188, 1788833188);
    expect(order(1788833189, 1788833190)).toEqual(settled);
    expect(order(1788833190, 1788833189)).toEqual(settled);
  });

  it("입력 기록이 없어도 한참 오래된 창은 아래에 둔다", () => {
    const rows = windowRows(
      buildRows({
        panes: [
          pane({ windowId: "@14", paneId: "%14", windowActivity: 1788832184 }),
          pane({ windowId: "@45", paneId: "%45", windowActivity: 1788833190 }),
        ],
        agents: [
          agent({ paneId: "%14", state: "idle", lastPromptTs: null }),
          agent({ paneId: "%45", state: "idle", lastPromptTs: null }),
        ],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 1788833200000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows.map((r) => r.windowId)).toEqual(["@45", "@14"]);
  });

  it("group 모드에서 잠자는 창은 저장소와 상관없이 맨 밑으로 모은다", () => {
    const repoA: RepoInfo = { toplevel: "/repo-a", repoRoot: "/repo-a", branch: "main" };
    const repoB: RepoInfo = { toplevel: "/repo-b", repoRoot: "/repo-b", branch: "main" };
    const rows = buildRows({
      panes: [
        pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/repo-a" }),
        pane({ windowId: "@2", paneId: "%2", paneCurrentPath: "/repo-b" }),
        pane({ windowId: "@3", paneId: "%3", paneCurrentPath: "/repo-a" }),
      ],
      agents: [
        agent({ paneId: "%1", lastPromptTs: 3000 }),
        agent({ paneId: "%2", lastPromptTs: 2000 }),
        agent({ paneId: "%3", lastPromptTs: 1000 }),
      ],
      repoByCwd: new Map<string, RepoInfo | null>([
        ["/repo-a", repoA],
        ["/repo-b", repoB],
      ]),
      sleepMap: new Map([["@3", true]]),
      now: 5000,
      mode: "group",
      tmuxPid: TMUX_PID,
    });
    expect(rows.map((r) => (r.kind === "window" ? r.windowId : `#${r.name}`))).toEqual([
      "#repo-a",
      "@1",
      "#repo-b",
      "@2",
      "#",
      "#잠자는 중",
      "#repo-a",
      "@3",
    ]);
  });
});

describe("buildRows autoName", () => {
  it("tmux 자동 이름 여부를 그대로 전달한다", () => {
    const rows = windowRows(
      buildRows({
        panes: [
          pane({ windowId: "@1", paneId: "%1", windowName: "node", windowAutoName: true }),
          pane({ windowId: "@2", paneId: "%2", windowName: "code", windowAutoName: false }),
        ],
        agents: [
          agent({ paneId: "%1", lastPromptTs: 2000 }),
          agent({ paneId: "%2", lastPromptTs: 1000 }),
        ],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows.map((r) => [r.name, r.autoName])).toEqual([
      ["node", true],
      ["code", false],
    ]);
  });
});

describe("buildRows 머리글 라벨", () => {
  const labels = (repoByCwd: Map<string, RepoInfo | null>, cwds: string[]) =>
    buildRows({
      panes: cwds.map((cwd, i) =>
        pane({ windowId: `@${i + 1}`, paneId: `%${i + 1}`, paneCurrentPath: cwd })
      ),
      agents: cwds.map((_, i) => agent({ paneId: `%${i + 1}`, lastPromptTs: 9000 - i })),
      repoByCwd,
      sleepMap: new Map(),
      now: 5000,
      mode: "recent",
      tmuxPid: TMUX_PID,
    })
      .filter((r) => r.kind === "window")
      .map((r) => [r.repoLabel, r.worktreeLabel]);

  it("1층은 메인 저장소, 2층은 '워크트리 : 브랜치'. 따로 판 워크트리는 +를 붙인다", () => {
    const wt: RepoInfo = { toplevel: "/src/hive-wt", repoRoot: "/src/hive", branch: "feature/x" };
    expect(labels(new Map([["/src/hive-wt", wt]]), ["/src/hive-wt"])).toEqual([
      ["hive", "+hive-wt : feature/x"],
    ]);
  });

  it("저장소 본체에서 일하면 +를 붙이지 않는다", () => {
    const main: RepoInfo = { toplevel: "/src/hive", repoRoot: "/src/hive", branch: "main" };
    expect(labels(new Map([["/src/hive", main]]), ["/src/hive"])).toEqual([["hive", "hive : main"]]);
  });

  it("repo가 아니면 cwd 이름만 쓴다", () => {
    expect(labels(new Map([["/tmp/scratch", null]]), ["/tmp/scratch"])).toEqual([
      ["(repo 아님)", "scratch"],
    ]);
  });
});

describe("buildRows key", () => {
  it("잠자는 묶음까지 합쳐도 key가 겹치지 않는다", () => {
    const repoA: RepoInfo = { toplevel: "/repo-a", repoRoot: "/repo-a", branch: "main" };
    for (const mode of ["recent", "group"] as const) {
      const rows = buildRows({
        panes: [
          pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/repo-a" }),
          pane({ windowId: "@2", paneId: "%2", paneCurrentPath: "/repo-a" }),
        ],
        agents: [
          agent({ paneId: "%1", lastPromptTs: 2000 }),
          agent({ paneId: "%2", lastPromptTs: 1000 }),
        ],
        repoByCwd: new Map<string, RepoInfo | null>([["/repo-a", repoA]]),
        sleepMap: new Map([["@2", true]]),
        now: 5000,
        mode,
        tmuxPid: TMUX_PID,
      });
      const keys = rows.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
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

  it("워크트리는 머리글로 찍지 않는다. 저장소 머리글만 남는다", () => {
    const wtA: RepoInfo = { toplevel: "/src/hive-a", repoRoot: "/src/hive", branch: "a" };
    const wtB: RepoInfo = { toplevel: "/src/hive-b", repoRoot: "/src/hive", branch: "b" };
    const rows = buildRows({
      panes: [
        pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/src/hive-a" }),
        pane({ windowId: "@2", paneId: "%2", paneCurrentPath: "/src/hive-b" }),
      ],
      agents: [
        agent({ paneId: "%1", lastPromptTs: 2000 }),
        agent({ paneId: "%2", lastPromptTs: 1000 }),
      ],
      repoByCwd: new Map([
        ["/src/hive-a", wtA],
        ["/src/hive-b", wtB],
      ]),
      sleepMap: new Map(),
      now: 5000,
      mode: "recent",
      tmuxPid: TMUX_PID,
    });
    // 워크트리가 둘로 갈려도 같은 저장소면 머리글은 한 번이다.
    expect(rows.filter((r) => r.kind === "group").map((r) => r.name)).toEqual(["hive"]);
  });

  it("group 모드에서도 워크트리 머리글은 찍지 않는다", () => {
    const wtA: RepoInfo = { toplevel: "/src/hive-a", repoRoot: "/src/hive", branch: "a" };
    const wtB: RepoInfo = { toplevel: "/src/hive-b", repoRoot: "/src/hive", branch: "b" };
    const rows = buildRows({
      panes: [
        pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/src/hive-a" }),
        pane({ windowId: "@2", paneId: "%2", paneCurrentPath: "/src/hive-b" }),
      ],
      agents: [
        agent({ paneId: "%1", lastPromptTs: 2000 }),
        agent({ paneId: "%2", lastPromptTs: 1000 }),
      ],
      repoByCwd: new Map([
        ["/src/hive-a", wtA],
        ["/src/hive-b", wtB],
      ]),
      sleepMap: new Map(),
      now: 5000,
      mode: "group",
      tmuxPid: TMUX_PID,
    });
    expect(rows.filter((r) => r.kind === "group").map((r) => r.name)).toEqual(["hive"]);
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
    const groupNames = rows.filter((r) => r.kind !== "window").map((r) => [r.depth, r.name]);
    expect(groupNames).toEqual([
      [0, "repo-b"],
      [0, "repo-a"],
    ]);
  });
});

describe("buildRows agent 없는 pane 처리", () => {
  // 사이드바(node)는 join-pane -hb로 항상 window의 첫 pane이 된다.
  const sidebar = (windowId: string, paneId: string) =>
    pane({
      windowId,
      paneId,
      paneCurrentCommand: "node",
      paneCurrentPath: "/home/me",
      paneActive: false,
    });

  it("사이드바 pane이 claude의 done 상태를 unknown으로 덮어쓰지 않는다", () => {
    const rows = windowRows(
      buildRows({
        panes: [sidebar("@1", "%0"), pane({ windowId: "@1", paneId: "%1" })],
        agents: [agent({ paneId: "%1", state: "done", lastEvent: "Stop" })],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("done");
  });

  it("window의 cwd를 사이드바가 아닌 claude pane에서 가져온다", () => {
    const rows = windowRows(
      buildRows({
        panes: [
          sidebar("@1", "%0"),
          pane({ windowId: "@1", paneId: "%1", paneCurrentPath: "/repo/feature" }),
        ],
        agents: [agent({ paneId: "%1" })],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows[0].cwd).toBe("/repo/feature");
  });

  it("agent가 하나도 없는 window는 목록에서 뺀다", () => {
    const rows = windowRows(
      buildRows({
        panes: [sidebar("@1", "%0"), pane({ windowId: "@1", paneId: "%1", paneCurrentCommand: "zsh" })],
        agents: [],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows).toHaveLength(0);
  });

  it("claude가 도는 window만 남기고 셸뿐인 window는 뺀다", () => {
    const rows = windowRows(
      buildRows({
        panes: [
          pane({ windowId: "@1", paneId: "%1" }),
          pane({ windowId: "@2", paneId: "%2", paneCurrentCommand: "zsh" }),
        ],
        agents: [],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows.map((r) => r.windowId)).toEqual(["@1"]);
  });

  it("hook 기록이 없어도 claude가 도는 pane은 unknown으로 남긴다", () => {
    const rows = windowRows(
      buildRows({
        panes: [sidebar("@1", "%0"), pane({ windowId: "@1", paneId: "%1" })],
        agents: [],
        repoByCwd: new Map(),
        sleepMap: new Map(),
        now: 5000,
        mode: "recent",
        tmuxPid: TMUX_PID,
      })
    );
    expect(rows[0].state).toBe("unknown");
  });
});

describe("resolvePaneAgents", () => {
  const proc = (pid: string, ppid: string, comm: string) => ({ pid, ppid, comm });

  it("pane 명령이 그대로 agent면 바로 잡는다", () => {
    const agents = resolvePaneAgents([pane({ paneId: "%1", paneCurrentCommand: "claude", panePid: "10" })], []);
    expect(agents.get("%1")).toBe("claude");
  });

  it("npm 래퍼(node) 아래에 있는 codex를 찾아낸다", () => {
    // 실측: pane(zsh) -> node(codex.js) -> codex
    const panes = [pane({ paneId: "%1", paneCurrentCommand: "node", panePid: "10" })];
    const procs = [proc("11", "10", "node"), proc("12", "11", "codex")];
    expect(resolvePaneAgents(panes, procs).get("%1")).toBe("codex");
  });

  it("agent가 없는 셸 pane은 비워 둔다", () => {
    const panes = [pane({ paneId: "%1", paneCurrentCommand: "zsh", panePid: "10" })];
    const procs = [proc("11", "10", "vim")];
    expect(resolvePaneAgents(panes, procs).has("%1")).toBe(false);
  });

  it("claude가 codex를 자식으로 돌려도 그 pane은 claude로 본다", () => {
    const panes = [pane({ paneId: "%1", paneCurrentCommand: "zsh", panePid: "10" })];
    const procs = [proc("11", "10", "claude"), proc("12", "11", "codex")];
    expect(resolvePaneAgents(panes, procs).get("%1")).toBe("claude");
  });
});

describe("codex pane", () => {
  const rowsFor = (paneCurrentCommand: string, agentByPane?: Map<string, "claude" | "codex">) =>
    buildRows({
      panes: [pane({ paneId: "%1", windowId: "@1", paneCurrentCommand })],
      agents: [],
      repoByCwd: new Map(),
      sleepMap: new Map(),
      agentByPane,
      now: 1000,
      mode: "recent",
      tmuxPid: TMUX_PID,
    });

  it("hook 이벤트가 없어도 codex가 떠 있으면 agent로 잡는다", () => {
    const rows = windowRows(rowsFor("codex", new Map([["%1", "codex" as const]])));
    expect(rows[0].state).toBe("unknown");
    expect(rows[0].agent).toBe("codex");
  });

  it("agent가 아닌 셸 pane뿐인 window는 목록에서 뺀다", () => {
    expect(windowRows(rowsFor("zsh"))).toHaveLength(0);
  });
});

describe("unreadUpdates", () => {
  function row(overrides: Partial<Row>): Row {
    return {
      kind: "window",
      key: overrides.windowId ?? "@1",
      sessionName: "s",
      windowId: overrides.windowId ?? "@1",
      windowIndex: "1",
      name: "w",
      autoName: false,
      cwd: "/repo",
      repoLabel: "repo",
      worktreeLabel: "repo",
      state: "done",
      source: "hook",
      agentPaneId: "%1",
      prompt: null,
      title: null,
      liveTitle: null,
      lastInputTs: 0,
      lastInputIsFallback: false,
      sleep: false,
      unread: false,
      active: false,
      depth: 0,
      ...overrides,
    };
  }

  it("처음 보는 창이 done이면 안 읽음을 켠다", () => {
    const out = unreadUpdates({
      rows: [row({ windowId: "@1", state: "done" })],
      seenStates: new Map(),
      currentWindowId: null,
    });
    expect(out).toEqual([{ windowId: "@1", seenState: "done", unread: true }]);
  });

  it("본 상태 그대로면 아무것도 돌려주지 않는다", () => {
    const out = unreadUpdates({
      rows: [row({ windowId: "@1", state: "done" })],
      seenStates: new Map([["@1", "done"]]),
      currentWindowId: null,
    });
    expect(out).toEqual([]);
  });

  it("working이나 idle로 바뀌면 본 상태만 갱신하고 안 읽음은 안 켠다", () => {
    const out = unreadUpdates({
      rows: [row({ windowId: "@1", state: "working" }), row({ windowId: "@2", state: "idle" })],
      seenStates: new Map([
        ["@1", "done"],
        ["@2", "working"],
      ]),
      currentWindowId: null,
    });
    expect(out.map((u) => u.unread)).toEqual([false, false]);
    expect(out.map((u) => u.seenState)).toEqual(["working", "idle"]);
  });

  it("지금 보고 있는 창은 done이 돼도 안 읽음을 안 켠다", () => {
    const out = unreadUpdates({
      rows: [row({ windowId: "@1", state: "done" })],
      seenStates: new Map([["@1", "working"]]),
      currentWindowId: "@1",
    });
    expect(out).toEqual([{ windowId: "@1", seenState: "done", unread: false }]);
  });

  it("done에서 waiting으로 넘어가면 다시 켠다", () => {
    const out = unreadUpdates({
      rows: [row({ windowId: "@1", state: "waiting" })],
      seenStates: new Map([["@1", "done"]]),
      currentWindowId: null,
    });
    expect(out).toEqual([{ windowId: "@1", seenState: "waiting", unread: true }]);
  });

  it("머리글 행은 건너뛴다", () => {
    const out = unreadUpdates({
      rows: [row({ kind: "group", windowId: "", state: "done" })],
      seenStates: new Map(),
      currentWindowId: null,
    });
    expect(out).toEqual([]);
  });
});
