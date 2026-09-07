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

  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<ViewMode>(() => loadMode());
  const [selected, setSelected] = useState(0);
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

      const nextRows = buildRows({
        panes,
        agents: db.listAgents(),
        repoByCwd,
        sleepMap: db.getSleepMap(server.startTime),
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

  const moveSelection = useCallback(
    (delta: number) => {
      if (windowRows.length === 0) return;
      setSelected((prev) => {
        const currentRow = rows[prev];
        const currentWindowIdx = currentRow
          ? windowRows.findIndex((r) => r.key === currentRow.key)
          : -1;
        const base = currentWindowIdx === -1 ? 0 : currentWindowIdx;
        const nextWindowIdx = (base + delta + windowRows.length) % windowRows.length;
        return rows.findIndex((r) => r.key === windowRows[nextWindowIdx].key);
      });
    },
    [rows, windowRows]
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
    const row = rows[selected];
    const db = dbRef.current;
    if (!row || row.kind !== "window" || !db) return;
    const server = serverInfo();
    db.setSleep(server.startTime, row.windowId, !row.sleep);
    void tick();
  }, [rows, selected, tick]);

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
      const row = rows[selected];
      if (!branch.trim() || !row) return;
      try {
        const result = wtNew({ branch: branch.trim(), repo: row.repoRoot ?? row.cwd });
        setStatusMsg(`worktree: ${result.path}`);
      } catch (err) {
        setStatusMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [rows, selected]
  );

  // 마우스: 클릭으로 선택+이동, 휠로 스크롤. SGR 시퀀스는 useInput이 아닌 stdin 'data'에서 직접 파싱한다(실측).
  useEffect(() => {
    if (!stdin || !isRawModeSupported) return;
    process.stdout.write("\x1b[?1000;1006h");
    const headerLines = 2;
    const onData = (chunk: Buffer | string) => {
      const str = chunk.toString();
      const re = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(str))) {
        const btn = Number(m[1]);
        const tmuxRow = Number(m[3]);
        const isRelease = m[4] === "m";
        if (btn === 64) {
          moveSelection(-1);
        } else if (btn === 65) {
          moveSelection(1);
        } else if (btn === 0 && !isRelease) {
          const idx = tmuxRow - headerLines - 1;
          const row = rows[idx];
          if (row && row.kind === "window") {
            setSelected(idx);
            activateRow(row);
          }
        }
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      process.stdout.write("\x1b[?1000;1006l");
    };
  }, [stdin, isRawModeSupported, rows, moveSelection, activateRow]);

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
    else if (key.return) activateRow(rows[selected]);
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
      {rows.map((row, idx) => {
        const isSelected = idx === selected;
        const indent = "  ".repeat(row.depth);
        if (row.kind === "group") {
          return (
            <Text key={row.key} bold dimColor wrap="truncate-end">
              {indent}{row.name}
            </Text>
          );
        }
        const icon = (row.sleep ? "z" : "") + STATE_ICON[row.state];
        const label = row.branch ? `${row.name} (${row.branch})` : row.name;
        return (
          <Text
            key={row.key}
            inverse={isSelected}
            dimColor={row.sleep}
            color={row.sleep ? undefined : STATE_COLOR[row.state]}
            wrap="truncate-end"
          >
            {indent}{icon} {label}
          </Text>
        );
      })}
      {branchInput !== null && <Text>branch: {branchInput}</Text>}
      {statusMsg && <Text dimColor>{statusMsg}</Text>}
      {error && <Text color="red">error: {error}</Text>}
    </Box>
  );
}
