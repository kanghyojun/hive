import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCollector, sendMessage, type CollectorHandle } from "./collector.js";
import { CollectorClient } from "./collectorClient.js";
import { MAX_SEND_BUFFER_BYTES, type CollectorSnapshot } from "./collectorProtocol.js";
import { openDb } from "./db.js";
import { setHiveHomeOverride } from "./paths.js";
import { listPanesStrict, listProcesses, setTmuxSocketOverride, type PaneInfo } from "./tmux.js";
import { readClaudeUsage, readCodexUsage } from "./usage.js";

vi.mock("./tmux.js", async (original) => ({
  ...await original<typeof import("./tmux.js")>(),
  serverInfo: vi.fn(() => ({ pid: String(process.pid), startTime: "1", socketPath: "/tmp/hive-mocked-tmux" })),
  listPanesStrict: vi.fn(), listProcesses: vi.fn(() => []), capturePaneTail: vi.fn(() => ""),
}));
vi.mock("./git.js", async (original) => ({ ...await original<typeof import("./git.js")>(), resolveRepo: vi.fn(() => null) }));
vi.mock("./abBridge.js", async (original) => ({ ...await original<typeof import("./abBridge.js")>(), abLocalInstalled: vi.fn(() => false) }));
vi.mock("./cronRun.js", () => ({ cronTick: vi.fn(() => ({ errors: [] })), logCronError: vi.fn() }));
vi.mock("./usage.js", () => ({ readClaudeUsage: vi.fn(() => null), readCodexUsage: vi.fn(() => null) }));

const server = { pid: String(process.pid), startTime: "1", socketPath: "/tmp/hive-mocked-tmux" };
const pane: PaneInfo = {
  sessionName: "test", sessionId: "$0", windowId: "@0", windowIndex: "0", windowName: "test",
  windowAutoName: false, windowActive: true, windowActivity: 1, paneId: "%0", paneActive: true,
  paneCurrentPath: "/tmp", paneCurrentCommand: "claude", paneTitle: "", panePid: "1",
  sidebarPaneId: "", sidebarMark: false, sessionAttached: false,
};

describe("공유 수집기", () => {
  let home: string;
  let handle: CollectorHandle | null;
  let clients: CollectorClient[];
  let now: number;
  beforeEach(() => {
    home = mkdtempSync("/tmp/hive-collector-test-");
    handle = null;
    clients = [];
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(listPanesStrict).mockReset().mockReturnValue([pane]);
    vi.mocked(listProcesses).mockClear();
    vi.mocked(readClaudeUsage).mockClear();
    vi.mocked(readCodexUsage).mockClear();
  });
  afterEach(async () => {
    for (const client of clients) client.close();
    await handle?.close();
    setHiveHomeOverride(undefined);
    setTmuxSocketOverride(undefined);
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  async function connect(): Promise<CollectorClient> {
    const client = new CollectorClient({ home, server, paneId: "%0" });
    clients.push(client);
    client.start();
    await vi.waitFor(() => expect(client.snapshot).not.toBeNull());
    return client;
  }

  it("큰 원본 프롬프트를 화면에 전송하지 않고 여러 UI가 같은 수집 결과를 받습니다", async () => {
    const db = await openDb(join(home, "hive.db"));
    const prompt = "긴 원본 프롬프트입니다".repeat(300_000);
    db.upsertAgent({ tmuxPid: server.pid, paneId: "%0", state: "working", source: "hook", toolName: null,
      prompt, title: "큰 작업", lastEvent: "UserPromptSubmit", lastTs: now, lastPromptTs: now, subagents: "{}", ended: 0 });
    db.close();
    handle = await startCollector({ home, server });
    const a = await connect();
    const b = await connect();
    expect(listPanesStrict).toHaveBeenCalledTimes(1);
    expect(listProcesses).toHaveBeenCalledTimes(1);
    expect(a.snapshot).toEqual(b.snapshot);
    expect(a.snapshot!.rows.find((r) => r.kind === "window")).toMatchObject({ prompt: null, title: "큰 작업" });
    expect(Buffer.byteLength(JSON.stringify(a.snapshot))).toBeLessThan(10_000);
    const check = await openDb(join(home, "hive.db"));
    expect(check.getAgent(server.pid, "%0")?.prompt).toBe(prompt);
    check.close();
    now += 3001;
    await a.command({ type: "refresh" });
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  it("복수 UI의 연속 토글은 DB 현재값으로 적용하고 모드를 공유합니다", async () => {
    handle = await startCollector({ home, server });
    const a = await connect();
    const b = await connect();
    await Promise.all([a.command({ type: "toggleSleep", windowId: "@0" }), b.command({ type: "toggleSleep", windowId: "@0" })]);
    expect(a.snapshot!.rows.find((r) => r.kind === "window")?.sleep).toBe(false);
    await a.command({ type: "toggleSleep", windowId: "@0" });
    await b.command({ type: "toggleUnread", windowId: "@0" });
    expect(b.snapshot!.rows.find((r) => r.kind === "window")).toMatchObject({ sleep: true, unread: true });
    await b.command({ type: "activate", windowId: "@0" });
    expect(b.snapshot!.rows.find((r) => r.kind === "window")).toMatchObject({ sleep: false, unread: false });
    await a.command({ type: "setMode", mode: "group" });
    await vi.waitFor(() => expect(b.snapshot!.mode).toBe("group"));
    await expect(a.command({ type: "toggleSleep", windowId: "@999" })).rejects.toThrow("존재하지 않습니다");
  });

  it("사용량 관심을 합쳐 30초마다 한 번만 읽고 연결 종료 시 관심을 제거합니다", async () => {
    handle = await startCollector({ home, server });
    const a = await connect();
    const b = await connect();
    expect(readClaudeUsage).not.toHaveBeenCalled();
    await a.command({ type: "usage", interested: true });
    await b.command({ type: "usage", interested: true });
    expect(readClaudeUsage).toHaveBeenCalledTimes(1);
    now += 30_001;
    await a.command({ type: "refresh" });
    expect(readCodexUsage).toHaveBeenCalledTimes(2);
    await a.command({ type: "usage", interested: false });
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    now += 30_001;
    await a.command({ type: "refresh" });
    expect(readClaudeUsage).toHaveBeenCalledTimes(2);
  });

  it("pane 조회 오류에서 마지막 행과 성공 시각을 유지하고 복구합니다", async () => {
    handle = await startCollector({ home, server });
    const client = await connect();
    const before = client.snapshot!;
    vi.mocked(listPanesStrict).mockImplementation(() => { throw new Error("tmux 일시 실패"); });
    now += 10_000;
    await expect(client.command({ type: "refresh" })).rejects.toThrow("tmux 일시 실패");
    expect(client.snapshot).toMatchObject({ rows: before.rows, lastSuccessAt: before.lastSuccessAt, error: "tmux 일시 실패" });
    vi.mocked(listPanesStrict).mockReturnValue([pane]);
    await client.command({ type: "refresh" });
    expect(client.snapshot).toMatchObject({ lastSuccessAt: now, error: null });
  });

  it("느린 구독자의 송신 버퍼가 상한을 넘기 전에 연결을 닫습니다", () => {
    const socket = { destroyed: false, writableLength: MAX_SEND_BUFFER_BYTES, destroy: vi.fn(), write: vi.fn() };
    sendMessage(socket as unknown as Socket, { type: "snapshot", snapshot: {} as CollectorSnapshot });
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.write).not.toHaveBeenCalled();
  });
});
