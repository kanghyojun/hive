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
  "Ctrl-L 화면 다시 그리기",
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
  const { columns, rows: termRows } = useWindowSize();

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
      if (!branch.trim() || !actionRow) return;
      try {
        const result = wtNew({ branch: branch.trim(), repo: actionRow.repoRoot ?? actionRow.cwd });
        setStatusMsg(`worktree: ${result.path}`);
      } catch (err) {
        setStatusMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [actionRow]
  );

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
    else if (key.return) activateRow(actionRow);
    else if (input === "s") toggleSleep();
    else if (input === "g") toggleMode();
    else if (input === "r") void tick();
    else if (input === "n") setBranchInput("");
    else if (input === "?") setShowHelp((v) => !v);
    else if (key.ctrl && input === "l") forceRedraw();
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
          {clip(`${indent}${num} ${icon} ${label}`, width) + tail}
        </Text>
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
  if (statusMsg) {
    footer.push(
      <Text key="status" dimColor wrap="truncate-end">
        {statusMsg}
        {tail}
      </Text>
    );
  }
  if (error) {
    footer.push(
      <Text key="error" color="red" wrap="truncate-end">
        error: {error}
        {tail}
      </Text>
    );
  }
  if (showHelp) {
    for (const line of HELP_LINES) {
      footer.push(
        <Text key={`help:${line}`} dimColor wrap="truncate-end">
          {line}
          {tail}
        </Text>
      );
    }
  } else {
    footer.push(
      <Text key="help" dimColor wrap="truncate-end">
        ? help
        {tail}
      </Text>
    );
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
  const scrollHint = `${above > 0 ? ` ↑${above}` : ""}${below > 0 ? ` ↓${below}` : ""}`;

  // 클릭 판정용. 0번은 머리글 줄이다.
  lineRowsRef.current = [null, ...visible.map((l) => l.row)];
  frameLinesRef.current = 1 + visible.length + shownFooter.length;

  return (
    <Box flexDirection="column" width="100%">
      <Text bold wrap="truncate-end">
        {clip(`sort: ${mode}${scrollHint}`, width) + tail}
      </Text>
      {visible.map((l) => l.el)}
      {shownFooter}
    </Box>
  );
}
