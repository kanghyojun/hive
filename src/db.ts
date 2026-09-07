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

export interface Db {
  raw: DatabaseSync;
  getOffset(spoolFile: string): number;
  setOffset(spoolFile: string, offset: number): void;
  insertEvent(row: EventRow): number;
  getAgent(tmuxPid: string, paneId: string): AgentRecord | undefined;
  upsertAgent(rec: AgentRecord): void;
  listAgents(tmuxPid?: string): AgentRecord[];
  getSleepMap(serverKey: string): Map<string, boolean>;
  setSleep(serverKey: string, windowId: string, sleep: boolean): void;
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
  PRIMARY KEY(server_key, window_id)
);
`;

export async function openDb(path: string): Promise<Db> {
  // ExperimentalWarning 억제는 cli.tsx 진입부에서 처리한다(동적 import 전에 리스너를 걸어야 함).
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA busy_timeout = 3000");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec(SCHEMA);

  const stmts = {
    getOffset: raw.prepare("SELECT offset FROM spool_offsets WHERE spool_file = ?"),
    setOffset: raw.prepare(
      "INSERT INTO spool_offsets(spool_file, offset) VALUES(?, ?) ON CONFLICT(spool_file) DO UPDATE SET offset = excluded.offset"
    ),
    insertEvent: raw.prepare(
      `INSERT OR IGNORE INTO events(spool_file, spool_offset, ts, tmux_pid, pane_id, session_id, event, tool_name, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getAgent: raw.prepare("SELECT * FROM agents WHERE tmux_pid = ? AND pane_id = ?"),
    upsertAgent: raw.prepare(
      `INSERT INTO agents(tmux_pid, pane_id, state, source, tool_name, prompt, last_event, last_ts, last_prompt_ts, subagents, ended)
       VALUES (@tmuxPid, @paneId, @state, @source, @toolName, @prompt, @lastEvent, @lastTs, @lastPromptTs, @subagents, @ended)
       ON CONFLICT(tmux_pid, pane_id) DO UPDATE SET
         state = excluded.state, source = excluded.source, tool_name = excluded.tool_name,
         prompt = excluded.prompt, last_event = excluded.last_event, last_ts = excluded.last_ts,
         last_prompt_ts = excluded.last_prompt_ts, subagents = excluded.subagents, ended = excluded.ended`
    ),
    listAgentsAll: raw.prepare("SELECT * FROM agents"),
    listAgentsByPid: raw.prepare("SELECT * FROM agents WHERE tmux_pid = ?"),
    getSleepMap: raw.prepare("SELECT window_id, sleep FROM window_flags WHERE server_key = ?"),
    setSleep: raw.prepare(
      `INSERT INTO window_flags(server_key, window_id, sleep) VALUES(?, ?, ?)
       ON CONFLICT(server_key, window_id) DO UPDATE SET sleep = excluded.sleep`
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
    getSleepMap(serverKey) {
      const rows = stmts.getSleepMap.all(serverKey) as { window_id: string; sleep: number }[];
      return new Map(rows.map((r) => [r.window_id, r.sleep === 1]));
    },
    setSleep(serverKey, windowId, sleep) {
      stmts.setSleep.run(serverKey, windowId, sleep ? 1 : 0);
    },
    pruneWindowFlags(serverKey, liveWindowIds) {
      raw.exec(`DELETE FROM window_flags WHERE server_key != '${serverKey.replace(/'/g, "''")}'`);
      if (liveWindowIds.length === 0) {
        raw.exec(
          `DELETE FROM window_flags WHERE server_key = '${serverKey.replace(/'/g, "''")}'`
        );
        return;
      }
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
