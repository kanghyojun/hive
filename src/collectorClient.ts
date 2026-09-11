import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { canonicalHiveHome, collectorEntryPath, collectorSocketPath, selfRelaunchArgv } from "./paths.js";
import { currentPaneId, serverInfo, serverKey, type ServerInfo } from "./tmux.js";
import { encodeMessage, isServerInfo, NdjsonDecoder, PROTOCOL_VERSION, SNAPSHOT_STALE_MS,
  type CollectorCommand, type CollectorMessage, type CollectorSnapshot } from "./collectorProtocol.js";

export interface CollectorStatus { connected: boolean; stale: boolean; error: string | null }
export interface CollectorClientOptions {
  home?: string;
  server?: ServerInfo;
  paneId?: string;
  onSnapshot?: (snapshot: CollectorSnapshot) => void;
  onStatus?: (status: CollectorStatus) => void;
}

export class CollectorClient {
  paneId: string | undefined;
  snapshot: CollectorSnapshot | null = null;
  private socket: Socket | null = null;
  private home = "";
  private server: ServerInfo | undefined;
  private stopped = true;
  private connected = false;
  private usage = false;
  private appliedUsage: boolean | null = false;
  private usageSyncSocket: Socket | null = null;
  private lastSpawn = 0;
  private lastReceived = 0;
  private nextId = 0;
  private retry: NodeJS.Timeout | undefined;
  private monitor: NodeJS.Timeout | undefined;
  private connectionTimer: NodeJS.Timeout | undefined;
  private lastStatus = "";
  private connectionError: string | null = null;
  private requests = new Map<string, {
    resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout;
  }>();

  constructor(private options: CollectorClientOptions = {}) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      this.home = canonicalHiveHome(this.options.home);
      this.paneId = this.options.paneId ?? currentPaneId();
    } catch (err) {
      this.connectionError = err instanceof Error ? err.message : String(err);
    }
    this.reportStatus();
    this.monitor = setInterval(() => {
      this.reportStatus();
      if (this.connected && Date.now() - this.lastReceived > 15_000) this.socket?.destroy();
      if (!this.snapshot?.error) this.syncUsage();
    }, 1000);
    this.connect();
  }

  private reportStatus(): void {
    const stale = !this.connected || !this.snapshot?.lastSuccessAt || Boolean(this.snapshot.error)
      || Date.now() - this.snapshot.lastSuccessAt > SNAPSHOT_STALE_MS;
    const status: CollectorStatus = { connected: this.connected, stale,
      error: this.connectionError ?? this.snapshot?.error ?? null };
    const key = JSON.stringify(status);
    if (key !== this.lastStatus) { this.lastStatus = key; this.options.onStatus?.(status); }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, 1000);
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    try {
      this.home ||= canonicalHiveHome(this.options.home);
      this.server = this.options.server ?? serverInfo();
      const server = this.server;
      const socket = createConnection(collectorSocketPath(this.home, server));
      this.socket = socket;
      let connectionFailed = false;
      this.connectionTimer = setTimeout(() => {
        this.connectionError = "수집기 연결 응답이 없습니다";
        socket.destroy();
      }, 3000);
      const decoder = new NdjsonDecoder((value) => {
        if (!value || typeof value !== "object") throw new Error("잘못된 수집기 응답입니다");
        const message = value as CollectorMessage;
        if (message.type === "snapshot") {
          const s = message.snapshot;
          if (!s || s.version !== PROTOCOL_VERSION || !isServerInfo(s.server) || serverKey(s.server) !== serverKey(server)
            || !Number.isSafeInteger(s.collectorPid) || !Number.isSafeInteger(s.sequence)
            || (s.lastSuccessAt !== null && typeof s.lastSuccessAt !== "number")
            || (s.error !== null && typeof s.error !== "string")
            || (s.mode !== "recent" && s.mode !== "group")
            || !Array.isArray(s.rows) || !Array.isArray(s.panes) || !Array.isArray(s.usage)) {
            throw new Error("수집기 snapshot이 올바르지 않습니다");
          }
          this.lastReceived = Date.now();
          this.snapshot = s;
          this.connectionError = null;
          this.options.onSnapshot?.(s);
          this.reportStatus();
        } else if (message.type === "response" && typeof message.id === "string" && typeof message.ok === "boolean") {
          const request = this.requests.get(message.id);
          if (!request) return;
          this.requests.delete(message.id);
          clearTimeout(request.timer);
          if (message.ok) request.resolve();
          else request.reject(new Error(typeof message.error === "string" ? message.error : "수집기 명령이 실패했습니다"));
        } else throw new Error("잘못된 수집기 응답입니다");
      });
      socket.on("connect", () => {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connected = true;
        this.lastReceived = Date.now();
        this.connectionError = null;
        this.reportStatus();
        this.appliedUsage = false;
        this.syncUsage();
      });
      socket.on("data", (chunk) => {
        try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch (err) {
          this.connectionError = err instanceof Error ? err.message : String(err);
          socket.destroy();
        }
      });
      socket.on("error", (err: NodeJS.ErrnoException) => {
        connectionFailed = err.code === "ENOENT" || err.code === "ECONNREFUSED";
        this.connectionError = err.message;
      });
      socket.on("close", () => {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.socket = null;
        this.connected = false;
        this.failRequests("수집기 연결이 끊겼습니다. 명령 결과를 확인한 뒤 다시 시도하세요");
        if (this.stopped) return;
        this.reportStatus();
        if (connectionFailed && Date.now() - this.lastSpawn >= 3000) this.spawnCollector(server);
        this.scheduleRetry();
      });
    } catch (err) {
      this.connectionError = err instanceof Error ? err.message : String(err);
      this.reportStatus();
      this.scheduleRetry();
    }
  }

  private spawnCollector(server: ServerInfo): void {
    this.lastSpawn = Date.now();
    const [node, ...args] = selfRelaunchArgv(collectorEntryPath());
    const child = spawn(node, [...args, "--home", this.home, "--server", JSON.stringify(server)],
      { detached: true, stdio: "ignore" });
    child.on("error", (err) => { this.connectionError = err.message; this.reportStatus(); });
    child.unref();
  }

  command(command: CollectorCommand): Promise<void> {
    const socket = this.socket;
    if (!this.connected || !socket || socket.destroyed || this.stopped) {
      return Promise.reject(new Error("수집기에 연결하는 중입니다"));
    }
    if (this.requests.size >= 256) return Promise.reject(new Error("수집기 응답을 기다리는 명령이 너무 많습니다"));
    const id = String(++this.nextId);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error("수집기 명령 응답이 없습니다. 결과를 확인한 뒤 다시 시도하세요"));
      }, 5000);
      this.requests.set(id, { resolve, reject, timer });
      try { socket.write(encodeMessage({ id, command })); } catch (err) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  setUsageInterest(interested: boolean): void {
    if (this.usage === interested) return;
    this.usage = interested;
    this.syncUsage();
  }

  private syncUsage(): void {
    const socket = this.socket;
    if (!socket || !this.connected || this.stopped || this.appliedUsage === this.usage || this.usageSyncSocket === socket) return;
    const interested = this.usage;
    this.usageSyncSocket = socket;
    // 관심 설정은 같은 값을 다시 보내도 안전하지만, sleep/unread 토글은 재전송하지 않는다.
    void this.command({ type: "usage", interested }).then(() => {
      if (this.socket === socket) this.appliedUsage = interested;
    }).catch(() => {
      if (this.socket === socket) this.appliedUsage = null;
    }).finally(() => {
      if (this.usageSyncSocket === socket) this.usageSyncSocket = null;
    });
  }

  private failRequests(message: string): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.requests.clear();
  }

  close(): void {
    this.stopped = true;
    this.connected = false;
    if (this.retry) clearTimeout(this.retry);
    if (this.monitor) clearInterval(this.monitor);
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.retry = undefined;
    this.failRequests("수집기 연결을 닫았습니다");
    this.socket?.destroy();
  }
}
