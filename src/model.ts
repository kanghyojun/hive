import { hostname } from "node:os";
import { basename } from "node:path";
import type { AgentRecord, AgentState } from "./state.js";
import { effectiveState } from "./state.js";
import type { PaneInfo } from "./tmux.js";
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

// 사이드바 자신과 일반 셸 pane은 agent가 아니다. 이런 pane까지 상태를 매기면 unknown이 되고,
// unknown은 done/idle보다 급한 상태라 claude가 끝난 window를 ◌로 덮어쓴다.
// 사이드바는 join-pane -hb로 항상 pane_index 0이라 window의 첫 pane이기도 하다(실측).
function isAgentPane(pane: PaneInfo, agent: AgentRecord | undefined): boolean {
  return agent !== undefined || pane.paneCurrentCommand === "claude";
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
        autoName: pane.windowAutoName,
        cwd: pane.paneCurrentPath,
        cwdRank: rank,
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
      state: w.state,
      source: w.source,
      agentPaneId: w.agentPaneId,
      prompt: w.prompt,
      title: w.title,
      liveTitle: w.liveTitle,
      lastInputTs: w.lastPromptTs ?? w.windowActivity * 1000,
      lastInputIsFallback,
      sleep: input.sleepMap.get(w.windowId) ?? false,
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
