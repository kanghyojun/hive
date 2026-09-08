import { promptTitle } from "./state.js";
import type { AgentRecord, AgentState } from "./state.js";

// node:sqlite는 experimental이라 의존을 이 파일 하나에 가둔다.
// ExperimentalWarning은 cli.tsx에서 미리 warning 리스너를 정리해 두고, 여기서는 동적 import만 한다.
type SqliteModule = typeof import("node:sqlite");
type DatabaseSync = InstanceType<SqliteModule["DatabaseSync"]>;

export interface EventRow {
  spoolFile: string;
  spoolOffset: number;
  ts: number;
  tmuxPid: string;
  paneId: string;
  sessionId: string;
  event: string;
  toolName: string | null;
  payload: string;
}

export type { AgentRecord };

export interface WindowFlags {
  sleep: boolean;
  /** 상태가 바뀌었는데 아직 그 창에 들어가 보지 않았다. */
  unread: boolean;
  /** 마지막으로 읽음 처리된 시점의 상태. 같은 상태가 이어질 때 unread를 다시 켜지 않으려고 둔다. */
  seenState: string | null;
}

export interface Db {
  raw: DatabaseSync;
  getOffset(spoolFile: string): number;
  setOffset(spoolFile: string, offset: number): void;
  insertEvent(row: EventRow): number;
  deleteEventsForFile(spoolFile: string): void;
  getAgent(tmuxPid: string, paneId: string): AgentRecord | undefined;
  upsertAgent(rec: AgentRecord): void;
  listAgents(tmuxPid?: string): AgentRecord[];
  getWindowFlags(serverKey: string): Map<string, WindowFlags>;
  setSleep(serverKey: string, windowId: string, sleep: boolean): void;
  setUnread(serverKey: string, windowId: string, unread: boolean): void;
  setSeenState(serverKey: string, windowId: string, state: string): void;
  pruneWindowFlags(serverKey: string, liveWindowIds: string[]): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  spool_file TEXT NOT NULL,
  spool_offset INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  tmux_pid TEXT,
  pane_id TEXT,
  session_id TEXT,
  event TEXT,
  tool_name TEXT,
  payload TEXT NOT NULL,
  UNIQUE(spool_file, spool_offset)
);
CREATE TABLE IF NOT EXISTS spool_offsets (
  spool_file TEXT PRIMARY KEY,
  offset INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  tmux_pid TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  state TEXT NOT NULL,
  source TEXT,
  tool_name TEXT,
  prompt TEXT,
  title TEXT,
  last_event TEXT,
  last_ts INTEGER,
  last_prompt_ts INTEGER,
  subagents TEXT,
  ended INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tmux_pid, pane_id)
);
CREATE TABLE IF NOT EXISTS window_flags (
  server_key TEXT NOT NULL,
  window_id TEXT NOT NULL,
  sleep INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  seen_state TEXT,
  PRIMARY KEY(server_key, window_id)
);
`;

// 이미 만들어진 DB에는 CREATE TABLE IF NOT EXISTS가 컬럼을 더해주지 않는다.
// 아직 몇 개뿐이라 직접 확인하고 붙인다. 더 늘어나면 버전 테이블로 바꾼다.
function migrate(raw: DatabaseSync): void {
  const agentCols = raw.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!agentCols.some((c) => c.name === "title")) {
    raw.exec("ALTER TABLE agents ADD COLUMN title TEXT");
  }
  const flagCols = raw.prepare("PRAGMA table_info(window_flags)").all() as { name: string }[];
  if (!flagCols.some((c) => c.name === "unread")) {
    raw.exec("ALTER TABLE window_flags ADD COLUMN unread INTEGER NOT NULL DEFAULT 0");
  }
  if (!flagCols.some((c) => c.name === "seen_state")) {
    raw.exec("ALTER TABLE window_flags ADD COLUMN seen_state TEXT");
  }
}

// title은 새 UserPromptSubmit이 들어와야 채워진다. 그래서 이미 이벤트를 다 먹은 세션은
// 이름이 비어 있다가, 그 뒤 아무 입력이나 하나 들어오면 그게 제목이 돼버린다.
// 원본 이벤트가 남아 있으면 진짜 첫 입력으로 다시 계산해 바로잡는다.
// 세션이 새로 시작했으면 그 뒤 첫 입력만 본다(reduceAgent와 같은 규칙).
function backfillTitles(raw: DatabaseSync): void {
  const rows = raw
    .prepare(
      `SELECT a.tmux_pid AS tmuxPid, a.pane_id AS paneId, a.title AS title,
              (SELECT e.payload FROM events e
                WHERE e.tmux_pid = a.tmux_pid AND e.pane_id = a.pane_id
                  AND e.event = 'UserPromptSubmit'
                  AND e.ts >= COALESCE((SELECT MAX(s.ts) FROM events s
                                         WHERE s.tmux_pid = a.tmux_pid AND s.pane_id = a.pane_id
                                           AND s.event = 'SessionStart'), 0)
                ORDER BY e.ts ASC LIMIT 1) AS payload
         FROM agents a`
    )
    .all() as { tmuxPid: string; paneId: string; title: string | null; payload: string | null }[];

  const update = raw.prepare("UPDATE agents SET title = ? WHERE tmux_pid = ? AND pane_id = ?");
  for (const row of rows) {
    if (!row.payload) continue;
    let title: string | null = null;
    try {
      title = promptTitle((JSON.parse(row.payload) as { prompt?: unknown }).prompt);
    } catch {
      continue;
    }
    // 이벤트가 잘려나가 계산이 안 되면 지금 값을 그대로 둔다. 비우지는 않는다.
    if (title && title !== row.title) update.run(title, row.tmuxPid, row.paneId);
  }
}

export async function openDb(path: string): Promise<Db> {
  // ExperimentalWarning 억제는 cli.tsx 진입부에서 처리한다(동적 import 전에 리스너를 걸어야 함).
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  // busy_timeout을 제일 먼저 걸어야 한다. journal_mode 설정도 잠금을 잡기 때문에,
  // 사이드바가 둘 이상 동시에 열리면 여기서 바로 "database is locked"가 난다(실측).
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec(SCHEMA);
  migrate(raw);
  backfillTitles(raw);

  const stmts = {
    getOffset: raw.prepare("SELECT offset FROM spool_offsets WHERE spool_file = ?"),
    setOffset: raw.prepare(
      "INSERT INTO spool_offsets(spool_file, offset) VALUES(?, ?) ON CONFLICT(spool_file) DO UPDATE SET offset = excluded.offset"
    ),
    insertEvent: raw.prepare(
      `INSERT OR IGNORE INTO events(spool_file, spool_offset, ts, tmux_pid, pane_id, session_id, event, tool_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    deleteEventsForFile: raw.prepare("DELETE FROM events WHERE spool_file = ?"),
    getAgent: raw.prepare("SELECT * FROM agents WHERE tmux_pid = ? AND pane_id = ?"),
    upsertAgent: raw.prepare(
      `INSERT INTO agents(tmux_pid, pane_id, state, source, tool_name, prompt, title, last_event, last_ts, last_prompt_ts, subagents, ended)
       VALUES (@tmuxPid, @paneId, @state, @source, @toolName, @prompt, @title, @lastEvent, @lastTs, @lastPromptTs, @subagents, @ended)
       ON CONFLICT(tmux_pid, pane_id) DO UPDATE SET
         state = excluded.state, source = excluded.source, tool_name = excluded.tool_name,
         prompt = excluded.prompt, title = excluded.title, last_event = excluded.last_event, last_ts = excluded.last_ts,
         last_prompt_ts = excluded.last_prompt_ts, subagents = excluded.subagents, ended = excluded.ended`
    ),
    listAgentsAll: raw.prepare("SELECT * FROM agents"),
    listAgentsByPid: raw.prepare("SELECT * FROM agents WHERE tmux_pid = ?"),
    getWindowFlags: raw.prepare(
      "SELECT window_id, sleep, unread, seen_state FROM window_flags WHERE server_key = ?"
    ),
    setSleep: raw.prepare(
      `INSERT INTO window_flags(server_key, window_id, sleep) VALUES(?, ?, ?)
       ON CONFLICT(server_key, window_id) DO UPDATE SET sleep = excluded.sleep`
    ),
    setUnread: raw.prepare(
      `INSERT INTO window_flags(server_key, window_id, unread) VALUES(?, ?, ?)
       ON CONFLICT(server_key, window_id) DO UPDATE SET unread = excluded.unread`
    ),
    setSeenState: raw.prepare(
      `INSERT INTO window_flags(server_key, window_id, seen_state) VALUES(?, ?, ?)
       ON CONFLICT(server_key, window_id) DO UPDATE SET seen_state = excluded.seen_state`
    ),
  };

  function rowToAgent(row: Record<string, unknown>): AgentRecord {
    return {
      tmuxPid: String(row.tmux_pid),
      paneId: String(row.pane_id),
      state: String(row.state) as AgentState,
      source: String(row.source ?? ""),
      toolName: (row.tool_name as string | null) ?? null,
      prompt: (row.prompt as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      lastEvent: (row.last_event as string | null) ?? null,
      lastTs: Number(row.last_ts ?? 0),
      lastPromptTs: row.last_prompt_ts == null ? null : Number(row.last_prompt_ts),
      subagents: String(row.subagents ?? "{}"),
      ended: Number(row.ended ?? 0),
    };
  }

  return {
    raw,
    getOffset(spoolFile) {
      const row = stmts.getOffset.get(spoolFile) as { offset: number } | undefined;
      return row?.offset ?? 0;
    },
    setOffset(spoolFile, offset) {
      stmts.setOffset.run(spoolFile, offset);
    },
    insertEvent(row) {
      const result = stmts.insertEvent.run(
        row.spoolFile,
        row.spoolOffset,
        row.ts,
        row.tmuxPid,
        row.paneId,
        row.sessionId,
        row.event,
        row.toolName,
        row.payload
      );
      return Number(result.changes);
    },
    deleteEventsForFile(spoolFile) {
      stmts.deleteEventsForFile.run(spoolFile);
    },
    getAgent(tmuxPid, paneId) {
      const row = stmts.getAgent.get(tmuxPid, paneId) as Record<string, unknown> | undefined;
      return row ? rowToAgent(row) : undefined;
    },
    upsertAgent(rec) {
      stmts.upsertAgent.run(rec as unknown as Record<string, string | number | null>);
    },
    listAgents(tmuxPid) {
      const rows = (
        tmuxPid ? stmts.listAgentsByPid.all(tmuxPid) : stmts.listAgentsAll.all()
      ) as Record<string, unknown>[];
      return rows.map(rowToAgent);
    },
    getWindowFlags(serverKey) {
      const rows = stmts.getWindowFlags.all(serverKey) as {
        window_id: string;
        sleep: number;
        unread: number;
        seen_state: string | null;
      }[];
      return new Map(
        rows.map((r) => [
          r.window_id,
          { sleep: r.sleep === 1, unread: r.unread === 1, seenState: r.seen_state ?? null },
        ])
      );
    },
    setSleep(serverKey, windowId, sleep) {
      stmts.setSleep.run(serverKey, windowId, sleep ? 1 : 0);
    },
    setUnread(serverKey, windowId, unread) {
      stmts.setUnread.run(serverKey, windowId, unread ? 1 : 0);
    },
    setSeenState(serverKey, windowId, state) {
      stmts.setSeenState.run(serverKey, windowId, state);
    },
    pruneWindowFlags(serverKey, liveWindowIds) {
      // 다른 server_key까지 지우면 안 된다. tmux 서버가 여럿이면 사이드바끼리 서로의
      // sleep 표시를 1초마다 지워버린다. 죽은 서버의 찌꺼기는 몇 줄이라 그냥 둔다.
      // 살아 있는 window를 하나도 못 받았으면 tmux 조회가 실패한 것이다. 그때 지우면
      // 일시적인 실패 한 번에 sleep이 전부 풀린다. 아무것도 하지 않는다.
      if (liveWindowIds.length === 0) return;
      const placeholders = liveWindowIds.map(() => "?").join(",");
      const stmt = raw.prepare(
        `DELETE FROM window_flags WHERE server_key = ? AND window_id NOT IN (${placeholders})`
      );
      stmt.run(serverKey, ...liveWindowIds);
    },
    transaction(fn) {
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      raw.close();
    },
  };
}
