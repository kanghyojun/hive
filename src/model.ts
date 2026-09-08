import { hostname } from "node:os";
import { basename } from "node:path";
import type { AgentKind, AgentRecord, AgentState } from "./state.js";
import { AGENT_KINDS, effectiveState } from "./state.js";
import type { PaneInfo, ProcInfo } from "./tmux.js";
import type { RepoInfo } from "./git.js";

export type ViewMode = "recent" | "group";

export interface Row {
  kind: "group" | "divider" | "window";
  key: string;
  sessionName: string;
  windowId: string;
  windowIndex: string;
  name: string;
  /** 창 이름이 tmux 자동 이름(활성 pane 명령어)이면 라벨로 쓰지 않는다. */
  autoName: boolean;
  cwd: string;
  repoRoot?: string;
  worktreePath?: string;
  repoName?: string;
  branch?: string;
  /** 1층 머리글: 메인 저장소 이름. */
  repoLabel: string;
  /** 2층 머리글: "워크트리 이름 : 브랜치". */
  worktreeLabel: string;
  agent?: AgentKind;
  state: AgentState;
  source: string;
  /** 이 창을 대표하는 agent pane. 창으로 옮겨갈 때 여기로 포커스를 준다. */
  agentPaneId: string | null;
  prompt: string | null;
  /** agent 세션의 첫 입력. 살아 있는 제목이 없을 때 라벨로 쓴다. */
  title: string | null;
  /** claude가 pane 제목에 써 넣는 지금 하는 일. 작업이 바뀌면 같이 바뀐다. */
  liveTitle: string | null;
  lastInputTs: number;
  lastInputIsFallback: boolean;
  sleep: boolean;
  /** 상태가 바뀌었는데 아직 그 창에 들어가 보지 않았다. 행 오른쪽 끝에 막대로 표시한다. */
  unread: boolean;
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

// 목록에서 위로 올릴 순서. "지금 사람이 봐야 하는가" 기준이라 window 상태를 접을 때 쓰는
// STATE_PRIORITY와는 다르다. 거기선 working이 더 급하지만, 여기선 끝난 창(done)이 "다음 지시 차례"라 더 급하다.
const ATTENTION_PRIORITY: Record<AgentState, number> = {
  waiting: 0,
  done: 1,
  working: 2,
  unknown: 3,
  idle: 4,
};

export interface BuildRowsInput {
  panes: PaneInfo[];
  agents: AgentRecord[];
  repoByCwd: Map<string, RepoInfo | null>;
  sleepMap: Map<string, boolean>;
  unreadMap?: Map<string, boolean>;
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
  autoName: boolean;
  cwd: string;
  cwdRank: number;
  agent?: AgentKind;
  active: boolean;
  windowActivity: number;
  tracked: boolean;
  state: AgentState;
  source: string;
  agentPaneId: string | null;
  prompt: string | null;
  title: string | null;
  liveTitle: string | null;
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

const HOST = hostname();

// claude는 pane 제목을 "✳ 지금 하는 일" 꼴로 쓴다. 앞의 상태 글리프만 떼어낸다.
// 아직 아무 일도 안 한 세션은 "Claude Code", 셸이 쓴 제목은 호스트명이라 둘 다 이름값을 못 한다.
export function liveTitleOf(paneTitle: string | undefined): string | null {
  if (!paneTitle) return null;
  const cleaned = paneTitle.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!cleaned || cleaned === "Claude Code" || cleaned === HOST) return null;
  return cleaned;
}

// window를 대표할 cwd는 agent pane을, 그중에서도 활성 pane을 우선한다.
function cwdRank(pane: PaneInfo, agentPane: boolean): number {
  return (agentPane ? 2 : 0) + (pane.paneActive ? 1 : 0);
}

// 머리글 두 줄에 쓸 라벨. 1층은 메인 저장소, 2층은 "워크트리 이름 : 브랜치".
// 저장소 본체에서 바로 일하는 것과 따로 판 워크트리는 겉보기가 같아서 구분이 안 된다.
// 따로 판 워크트리에만 "+"를 붙인다. toplevel이 repoRoot와 다르면 별도 워크트리다.
function placeLabels(repo: RepoInfo | null, cwd: string): { repoLabel: string; worktreeLabel: string } {
  if (!repo) return { repoLabel: "(repo 아님)", worktreeLabel: basename(cwd) };
  const linked = repo.toplevel !== repo.repoRoot;
  return {
    repoLabel: basename(repo.repoRoot),
    worktreeLabel: `${linked ? "+" : ""}${basename(repo.toplevel)} : ${repo.branch}`,
  };
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
        autoName: pane.windowAutoName,
        cwd: pane.paneCurrentPath,
        cwdRank: rank,
        agent: kind,
        active: pane.windowActive,
        windowActivity: pane.windowActivity,
        tracked,
        state,
        source,
        agentPaneId: tracked ? pane.paneId : null,
        prompt: agent?.prompt ?? null,
        title: agent?.title ?? null,
        liveTitle: tracked ? liveTitleOf(pane.paneTitle) : null,
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
      existing.agentPaneId = pane.paneId;
      existing.prompt = agent?.prompt ?? null;
      existing.title = agent?.title ?? null;
      existing.liveTitle = liveTitleOf(pane.paneTitle);
      existing.agent = kind ?? existing.agent;
    }
  }

  const rows: Row[] = [];
  for (const w of windows.values()) {
    // agent가 없는 window는 목록에서 뺀다. 쓰레드뷰는 claude가 떠 있는 창만 보여준다.
    if (!w.tracked) continue;
    const repo = input.repoByCwd.get(w.cwd) ?? null;
    const lastInputIsFallback = w.lastPromptTs == null;
    rows.push({
      kind: "window",
      key: w.windowId,
      sessionName: w.sessionName,
      windowId: w.windowId,
      windowIndex: w.windowIndex,
      name: w.name,
      autoName: w.autoName,
      cwd: w.cwd,
      repoRoot: repo?.repoRoot,
      worktreePath: repo?.toplevel,
      repoName: repo ? basename(repo.repoRoot) : undefined,
      branch: repo?.branch,
      ...placeLabels(repo, w.cwd),
      agent: w.agent,
      state: w.state,
      source: w.source,
      agentPaneId: w.agentPaneId,
      prompt: w.prompt,
      title: w.title,
      liveTitle: w.liveTitle,
      lastInputTs: w.lastPromptTs ?? w.windowActivity * 1000,
      lastInputIsFallback,
      sleep: input.sleepMap.get(w.windowId) ?? false,
      unread: input.unreadMap?.get(w.windowId) ?? false,
      active: w.active,
      depth: 0,
    });
  }

  // 잠자는 창은 저장소별로 흩어놓지 않고 목록 맨 밑에 한 덩어리로 모은다.
  const awake = rows.filter((r) => !r.sleep);
  const asleep = rows.filter((r) => r.sleep);
  const out = input.mode === "recent" ? layoutRecent(awake) : layoutGroup(awake);
  if (asleep.length > 0) {
    // 구분선 바로 위는 한 줄 띄운다. 붙어 있으면 앞 묶음의 마지막 줄처럼 보인다.
    if (out.length > 0) out.push(headerRow(`gap:${out.length}`, "", 0, []));
    out.push(headerRow(SLEEP_GROUP_KEY, "잠자는 중", 0, asleep, "divider"));
    out.push(...layoutRecent(asleep));
  }
  // 머리글 key는 화면 순서로 다시 매긴다. layout을 두 번(깨어있는 목록 + 잠자는 목록) 부르면
  // 각자 0부터 세어서 key가 겹친다. window 행은 windowId라 그대로 둔다.
  return out.map((r, i) => (r.kind === "window" ? r : { ...r, key: `group:${i}` }));
}

// 잠자는 창을 맨 밑으로, 그 위는 관심 필요한 순, 같은 급이면 최근 입력 순.
function sortByAttention(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.sleep !== b.sleep) return a.sleep ? 1 : -1;
    const attention = ATTENTION_PRIORITY[a.state] - ATTENTION_PRIORITY[b.state];
    if (attention !== 0) return attention;
    return b.lastInputTs - a.lastInputTs;
  });
}

const SLEEP_GROUP_KEY = "__sleep__";

// unread를 켜는 상태. "이제 내 차례"라는 신호만 잡는다. working 시작이나 idle 전환은
// 진행 상황이지 부름이 아니라서 표시하지 않는다.
const NOTIFY_STATES = new Set<AgentState>(["waiting", "done"]);

export interface UnreadUpdate {
  windowId: string;
  /** 이번에 본 것으로 기록할 상태. 같은 상태가 이어지는 동안 다시 켜지지 않게 한다. */
  seenState: AgentState;
  /** true면 안 읽음을 켠다. false는 "끄라"가 아니라 "건드리지 말라"는 뜻이다. */
  unread: boolean;
}

// 상태가 직전에 본 것과 달라진 창만 골라낸다. 지금 보고 있는 창은 눈앞에서 바뀐 것이라
// 표시를 붙이지 않고 본 상태만 갱신한다.
export function unreadUpdates(input: {
  rows: Row[];
  seenStates: Map<string, string | null>;
  currentWindowId: string | null;
}): UnreadUpdate[] {
  const updates: UnreadUpdate[] = [];
  for (const row of input.rows) {
    if (row.kind !== "window") continue;
    if (input.seenStates.get(row.windowId) === row.state) continue;
    updates.push({
      windowId: row.windowId,
      seenState: row.state,
      unread: NOTIFY_STATES.has(row.state) && row.windowId !== input.currentWindowId,
    });
  }
  return updates;
}

function maxInputTs(rows: Row[]): number {
  return rows.reduce((max, r) => Math.max(max, r.lastInputTs), 0);
}

function headerRow(
  key: string,
  label: string,
  depth: number,
  rows: Row[],
  kind: "group" | "divider" = "group"
): Row {
  return {
    kind,
    key: `group:${key}`,
    sessionName: "",
    windowId: "",
    windowIndex: "",
    name: label,
    autoName: false,
    cwd: "",
    repoLabel: label,
    worktreeLabel: label,
    state: "idle",
    source: "",
    agentPaneId: null,
    prompt: null,
    title: null,
    liveTitle: null,
    lastInputTs: maxInputTs(rows),
    lastInputIsFallback: true,
    sleep: false,
    unread: false,
    active: false,
    depth,
  };
}

function worktreeKey(r: Row): string {
  return r.worktreePath ?? r.cwd;
}

function repoKey(r: Row): string {
  return r.repoRoot ?? `__norepo__:${r.cwd}`;
}

// 두 모드 모두 저장소 → 워크트리 → 창 3층으로 그린다. 다른 건 순서뿐이다.
// recent는 관심 순으로 늘어놓고, 앞 줄과 워크트리가 달라질 때마다 머리글 두 줄을 다시 찍는다.
function layoutRecent(rows: Row[]): Row[] {
  const out: Row[] = [];
  let lastKey: string | null = null;
  for (const row of sortByAttention(rows)) {
    const key = worktreeKey(row);
    if (key !== lastKey) {
      out.push(headerRow(`repo:${out.length}`, row.repoLabel, 0, [row]));
      out.push(headerRow(`wt:${out.length}`, row.worktreeLabel, 1, [row]));
      lastKey = key;
    }
    out.push({ ...row, depth: 2 });
  }
  return out;
}

function bucketBy(rows: Row[], keyOf: (r: Row) => string): Row[][] {
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const list = buckets.get(keyOf(r)) ?? [];
    list.push(r);
    buckets.set(keyOf(r), list);
  }
  return [...buckets.values()].sort((a, b) => maxInputTs(b) - maxInputTs(a));
}

function layoutGroup(rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const repoRows of bucketBy(rows, repoKey)) {
    out.push(headerRow(`repo:${out.length}`, repoRows[0].repoLabel, 0, repoRows));
    for (const worktreeRows of bucketBy(repoRows, worktreeKey)) {
      out.push(headerRow(`wt:${out.length}`, worktreeRows[0].worktreeLabel, 1, worktreeRows));
      out.push(...sortByAttention(worktreeRows).map((r) => ({ ...r, depth: 2 })));
    }
  }
  return out;
}
