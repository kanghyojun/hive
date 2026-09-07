import { basename } from "node:path";
import type { AgentRecord, AgentState } from "./state.js";
import { effectiveState } from "./state.js";
import type { PaneInfo } from "./tmux.js";
import type { RepoInfo } from "./git.js";

export type ViewMode = "recent" | "group";

export interface Row {
  kind: "group" | "window";
  key: string;
  sessionName: string;
  windowId: string;
  windowIndex: string;
  name: string;
  cwd: string;
  repoRoot?: string;
  worktreePath?: string;
  repoName?: string;
  branch?: string;
  state: AgentState;
  source: string;
  prompt: string | null;
  lastInputTs: number;
  lastInputIsFallback: boolean;
  sleep: boolean;
  active: boolean;
  depth: number;
}

const STATE_PRIORITY: Record<AgentState, number> = {
  waiting: 0,
  working: 1,
  unknown: 2,
  done: 3,
  idle: 4,
};

export interface BuildRowsInput {
  panes: PaneInfo[];
  agents: AgentRecord[];
  repoByCwd: Map<string, RepoInfo | null>;
  sleepMap: Map<string, boolean>;
  now: number;
  mode: ViewMode;
  tmuxPid: string;
  screenWaitingPanes?: Set<string>;
}

interface WindowAgg {
  sessionName: string;
  windowId: string;
  windowIndex: string;
  name: string;
  cwd: string;
  cwdRank: number;
  active: boolean;
  windowActivity: number;
  tracked: boolean;
  state: AgentState;
  source: string;
  prompt: string | null;
  lastPromptTs: number | null;
}

// 사이드바 자신과 일반 셸 pane은 agent가 아니다. 이런 pane까지 상태를 매기면 unknown이 되고,
// unknown은 done/idle보다 급한 상태라 claude가 끝난 window를 ◌로 덮어쓴다.
// 사이드바는 join-pane -hb로 항상 pane_index 0이라 window의 첫 pane이기도 하다(실측).
function isAgentPane(pane: PaneInfo, agent: AgentRecord | undefined): boolean {
  return agent !== undefined || pane.paneCurrentCommand === "claude";
}

// window를 대표할 cwd는 agent pane을, 그중에서도 활성 pane을 우선한다.
function cwdRank(pane: PaneInfo, agentPane: boolean): number {
  return (agentPane ? 2 : 0) + (pane.paneActive ? 1 : 0);
}

export function buildRows(input: BuildRowsInput): Row[] {
  const agentByPane = new Map<string, AgentRecord>();
  for (const a of input.agents) {
    if (a.tmuxPid === input.tmuxPid) agentByPane.set(a.paneId, a);
  }

  const windows = new Map<string, WindowAgg>();
  for (const pane of input.panes) {
    const agent = agentByPane.get(pane.paneId);
    const screenWaiting = input.screenWaitingPanes?.has(pane.paneId) ?? false;
    const tracked = isAgentPane(pane, agent);
    // agent가 없는 pane은 상태 집계에서 빼되 window 자체는 목록에 남긴다(idle = agent 없음).
    const { state, source } = tracked
      ? effectiveState(agent, input.now, screenWaiting)
      : { state: "idle" as AgentState, source: "" };
    const promptTs = agent?.lastPromptTs ?? null;
    const rank = cwdRank(pane, tracked);

    const existing = windows.get(pane.windowId);
    if (!existing) {
      windows.set(pane.windowId, {
        sessionName: pane.sessionName,
        windowId: pane.windowId,
        windowIndex: pane.windowIndex,
        name: pane.windowName,
        cwd: pane.paneCurrentPath,
        cwdRank: rank,
        active: pane.windowActive,
        windowActivity: pane.windowActivity,
        tracked,
        state,
        source,
        prompt: agent?.prompt ?? null,
        lastPromptTs: promptTs,
      });
      continue;
    }

    existing.windowActivity = Math.max(existing.windowActivity, pane.windowActivity);
    if (promptTs != null) {
      existing.lastPromptTs = existing.lastPromptTs == null ? promptTs : Math.max(existing.lastPromptTs, promptTs);
    }
    if (rank > existing.cwdRank) {
      existing.cwd = pane.paneCurrentPath;
      existing.cwdRank = rank;
    }
    // 창 상태는 그 안의 agent pane들 중 가장 급한 상태(waiting > working > unknown > done > idle)를 대표로 쓴다.
    if (tracked && (!existing.tracked || STATE_PRIORITY[state] < STATE_PRIORITY[existing.state])) {
      existing.tracked = true;
      existing.state = state;
      existing.source = source;
      existing.prompt = agent?.prompt ?? null;
    }
  }

  const rows: Row[] = [];
  for (const w of windows.values()) {
    const repo = input.repoByCwd.get(w.cwd) ?? null;
    const lastInputIsFallback = w.lastPromptTs == null;
    rows.push({
      kind: "window",
      key: w.windowId,
      sessionName: w.sessionName,
      windowId: w.windowId,
      windowIndex: w.windowIndex,
      name: w.name,
      cwd: w.cwd,
      repoRoot: repo?.repoRoot,
      worktreePath: repo?.toplevel,
      repoName: repo ? basename(repo.repoRoot) : undefined,
      branch: repo?.branch,
      state: w.state,
      source: w.source,
      prompt: w.prompt,
      lastInputTs: w.lastPromptTs ?? w.windowActivity * 1000,
      lastInputIsFallback,
      sleep: input.sleepMap.get(w.windowId) ?? false,
      active: w.active,
      depth: 0,
    });
  }

  return input.mode === "recent" ? sortRecent(rows) : groupRows(rows);
}

function sortRecent(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.sleep !== b.sleep) return a.sleep ? 1 : -1;
    return b.lastInputTs - a.lastInputTs;
  });
}

function maxInputTs(rows: Row[]): number {
  return rows.reduce((max, r) => Math.max(max, r.lastInputTs), 0);
}

function groupHeaderRow(key: string, label: string, rows: Row[]): Row {
  return {
    kind: "group",
    key: `group:${key}`,
    sessionName: "",
    windowId: "",
    windowIndex: "",
    name: label,
    cwd: "",
    state: "idle",
    source: "",
    prompt: null,
    lastInputTs: maxInputTs(rows),
    lastInputIsFallback: true,
    sleep: false,
    active: false,
    depth: 0,
  };
}

function groupRows(rows: Row[]): Row[] {
  const repoBuckets = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.repoRoot ?? `__norepo__:${r.cwd}`;
    const list = repoBuckets.get(key) ?? [];
    list.push(r);
    repoBuckets.set(key, list);
  }

  const orderedRepoKeys = [...repoBuckets.keys()].sort(
    (a, b) => maxInputTs(repoBuckets.get(b)!) - maxInputTs(repoBuckets.get(a)!)
  );

  const out: Row[] = [];
  for (const repoKey of orderedRepoKeys) {
    const repoRows = repoBuckets.get(repoKey)!;
    const label = repoRows[0].repoName ?? "(repo 아님)";
    out.push(groupHeaderRow(repoKey, label, repoRows));

    const worktreeBuckets = new Map<string, Row[]>();
    for (const r of repoRows) {
      const wKey = r.worktreePath ?? r.cwd;
      const list = worktreeBuckets.get(wKey) ?? [];
      list.push(r);
      worktreeBuckets.set(wKey, list);
    }
    const orderedWorktreeKeys = [...worktreeBuckets.keys()].sort(
      (a, b) => maxInputTs(worktreeBuckets.get(b)!) - maxInputTs(worktreeBuckets.get(a)!)
    );
    for (const wKey of orderedWorktreeKeys) {
      out.push(...sortRecent(worktreeBuckets.get(wKey)!).map((r) => ({ ...r, depth: 1 })));
    }
  }
  return out;
}
