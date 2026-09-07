import { basename } from "node:path";
import type { AgentKind, AgentRecord, AgentState } from "./state.js";
import { AGENT_KINDS, effectiveState } from "./state.js";
import type { PaneInfo, ProcInfo } from "./tmux.js";
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
  agent?: AgentKind;
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
  agentByPane?: Map<string, AgentKind>;
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
  agent?: AgentKind;
  active: boolean;
  windowActivity: number;
  tracked: boolean;
  state: AgentState;
  source: string;
  prompt: string | null;
  lastPromptTs: number | null;
}

// 프로세스 트리를 몇 단계까지 따라가며 agent를 찾을지. npm 래퍼는 보통 한두 단계다.
const MAX_PROC_DEPTH = 8;

export function agentKindFromCommand(command: string): AgentKind | undefined {
  return AGENT_KINDS.find((kind) => kind === command);
}

function findAgentInTree(rootPid: string, childrenByPpid: Map<string, ProcInfo[]>): AgentKind | undefined {
  let frontier = childrenByPpid.get(rootPid) ?? [];
  for (let depth = 0; depth < MAX_PROC_DEPTH && frontier.length > 0; depth++) {
    const next: ProcInfo[] = [];
    for (const proc of frontier) {
      const kind = agentKindFromCommand(proc.comm);
      if (kind) return kind;
      next.push(...(childrenByPpid.get(proc.pid) ?? []));
    }
    frontier = next;
  }
  return undefined;
}

// hook 이벤트가 아직 하나도 없어도 pane에 떠 있는 agent는 목록에 잡아야 한다.
// codex는 npm 래퍼(node)가 실제 바이너리를 자식으로 띄워서 pane 명령만 보면 놓친다(실측).
// 얕은 쪽부터 훑으므로 claude가 codex exec을 돌리는 pane은 claude로 남는다.
export function resolvePaneAgents(panes: PaneInfo[], procs: ProcInfo[]): Map<string, AgentKind> {
  const childrenByPpid = new Map<string, ProcInfo[]>();
  for (const proc of procs) {
    const list = childrenByPpid.get(proc.ppid) ?? [];
    list.push(proc);
    childrenByPpid.set(proc.ppid, list);
  }

  const agents = new Map<string, AgentKind>();
  for (const pane of panes) {
    const kind = agentKindFromCommand(pane.paneCurrentCommand) ?? findAgentInTree(pane.panePid, childrenByPpid);
    if (kind) agents.set(pane.paneId, kind);
  }
  return agents;
}

// 사이드바 자신과 일반 셸 pane은 agent가 아니다. 이런 pane까지 상태를 매기면 unknown이 되고,
// unknown은 done/idle보다 급한 상태라 agent가 끝난 window를 ◌로 덮어쓴다.
// 사이드바는 join-pane -hb로 항상 pane_index 0이라 window의 첫 pane이기도 하다(실측).
function isAgentPane(agent: AgentRecord | undefined, kind: AgentKind | undefined): boolean {
  return agent !== undefined || kind !== undefined;
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
    // agentByPane은 프로세스 트리까지 본 결과라 더 정확하지만, 없으면 pane 명령만으로 판단한다.
    const kind = input.agentByPane?.get(pane.paneId) ?? agentKindFromCommand(pane.paneCurrentCommand);
    const screenWaiting = input.screenWaitingPanes?.has(pane.paneId) ?? false;
    const tracked = isAgentPane(agent, kind);
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
        agent: kind,
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
      existing.agent = kind ?? existing.agent;
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
      agent: w.agent,
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
