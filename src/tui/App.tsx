import { readFileSync, writeFileSync } from "node:fs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from "ink";
import { openDb, type Db } from "../db.js";
import { ingestAll } from "../spool.js";
import { reduceAgent, looksLikePermissionPrompt, type AgentState } from "../state.js";
import { resolveRepo, type RepoInfo } from "../git.js";
import { buildRows, type Row, type ViewMode } from "../model.js";
import {
  capturePaneTail,
  listPanes,
  selectWindow,
  serverInfo,
  switchClient,
  currentSessionName,
  selectPane,
  currentPaneId,
} from "../tmux.js";
import stringWidth from "string-width";
import { cleanupFromTui, SIDEBAR_WIDTH } from "../sidebar.js";
import { wtNew } from "../worktree.js";
import { dbPath, spoolDir, uiStatePath, ensureDirs } from "../paths.js";

const TICK_MS = 1000;
const SCREEN_CHECK_MS = 3000;
const SCREEN_TAIL_LINES = 25;

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
// 지금 보고 있는 창이 주인공이라 진한 청록, 옮겨다니는 커서는 그보다 옅은 회색으로 둔다.
const SELECT_COLOR = "gray";
const CURRENT_COLOR = "cyan";
const JUMP_MAX = 9;

const HELP_LINES = [
  "j/k    위/아래",
  "1-9    번호로 바로 이동",
  "Enter  해당 window로",
  "s      sleep 토글",
  "g      recent/group",
  "n      worktree 생성",
  "r      새로고침",
  "?      도움말 닫기",
  "q      종료",
  "",
  "▌ 청록=지금 창  회색=커서",
  "+ 는 따로 판 워크트리",
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
  const { columns } = useWindowSize();

  const dbRef = useRef<Db | null>(null);
  const screenWaitingRef = useRef<Set<string>>(new Set());
  const lastScreenCheckRef = useRef(0);

  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<ViewMode>(() => loadMode());
  // 인덱스가 아니라 key로 들고 있어야 tick마다 정렬이 바뀌어도 선택이 다른 window로 미끄러지지 않는다.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [frame, setFrame] = useState(0);
  // 사이드바가 들어 있는 창이 곧 지금 보고 있는 창이다. 선택 커서와 헷갈리지 않게 따로 표시한다.
  const [currentWindowId, setCurrentWindowId] = useState<string | null>(null);

  const repoCacheRef = useRef(new Map<string, RepoInfo | null>());

  const tick = useCallback(async () => {
    try {
      const db = dbRef.current;
      if (!db) return;

      ingestAll(db, spoolDir(), reduceAgent);

      const panes = listPanes();
      const server = serverInfo();
      const liveWindowIds = [...new Set(panes.map((p) => p.windowId))];
      db.pruneWindowFlags(server.startTime, liveWindowIds);

      const now = Date.now();
      if (now - lastScreenCheckRef.current > SCREEN_CHECK_MS) {
        lastScreenCheckRef.current = now;
        const nextWaiting = new Set<string>();
        for (const pane of panes) {
          if (pane.paneCurrentCommand !== "claude") continue;
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

      const nextRows = buildRows({
        panes,
        agents: db.listAgents(),
        repoByCwd,
        sleepMap: db.getSleepMap(server.startTime),
        now,
        mode: savedMode,
        tmuxPid: server.pid,
        screenWaitingPanes: screenWaitingRef.current,
      });

      const myPane = currentPaneId();
      setCurrentWindowId(panes.find((p) => p.paneId === myPane)?.windowId ?? null);

      setRows(nextRows);
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

  const selectedRow = rows.find((r) => r.key === selectedKey);

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
      // 옮겨갔으면 커서는 할 일이 끝났다. 그 창은 이제 "지금 창"(청록)으로 표시된다.
      setSelectedKey(null);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleSleep = useCallback(() => {
    const db = dbRef.current;
    if (!selectedRow || selectedRow.kind !== "window" || !db) return;
    const server = serverInfo();
    db.setSleep(server.startTime, selectedRow.windowId, !selectedRow.sleep);
    void tick();
  }, [selectedRow, tick]);

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
      if (!branch.trim() || !selectedRow) return;
      try {
        const result = wtNew({ branch: branch.trim(), repo: selectedRow.repoRoot ?? selectedRow.cwd });
        setStatusMsg(`worktree: ${result.path}`);
      } catch (err) {
        setStatusMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedRow]
  );

  // 마우스 핸들러가 매 렌더 새로 만들어지는 rows/콜백을 직접 잡으면 리스너를 떼고 붙이게 된다.
  // 등록 이펙트는 stdin에만 의존시키고 최신 값은 ref로 읽는다.
  // 한 window가 두 줄을 차지해서 "화면 줄 번호 - 헤더 수"로는 행을 못 찾는다.
  // 렌더할 때 만든 줄별 row 배열을 그대로 클릭 판정에 쓴다.
  const lineRowsRef = useRef<(Row | null)[]>([]);
  const mouseDepsRef = useRef({ moveSelection, activateRow });
  useEffect(() => {
    mouseDepsRef.current = { moveSelection, activateRow };
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

    if (branchInput !== null) {
      if (key.return) submitBranch(branchInput);
      else if (key.escape) setBranchInput(null);
      else if (key.backspace || key.delete) setBranchInput((s) => (s ?? "").slice(0, -1));
      else if (input) setBranchInput((s) => (s ?? "") + input);
      return;
    }

    if (/^[1-9]$/.test(input)) {
      const target = windowRows[Number(input) - 1];
      if (target) {
        setSelectedKey(target.key);
        activateRow(target);
      }
      return;
    }

    if (input === "j" || key.downArrow) moveSelection(1);
    else if (input === "k" || key.upArrow) moveSelection(-1);
    else if (key.return) activateRow(selectedRow);
    else if (input === "s") toggleSleep();
    else if (input === "g") toggleMode();
    else if (input === "r") void tick();
    else if (input === "n") setBranchInput("");
    else if (input === "?") setShowHelp((v) => !v);
    else if (input === "q") {
      cleanupFromTui();
      exit();
    }
  });

  const cols = columns || SIDEBAR_WIDTH;

  // 화면에 그릴 줄과 그 줄이 가리키는 row를 같이 만든다. lineRows는 클릭 판정에 쓴다.
  const lines: React.JSX.Element[] = [];
  const lineRows: (Row | null)[] = [];
  const pushLine = (el: React.JSX.Element, row: Row | null): void => {
    lines.push(el);
    lineRows.push(row);
  };

  pushLine(
    <Text key="header" bold wrap="truncate-end">
      {clip(`sort: ${mode}`, cols)}
    </Text>,
    null
  );

  let ordinal = 0;
  for (const row of rows) {
    const indent = "  ".repeat(row.depth);
    if (row.kind === "divider") {
      // 잠자는 묶음은 위에 가로줄을 그어 확실히 끊어준다.
      const label = ` ${row.name} `;
      const rule = "─".repeat(Math.max(0, cols - stringWidth(label) - 2));
      pushLine(
        <Text key={row.key} dimColor wrap="truncate-end">
          {clip(`─${label}${rule}`, cols)}
        </Text>,
        null
      );
      continue;
    }
    if (row.kind === "group") {
      pushLine(
        <Text key={row.key} bold={row.depth === 0} dimColor wrap="truncate-end">
          {clip(` ${indent}${row.name}`, cols)}
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
    // 숫자 키로 바로 갈 수 있는 건 앞에서 9개까지다. 그 뒤로는 자리만 비워 열을 맞춘다.
    const num = ordinal <= JUMP_MAX ? String(ordinal) : " ";
    // claude가 pane 제목에 쓰는 "지금 하는 일"이 가장 최신이라 그걸 먼저 쓴다.
    // 없으면 직접 붙인 창 이름 → 세션 첫 입력 → 어느 tmux 세션의 몇 번 창인지 순으로 내려간다.
    const label =
      row.liveTitle ??
      (row.autoName ? row.title ?? `${row.sessionName}:${row.windowIndex}` : row.name);
    const barColor = isSelected ? SELECT_COLOR : isCurrent ? CURRENT_COLOR : undefined;

    pushLine(
      <Text key={row.key} wrap="truncate-end">
        <Text color={barColor}>{barColor ? BAR : " "}</Text>
        <Text
          bold={isCurrent}
          dimColor={row.sleep}
          color={row.sleep ? undefined : STATE_COLOR[row.state]}
        >
          {clip(`${indent}${num} ${icon} ${label}`, cols - 1)}
        </Text>
      </Text>,
      row
    );
  }
  lineRowsRef.current = lineRows;

  return (
    <Box flexDirection="column" width="100%">
      {lines}
      {branchInput !== null && <Text wrap="truncate-end">branch: {branchInput}</Text>}
      {statusMsg && (
        <Text dimColor wrap="truncate-end">
          {statusMsg}
        </Text>
      )}
      {error && (
        <Text color="red" wrap="truncate-end">
          error: {error}
        </Text>
      )}
      {showHelp ? (
        HELP_LINES.map((line) => (
          <Text key={line} dimColor wrap="truncate-end">
            {line}
          </Text>
        ))
      ) : (
        <Text dimColor>? help</Text>
      )}
    </Box>
  );
}
