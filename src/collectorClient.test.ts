import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectorClient, type CollectorStatus } from "./collectorClient.js";
import { encodeMessage, type CollectorSnapshot } from "./collectorProtocol.js";
import { collectorEntryPath, selfRelaunchArgv } from "./paths.js";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";

vi.mock("node:net", () => ({ createConnection: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: string[] = [];
  write(data: string): void { this.writes.push(data); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}
const server = { pid: "123", startTime: "456", socketPath: "/tmp/hive-client-fake" };
const snapshot = (): CollectorSnapshot => ({ version: 1, server, collectorPid: 789, sequence: 1,
  lastSuccessAt: Date.now(), error: null, rows: [], panes: [], mode: "recent", ab: null, usage: [] });

describe("수집기 client 복구와 요청 수명", () => {
  let home: string;
  let sockets: FakeSocket[];
  let statuses: CollectorStatus[];
  let client: CollectorClient;
  beforeEach(() => {
    vi.useFakeTimers();
    home = mkdtempSync("/tmp/hive-client-test-");
    sockets = [];
    statuses = [];
    vi.mocked(createConnection).mockImplementation(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as never;
    });
    vi.mocked(spawn).mockReset().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      return child as never;
    });
    client = new CollectorClient({ home, server, paneId: "%0", onStatus: (status) => statuses.push(status) });
    client.start();
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  function connected(): FakeSocket {
    const socket = sockets.at(-1)!;
    socket.emit("connect");
    socket.emit("data", Buffer.from(encodeMessage({ type: "snapshot", snapshot: snapshot() })));
    return socket;
  }

  it("연결과 snapshot 갱신 지연을 노출하고 연결 무응답을 재시도합니다", () => {
    expect(statuses.at(-1)).toMatchObject({ connected: false, stale: true });
    vi.advanceTimersByTime(3000);
    expect(sockets[0].destroyed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    const socket = connected();
    expect(statuses.at(-1)).toMatchObject({ connected: true, stale: false });
    vi.advanceTimersByTime(6000);
    expect(statuses.at(-1)).toMatchObject({ connected: true, stale: true });
    expect(socket.destroyed).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(socket.destroyed).toBe(true);
  });

  it("응답 없는 토글은 timeout 또는 연결 종료로 실패하며 재전송하지 않습니다", async () => {
    const socket = connected();
    const timeout = client.command({ type: "toggleSleep", windowId: "@0" });
    const rejected = expect(timeout).rejects.toThrow("응답이 없습니다");
    vi.advanceTimersByTime(5000);
    await rejected;
    const pending = client.command({ type: "toggleUnread", windowId: "@0" });
    const disconnected = expect(pending).rejects.toThrow("연결이 끊겼습니다");
    socket.destroy();
    await disconnected;
    vi.advanceTimersByTime(1000);
    const next = connected();
    expect(next.writes).toEqual([]);
    expect(socket.writes).toHaveLength(2);
  });

  it("기존 소켓 연결 실패 때만 entry를 시작하고 usage 관심을 재등록합니다", async () => {
    sockets[0].emit("error", Object.assign(new Error("없음"), { code: "ENOENT" }));
    sockets[0].destroy();
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(expect.arrayContaining(
      [...selfRelaunchArgv(collectorEntryPath()).slice(1), "--home", home, "--server", JSON.stringify(server)]));
    client.setUsageInterest(true);
    vi.advanceTimersByTime(1000);
    const socket = connected();
    expect(JSON.parse(socket.writes[0]).command).toEqual({ type: "usage", interested: true });
    socket.destroy();
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    const next = connected();
    expect(JSON.parse(next.writes[0]).command).toEqual({ type: "usage", interested: true });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("거절된 사용량 구독은 수집이 복구된 뒤 재등록하고 정상 등록은 반복하지 않습니다", async () => {
    const socket = connected();
    client.setUsageInterest(true);
    const first = JSON.parse(socket.writes[0]);
    socket.emit("data", Buffer.from(encodeMessage({ type: "snapshot", snapshot: { ...snapshot(), error: "일시 오류" } })));
    socket.emit("data", Buffer.from(encodeMessage({ type: "response", id: first.id, ok: false, error: "일시 오류" })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.writes).toHaveLength(1);
    socket.emit("data", Buffer.from(encodeMessage({ type: "snapshot", snapshot: snapshot() })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.writes).toHaveLength(2);
    const retry = JSON.parse(socket.writes[1]);
    expect(retry.command).toEqual({ type: "usage", interested: true });
    socket.emit("data", Buffer.from(encodeMessage({ type: "response", id: retry.id, ok: true })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.writes).toHaveLength(2);
  });

  it("등록 결과를 받기 전에 사용량 화면을 닫아도 최종 관심 상태로 재시도합니다", async () => {
    const socket = connected();
    client.setUsageInterest(true);
    const request = JSON.parse(socket.writes[0]);
    client.setUsageInterest(false);
    socket.emit("data", Buffer.from(encodeMessage({ type: "response", id: request.id, ok: false, error: "일시 오류" })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.writes).toHaveLength(2);
    expect(JSON.parse(socket.writes[1]).command).toEqual({ type: "usage", interested: false });
  });
});
