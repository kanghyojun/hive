import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { abConfigPath, abLocalInstalled, parseAbConfig, probeAbBridge } from "./abBridge.js";
import { cronTick, logCronError } from "./cronRun.js";
import { openDb, processMatches, processStart } from "./db.js";
import { resolveRepo, type RepoInfo } from "./git.js";
import { buildRows, readWindowIds, resolvePaneAgents, unreadUpdates } from "./model.js";
import { canonicalHiveHome, collectorSocketPath, dbPath, ensureDirs, setHiveHomeOverride, spoolDir } from "./paths.js";
import { ingestAll } from "./spool.js";
import { looksLikePermissionPrompt, reduceAgent, type AgentKind } from "./state.js";
import { capturePaneTail, listPanesStrict, listProcesses, serverInfo, serverKey, setTmuxSocketOverride, type ServerInfo } from "./tmux.js";
import { loadMode, saveMode } from "./uiState.js";
import { readClaudeUsage, readCodexUsage, type AgentUsage } from "./usage.js";
import { encodeMessage, MAX_SEND_BUFFER_BYTES, NdjsonDecoder, parseRequest, PROTOCOL_VERSION,
  type CollectorMessage, type CollectorRequest, type CollectorSnapshot } from "./collectorProtocol.js";

export function sendMessage(socket: Socket, message: CollectorMessage): void {
  if (socket.destroyed) return;
  try {
    const data = encodeMessage(message);
    if (socket.writableLength + Buffer.byteLength(data) > MAX_SEND_BUFFER_BYTES) {
      socket.destroy();
      return;
    }
    socket.write(data);
  } catch {
    socket.destroy();
  }
}

export interface CollectorHandle { close(): Promise<void>; done: Promise<void> }

export async function startCollector(options: { home: string; server: ServerInfo }): Promise<CollectorHandle | null> {
  setHiveHomeOverride(canonicalHiveHome(options.home));
  setTmuxSocketOverride(options.server.socketPath);
  ensureDirs();
  const identity = serverKey(options.server);
  if (serverKey(serverInfo()) !== identity) return null;
  const ownerStart = processStart(process.pid);
  if (!ownerStart) throw new Error("수집기 프로세스 시작 시각을 읽을 수 없습니다");
  const serverStart = processStart(Number(options.server.pid));
  const path = collectorSocketPath(options.home, options.server);
  const db = await openDb(dbPath());
  const token = randomUUID();
  if (!db.acquireCollectorOwner(identity, { pid: process.pid, start: ownerStart, token })) {
    db.close();
    return null;
  }

  const clients = new Map<Socket, { usage: boolean }>();
  let pending: { socket: Socket; request: CollectorRequest }[] = [];
  const repoByCwd = new Map<string, RepoInfo | null>();
  let paneAgents = new Map<string, AgentKind>();
  let waiting = new Set<string>();
  let lastScreen = 0;
  let lastCron = 0;
  let lastUsage = 0;
  let lastProbe = 0;
  let lastCronError = "";
  let probeInFlight = false;
  let stopped = false;
  let closing: Promise<void> | undefined;
  let ownsSocket = false;
  let timer: NodeJS.Timeout | undefined;
  let scheduled: NodeJS.Immediate | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let snapshot: CollectorSnapshot = {
    version: PROTOCOL_VERSION, server: options.server, collectorPid: process.pid,
    sequence: 0, lastSuccessAt: null, error: null, rows: [], panes: [], mode: loadMode(), ab: null, usage: [],
  };
  const bridgeInstalled = abLocalInstalled();
  let bridgeRaw: string | undefined;
  if (bridgeInstalled) {
    try { bridgeRaw = readFileSync(abConfigPath(), "utf8"); } catch { /* 기본 설정을 사용한다. */ }
  }
  const bridgeConfig = parseAbConfig(bridgeRaw);

  function publish(): void {
    if (stopped) return;
    snapshot = { ...snapshot, sequence: snapshot.sequence + 1 };
    for (const socket of clients.keys()) sendMessage(socket, { type: "snapshot", snapshot });
  }

  function respond(socket: Socket, request: CollectorRequest, error?: string): void {
    sendMessage(socket, { type: "response", id: request.id, ok: error === undefined, ...(error ? { error } : {}) });
  }

  function collect(): void {
    scheduled = undefined;
    if (stopped) return;
    const requests = pending;
    pending = [];
    try {
      let actual: ServerInfo;
      try {
        actual = serverInfo();
      } catch (err) {
        if (!processMatches(Number(options.server.pid), serverStart)) {
          void close();
          return;
        }
        throw err;
      }
      if (serverKey(actual) !== identity) { void close(); return; }
      const panes = listPanesStrict();
      const liveWindowIds = [...new Set(panes.map((p) => p.windowId))];
      ingestAll(db, spoolDir(), reduceAgent);
      db.migrateWindowFlags(options.server.startTime, identity, liveWindowIds);
      db.pruneWindowFlags(identity, liveWindowIds);
      const now = Date.now();
      if (now - lastScreen >= 3000) {
        lastScreen = now;
        paneAgents = resolvePaneAgents(panes, listProcesses());
        waiting = new Set(panes.filter((p) => paneAgents.has(p.paneId)
          && looksLikePermissionPrompt(capturePaneTail(p.paneId, 25))).map((p) => p.paneId));
      }
      if (now - lastCron >= 30_000) {
        lastCron = now;
        try {
          const cron = cronTick({ db, now, liveWindowIds, serverKey: identity });
          const errors = cron.errors.join(" | ");
          if (errors && errors !== lastCronError) logCronError(errors);
          lastCronError = errors;
        } catch (err) { logCronError(err instanceof Error ? err.message : String(err)); }
      }
      const liveCwds = new Set(panes.map((p) => p.paneCurrentPath));
      for (const cwd of repoByCwd.keys()) if (!liveCwds.has(cwd)) repoByCwd.delete(cwd);
      for (const cwd of liveCwds) if (!repoByCwd.has(cwd)) repoByCwd.set(cwd, resolveRepo(cwd));
      let mode = loadMode();
      const agents = db.listAgents(options.server.pid);
      const rowsFromFlags = () => {
        const flags = db.getWindowFlags(identity);
        return buildRows({ panes, agents, repoByCwd,
          sleepMap: new Map([...flags].map(([id, f]) => [id, f.sleep])),
          unreadMap: new Map([...flags].map(([id, f]) => [id, f.unread])),
          agentByPane: paneAgents, now, mode, tmuxPid: options.server.pid, screenWaitingPanes: waiting });
      };
      const initialRows = rowsFromFlags();
      const flags = db.getWindowFlags(identity);
      const viewedWindowIds = new Set(panes.filter((p) => p.windowActive && p.sessionAttached).map((p) => p.windowId));
      db.transaction(() => {
        for (const update of unreadUpdates({ rows: initialRows, viewedWindowIds,
          seenStates: new Map([...flags].map(([id, f]) => [id, f.seenState])) })) {
          db.setSeenState(identity, update.windowId, update.seenState);
          if (update.unread) db.setUnread(identity, update.windowId, true);
        }
        for (const id of readWindowIds({ rows: initialRows, viewedWindowIds })) db.setUnread(identity, id, false);
      });
      const responses: { socket: Socket; request: CollectorRequest; error?: string }[] = [];
      for (const { socket, request } of requests) {
        if (socket.destroyed) continue;
        try {
          const c = request.command;
          if ("windowId" in c && !liveWindowIds.includes(c.windowId)) throw new Error("창이 더 이상 존재하지 않습니다");
          switch (c.type) {
            case "toggleSleep": case "toggleUnread": case "activate":
              db.transaction(() => {
                const current = db.getWindowFlags(identity).get(c.windowId);
                if (c.type === "toggleSleep") db.setSleep(identity, c.windowId, !current?.sleep);
                else if (c.type === "toggleUnread") db.setUnread(identity, c.windowId, !current?.unread);
                else { db.setSleep(identity, c.windowId, false); db.setUnread(identity, c.windowId, false); }
              });
              break;
            case "setMode": saveMode(c.mode); mode = c.mode; break;
            case "usage": {
              const client = clients.get(socket);
              if (client) client.usage = c.interested;
              break;
            }
            case "refresh": break;
          }
          responses.push({ socket, request });
        } catch (err) {
          responses.push({ socket, request, error: err instanceof Error ? err.message : String(err) });
        }
      }
      let usage = snapshot.usage;
      if ([...clients.values()].some((c) => c.usage) && now - lastUsage >= 30_000) {
        lastUsage = now;
        usage = [readClaudeUsage(), readCodexUsage()].filter((u): u is AgentUsage => u !== null);
      }
      snapshot = { ...snapshot, panes, rows: rowsFromFlags().map((row) => ({ ...row, prompt: null })), mode, usage, lastSuccessAt: now, error: null };
      publish();
      for (const { socket, request, error } of responses) respond(socket, request, error);
      if (bridgeInstalled && !probeInFlight && now - lastProbe >= 30_000) {
        lastProbe = now;
        probeInFlight = true;
        void probeAbBridge(bridgeConfig).then((r) => r.status, () => "down" as const).then((ab) => {
          if (stopped) return;
          snapshot = { ...snapshot, ab };
          publish();
        }).finally(() => { probeInFlight = false; });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      snapshot = { ...snapshot, error };
      publish();
      for (const { socket, request } of requests) respond(socket, request, error);
    }
  }

  function refresh(): void {
    if (!stopped && !scheduled) scheduled = setImmediate(collect);
  }

  const listener = createServer((socket) => {
    clients.set(socket, { usage: false });
    if (snapshot.sequence) sendMessage(socket, { type: "snapshot", snapshot });
    const decoder = new NdjsonDecoder((value) => {
      const request = parseRequest(value);
      if (pending.length >= 1024) throw new Error("수집기 요청이 너무 많습니다");
      pending.push({ socket, request });
      refresh();
    }, 16 * 1024);
    socket.on("data", (chunk) => {
      try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch { socket.destroy(); }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clients.delete(socket);
      pending = pending.filter((p) => p.socket !== socket);
    });
  });

  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    if (timer) clearInterval(timer);
    if (scheduled) clearImmediate(scheduled);
    for (const socket of clients.keys()) socket.destroy();
    clients.clear();
    pending = [];
    closing = new Promise<void>((resolve, reject) => {
      listener.close(() => {
        try {
          if (ownsSocket) {
            try { unlinkSync(path); } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            }
          }
          db.releaseCollectorOwner(identity, token);
          resolve();
        } catch (err) { reject(err); }
        finally { db.close(); finish(); }
      });
    });
    return closing;
  }

  try {
    try {
      const stat = lstatSync(path);
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error(`안전하지 않은 수집기 소켓입니다: ${path}`);
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(path, () => { listener.off("error", reject); ownsSocket = true; resolve(); });
    });
    chmodSync(path, 0o600);
    listener.on("error", () => { void close(); });
    collect();
    if (!stopped) timer = setInterval(refresh, 1000);
    return { close, done };
  } catch (err) {
    await close();
    throw err;
  }
}
