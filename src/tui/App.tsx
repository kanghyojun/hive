import { readFileSync, writeFileSync } from "node:fs";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from "ink";
import { openDb, type Db } from "../db.js";
import { ingestAll } from "../spool.js";
import {
  reduceAgent,
  looksLikePermissionPrompt,
  AGENT_GLYPH,
  AGENT_GLYPH_WIDTH,
  HIDE_GLYPH_WHEN_UNIFORM,
  type AgentKind,
  type AgentState,
} from "../state.js";
import { basename } from "node:path";
import { listWorktrees, resolveRepo, type RepoInfo } from "../git.js";
import { buildRows,
  unreadUpdates, readWindowIds, resolvePaneAgents, type Row, type ViewMode } from "../model.js";
import { fitSegments, statusSegments, STATUS_SEP } from "./statusbar.js";
import {
  capturePaneTail,
  listPanes,
  listProcesses,
  selectWindow,
  resizePaneWidth,
  serverInfo,
  switchClient,
  currentSessionName,
  selectPane,
  currentPaneId,
  type PaneInfo,
} from "../tmux.js";
import stringWidth from "string-width";
import { cleanupFromTui, SIDEBAR_WIDTH } from "../sidebar.js";
import {
  knownRepos,
  planWtRemove,
  sessionsAfterKill,
  unopenedWorktrees,
  wtNew,
  wtOpen,
  wtRemove,
  type WtRemovePlan,
} from "../worktree.js";
import { collapseHome, listDirCandidates, sliceStart, type DirCandidate } from "../pathPicker.js";
import {
  ghErrorMessage,
  listPullRequests,
  prLabel,
  wtFromPr,
  type PullRequest,
} from "../githubPr.js";
import { jumpIndex, jumpLabel, jumpLabelWidth, JUMP_PREFIX } from "../jump.js";
import {
  abConfigPath,
  abLocalInstalled,
  parseAbConfig,
  probeAbBridge,
  type AbStatus,
} from "../abBridge.js";
import { formatUsageLines, readClaudeUsage, readCodexUsage, type AgentUsage } from "../usage.js";
import { dbPath, spoolDir, uiStatePath, ensureDirs } from "../paths.js";

const TICK_MS = 1000;
const SCREEN_CHECK_MS = 3000;
const SCREEN_TAIL_LINES = 25;
const REPO_CANDIDATE_MAX = 8;
const AB_PROBE_MS = 30_000;
// PR은 30개까지 받아오는데 footer는 잘려 나가므로 repoInput처럼 창을 내어 보여준다.
const PR_CANDIDATE_MAX = 8;
const USAGE_REFRESH_MS = 30_000;

/**
 * path가 없으면 "그 저장소에 새 worktree 만들기" 항목이고,
 * repoRoot까지 없으면 "hive가 모르는 저장소를 경로로 찾기" 항목이다.
 * pr이 붙으면 그 저장소의 PR 목록으로 넘어가는 항목이다.
 */
interface PickerItem {
  label: string;
  repoRoot?: string;
  path?: string;
  pr?: true;
}

const STATE_ICON: Record<AgentState, string> = {
  working: "●",
  waiting: "?",
  done: "✓",
  idle: "·",
  unknown: "◌",
};

const STATE_COLOR: Record<AgentState, string | undefined> = {
  working: "yellow",
  waiting: "red",
  done: "green",
  idle: "gray",
  unknown: undefined,
};

// 도는 중인 창만 프레임을 돌린다. claude code처럼 글자 몇 개를 번갈아 보여주는 정도다.
const SPINNER = ["✳", "✶", "✻"];
const SPINNER_MS = 400;

// 선택과 "지금 보고 있는 창"을 같은 자리(왼쪽 세로 막대)에 색으로 구분한다.
// 한 행이 둘 다면 선택 색이 위에 온다. 대신 그 행으로 실제 옮겨가는 순간 선택을 아예 해제해서
// 자홍 막대를 화면에서 없앤다. 남겨두면 사이드바로 돌아왔을 때 커서가 어디 있는지 헷갈린다.
const BAR = "▌";
// 창 한 개가 두 줄을 쓰므로 왼쪽에 세로선을 세워 어디까지가 한 항목인지 보이게 한다.
const RAIL = "│";
// 안 읽음 표시. 왼쪽의 선택/현재 막대(BAR)와 반대쪽을 채워 서로 헷갈리지 않게 한다.
const UNREAD_BAR = "▐";
// 빈 문자열만 담은 <Text>는 ink가 줄로 세지 않는다(실측). 화면을 한 줄 비우려면 공백을 넣어야
// 한다. 상태바를 pane 바닥에 붙이는 이상, 계산한 줄 수와 실제로 그려진 줄 수가 어긋나면 바로
// 상태바 위치가 튄다.
const BLANK_LINE = " ";
// 지금 보고 있는 창이 주인공이라 진한 청록, 옮겨다니는 커서는 그보다 옅은 회색으로 둔다.
const SELECT_COLOR = "gray";
const CURRENT_COLOR = "cyan";

const HELP_LINES = [
  "j/k    위/아래",
  "1-9    번호로 바로 이동",
  "l1/ll1 열 번째부터는 l을 앞에 붙여서 (l9 다음 ll1)",
  "Enter  해당 window로",
  "s      sleep 토글",
  "m      안 읽음 토글",
  "g      recent/group",
  "n      worktree 생성",
  "o      worktree 열기 / 저장소 찾기",
  "p      PR 골라서 worktree로",
  "D      worktree 삭제",
  "u      사용량 보기",
  "r      새로고침",
  "?      도움말 닫기",
  "Ctrl-L 화면 다시 그리기",
  "q      종료",
  "",
  "▌ 청록=지금 창  회색=커서",
  "+ 는 따로 판 워크트리",
  "✱ claude  ⬡ codex",
  "ab●/✗ 맥 브라우저 브리지",
];

// 폭 기준으로 잘라낸다. 한글은 한 글자가 2칸이라 length가 아니라 stringWidth로 세야 한다.
// 예전엔 남는 칸을 공백으로 채워 선택 행 배경을 줄 끝까지 늘렸는데, 그러면 모든 줄이
// pane 폭과 같아져서 pane이 좁아지는 순간 전부 두 줄로 접히고 화면이 깨졌다(실측). 이제 채우지 않는다.
function clip(text: string, width: number): string {
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = stringWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

function loadMode(): ViewMode {
  try {
    const raw = JSON.parse(readFileSync(uiStatePath(), "utf8"));
    return raw.mode === "group" ? "group" : "recent";
  } catch {
    return "recent";
  }
}

function saveMode(mode: ViewMode): void {
  try {
    writeFileSync(uiStatePath(), JSON.stringify({ mode }));
  } catch {
    // 저장 실패는 무시. 다음 실행에 기본값(recent)으로 돌아간다.
  }
}

export function App(): React.JSX.Element {
  const { exit } = useApp();
  const { stdin, isRawModeSupported } = useStdin();
  const { columns, rows: termRows } = useWindowSize();

  const dbRef = useRef<Db | null>(null);
  const screenWaitingRef = useRef<Set<string>>(new Set());
  const lastScreenCheckRef = useRef(0);
  // ps 전체 조회는 1초 tick마다 돌릴 만큼 싸지 않아서 화면 확인과 같은 주기로 갱신한다.
  const paneAgentsRef = useRef<Map<string, AgentKind>>(new Map());

  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<ViewMode>(() => loadMode());
  // 인덱스가 아니라 key로 들고 있어야 tick마다 정렬이 바뀌어도 선택이 다른 window로 미끄러지지 않는다.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [confirm, setConfirm] = useState<{ plan: WtRemovePlan; input: string } | null>(null);
  const [picker, setPicker] = useState<{ items: PickerItem[]; cursor: number } | null>(null);
  const [repoInput, setRepoInput] = useState<{ text: string; cursor: number } | null>(null);
  // prs가 null이면 gh를 기다리는 중이다. 목록 조회는 이 화면에서 유일한 네트워크 호출이라
  // 동기로 부르면 그동안 사이드바가 통째로 멈춘다.
  const [prPicker, setPrPicker] = useState<{
    repoRoot: string;
    prs: PullRequest[] | null;
    cursor: number;
    error?: string;
  } | null>(null);
  // 열 번째 이후 행으로 가려고 사용자가 쌓아 둔 접두사(l, ll, …)의 길이.
  const [jumpPrefix, setJumpPrefix] = useState(0);
  const [ab, setAb] = useState<AbStatus | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [usage, setUsage] = useState<AgentUsage[]>([]);
  // picker에서 "+ 새 worktree"를 고르면 커서 행이 아니라 그 저장소에 만들어야 한다.
  const branchRepoRef = useRef<string | null>(null);
  // 키 핸들러에서도 pane 목록이 필요한데 tick의 panes는 지역 변수라 못 쓴다.
  const panesRef = useRef<PaneInfo[]>([]);
  const [frame, setFrame] = useState(0);
  // Ctrl-L 강제 새로고침용. ink는 출력이 이전과 같으면 아예 쓰지 않아서,
  // 화면을 지운 뒤 다시 그리게 하려면 출력 문자열이 달라져야 한다(끝의 공백 하나로 바꾼다).
  const [redraw, setRedraw] = useState(0);
  // 목록이 pane보다 길면 잘라서 보여준다. 스크롤 위치는 렌더에서 바로 계산하므로 state가 아니라 ref다.
  const scrollRef = useRef(0);
  // 직전에 그린 줄 수. 강제 다시 그리기에서 커서를 어디에 놓을지 정하는 데 쓴다.
  const frameLinesRef = useRef(1);
  // 사이드바가 들어 있는 창이 곧 지금 보고 있는 창이다. 선택 커서와 헷갈리지 않게 따로 표시한다.
  const [currentWindowId, setCurrentWindowId] = useState<string | null>(null);

  const repoCacheRef = useRef(new Map<string, RepoInfo | null>());

  const tick = useCallback(async () => {
    try {
      const db = dbRef.current;
      if (!db) return;

      ingestAll(db, spoolDir(), reduceAgent);

      const panes = listPanes();
      panesRef.current = panes;
      const server = serverInfo();
      const liveWindowIds = [...new Set(panes.map((p) => p.windowId))];
      db.pruneWindowFlags(server.startTime, liveWindowIds);

      const now = Date.now();
      if (now - lastScreenCheckRef.current > SCREEN_CHECK_MS) {
        lastScreenCheckRef.current = now;
        paneAgentsRef.current = resolvePaneAgents(panes, listProcesses());
        const nextWaiting = new Set<string>();
        for (const pane of panes) {
          if (!paneAgentsRef.current.has(pane.paneId)) continue;
          const tail = capturePaneTail(pane.paneId, SCREEN_TAIL_LINES);
          if (looksLikePermissionPrompt(tail)) nextWaiting.add(pane.paneId);
        }
        screenWaitingRef.current = nextWaiting;
      }

      const repoByCwd = repoCacheRef.current;
      for (const cwd of new Set(panes.map((p) => p.paneCurrentPath))) {
        if (!repoByCwd.has(cwd)) repoByCwd.set(cwd, resolveRepo(cwd));
      }

      // 사이드바가 여러 개 떠 있을 수 있다(세션마다, 또는 tmux 서버마다).
      // 정렬 모드는 ui.json 한 곳에 있으니 매 tick 다시 읽어서 어디서 바꾸든 1초 안에 맞춰진다.
      const savedMode = loadMode();
      if (savedMode !== mode) setMode(savedMode);

      const flags = db.getWindowFlags(server.startTime);
      const myPane = currentPaneId();
      const myWindowId = panes.find((p) => p.paneId === myPane)?.windowId ?? null;

      const nextRows = buildRows({
        panes,
        agents: db.listAgents(),
        repoByCwd,
        sleepMap: new Map([...flags].map(([id, f]) => [id, f.sleep])),
        unreadMap: new Map([...flags].map(([id, f]) => [id, f.unread])),
        agentByPane: paneAgentsRef.current,
        now,
        mode: savedMode,
        tmuxPid: server.pid,
        screenWaitingPanes: screenWaitingRef.current,
      });

      // 상태가 바뀐 창에 안 읽음을 켠다. 방금 켠 건 다음 tick을 기다리지 않고 이번 프레임에 바로 그린다.
      // "사람이 보고 있는 창"은 자기 창이 아니라 tmux 전체에서 뽑는다. 사이드바는 세션마다 하나씩
      // 떠서 같은 DB에 쓰기 때문에, 자기 창 기준으로 판정하면 사이드바끼리 알림을 지운다(model.ts 주석).
      const viewedWindowIds = new Set(
        panes.filter((p) => p.windowActive && p.sessionAttached).map((p) => p.windowId)
      );
      const justUnread = new Set<string>();
      for (const u of unreadUpdates({
        rows: nextRows,
        seenStates: new Map([...flags].map(([id, f]) => [id, f.seenState])),
        viewedWindowIds,
      })) {
        db.setSeenState(server.startTime, u.windowId, u.seenState);
        if (!u.unread) continue;
        db.setUnread(server.startTime, u.windowId, true);
        justUnread.add(u.windowId);
      }

      // 보고 있는 창에 남아 있는 안 읽음은 지운다. 켤 때와 기준이 같아서 새로 켠 표시를 되돌리는
      // 일은 없다. 사이드바에서 점프해 들어갈 때만 꺼주면, tmux로 직접 옮겨 다닌 창은 표시가
      // 영영 안 꺼져서 지금 보고 앉은 창에 막대가 남는다(model.ts readWindowIds 주석).
      const justRead = new Set(readWindowIds({ rows: nextRows, viewedWindowIds }));
      for (const windowId of justRead) db.setUnread(server.startTime, windowId, false);

      setCurrentWindowId(myWindowId);

      setRows(
        justUnread.size === 0 && justRead.size === 0
          ? nextRows
          : nextRows.map((r) => {
              if (justUnread.has(r.windowId)) return { ...r, unread: true };
              if (justRead.has(r.windowId)) return { ...r, unread: false };
              return r;
            })
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [mode]);

  // setInterval이 마운트 시점의 tick을 클로저로 잡으면 mode를 바꿔도 1초 뒤 옛 mode로 덮어쓴다.
  // 타이머는 한 번만 걸고, 호출은 항상 최신 tick으로 한다.
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    ensureDirs();
    openDb(dbPath())
      .then((db) => {
        dbRef.current = db;
        void tickRef.current();
        timer = setInterval(() => void tickRef.current(), TICK_MS);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      if (timer) clearInterval(timer);
      dbRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void tick();
  }, [mode, tick]);

  const windowRows = rows.filter((r) => r.kind === "window");
  const hasWorking = windowRows.some((r) => r.state === "working" && !r.sleep);

  // 돌아가는 창이 없으면 타이머를 걸지 않는다. 가만히 있는 사이드바를 0.4초마다 다시 그릴 이유가 없다.
  useEffect(() => {
    if (!hasWorking) return;
    const timer = setInterval(() => setFrame((f) => f + 1), SPINNER_MS);
    return () => clearInterval(timer);
  }, [hasWorking]);

  // tmux는 window 크기가 바뀌면 pane을 비율로 다시 나눈다. 크기가 다른 클라이언트가 오가거나
  // 새 세션이 다른 크기로 만들어지면 41칸이던 사이드바가 27칸이나 78칸으로 벌어진다(실측).
  // 폭이 어긋나면 스스로 되돌린다. 같은 폭에서 되돌리기가 안 먹으면(창이 너무 좁으면) 다시 시도하지 않는다.
  const widthFixRef = useRef<number | null>(null);
  useEffect(() => {
    if (!columns || columns === SIDEBAR_WIDTH) {
      widthFixRef.current = null;
      return;
    }
    if (widthFixRef.current === columns) return;
    widthFixRef.current = columns;
    const myPane = currentPaneId();
    if (!myPane) return;
    try {
      resizePaneWidth(myPane, SIDEBAR_WIDTH);
    } catch {
      // 창이 좁아 41칸을 못 주면 tmux가 거절한다. 다음 크기 변화까지 그대로 둔다.
    }
  }, [columns]);

  const selectedRow = rows.find((r) => r.key === selectedKey);
  // 창으로 옮겨가면 커서를 지우기 때문에 평소에는 커서가 없다. 그때 s나 n이 아무 일도 안 하면
  // 고장난 것처럼 보인다. 커서가 없으면 지금 보고 있는 창을 대상으로 삼는다.
  const actionRow = selectedRow ?? windowRows.find((r) => r.windowId === currentWindowId);

  // 선택한 window가 사라지면 커서를 비운다. 비어 있는 상태가 정상이다(이동 직후가 그렇다).
  useEffect(() => {
    if (selectedKey === null) return;
    if (windowRows.some((r) => r.key === selectedKey)) return;
    setSelectedKey(null);
  }, [windowRows, selectedKey]);

  const moveSelection = useCallback(
    (delta: number) => {
      if (windowRows.length === 0) return;
      // 커서가 없으면 지금 보고 있는 창을 기준으로 움직인다. 거기서 위아래로 가는 게 자연스럽다.
      const selected = windowRows.findIndex((r) => r.key === selectedKey);
      const base = selected !== -1 ? selected : windowRows.findIndex((r) => r.windowId === currentWindowId);
      const next =
        base === -1
          ? delta > 0
            ? 0
            : windowRows.length - 1
          : (base + delta + windowRows.length) % windowRows.length;
      setSelectedKey(windowRows[next].key);
    },
    [windowRows, selectedKey, currentWindowId]
  );

  const activateRow = useCallback((row: Row | undefined) => {
    if (!row || row.kind !== "window") return;
    try {
      const here = currentSessionName();
      if (here && here !== row.sessionName) {
        switchClient(row.sessionName);
      }
      selectWindow(row.windowId);
      // 창만 고르면 마지막으로 보던 pane(사이드바일 때가 많다)이 잡힌다. claude가 도는 pane으로 옮긴다.
      if (row.agentPaneId) selectPane(row.agentPaneId);
      // 직접 들어간 창은 더 이상 자는 창이 아니다. 여기서 풀어주지 않으면 목록 맨 아래 어두운 자리에
      // 지금 보고 있는 창이 남아서, s를 한 번 더 눌러야 제자리로 온다.
      const db = dbRef.current;
      if (db && (row.sleep || row.unread)) {
        const serverKey = serverInfo().startTime;
        if (row.sleep) db.setSleep(serverKey, row.windowId, false);
        // 들어가 본 창은 읽은 창이다.
        if (row.unread) db.setUnread(serverKey, row.windowId, false);
        void tickRef.current();
      }
      // 옮겨갔으면 커서는 할 일이 끝났다. 그 창은 이제 "지금 창"(청록)으로 표시된다.
      setSelectedKey(null);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleSleep = useCallback(() => {
    const db = dbRef.current;
    if (!actionRow || !db) return;
    const server = serverInfo();
    db.setSleep(server.startTime, actionRow.windowId, !actionRow.sleep);
    void tick();
  }, [actionRow, tick]);

  // 지금 볼 여유가 없는 창을 도로 안 읽음으로 돌려놓거나, 표시만 지우고 싶을 때 쓴다.
  const toggleUnread = useCallback(() => {
    const db = dbRef.current;
    if (!actionRow || !db) return;
    db.setUnread(serverInfo().startTime, actionRow.windowId, !actionRow.unread);
    void tick();
  }, [actionRow, tick]);

  const toggleMode = useCallback(() => {
    setMode((m) => {
      const next: ViewMode = m === "recent" ? "group" : "recent";
      saveMode(next);
      return next;
    });
  }, []);

  const submitBranch = useCallback(
    (branch: string) => {
      setBranchInput(null);
      const repo = branchRepoRef.current ?? actionRow?.repoRoot ?? actionRow?.cwd;
      branchRepoRef.current = null;
      if (!branch.trim() || !repo) return;
      try {
        const result = wtNew({ branch: branch.trim(), repo });
        setStatusMsg(`worktree: ${result.path}`);
      } catch (err) {
        setStatusMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [actionRow]
  );

  const startRemove = useCallback(() => {
    if (!actionRow || !actionRow.repoRoot) {
      setStatusMsg("저장소가 아닙니다");
      return;
    }
    if (actionRow.worktreePath === actionRow.repoRoot) {
      setStatusMsg("메인 저장소는 지울 수 없습니다");
      return;
    }
    try {
      const plan = planWtRemove({
        repo: actionRow.repoRoot,
        target: actionRow.worktreePath ?? actionRow.cwd,
        panes: panesRef.current,
      });
      setConfirm({ plan, input: "" });
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }, [actionRow]);

  const executeRemove = useCallback(
    (plan: WtRemovePlan, force: boolean) => {
      setConfirm(null);
      try {
        const here = currentSessionName();
        const killIds = new Set(plan.windows.map((w) => w.windowId));
        // pane 목록은 여기서 한 번만 찍어 wtRemove까지 같은 스냅샷으로 판정한다.
        const panes = listPanes();
        // 세션 이름이 아니라 창 단위로 본다. 대상 창을 죽여도 다른 창이 남는 세션은 살아남는다.
        const alive = sessionsAfterKill(panes, killIds);
        let moveTo: string | undefined;
        if (here && !alive.has(here)) {
          const other = [...alive][0];
          if (!other) {
            setStatusMsg("마지막 창이라 지울 수 없습니다. 다른 세션을 먼저 여세요");
            return;
          }
          // detach-on-destroy 기본값 때문에 자기 세션이 죽으면 클라이언트가 떨어진다.
          // 다만 여기서 바로 옮기면 git이 삭제를 거부했을 때 화면만 엉뚱하게 튄다.
          // 창을 죽이기 직전(beforeKill)에 옮긴다.
          moveTo = other;
        }
        const result = wtRemove(plan, {
          force,
          currentWindowId: currentWindowId ?? undefined,
          beforeKill: moveTo
            ? () => {
                try {
                  switchClient(moveTo);
                } catch {
                  // detach된 세션에서는 옮길 클라이언트가 없다. 여기서 던지면 git이 이미
                  // worktree를 지운 뒤라 창만 남는다.
                }
              }
            : undefined,
          panes,
        });
        const suffix = result.skippedReason ? ` — ${result.skippedReason}` : "";
        setStatusMsg(`removed: ${basename(result.path)} (창 ${result.killedWindows}개)${suffix}`);
      } catch (err) {
        setStatusMsg(err instanceof Error ? err.message : String(err));
      }
      void tick();
    },
    [currentWindowId, tick]
  );

  const openPicker = useCallback(() => {
    const repos = [
      ...new Set([
        ...windowRows.map((r) => r.repoRoot).filter((v): v is string => Boolean(v)),
        ...knownRepos(),
      ]),
    ];
    const items: PickerItem[] = [];
    for (const repo of repos) {
      for (const entry of unopenedWorktrees(listWorktrees(repo), panesRef.current)) {
        items.push({
          label: `${basename(repo)}: ${entry.branch ?? basename(entry.path)}`,
          repoRoot: repo,
          path: entry.path,
        });
      }
      items.push({ label: `${basename(repo)}: + 새 worktree`, repoRoot: repo });
      items.push({ label: `${basename(repo)}: + PR에서 열기`, repoRoot: repo, pr: true });
    }
    // hive가 아직 모르는 저장소로 가는 유일한 입구다. 아는 저장소가 없어도 이 항목은 남는다.
    items.push({ label: "+ 다른 저장소 찾기…" });
    setJumpPrefix(0);
    setPicker({ items, cursor: 0 });
  }, [windowRows]);

  const openPrPicker = useCallback((repoRoot: string) => {
    setJumpPrefix(0);
    setPrPicker({ repoRoot, prs: null, cursor: 0 });
    // 기다리는 사이 사용자가 Esc를 눌렀거나 다른 저장소를 열었을 수 있다. 그때 도착한 응답이
    // 화면을 되살리지 않도록 지금 보고 있는 저장소일 때만 채운다.
    const fill = (patch: { prs: PullRequest[]; error?: string }): void => {
      setPrPicker((cur) => (cur && cur.repoRoot === repoRoot ? { ...cur, ...patch } : cur));
    };
    listPullRequests(repoRoot)
      .then((prs) => fill({ prs }))
      .catch((err) => fill({ prs: [], error: ghErrorMessage(err) }));
  }, []);

  const choosePr = useCallback((repoRoot: string, pr: PullRequest | undefined) => {
    setPrPicker(null);
    setJumpPrefix(0);
    if (!pr) return;
    try {
      const result = wtFromPr({ repoRoot, pr });
      setStatusMsg(
        result.alreadyOpen
          ? `이미 열려 있음: ${result.alreadyOpen}`
          : `#${pr.number}: ${result.branch}`
      );
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const choosePicker = useCallback((item: PickerItem | undefined) => {
    setPicker(null);
    setJumpPrefix(0);
    if (!item) return;
    if (!item.repoRoot) {
      setRepoInput({ text: "~/", cursor: 0 });
      return;
    }
    if (item.pr) {
      openPrPicker(item.repoRoot);
      return;
    }
    if (!item.path) {
      branchRepoRef.current = item.repoRoot;
      setBranchInput("");
      return;
    }
    try {
      const result = wtOpen({ repo: item.repoRoot, target: item.path, panes: panesRef.current });
      setStatusMsg(result.alreadyOpen ? `이미 열려 있음: ${result.alreadyOpen}` : `opened: ${result.sessionName}`);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }, [openPrPicker]);

  // 한 단계만 readdir하므로 입력이 바뀔 때만 다시 읽으면 충분하다.
  const repoCandidates = useMemo<DirCandidate[]>(
    () => (repoInput === null ? [] : listDirCandidates(repoInput.text)),
    [repoInput?.text]
  );

  const chooseRepoPath = useCallback((candidate: DirCandidate | undefined) => {
    if (!candidate) return;
    // 저장소가 아니면 그 안으로 한 단계 내려간다. 저장소면 브랜치를 물어보는 기존 흐름으로 넘긴다.
    if (!candidate.isRepo) {
      setRepoInput({ text: `${collapseHome(candidate.path)}/`, cursor: 0 });
      return;
    }
    setRepoInput(null);
    branchRepoRef.current = candidate.path;
    setBranchInput("");
  }, []);

  // ab-local이 없는 머신에서는 표시 자체를 하지 않는다.
  useEffect(() => {
    if (!abLocalInstalled()) return;
    let raw: string | undefined;
    try {
      raw = readFileSync(abConfigPath(), "utf8");
    } catch {
      // 설정 파일이 없으면 ab-bridge 기본값으로 돈다.
    }
    const cfg = parseAbConfig(raw);
    let inFlight = false;
    const probe = () => {
      if (inFlight) return;
      inFlight = true;
      probeAbBridge(cfg)
        .then((r) => setAb(r.status))
        .catch(() => setAb("down"))
        .finally(() => {
          inFlight = false;
        });
    };
    probe();
    const timer = setInterval(probe, AB_PROBE_MS);
    return () => clearInterval(timer);
  }, []);

  // 뷰가 꺼져 있으면 파일을 전혀 읽지 않는다.
  useEffect(() => {
    if (!showUsage) return;
    const refresh = () => {
      setUsage([readClaudeUsage(), readCodexUsage()].filter((u): u is AgentUsage => u !== null));
    };
    refresh();
    const timer = setInterval(refresh, USAGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [showUsage]);

  // ink는 증분 렌더를 하면서 "커서가 이전 프레임의 마지막 줄에 있다"고 가정하고 cursorUp으로
  // 거슬러 올라간다. 리사이즈로 화면이 접히거나 밀리면 그 가정이 깨져 프레임이 계속 아래에 쌓인다.
  // 그래서 화면을 지우고 ink가 기대하는 자리에 커서를 놓은 뒤, 모든 줄을 다시 쓰게 만든다.
  const forceRedraw = useCallback(() => {
    const height = process.stdout.rows || 24;
    const row = Math.min(Math.max(1, frameLinesRef.current), height);
    process.stdout.write(`\x1b[2J\x1b[${row};1H`);
    setRedraw((v) => v + 1);
  }, []);

  useEffect(() => {
    const onResize = () => forceRedraw();
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, [forceRedraw]);

  // 마우스 핸들러가 매 렌더 새로 만들어지는 rows/콜백을 직접 잡으면 리스너를 떼고 붙이게 된다.
  // 등록 이펙트는 stdin에만 의존시키고 최신 값은 ref로 읽는다.
  // 한 window가 두 줄을 차지해서 "화면 줄 번호 - 헤더 수"로는 행을 못 찾는다.
  // 렌더할 때 만든 줄별 row 배열을 그대로 클릭 판정에 쓴다.
  const lineRowsRef = useRef<(Row | null)[]>([]);
  const mouseDepsRef = useRef({ moveSelection, activateRow, modalOpen: false });
  useEffect(() => {
    mouseDepsRef.current = {
      moveSelection,
      activateRow,
      modalOpen:
        confirm !== null ||
        picker !== null ||
        branchInput !== null ||
        repoInput !== null ||
        prPicker !== null,
    };
  });

  // 마우스 모드 on/off는 마운트/언마운트에서 한 번씩만 한다.
  // rows를 의존성에 두면 1초 tick마다 \x1b[?1000;1006h/l이 다시 나가면서
  // 그 사이 클릭이 pane으로 전달되지 않고 tmux 기본 바인딩으로 샌다.
  useEffect(() => {
    if (!stdin || !isRawModeSupported) return;
    process.stdout.write("\x1b[?1000;1006h");
    return () => {
      process.stdout.write("\x1b[?1000;1006l");
    };
  }, [stdin, isRawModeSupported]);

  // 클릭으로 선택+이동, 휠로 스크롤. SGR 시퀀스는 useInput이 아닌 stdin 'data'에서 직접 파싱한다(실측).
  useEffect(() => {
    if (!stdin || !isRawModeSupported) return;
    const onData = (chunk: Buffer | string) => {
      // 확인창·선택창·브랜치 입력이 떠 있으면 마우스도 삼킨다. 키는 각 모드에서 막고 있는데
      // 여기만 새면 가려진 목록의 커서가 움직이고, 클릭 한 번에 다른 세션으로 옮겨간 채
      // 삭제 확인창만 그대로 남는다.
      if (mouseDepsRef.current.modalOpen) return;
      const str = chunk.toString();
      const re = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(str))) {
        const btn = Number(m[1]);
        const tmuxRow = Number(m[3]);
        const isRelease = m[4] === "m";
        const deps = mouseDepsRef.current;
        if (btn === 64) {
          deps.moveSelection(-1);
        } else if (btn === 65) {
          deps.moveSelection(1);
        } else if (btn === 0 && !isRelease) {
          const row = lineRowsRef.current[tmuxRow - 1];
          if (row && row.kind === "window") {
            setSelectedKey(row.key);
            deps.activateRow(row);
          }
        }
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin, isRawModeSupported]);

  useInput((input, key) => {
    if (input.startsWith("[<")) return; // 마우스 시퀀스, 위 stdin 리스너가 처리

    // ink는 Ctrl+letter를 input="l" + key.ctrl로 넘긴다. 아래 세 모드는 남은 입력을 전부
    // 삼키므로 여기서 먼저 잡지 않으면 프레임이 깨졌을 때 다시 그릴 방법이 없다.
    // (확인창에서는 "l"이 yes 버퍼에 섞이거나 창이 닫혔다.)
    if (key.ctrl && input === "l") {
      forceRedraw();
      return;
    }

    if (confirm !== null) {
      if (key.escape) setConfirm(null);
      else if (confirm.plan.changes === 0) {
        if (input === "y") executeRemove(confirm.plan, false);
        else setConfirm(null);
      } else if (key.return) {
        if (confirm.input === "yes") executeRemove(confirm.plan, true);
        else setConfirm(null);
      } else if (key.backspace || key.delete) {
        setConfirm((c) => (c ? { ...c, input: c.input.slice(0, -1) } : c));
      } else if (input) {
        setConfirm((c) => (c ? { ...c, input: c.input + input } : c));
      }
      return;
    }

    if (picker !== null) {
      const count = picker.items.length;
      if (key.escape) setPicker(null);
      else if (input === "j" || key.downArrow) setPicker((p) => (p ? { ...p, cursor: (p.cursor + 1) % count } : p));
      else if (input === "k" || key.upArrow)
        setPicker((p) => (p ? { ...p, cursor: (p.cursor - 1 + count) % count } : p));
      else if (input === JUMP_PREFIX && !key.ctrl) setJumpPrefix((n) => n + 1);
      else if (/^[1-9]$/.test(input)) choosePicker(picker.items[jumpIndex(jumpPrefix, Number(input))]);
      else if (key.return) choosePicker(picker.items[picker.cursor]);
      else if (jumpPrefix > 0) setJumpPrefix(0);
      return;
    }

    if (prPicker !== null) {
      const prs = prPicker.prs;
      // 아직 못 받았거나 고를 게 없으면 옮길 커서도 없다. 그래도 다른 키는 삼켜야
      // 가려진 목록이 뒤에서 움직이지 않는다.
      if (key.escape) setPrPicker(null);
      else if (prs === null || prs.length === 0) {
        if (jumpPrefix > 0) setJumpPrefix(0);
      } else if (input === "j" || key.downArrow)
        setPrPicker((p) => (p ? { ...p, cursor: (p.cursor + 1) % prs.length } : p));
      else if (input === "k" || key.upArrow)
        setPrPicker((p) => (p ? { ...p, cursor: (p.cursor - 1 + prs.length) % prs.length } : p));
      else if (input === JUMP_PREFIX && !key.ctrl) setJumpPrefix((n) => n + 1);
      else if (/^[1-9]$/.test(input))
        choosePr(prPicker.repoRoot, prs[jumpIndex(jumpPrefix, Number(input))]);
      else if (key.return) choosePr(prPicker.repoRoot, prs[prPicker.cursor]);
      else if (jumpPrefix > 0) setJumpPrefix(0);
      return;
    }

    // 타이핑으로 걸러야 해서 j/k를 커서로 못 쓴다. 방향키와 Tab, Ctrl-n/p로 옮긴다.
    if (repoInput !== null) {
      const count = repoCandidates.length;
      const move = (d: number) =>
        setRepoInput((r) => (r && count > 0 ? { ...r, cursor: (r.cursor + d + count) % count } : r));
      // 입력이 바뀌면 후보가 통째로 달라지므로 커서를 맨 위로 되돌린다.
      const retype = (text: string) => setRepoInput((r) => (r ? { text, cursor: 0 } : r));
      if (key.escape) setRepoInput(null);
      else if (key.return) chooseRepoPath(repoCandidates[repoInput.cursor]);
      else if (key.upArrow || (key.tab && key.shift) || (key.ctrl && input === "p")) move(-1);
      else if (key.downArrow || key.tab || (key.ctrl && input === "n")) move(1);
      else if (key.backspace || key.delete) retype(repoInput.text.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) retype(repoInput.text + input);
      return;
    }

    if (branchInput !== null) {
      if (key.return) submitBranch(branchInput);
      else if (key.escape) {
        branchRepoRef.current = null;
        setBranchInput(null);
      } else if (key.backspace || key.delete) setBranchInput((s) => (s ?? "").slice(0, -1));
      else if (input) setBranchInput((s) => (s ?? "") + input);
      return;
    }

    // 아홉 개를 넘는 목록은 l을 쌓아 그 다음 아홉 칸으로 넘어간다. l9 다음이 ll1이다.
    if (input === JUMP_PREFIX && !key.ctrl) {
      setJumpPrefix((n) => n + 1);
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const target = windowRows[jumpIndex(jumpPrefix, Number(input))];
      setJumpPrefix(0);
      if (target) {
        setSelectedKey(target.key);
        activateRow(target);
      }
      return;
    }
    // 쌓다가 엉뚱한 키를 누르면 접두사만 버리고 그 키는 흘린다.
    if (jumpPrefix > 0) {
      setJumpPrefix(0);
      return;
    }

    if (input === "j" || key.downArrow) moveSelection(1);
    else if (input === "k" || key.upArrow) moveSelection(-1);
    else if (key.return) activateRow(actionRow);
    else if (input === "s") toggleSleep();
    else if (input === "m") toggleUnread();
    else if (input === "g") toggleMode();
    else if (input === "r") void tick();
    else if (input === "n") setBranchInput("");
    else if (input === "o") openPicker();
    else if (input === "p") {
      // worktree 안에서 눌러도 PR은 저장소 쪽에서 받아온다.
      const repo = actionRow?.repoRoot;
      if (repo) openPrPicker(repo);
      else setStatusMsg("저장소를 알 수 없습니다");
    }
    else if (input === "D") startRemove();
    else if (input === "u") setShowUsage((v) => !v);
    else if (input === "?") setShowHelp((v) => !v);
    else if (input === "q") {
      cleanupFromTui();
      exit();
    }
  });

  const cols = columns || SIDEBAR_WIDTH;
  const height = termRows || 24;
  // ink는 이전과 같은 줄은 다시 쓰지 않는다. 강제 다시 그리기로 화면을 지운 뒤에도 그러면
  // 지워진 자리가 빈 채로 남는다. 그래서 모든 줄을 "바뀐 줄"로 만들어야 한다.
  // 끝에 공백을 붙였다 뗐다 하되 자르는 폭도 같이 줄여서, 줄 폭은 그대로 둔다.
  // 폭 0짜리 문자를 쓰면 터미널에 따라 네모로 보일 수 있어 쓰지 않는다.
  const pad = redraw % 2;
  const tail = pad ? " " : "";
  const width = cols - 1 - pad;

  // 목록 줄과 그 줄이 가리키는 row를 같이 만든다. lineRows는 클릭 판정에 쓴다.
  const body: { el: React.JSX.Element; row: Row | null }[] = [];
  const pushLine = (el: React.JSX.Element, row: Row | null): void => {
    body.push({ el, row });
  };

  const agentKinds = new Set(windowRows.map((r) => r.agent).filter(Boolean));
  const showGlyph = !(HIDE_GLYPH_WHEN_UNIFORM && agentKinds.size <= 1);

  // 라벨이 길어지면 앞 항목도 같이 밀어 열을 맞춘다. 아홉 개까지는 지금처럼 한 글자다.
  const jumpWidth = jumpLabelWidth(windowRows.length);
  let ordinal = 0;
  for (const row of rows) {
    const indent = "  ".repeat(row.depth);
    if (row.kind === "divider") {
      // 잠자는 묶음은 위에 가로줄을 그어 확실히 끊어준다.
      const label = ` ${row.name} `;
      const rule = "─".repeat(Math.max(0, cols - stringWidth(label) - 2));
      pushLine(
        <Text key={row.key} dimColor wrap="truncate-end">
          {clip(`─${label}${rule}`, width) + tail}
        </Text>,
        null
      );
      continue;
    }
    if (row.kind === "group") {
      pushLine(
        <Text key={row.key} bold={row.depth === 0} dimColor wrap="truncate-end">
          {clip(` ${indent}${row.name}`, width) + tail}
        </Text>,
        null
      );
      continue;
    }
    ordinal += 1;
    const isSelected = row.key === selectedKey;
    const isCurrent = row.windowId === currentWindowId;
    const spinning = row.state === "working" && !row.sleep;
    const icon = (row.sleep ? "z" : "") + (spinning ? SPINNER[frame % SPINNER.length] : STATE_ICON[row.state]);
    const num = jumpLabel(ordinal - 1).padStart(jumpWidth);
    // claude가 pane 제목에 쓰는 "지금 하는 일"이 가장 최신이라 그걸 먼저 쓴다.
    // 없으면 직접 붙인 창 이름 → 세션 첫 입력 → 어느 tmux 세션의 몇 번 창인지 순으로 내려간다.
    const label =
      row.liveTitle ??
      (row.autoName ? row.title ?? `${row.sessionName}:${row.windowIndex}` : row.name);
    // 어느 쪽도 아니면 자리만 비워 아이콘 열을 맞춘다. 종류가 하나뿐이면 열 자체가 사라진다.
    const agentTag = showGlyph
      ? row.agent
        ? `${AGENT_GLYPH[row.agent]} `
        : " ".repeat(AGENT_GLYPH_WIDTH + 1)
      : "";
    const barColor = isSelected ? SELECT_COLOR : isCurrent ? CURRENT_COLOR : undefined;
    // 안 읽음 막대는 오른쪽 끝에 붙인다. 그 자리와 최소 여백 한 칸을 본문에서 미리 뺀다.
    const bodyWidth = row.unread ? Math.max(0, width - 2) : width;
    const text = clip(`${indent}${num} ${agentTag}${icon} ${label}`, bodyWidth);
    const unreadPad = " ".repeat(Math.max(0, width - stringWidth(text) - 1));

    pushLine(
      <Text key={row.key} wrap="truncate-end">
        <Text color={barColor} dimColor={!barColor}>
          {barColor ? BAR : RAIL}
        </Text>
        <Text
          bold={isCurrent}
          dimColor={row.sleep}
          color={row.sleep ? undefined : STATE_COLOR[row.state]}
        >
          {text}
        </Text>
        {row.unread ? (
          <Text dimColor={row.sleep} color={row.sleep ? undefined : STATE_COLOR[row.state]}>
            {unreadPad + UNREAD_BAR}
          </Text>
        ) : null}
        <Text>{tail}</Text>
      </Text>,
      row
    );

    // 어느 워크트리의 창인지는 제목 아래에 붙인다. 클릭 판정에서 같은 row를 가리키므로
    // 두 줄 어디를 눌러도 그 창으로 간다.
    pushLine(
      <Text key={`${row.key}:wt`} wrap="truncate-end">
        <Text color={barColor} dimColor={!barColor}>
          {barColor ? BAR : RAIL}
        </Text>
        <Text dimColor>{clip(`${indent}  ${row.worktreeLabel}`, width) + tail}</Text>
      </Text>,
      row
    );
  }

  const footer: React.JSX.Element[] = [];
  if (branchInput !== null) {
    footer.push(
      <Text key="branch" wrap="truncate-end">
        branch: {branchInput}
        {tail}
      </Text>
    );
  }
  if (confirm !== null) {
    const { plan } = confirm;
    footer.push(
      <Text key="confirm" color="red" wrap="truncate-end">
        {clip(
          `rm ${basename(plan.entry.path)} (${plan.entry.branch ?? "detached"})  창 ${plan.windows.length}개 닫힘`,
          width
        ) + tail}
      </Text>
    );
    footer.push(
      <Text key="confirm-input" wrap="truncate-end">
        {clip(
          plan.changes === 0
            ? "지우려면 y, 취소 Esc"
            : `변경 ${plan.changes}개 있음. 지우려면 yes 입력: ${confirm.input}`,
          width
        ) + tail}
      </Text>
    );
  }
  if (picker !== null) {
    footer.push(
      <Text key="picker" wrap="truncate-end">
        {clip("열기 (j/k Enter, Esc 취소)", width) + tail}
      </Text>
    );
    const pickerJumpWidth = jumpLabelWidth(picker.items.length);
    picker.items.forEach((item, i) => {
      const selected = i === picker.cursor;
      const num = jumpLabel(i).padStart(pickerJumpWidth);
      footer.push(
        <Text key={`picker:${i}`} wrap="truncate-end">
          <Text color={selected ? SELECT_COLOR : undefined}>{selected ? BAR : " "}</Text>
          <Text dimColor={!selected}>{clip(`${num} ${item.label}`, width - 1) + tail}</Text>
        </Text>
      );
    });
  }
  if (prPicker !== null) {
    footer.push(
      <Text key="pr" wrap="truncate-end">
        {clip(`PR ${basename(prPicker.repoRoot)} (j/k Enter, Esc 취소)`, width) + tail}
      </Text>
    );
    if (prPicker.error) {
      footer.push(
        <Text key="pr:error" color="red" wrap="truncate-end">
          {clip(`  ${prPicker.error}`, width - 1) + tail}
        </Text>
      );
    } else if (prPicker.prs === null) {
      footer.push(
        <Text key="pr:loading" dimColor wrap="truncate-end">
          {clip("  gh에 물어보는 중…", width - 1) + tail}
        </Text>
      );
    } else if (prPicker.prs.length === 0) {
      footer.push(
        <Text key="pr:none" dimColor wrap="truncate-end">
          {clip("  열린 PR이 없습니다 (Esc 취소)", width - 1) + tail}
        </Text>
      );
    } else {
      const prJumpWidth = jumpLabelWidth(prPicker.prs.length);
      const from = sliceStart(prPicker.cursor, prPicker.prs.length, PR_CANDIDATE_MAX);
      for (const [offset, pr] of prPicker.prs.slice(from, from + PR_CANDIDATE_MAX).entries()) {
        const index = from + offset;
        const selected = index === prPicker.cursor;
        const num = jumpLabel(index).padStart(prJumpWidth);
        footer.push(
          <Text key={`pr:${pr.number}`} wrap="truncate-end">
            <Text color={selected ? SELECT_COLOR : undefined}>{selected ? BAR : " "}</Text>
            <Text dimColor={!selected}>{clip(`${num} ${prLabel(pr)}`, width - 1) + tail}</Text>
          </Text>
        );
      }
    }
  }
  if (jumpPrefix > 0) {
    footer.push(
      <Text key="jump" wrap="truncate-end">
        {clip(`jump: ${JUMP_PREFIX.repeat(jumpPrefix)}`, width) + tail}
      </Text>
    );
  }
  if (repoInput !== null) {
    footer.push(
      <Text key="repo" wrap="truncate-end">
        {clip(`repo: ${repoInput.text}`, width) + tail}
      </Text>
    );
    if (repoCandidates.length === 0) {
      footer.push(
        <Text key="repo:none" dimColor wrap="truncate-end">
          {clip("  없음 (Esc 취소)", width) + tail}
        </Text>
      );
    }
    const from = sliceStart(repoInput.cursor, repoCandidates.length, REPO_CANDIDATE_MAX);
    for (const [offset, cand] of repoCandidates.slice(from, from + REPO_CANDIDATE_MAX).entries()) {
      const selected = from + offset === repoInput.cursor;
      // 저장소면 Enter가 곧 선택이고, 아니면 그 안으로 내려간다는 뜻으로 슬래시를 붙인다.
      const suffix = cand.isRepo ? "  ● git" : "/";
      footer.push(
        <Text key={`repo:${cand.path}`} wrap="truncate-end">
          <Text color={selected ? SELECT_COLOR : undefined}>{selected ? BAR : " "}</Text>
          <Text dimColor={!selected} color={selected ? undefined : cand.isRepo ? CURRENT_COLOR : undefined}>
            {clip(`${cand.name}${suffix}`, width - 1) + tail}
          </Text>
        </Text>
      );
    }
  }
  // 개행이 섞인 메시지는 한 <Text>가 두 줄로 렌더돼 frameLinesRef 계산이 어긋난다.
  // 폭 안에 확실히 들어가게 clip까지 거친다.
  const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
  if (statusMsg) {
    footer.push(
      <Text key="status" dimColor wrap="truncate-end">
        {clip(oneLine(statusMsg), width) + tail}
      </Text>
    );
  }
  if (error) {
    footer.push(
      <Text key="error" color="red" wrap="truncate-end">
        {clip(`error: ${oneLine(error)}`, width) + tail}
      </Text>
    );
  }
  if (showUsage) {
    for (const [i, line] of formatUsageLines(usage, Date.now(), width).entries()) {
      footer.push(
        <Text key={`usage:${i}`} color={line.color} dimColor={!line.color} wrap="truncate-end">
          {line.text}
          {tail}
        </Text>
      );
    }
  }
  if (showHelp) {
    for (const line of HELP_LINES) {
      footer.push(
        <Text key={`help:${line}`} dimColor wrap="truncate-end">
          {(line || BLANK_LINE) + tail}
        </Text>
      );
    }
  }

  // 프레임이 pane보다 길면 화면이 스크롤되고, 그때부터 ink는 지울 줄을 못 찾아 프레임을 계속
  // 아래에 덧붙인다(리사이즈를 반복하면 "sort: group"이 여러 개 쌓인다). 그래서 pane 안에 가둔다.
  // 도움말을 펼치면 꼬리말만으로 pane을 넘길 수 있다. 꼬리말도 잘라야 프레임이 pane 안에 남는다.
  const shownFooter = footer.slice(0, Math.max(0, height - 2));
  // 0까지 허용해야 한다. 1을 하한으로 두면 pane이 한 줄일 때 머리글 + 한 줄로 한 줄 넘친다.
  const budget = Math.max(0, height - 1 - shownFooter.length);
  const anchorKey = selectedKey ?? rows.find((r) => r.windowId === currentWindowId)?.key ?? null;
  const anchor = anchorKey === null ? -1 : body.findIndex((l) => l.row?.key === anchorKey);
  let start = Math.min(scrollRef.current, Math.max(0, body.length - budget));
  if (anchor >= 0) {
    if (anchor < start) start = anchor;
    else if (anchor >= start + budget) start = anchor - budget + 1;
  }
  start = Math.max(0, start);
  scrollRef.current = start;

  const visible = body.slice(start, start + budget);
  const above = start;
  const below = Math.max(0, body.length - start - budget);

  // 상태바는 목록 길이와 상관없이 pane 맨 아래에 있어야 눈이 한 자리만 보면 된다.
  // 목록이 짧으면 그만큼 빈 줄로 밀어 내린다.
  const filler = Math.max(0, budget - visible.length);

  // 클릭 판정용. 이제 목록이 프레임 첫 줄부터 시작한다.
  lineRowsRef.current = visible.map((l) => l.row);
  frameLinesRef.current = visible.length + filler + shownFooter.length + 1;

  const segments = fitSegments(statusSegments({ mode, above, below, ab, showHelp }), width);

  return (
    <Box flexDirection="column" width="100%">
      {visible.map((l) => l.el)}
      {Array.from({ length: filler }, (_, i) => (
        <Text key={`filler:${i}`}>{BLANK_LINE + tail}</Text>
      ))}
      {shownFooter}
      <Text wrap="truncate-end">
        {segments.map((seg, i) => (
          <Text key={seg.key}>
            {i > 0 ? <Text dimColor>{STATUS_SEP}</Text> : null}
            <Text
              color={seg.color}
              backgroundColor={seg.backgroundColor}
              bold={seg.bold}
              dimColor={seg.dim}
            >
              {seg.text}
            </Text>
          </Text>
        ))}
        {tail}
      </Text>
    </Box>
  );
}
