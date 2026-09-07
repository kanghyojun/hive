import { readFileSync, writeFileSync } from "node:fs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from "ink";
import { openDb, type Db } from "../db.js";
import { ingestAll } from "../spool.js";
import { reduceAgent, looksLikePermissionPrompt, AGENT_LABEL, type AgentKind, type AgentState } from "../state.js";
import { resolveRepo, type RepoInfo } from "../git.js";
import { buildRows, resolvePaneAgents, type Row, type ViewMode } from "../model.js";
import {
  capturePaneTail,
  listPanes,
  listProcesses,
  selectWindow,
  serverInfo,
  switchClient,
  currentSessionName,
} from "../tmux.js";
import { cleanupFromTui } from "../sidebar.js";
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
  working: "green",
  waiting: "yellow",
  done: undefined,
  idle: "gray",
  unknown: undefined,
};

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
  // ps 전체 조회는 1초 tick마다 돌릴 만큼 싸지 않아서 화면 확인과 같은 주기로 갱신한다.
  const paneAgentsRef = useRef<Map<string, AgentKind>>(new Map());

  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<ViewMode>(() => loadMode());
  // 인덱스가 아니라 key로 들고 있어야 tick마다 정렬이 바뀌어도 선택이 다른 window로 미끄러지지 않는다.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

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

      const nextRows = buildRows({
        panes,
        agents: db.listAgents(),
        repoByCwd,
        sleepMap: db.getSleepMap(server.startTime),
        agentByPane: paneAgentsRef.current,
        now,
        mode,
        tmuxPid: server.pid,
        screenWaitingPanes: screenWaitingRef.current,
      });

      setRows(nextRows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [mode]);

  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    ensureDirs();
    openDb(dbPath())
      .then((db) => {
        dbRef.current = db;
        void tick();
        timer = setInterval(() => void tick(), TICK_MS);
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
  const selectedRow = rows.find((r) => r.key === selectedKey);

  // 선택한 window가 사라졌거나 아직 아무것도 안 골랐으면 첫 window로 돌려놓는다.
  useEffect(() => {
    if (windowRows.length === 0) return;
    if (selectedKey !== null && windowRows.some((r) => r.key === selectedKey)) return;
    setSelectedKey(windowRows[0].key);
  }, [windowRows, selectedKey]);

  const moveSelection = useCallback(
    (delta: number) => {
      if (windowRows.length === 0) return;
      const current = windowRows.findIndex((r) => r.key === selectedKey);
      const base = current === -1 ? 0 : current;
      const next = (base + delta + windowRows.length) % windowRows.length;
      setSelectedKey(windowRows[next].key);
    },
    [windowRows, selectedKey]
  );

  const activateRow = useCallback((row: Row | undefined) => {
    if (!row || row.kind !== "window") return;
    try {
      const here = currentSessionName();
      if (here && here !== row.sessionName) {
        switchClient(row.sessionName);
      }
      selectWindow(row.windowId);
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
  const mouseDepsRef = useRef({ rows, moveSelection, activateRow });
  useEffect(() => {
    mouseDepsRef.current = { rows, moveSelection, activateRow };
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
    const headerLines = 2;
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
          const row = deps.rows[tmuxRow - headerLines - 1];
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

    if (input === "j" || key.downArrow) moveSelection(1);
    else if (input === "k" || key.upArrow) moveSelection(-1);
    else if (key.return) activateRow(selectedRow);
    else if (input === "s") toggleSleep();
    else if (input === "g") toggleMode();
    else if (input === "r") void tick();
    else if (input === "n") setBranchInput("");
    else if (input === "q") {
      cleanupFromTui();
      exit();
    }
  });

  const cols = columns || 34;

  return (
    <Box flexDirection="column" width={cols}>
      <Text bold>
        hive [{mode}]
      </Text>
      <Text dimColor wrap="truncate-end">
        j/k move Enter go s sleep g group n new q quit
      </Text>
      {rows.map((row) => {
        const isSelected = row.key === selectedKey;
        const indent = "  ".repeat(row.depth);
        if (row.kind === "group") {
          return (
            <Text key={row.key} bold dimColor wrap="truncate-end">
              {indent}{row.name}
            </Text>
          );
        }
        const icon = (row.sleep ? "z" : "") + STATE_ICON[row.state];
        // cc = claude code, co = codex. 어느 쪽도 아니면 자리만 비워 아이콘 열을 맞춘다.
        const prefix = row.agent ? `${AGENT_LABEL[row.agent]} ` : "   ";
        const label = row.branch ? `${row.name} (${row.branch})` : row.name;
        return (
          <Text
            key={row.key}
            inverse={isSelected}
            dimColor={row.sleep}
            color={row.sleep ? undefined : STATE_COLOR[row.state]}
            wrap="truncate-end"
          >
            {indent}{prefix}{icon} {label}
          </Text>
        );
      })}
      {branchInput !== null && <Text>branch: {branchInput}</Text>}
      {statusMsg && <Text dimColor>{statusMsg}</Text>}
      {error && <Text color="red">error: {error}</Text>}
    </Box>
  );
}
